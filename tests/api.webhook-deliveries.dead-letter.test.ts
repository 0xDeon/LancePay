import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/webhook-deliveries/dead-letter/route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    webhookDelivery: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockUserFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const db = prisma as unknown as {
  webhookDelivery: {
    findMany: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
}

const BASE_URL = 'http://localhost/api/webhook-deliveries/dead-letter'

function makeReq(url = BASE_URL, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(url, { method: 'GET', headers })
}

describe('GET /api/webhook-deliveries/dead-letter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: valid admin token and user
    mockVerify.mockResolvedValue({ userId: 'privy-admin-123' })
    mockUserFindUnique.mockResolvedValue({ id: 'admin-user-1', role: 'admin' })
    db.webhookDelivery.findMany.mockResolvedValue([])
    db.webhookDelivery.count.mockResolvedValue(0)
  })

  describe('Authorization', () => {
    it('returns 401 when no authorization token is provided', async () => {
      const res = await GET(makeReq(BASE_URL, null))
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toBe('Unauthorized')
    })

    it('returns 401 when token verification fails', async () => {
      mockVerify.mockResolvedValue(null)
      const res = await GET(makeReq())
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toBe('Unauthorized')
    })

    it('returns 404 when user is not found in database', async () => {
      mockUserFindUnique.mockResolvedValue(null)
      const res = await GET(makeReq())
      expect(res.status).toBe(404)
      const json = await res.json()
      expect(json.error).toBe('User not found')
    })

    it('returns 403 when user is not admin', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', role: 'freelancer' })
      const res = await GET(makeReq())
      expect(res.status).toBe(403)
      const json = await res.json()
      expect(json.error).toMatch(/admin/i)
    })

    it('returns 403 when user is standard role (not admin)', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', role: 'user' })
      const res = await GET(makeReq())
      expect(res.status).toBe(403)
      const json = await res.json()
      expect(json.error).toMatch(/forbidden/i)
    })
  })

  describe('Query Parameter Validation', () => {
    it('returns 400 when limit is invalid (non-numeric)', async () => {
      const res = await GET(makeReq(`${BASE_URL}?limit=invalid`))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/limit/i)
    })

    it('returns 400 when limit is zero', async () => {
      const res = await GET(makeReq(`${BASE_URL}?limit=0`))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/limit/i)
    })

    it('returns 400 when limit exceeds maximum (100)', async () => {
      const res = await GET(makeReq(`${BASE_URL}?limit=101`))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/limit/i)
    })

    it('returns 400 when page is non-numeric', async () => {
      const res = await GET(makeReq(`${BASE_URL}?page=abc`))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/page/i)
    })

    it('returns 400 when page is zero', async () => {
      const res = await GET(makeReq(`${BASE_URL}?page=0`))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/page/i)
    })

    it('returns 400 when page is negative', async () => {
      const res = await GET(makeReq(`${BASE_URL}?page=-1`))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/page/i)
    })

    it('accepts valid limit within range', async () => {
      const res = await GET(makeReq(`${BASE_URL}?limit=50`))
      expect(res.status).toBe(200)
    })

    it('accepts limit at boundary (1)', async () => {
      const res = await GET(makeReq(`${BASE_URL}?limit=1`))
      expect(res.status).toBe(200)
    })

    it('accepts limit at boundary (100)', async () => {
      const res = await GET(makeReq(`${BASE_URL}?limit=100`))
      expect(res.status).toBe(200)
    })
  })

  describe('Happy Path - Dead-Letter Deliveries', () => {
    it('returns 200 with empty list when no dead-letter deliveries exist', async () => {
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      const res = await GET(makeReq())
      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json.deliveries).toEqual([])
      expect(json.total).toBe(0)
      expect(json.page).toBe(1)
      expect(json.limit).toBe(50)
    })

    it('returns dead-letter deliveries with last-failure diagnostics', async () => {
      const mockDeliveries = [
        {
          id: 'delivery-1',
          webhookId: 'webhook-1',
          eventType: 'invoice.paid',
          payload: '{"invoiceId":"inv-1"}',
          status: 'dead',
          attemptCount: 5,
          lastAttemptAt: new Date('2026-09-20T12:00:00Z'),
          nextRetryAt: null,
          lastStatusCode: 500,
          lastError: 'Internal Server Error from target endpoint',
          createdAt: new Date('2026-09-20T10:00:00Z'),
          updatedAt: new Date('2026-09-20T12:00:00Z'),
        },
        {
          id: 'delivery-2',
          webhookId: 'webhook-2',
          eventType: 'invoice.overdue',
          payload: '{"invoiceId":"inv-2"}',
          status: 'dead_lettered',
          attemptCount: 5,
          lastAttemptAt: new Date('2026-09-19T15:30:00Z'),
          nextRetryAt: null,
          lastStatusCode: 503,
          lastError: 'Service Unavailable',
          createdAt: new Date('2026-09-19T13:00:00Z'),
          updatedAt: new Date('2026-09-19T15:30:00Z'),
        },
      ]

      db.webhookDelivery.findMany.mockResolvedValue(mockDeliveries)
      db.webhookDelivery.count.mockResolvedValue(2)

      const res = await GET(makeReq())
      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json.deliveries).toHaveLength(2)

      // Verify first delivery includes diagnostics
      expect(json.deliveries[0]).toEqual({
        id: 'delivery-1',
        webhookId: 'webhook-1',
        eventType: 'invoice.paid',
        payload: '{"invoiceId":"inv-1"}',
        status: 'dead',
        attemptCount: 5,
        lastAttemptAt: new Date('2026-09-20T12:00:00Z'),
        nextRetryAt: null,
        lastStatusCode: 500,
        lastError: 'Internal Server Error from target endpoint',
        createdAt: new Date('2026-09-20T10:00:00Z'),
        updatedAt: new Date('2026-09-20T12:00:00Z'),
      })

      // Verify second delivery includes diagnostics
      expect(json.deliveries[1]).toEqual({
        id: 'delivery-2',
        webhookId: 'webhook-2',
        eventType: 'invoice.overdue',
        payload: '{"invoiceId":"inv-2"}',
        status: 'dead_lettered',
        attemptCount: 5,
        lastAttemptAt: new Date('2026-09-19T15:30:00Z'),
        nextRetryAt: null,
        lastStatusCode: 503,
        lastError: 'Service Unavailable',
        createdAt: new Date('2026-09-19T13:00:00Z'),
        updatedAt: new Date('2026-09-19T15:30:00Z'),
      })

      expect(json.total).toBe(2)
      expect(json.page).toBe(1)
      expect(json.limit).toBe(50)
    })

    it('respects pagination limit and offset', async () => {
      const mockDeliveries = Array.from({ length: 10 }, (_, i) => ({
        id: `delivery-${i}`,
        webhookId: `webhook-${i}`,
        eventType: 'invoice.paid',
        payload: '{}',
        status: 'dead',
        attemptCount: 5,
        lastAttemptAt: new Date(),
        nextRetryAt: null,
        lastStatusCode: 500,
        lastError: 'Error',
        createdAt: new Date(),
        updatedAt: new Date(),
      }))

      db.webhookDelivery.findMany.mockResolvedValue(mockDeliveries.slice(0, 5))
      db.webhookDelivery.count.mockResolvedValue(10)

      const res = await GET(makeReq(`${BASE_URL}?limit=5&page=1`))
      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json.deliveries).toHaveLength(5)
      expect(json.total).toBe(10)
      expect(json.page).toBe(1)
      expect(json.limit).toBe(5)

      // Verify findMany was called with correct skip/take
      expect(db.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 5,
        })
      )
    })

    it('calculates correct offset for page 2', async () => {
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      await GET(makeReq(`${BASE_URL}?limit=20&page=2`))

      // Page 2 with limit 20 should skip 20 items (offset = (2-1)*20 = 20)
      expect(db.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 20,
        })
      )
    })

    it('uses default limit when not specified', async () => {
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      const res = await GET(makeReq())

      const json = await res.json()
      expect(json.limit).toBe(50)
    })

    it('uses default page 1 when not specified', async () => {
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      const res = await GET(makeReq())

      const json = await res.json()
      expect(json.page).toBe(1)
    })
  })

  describe('Exclusion - Still Retrying Deliveries', () => {
    it('excludes deliveries with future nextRetryAt', async () => {
      // These should NOT be returned since nextRetryAt is in the future
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      const res = await GET(makeReq())
      expect(res.status).toBe(200)

      // Verify the query filter excludes retrying deliveries by checking the where clause
      expect(db.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                nextRetryAt: null,
              }),
            ]),
          }),
        })
      )
    })

    it('excludes deliveries with attemptCount < 5 (still retrying)', async () => {
      // These are still retrying and should not appear in dead-letter list
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      await GET(makeReq())

      // Verify status filter excludes pending/retrying statuses
      expect(db.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                status: {
                  in: ['dead', 'dead_lettered'],
                },
              }),
            ]),
          }),
        })
      )
    })
  })

  describe('Exclusion - Succeeded Deliveries', () => {
    it('excludes deliveries with status "delivered"', async () => {
      // Successful deliveries should never appear in dead-letter list
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      await GET(makeReq())

      // Verify status filter only includes dead/dead_lettered
      expect(db.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                status: {
                  in: expect.not.arrayContaining(['delivered']),
                },
              }),
            ]),
          }),
        })
      )
    })

    it('excludes deliveries with status "success"', async () => {
      // Successful deliveries should never appear
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockResolvedValue(0)

      await GET(makeReq())

      // Verify status filter only includes dead/dead_lettered
      expect(db.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                status: {
                  in: expect.not.arrayContaining(['success']),
                },
              }),
            ]),
          }),
        })
      )
    })
  })

  describe('Boundary - Exactly at Retry Cap', () => {
    it('includes delivery at retry cap (attemptCount=5) with status dead', async () => {
      const boundaryDelivery = {
        id: 'boundary-1',
        webhookId: 'webhook-1',
        eventType: 'test.event',
        payload: '{}',
        status: 'dead',
        attemptCount: 5,
        lastAttemptAt: new Date('2026-09-20T12:00:00Z'),
        nextRetryAt: null,
        lastStatusCode: 500,
        lastError: 'Exhausted retry budget',
        createdAt: new Date('2026-09-20T10:00:00Z'),
        updatedAt: new Date('2026-09-20T12:00:00Z'),
      }

      db.webhookDelivery.findMany.mockResolvedValue([boundaryDelivery])
      db.webhookDelivery.count.mockResolvedValue(1)

      const res = await GET(makeReq())
      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json.deliveries).toHaveLength(1)
      expect(json.deliveries[0].attemptCount).toBe(5)
      expect(json.deliveries[0].nextRetryAt).toBeNull()
      expect(json.deliveries[0].status).toBe('dead')
    })

    it('includes delivery with status dead_lettered at cap', async () => {
      const boundaryDelivery = {
        id: 'boundary-2',
        webhookId: 'webhook-2',
        eventType: 'test.event',
        payload: '{}',
        status: 'dead_lettered',
        attemptCount: 5,
        lastAttemptAt: new Date(),
        nextRetryAt: null,
        lastStatusCode: 502,
        lastError: 'Bad Gateway',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      db.webhookDelivery.findMany.mockResolvedValue([boundaryDelivery])
      db.webhookDelivery.count.mockResolvedValue(1)

      const res = await GET(makeReq())
      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json.deliveries).toHaveLength(1)
      expect(json.deliveries[0].status).toBe('dead_lettered')
      expect(json.deliveries[0].nextRetryAt).toBeNull()
    })
  })

  describe('Error Handling', () => {
    it('returns 500 on database query failure', async () => {
      db.webhookDelivery.findMany.mockRejectedValue(new Error('Database connection failed'))
      const res = await GET(makeReq())
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toBe('Failed to fetch dead-letter deliveries')
    })

    it('returns 500 on count failure', async () => {
      db.webhookDelivery.findMany.mockResolvedValue([])
      db.webhookDelivery.count.mockRejectedValue(new Error('Count query failed'))
      const res = await GET(makeReq())
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toBe('Failed to fetch dead-letter deliveries')
    })

    it('returns 500 on verification error', async () => {
      mockVerify.mockRejectedValue(new Error('Auth service down'))
      const res = await GET(makeReq())
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toBe('Failed to fetch dead-letter deliveries')
    })
  })

  describe('Response Format', () => {
    it('returns all required fields in response', async () => {
      const mockDelivery = {
        id: 'delivery-1',
        webhookId: 'webhook-1',
        eventType: 'invoice.paid',
        payload: '{"test": "data"}',
        status: 'dead',
        attemptCount: 5,
        lastAttemptAt: new Date('2026-09-20T12:00:00Z'),
        nextRetryAt: null,
        lastStatusCode: 500,
        lastError: 'Test error message',
        createdAt: new Date('2026-09-20T10:00:00Z'),
        updatedAt: new Date('2026-09-20T12:00:00Z'),
      }

      db.webhookDelivery.findMany.mockResolvedValue([mockDelivery])
      db.webhookDelivery.count.mockResolvedValue(1)

      const res = await GET(makeReq())
      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json).toHaveProperty('deliveries')
      expect(json).toHaveProperty('total')
      expect(json).toHaveProperty('page')
      expect(json).toHaveProperty('limit')

      const delivery = json.deliveries[0]
      expect(delivery).toHaveProperty('id')
      expect(delivery).toHaveProperty('webhookId')
      expect(delivery).toHaveProperty('eventType')
      expect(delivery).toHaveProperty('payload')
      expect(delivery).toHaveProperty('status')
      expect(delivery).toHaveProperty('attemptCount')
      expect(delivery).toHaveProperty('lastAttemptAt')
      expect(delivery).toHaveProperty('nextRetryAt')
      expect(delivery).toHaveProperty('lastStatusCode')
      expect(delivery).toHaveProperty('lastError')
      expect(delivery).toHaveProperty('createdAt')
      expect(delivery).toHaveProperty('updatedAt')
    })
  })
})

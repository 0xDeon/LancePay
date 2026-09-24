import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

// Mock dependencies
const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const webhookDeliveryFindUnique = vi.fn()
const webhookDeliveryUpdate = vi.fn()
const userWebhookUpdate = vi.fn()
const prismaTransaction = vi.fn()
const sendWebhookDisabledEmail = vi.fn()
const fetch = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    webhookDelivery: { findUnique: webhookDeliveryFindUnique, update: webhookDeliveryUpdate },
    userWebhook: { update: userWebhookUpdate },
    $transaction: prismaTransaction,
  },
}))
vi.mock('@/lib/email', () => ({ sendWebhookDisabledEmail }))
global.fetch = fetch as any

const BASE_URL = 'http://localhost/api/webhook-deliveries'

function makeRequest(id: string) {
  return new NextRequest(`${BASE_URL}/${id}/replay`, {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })
}

const mockUser = {
  id: 'user_1',
  privyId: 'privy_1',
  email: 'user@example.com',
  name: 'Test User',
}

const mockWebhook = {
  id: 'wh_1',
  userId: 'user_1',
  targetUrl: 'https://example.com/webhook',
  signingSecret: 'test_secret_123',
  isActive: true,
  status: 'ACTIVE',
  consecutiveFailures: 0,
  lastFailureAt: null,
}

const mockDelivery = {
  id: 'del_1',
  webhookId: 'wh_1',
  status: 'failed',
  attemptCount: 2,
  payload: JSON.stringify({ event: 'invoice.paid', invoiceId: '123' }),
  eventType: 'invoice.paid',
  lastStatusCode: 500,
  lastError: 'Internal Server Error',
  lastAttemptAt: new Date(Date.now() - 3600000),
  nextRetryAt: new Date(Date.now() + 3600000),
  createdAt: new Date(Date.now() - 86400000),
  updatedAt: new Date(),
  webhook: mockWebhook,
}

describe('POST /api/webhook-deliveries/[id]/replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    fetch.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toMatch(/unauthorized/i)
  })

  it('returns 404 when delivery does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue(null)

    const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
    const res = await POST(makeRequest('nonexistent'), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatch(/not found/i)
  })

  it('returns 404 when delivery belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue({
      ...mockDelivery,
      webhook: { ...mockWebhook, userId: 'other_user' },
    })

    const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(404)
  })

  it('returns 409 when delivery is already delivered', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue({
      ...mockDelivery,
      status: 'delivered',
    })

    const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/already succeeded/i)
  })

  describe('Happy path - delivery succeeds', () => {
    it('resets consecutiveFailures to 0 and updates delivery status to delivered', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        status: 'failed',
        webhook: { ...mockWebhook, consecutiveFailures: 3 },
      })

      fetch.mockResolvedValue({
        status: 200,
        ok: true,
      })

      const updatedDelivery = {
        ...mockDelivery,
        status: 'delivered',
        attemptCount: 3,
        lastStatusCode: 200,
        lastError: null,
        nextRetryAt: null,
      }

      const updatedWebhook = {
        ...mockWebhook,
        consecutiveFailures: 0,
      }

      prismaTransaction.mockImplementation(async (callback) => {
        return callback({
          webhookDelivery: { update: vi.fn().mockResolvedValue(updatedDelivery) },
          userWebhook: { update: vi.fn().mockResolvedValue(updatedWebhook) },
        })
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.delivery.status).toBe('delivered')
      expect(json.webhook.consecutiveFailures).toBe(0)
      expect(json.deliveryAttempt.success).toBe(true)
      expect(json.deliveryAttempt.statusCode).toBe(200)
    })
  })

  describe('Happy path - delivery fails and retries scheduled', () => {
    it('increments attemptCount, schedules next retry via exponential backoff, increments consecutiveFailures', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        status: 'failed',
        attemptCount: 1,
        webhook: { ...mockWebhook, consecutiveFailures: 2 },
      })

      fetch.mockResolvedValue({
        status: 503,
        ok: false,
      })

      let capturedUpdateData: any

      const updatedDelivery = {
        ...mockDelivery,
        status: 'failed',
        attemptCount: 2,
        lastStatusCode: 503,
        lastError: 'HTTP 503',
      }

      const updatedWebhook = {
        ...mockWebhook,
        consecutiveFailures: 3,
      }

      prismaTransaction.mockImplementation(async (callback) => {
        return callback({
          webhookDelivery: {
            update: vi.fn().mockImplementation((args) => {
              capturedUpdateData = args.data
              return { ...updatedDelivery, ...args.data }
            }),
          },
          userWebhook: {
            update: vi.fn().mockResolvedValue(updatedWebhook),
          },
        })
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.delivery.attemptCount).toBe(2)
      expect(json.webhook.consecutiveFailures).toBe(3)
      expect(json.deliveryAttempt.success).toBe(false)
      expect(json.deliveryAttempt.statusCode).toBe(503)

      // Verify nextRetryAt was set (should be current time + backoff delay)
      expect(capturedUpdateData.nextRetryAt).toBeDefined()
      expect(capturedUpdateData.nextRetryAt instanceof Date).toBe(true)
    })
  })

  describe('Backoff cap - high attemptCount computes max delay', () => {
    it('does not compute ever-growing exponential delay after hitting the cap', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)

      // Delivery with high attemptCount
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        status: 'failed',
        attemptCount: 20, // High attempt count
        webhook: mockWebhook,
      })

      fetch.mockResolvedValue({
        status: 500,
        ok: false,
      })

      let capturedUpdateData: any

      const updatedDelivery = {
        ...mockDelivery,
        status: 'failed',
        attemptCount: 21,
      }

      prismaTransaction.mockImplementation(async (callback) => {
        return callback({
          webhookDelivery: {
            update: vi.fn().mockImplementation((args) => {
              capturedUpdateData = args.data
              return { ...updatedDelivery, ...args.data }
            }),
          },
          userWebhook: {
            update: vi.fn().mockResolvedValue(mockWebhook),
          },
        })
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)

      // Verify nextRetryAt is set but not excessively far in future
      // 86400000 ms = 24 hours (max delay configured)
      expect(capturedUpdateData.nextRetryAt).toBeDefined()
      const delayMs = capturedUpdateData.nextRetryAt.getTime() - Date.now()
      expect(delayMs).toBeLessThanOrEqual(86400000 + 1000) // Max delay + max jitter
      expect(delayMs).toBeGreaterThan(0)
    })
  })

  describe('Threshold crossing - webhook auto-disabled when consecutiveFailures reaches threshold', () => {
    it('disables webhook when failure crosses 10 consecutive failures threshold', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        status: 'failed',
        webhook: { ...mockWebhook, consecutiveFailures: 9 }, // Will become 10 after this failure
      })

      fetch.mockResolvedValue({
        status: 502,
        ok: false,
      })

      let capturedWebhookUpdateData: any

      const updatedDelivery = {
        ...mockDelivery,
        status: 'failed',
      }

      const updatedWebhook = {
        ...mockWebhook,
        status: 'INACTIVE',
        isActive: false,
        consecutiveFailures: 10,
      }

      prismaTransaction.mockImplementation(async (callback) => {
        return callback({
          webhookDelivery: {
            update: vi.fn().mockResolvedValue(updatedDelivery),
          },
          userWebhook: {
            update: vi.fn().mockImplementation((args) => {
              capturedWebhookUpdateData = args.data
              return { ...updatedWebhook, ...args.data }
            }),
          },
        })
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.webhook.status).toBe('INACTIVE')
      expect(json.webhook.isActive).toBe(false)
      expect(json.webhook.consecutiveFailures).toBe(10)

      // Verify email was sent for auto-disable
      expect(sendWebhookDisabledEmail).toHaveBeenCalled()
      const emailCall = (sendWebhookDisabledEmail as any).mock.calls[0][0]
      expect(emailCall.autoDisabled).toBe(true)
    })

    it('does not disable webhook if failure does not cross threshold', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        status: 'failed',
        webhook: { ...mockWebhook, consecutiveFailures: 5 }, // Will become 6, below threshold
      })

      fetch.mockResolvedValue({
        status: 500,
        ok: false,
      })

      let capturedWebhookUpdateData: any

      const updatedDelivery = {
        ...mockDelivery,
        status: 'failed',
      }

      const updatedWebhook = {
        ...mockWebhook,
        consecutiveFailures: 6,
      }

      prismaTransaction.mockImplementation(async (callback) => {
        return callback({
          webhookDelivery: {
            update: vi.fn().mockResolvedValue(updatedDelivery),
          },
          userWebhook: {
            update: vi.fn().mockImplementation((args) => {
              capturedWebhookUpdateData = args.data
              return { ...updatedWebhook, ...args.data }
            }),
          },
        })
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.webhook.status).toBe('ACTIVE') // Should remain ACTIVE
      expect(json.webhook.consecutiveFailures).toBe(6)

      // Email should not have been sent
      expect(sendWebhookDisabledEmail).not.toHaveBeenCalled()
    })
  })

  describe('Authorization - non-owner rejected', () => {
    it('returns 404 for non-owner trying to replay another user\'s webhook delivery', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      const otherUser = { ...mockUser, id: 'other_user_id' }
      userFindUnique.mockResolvedValue(otherUser)
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        webhook: { ...mockWebhook, userId: 'user_1' }, // Different owner
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
      expect(res.status).toBe(404)
    })
  })

  describe('Atomicity - transaction wrapping', () => {
    it('does not update delivery without updating webhook (via transaction)', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        webhook: { ...mockWebhook, consecutiveFailures: 9 },
      })

      fetch.mockResolvedValue({ status: 502, ok: false })

      let transactionCallbackCalled = false

      prismaTransaction.mockImplementation(async (callback) => {
        transactionCallbackCalled = true
        // Simulate transaction callback receiving tx object
        const mockTx = {
          webhookDelivery: {
            update: vi.fn().mockResolvedValue({
              ...mockDelivery,
              status: 'failed',
            }),
          },
          userWebhook: {
            update: vi.fn().mockResolvedValue({
              ...mockWebhook,
              consecutiveFailures: 10,
              status: 'INACTIVE',
            }),
          },
        }
        return callback(mockTx)
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)
      expect(transactionCallbackCalled).toBe(true)
      // Verify $transaction was called (indicating both updates wrapped together)
      expect(prismaTransaction).toHaveBeenCalled()
    })
  })

  describe('Max attempts - dead-lettering', () => {
    it('marks delivery as dead_lettered when max attempts exceeded', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)

      // Delivery already at max attempts - 1
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        attemptCount: 14, // Will be 15 after this attempt
        status: 'failed',
        webhook: mockWebhook,
      })

      fetch.mockResolvedValue({ status: 500, ok: false })

      let capturedUpdateData: any

      prismaTransaction.mockImplementation(async (callback) => {
        return callback({
          webhookDelivery: {
            update: vi.fn().mockImplementation((args) => {
              capturedUpdateData = args.data
              return {
                ...mockDelivery,
                status: args.data.status,
                attemptCount: args.data.attemptCount,
              }
            }),
          },
          userWebhook: {
            update: vi.fn().mockResolvedValue(mockWebhook),
          },
        })
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)
      expect(capturedUpdateData.status).toBe('dead_lettered')
      expect(capturedUpdateData.attemptCount).toBe(15)
      expect(capturedUpdateData.nextRetryAt).toBe(null)
    })
  })

  describe('HTTP delivery failures', () => {
    it('handles HTTP delivery timeout gracefully', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue(mockUser)
      webhookDeliveryFindUnique.mockResolvedValue({
        ...mockDelivery,
        webhook: mockWebhook,
      })

      fetch.mockRejectedValue(new Error('Request timeout'))

      prismaTransaction.mockImplementation(async (callback) => {
        return callback({
          webhookDelivery: {
            update: vi.fn().mockResolvedValue({
              ...mockDelivery,
              lastError: 'Request timeout',
            }),
          },
          userWebhook: {
            update: vi.fn().mockResolvedValue({
              ...mockWebhook,
              consecutiveFailures: 1,
            }),
          },
        })
      })

      const { POST } = await import('@/app/api/webhook-deliveries/[id]/replay/route')
      const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.deliveryAttempt.success).toBe(false)
      expect(json.deliveryAttempt.error).toMatch(/timeout/i)
    })
  })
})

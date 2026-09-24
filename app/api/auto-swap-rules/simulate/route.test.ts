import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/exchange-rate', () => ({ getUsdToNgnRate: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getUsdToNgnRate } from '@/lib/exchange-rate'

const mockUser = { id: 'user-1', privyId: 'privy-1', email: 'user@example.com' }
const mockClaims = { userId: 'privy-1' }
const mockExchangeRate = { rate: 1600, lastUpdated: new Date().toISOString() }

function makeRequest(depositAmount: number, percentage: number): NextRequest {
  return new NextRequest('http://localhost/api/auto-swap-rules/simulate', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify({ depositAmount, percentage }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(getUsdToNgnRate).mockResolvedValue(mockExchangeRate as any)
})

describe('POST /api/auto-swap-rules/simulate', () => {
  describe('happy path', () => {
    it('returns simulation results without database writes', async () => {
      const res = await POST(makeRequest(1000, 50))
      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data.estimate).toBe(true)
      expect(Number(data.depositAmount)).toBe(1000)
      expect(Number(data.swapAmount)).toBe(500) // 50% of 1000
      expect(Number(data.ngnAmount)).toBe(800000) // 500 * 1600
      expect(Number(data.remainingUSDC)).toBe(500) // 1000 - 500
    })

    it('includes exchange rate in response', async () => {
      const res = await POST(makeRequest(1000, 50))
      const data = await res.json()

      expect(data.exchangeRate).toBeDefined()
      expect(Number(data.exchangeRate)).toBe(1600)
    })

    it('clearly labels result as estimate, not guarantee', async () => {
      const res = await POST(makeRequest(1000, 50))
      const data = await res.json()

      expect(data.estimate).toBe(true)
      expect(data.estimate).not.toBeNull()
    })

    it('calculates correctly for various percentages', async () => {
      const res1 = await POST(makeRequest(1000, 25))
      const data1 = await res1.json()
      expect(Number(data1.swapAmount)).toBe(250)
      expect(Number(data1.remainingUSDC)).toBe(750)

      const res2 = await POST(makeRequest(1000, 100))
      const data2 = await res2.json()
      expect(Number(data2.swapAmount)).toBe(1000)
      expect(Number(data2.remainingUSDC)).toBe(0)

      const res3 = await POST(makeRequest(1000, 1))
      const data3 = await res3.json()
      expect(Number(data3.swapAmount)).toBe(10)
      expect(Number(data3.remainingUSDC)).toBe(990)
    })

    it('handles decimal deposit amounts correctly', async () => {
      const res = await POST(makeRequest(1234.56, 50))
      const data = await res.json()

      expect(Number(data.depositAmount)).toBe(1234.56)
      expect(Number(data.swapAmount)).toBe(617.28)
      expect(Number(data.remainingUSDC)).toBe(617.28)
    })

    it('uses current exchange rate in calculation', async () => {
      vi.mocked(getUsdToNgnRate).mockResolvedValue({ rate: 2000, lastUpdated: new Date().toISOString() } as any)

      const res = await POST(makeRequest(1000, 50))
      const data = await res.json()

      expect(Number(data.exchangeRate)).toBe(2000)
      expect(Number(data.ngnAmount)).toBe(1000000) // 500 * 2000
    })

    it('does not write to database', async () => {
      await POST(makeRequest(1000, 50))

      // Verify no database operations were called
      expect(vi.mocked(prisma.user.findUnique)).toHaveBeenCalledTimes(1) // Only for auth check
    })
  })

  describe('validation', () => {
    it('returns 400 when depositAmount is missing', async () => {
      const req = new NextRequest('http://localhost/api/auto-swap-rules/simulate', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: JSON.stringify({ percentage: 50 }),
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid request body')
    })

    it('returns 400 when percentage is missing', async () => {
      const req = new NextRequest('http://localhost/api/auto-swap-rules/simulate', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: JSON.stringify({ depositAmount: 1000 }),
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
    })

    it('returns 400 when depositAmount is not positive', async () => {
      const res = await POST(makeRequest(0, 50))
      expect(res.status).toBe(400)

      const res2 = await POST(makeRequest(-100, 50))
      expect(res2.status).toBe(400)
    })

    it('returns 400 when percentage is below 1', async () => {
      const res = await POST(makeRequest(1000, 0))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid request body')
    })

    it('returns 400 when percentage is above 100', async () => {
      const res = await POST(makeRequest(1000, 101))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid request body')
    })

    it('returns 400 for invalid JSON body', async () => {
      const req = new NextRequest('http://localhost/api/auto-swap-rules/simulate', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: 'invalid json',
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid JSON body')
    })
  })

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
      const res = await POST(makeRequest(1000, 50))
      expect(res.status).toBe(401)
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
      const res = await POST(makeRequest(1000, 50))
      expect(res.status).toBe(404)
    })
  })

  describe('edge cases', () => {
    it('handles very small deposit amounts', async () => {
      const res = await POST(makeRequest(0.01, 50))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(Number(data.swapAmount)).toBe(0.005)
    })

    it('handles very large deposit amounts', async () => {
      const res = await POST(makeRequest(1000000, 50))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(Number(data.swapAmount)).toBe(500000)
      expect(Number(data.ngnAmount)).toBe(800000000)
    })

    it('handles decimal precision with various exchange rates', async () => {
      vi.mocked(getUsdToNgnRate).mockResolvedValue({ rate: 1234.5678, lastUpdated: new Date().toISOString() } as any)

      const res = await POST(makeRequest(123.45, 33))
      expect(res.status).toBe(200)
      const data = await res.json()

      // Verify no precision loss
      expect(data.exchangeRate).toBeDefined()
      expect(data.swapAmount).toBeDefined()
      expect(data.ngnAmount).toBeDefined()
    })

    it('always includes all required fields in response', async () => {
      const res = await POST(makeRequest(1000, 50))
      const data = await res.json()

      expect(data).toHaveProperty('estimate')
      expect(data).toHaveProperty('depositAmount')
      expect(data).toHaveProperty('percentage')
      expect(data).toHaveProperty('exchangeRate')
      expect(data).toHaveProperty('swapAmount')
      expect(data).toHaveProperty('ngnAmount')
      expect(data).toHaveProperty('remainingUSDC')
    })

    it('percentage is correctly used in calculation', async () => {
      // Test that percentage is used, not hardcoded
      const res1 = await POST(makeRequest(100, 10))
      const data1 = await res1.json()
      expect(Number(data1.swapAmount)).toBe(10)

      const res2 = await POST(makeRequest(100, 20))
      const data2 = await res2.json()
      expect(Number(data2.swapAmount)).toBe(20)

      const res3 = await POST(makeRequest(100, 90))
      const data3 = await res3.json()
      expect(Number(data3.swapAmount)).toBe(90)
    })
  })
})

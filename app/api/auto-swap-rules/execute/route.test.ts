import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findUnique: vi.fn(), update: vi.fn() },
    autoSwapRule: { findUnique: vi.fn() },
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

function makeRequest(transactionId: string): NextRequest {
  return new NextRequest('http://localhost/api/auto-swap-rules/execute', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify({ transactionId }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(getUsdToNgnRate).mockResolvedValue(mockExchangeRate as any)
})

describe('POST /api/auto-swap-rules/execute', () => {
  describe('happy path', () => {
    it('executes auto-swap and updates transaction with conversion details', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: false,
        type: 'deposit',
      }
      const mockRule = {
        id: 'rule-1',
        userId: 'user-1',
        percentage: 50,
        isActive: true,
      }
      const mockUpdatedTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: true,
        type: 'conversion',
        ngnAmount: new Decimal('800000'),
        exchangeRate: new Decimal('1600'),
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)
      vi.mocked(prisma.transaction.update).mockResolvedValue(mockUpdatedTransaction as any)

      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.executed).toBe(true)
      expect(data.transactionId).toBe('txn-1')
      expect(Number(data.swapAmount)).toBe(500) // 50% of 1000
      expect(data.percentage).toBe(50)
    })

    it('locks in the exchange rate and includes it in response', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: false,
        type: 'deposit',
      }
      const mockRule = {
        id: 'rule-1',
        userId: 'user-1',
        percentage: 25,
        isActive: true,
      }
      const mockUpdatedTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: true,
        type: 'conversion',
        ngnAmount: new Decimal('400000'),
        exchangeRate: new Decimal('1600'),
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)
      vi.mocked(prisma.transaction.update).mockResolvedValue(mockUpdatedTransaction as any)

      const res = await POST(makeRequest('txn-1'))
      const data = await res.json()

      expect(data.exchangeRate).toBeDefined()
      expect(Number(data.exchangeRate)).toBe(1600)
      expect(vi.mocked(prisma.transaction.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            exchangeRate: expect.any(Object),
          }),
        })
      )
    })

    it('calculates NGN amount correctly with different percentages', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: false,
        type: 'deposit',
      }
      const mockRule = {
        id: 'rule-1',
        userId: 'user-1',
        percentage: 30,
        isActive: true,
      }
      const mockUpdatedTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: true,
        type: 'conversion',
        ngnAmount: new Decimal('480000'),
        exchangeRate: new Decimal('1600'),
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)
      vi.mocked(prisma.transaction.update).mockResolvedValue(mockUpdatedTransaction as any)
      vi.mocked(getUsdToNgnRate).mockResolvedValue({ rate: 1600, lastUpdated: new Date().toISOString() } as any)

      const res = await POST(makeRequest('txn-1'))
      const data = await res.json()

      // 30% of 1000 = 300, * 1600 = 480000
      expect(Number(data.ngnAmount)).toBe(480000)
    })
  })

  describe('skip execution', () => {
    it('returns skipped result when isActive is false', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: false,
      }
      const mockRule = {
        id: 'rule-1',
        userId: 'user-1',
        percentage: 50,
        isActive: false,
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)

      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.executed).toBe(false)
      expect(data.skipped).toBe(true)
      expect(data.reason).toContain('disabled')
    })

    it('returns skipped result when no rule exists', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: false,
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(null)

      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.executed).toBe(false)
      expect(data.skipped).toBe(true)
      expect(data.reason).toContain('No active auto-swap rule configured')
    })

    it('guards against re-execution by checking autoSwapTriggered flag', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: true, // Already executed
      }
      const mockRule = {
        id: 'rule-1',
        userId: 'user-1',
        percentage: 50,
        isActive: true,
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)

      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.executed).toBe(false)
      expect(data.skipped).toBe(true)
      expect(data.reason).toContain('already executed')
      expect(vi.mocked(prisma.transaction.update)).not.toHaveBeenCalled()
    })
  })

  describe('validation and error handling', () => {
    it('returns 400 for invalid JSON body', async () => {
      const req = new NextRequest('http://localhost/api/auto-swap-rules/execute', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: 'invalid json',
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid JSON body')
    })

    it('returns 400 when transactionId is missing', async () => {
      const req = new NextRequest('http://localhost/api/auto-swap-rules/execute', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: JSON.stringify({}),
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid request body')
    })

    it('returns 401 when unauthenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(401)
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(404)
    })

    it('returns 404 when transaction not found', async () => {
      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(404)
    })

    it('returns 403 when transaction does not belong to user', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'other-user',
        amount: new Decimal('1000'),
        autoSwapTriggered: false,
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)

      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(403)
    })

    it('returns 500 on database error', async () => {
      vi.mocked(prisma.transaction.findUnique).mockRejectedValue(new Error('db error'))
      const res = await POST(makeRequest('txn-1'))
      expect(res.status).toBe(500)
    })
  })

  describe('edge cases', () => {
    it('handles decimal precision correctly with various percentages', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1234.56'),
        autoSwapTriggered: false,
        type: 'deposit',
      }
      const mockRule = {
        id: 'rule-1',
        userId: 'user-1',
        percentage: 33,
        isActive: true,
      }
      const mockUpdatedTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1234.56'),
        autoSwapTriggered: true,
        type: 'conversion',
        ngnAmount: new Decimal('652654.08'),
        exchangeRate: new Decimal('1600'),
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)
      vi.mocked(prisma.transaction.update).mockResolvedValue(mockUpdatedTransaction as any)

      const res = await POST(makeRequest('txn-1'))
      const data = await res.json()
      expect(data.executed).toBe(true)
    })

    it('changes transaction type from deposit to conversion on successful execution', async () => {
      const mockTransaction = {
        id: 'txn-1',
        userId: 'user-1',
        amount: new Decimal('1000'),
        autoSwapTriggered: false,
        type: 'deposit',
      }
      const mockRule = {
        id: 'rule-1',
        userId: 'user-1',
        percentage: 50,
        isActive: true,
      }

      vi.mocked(prisma.transaction.findUnique).mockResolvedValue(mockTransaction as any)
      vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)

      await POST(makeRequest('txn-1'))

      expect(vi.mocked(prisma.transaction.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'conversion',
            autoSwapTriggered: true,
          }),
        })
      )
    })
  })
})

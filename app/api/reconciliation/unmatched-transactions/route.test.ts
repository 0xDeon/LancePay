import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { findMany: transactionFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function makeRequest(query = '', token: string | null = 'token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(
    `http://localhost/api/reconciliation/unmatched-transactions${query}`,
    { headers },
  )
}

describe('GET /api/reconciliation/unmatched-transactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy-admin' })
    userFindUnique.mockResolvedValue({ id: 'admin-1', role: 'admin' })
    transactionFindMany.mockResolvedValue([])
  })

  it('lists unmatched transactions and distinguishes both failure reasons', async () => {
    transactionFindMany.mockResolvedValue([
      {
        id: 'tx-amount',
        userId: 'user-1',
        type: 'payment',
        status: 'completed',
        amount: { toString: () => '105.00' },
        currency: 'USDC',
        externalId: 'external-1',
        txHash: 'hash-1',
        createdAt: new Date('2026-09-20T12:00:00Z'),
        reconciliationReason: 'amount_mismatch',
        reconciliationAttemptedAt: new Date('2026-09-20T12:05:00Z'),
      },
      {
        id: 'tx-none',
        userId: 'user-2',
        type: 'payment',
        status: 'completed',
        amount: { toString: () => '50.00' },
        currency: 'USDC',
        externalId: 'external-2',
        txHash: 'hash-2',
        createdAt: new Date('2026-09-19T12:00:00Z'),
        reconciliationReason: 'no_candidate',
        reconciliationAttemptedAt: new Date('2026-09-19T12:05:00Z'),
      },
    ])

    const { GET } = await import('./route')
    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.summary).toEqual({ total: 2, amountMismatch: 1, noCandidate: 1 })
    expect(body.unmatchedTransactions).toEqual([
      expect.objectContaining({ id: 'tx-amount', unmatchedReason: 'amount_mismatch' }),
      expect.objectContaining({ id: 'tx-none', unmatchedReason: 'no_candidate' }),
    ])
    expect(transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ reconciliationStatus: 'unmatched' }),
        orderBy: { createdAt: 'desc' },
      }),
    )
  })

  it('applies an inclusive date range', async () => {
    const { GET } = await import('./route')
    const response = await GET(makeRequest('?from=2026-09-01&to=2026-09-24'))

    expect(response.status).toBe(200)
    expect(transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-09-01T00:00:00.000Z'),
            lte: new Date('2026-09-24T23:59:59.999Z'),
          },
        }),
      }),
    )
  })

  it('rejects an invalid or reversed date range', async () => {
    const { GET } = await import('./route')

    const invalidResponse = await GET(makeRequest('?from=not-a-date'))
    const reversedResponse = await GET(makeRequest('?from=2026-09-25&to=2026-09-24'))

    expect(invalidResponse.status).toBe(400)
    expect(reversedResponse.status).toBe(400)
    expect(transactionFindMany).not.toHaveBeenCalled()
  })

  it('rejects callers outside admin and finance roles', async () => {
    userFindUnique.mockResolvedValue({ id: 'user-1', role: 'freelancer' })

    const { GET } = await import('./route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(403)
    expect(transactionFindMany).not.toHaveBeenCalled()
  })

  it('returns 401 without authentication', async () => {
    const { GET } = await import('./route')
    const response = await GET(makeRequest('', null))

    expect(response.status).toBe(401)
  })

  it('returns 500 when the database query fails', async () => {
    transactionFindMany.mockRejectedValue(new Error('database unavailable'))

    const { GET } = await import('./route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(500)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    journalEntry: { findMany: vi.fn() },
    fxRateSnapshot: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function request(query = '') {
  return new NextRequest(`http://localhost/api/ledger/multi-currency-trial-balance${query}`, {
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as any)
  vi.mocked(prisma.journalEntry.findMany).mockResolvedValue([])
})

describe('GET /api/ledger/multi-currency-trial-balance', () => {
  it('normalizes USDC and NGN entries with the latest persisted rate', async () => {
    vi.mocked(prisma.journalEntry.findMany).mockResolvedValue([
      { debitAccount: 'cash', creditAccount: 'revenue', amount: 100, currency: 'USDC' },
      { debitAccount: 'cash', creditAccount: 'revenue', amount: 160000, currency: 'NGN' },
    ] as any)
    vi.mocked(prisma.fxRateSnapshot.findFirst).mockResolvedValue({
      rate: 0.000625,
      source: 'exchange-rate-poller',
      capturedAt: new Date('2026-09-01T00:00:00Z'),
    } as any)

    const response = await GET(request('?asOf=2026-09-02T00:00:00Z'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.totalDebits).toBe(200)
    expect(body.totalCredits).toBe(200)
    expect(body.rateSource.source).toBe('exchange-rate-poller')
    expect(body.discrepancies).toEqual(['cash', 'revenue'])
    expect(prisma.journalEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ date: { lte: new Date('2026-09-02T00:00:00Z') } }),
    }))
  })

  it('uses the inverse of the available currency pair', async () => {
    vi.mocked(prisma.journalEntry.findMany).mockResolvedValue([
      { debitAccount: 'cash', creditAccount: 'revenue', amount: 1600, currency: 'NGN' },
    ] as any)
    vi.mocked(prisma.fxRateSnapshot.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ rate: 1600, source: 'manual', capturedAt: new Date() } as any)

    const body = await (await GET(request())).json()
    expect(body.totalDebits).toBe(1)
    expect(body.rateSource.inverted).toBe(true)
  })

  it('returns 422 when conversion is needed but no as-of rate exists', async () => {
    vi.mocked(prisma.journalEntry.findMany).mockResolvedValue([
      { debitAccount: 'cash', creditAccount: 'revenue', amount: 1600, currency: 'NGN' },
    ] as any)
    vi.mocked(prisma.fxRateSnapshot.findFirst).mockResolvedValue(null)

    expect((await GET(request())).status).toBe(422)
  })

  it('rejects invalid as-of dates and reporting currencies', async () => {
    expect((await GET(request('?asOf=not-a-date'))).status).toBe(400)
    expect((await GET(request('?reportingCurrency=EUR'))).status).toBe(400)
  })

  it('returns authentication and database failures using route conventions', async () => {
    expect((await GET(new NextRequest('http://localhost/api/ledger/multi-currency-trial-balance'))).status).toBe(401)
    vi.mocked(prisma.journalEntry.findMany).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})

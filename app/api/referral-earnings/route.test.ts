import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    referralEarning: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const earnings = [
  {
    id: 'e-1',
    referrerId: 'user-1',
    referredUserId: 'user-2',
    invoiceId: 'inv-1',
    amountUsdc: '25.000000',
    platformFee: '2.500000',
    status: 'earned',
    createdAt: new Date('2026-08-01T00:00:00Z'),
  },
  {
    id: 'e-2',
    referrerId: 'user-1',
    referredUserId: 'user-3',
    invoiceId: 'inv-2',
    amountUsdc: '10.000000',
    platformFee: '1.000000',
    status: 'paid',
    createdAt: new Date('2026-08-02T00:00:00Z'),
  },
]

const grouped = [
  { status: 'earned', _count: { status: 2 }, _sum: { amountUsdc: '50.000000', platformFee: '5.000000' } },
  { status: 'paid', _count: { status: 1 }, _sum: { amountUsdc: '10.000000', platformFee: '1.000000' } },
  { status: 'clawed_back', _count: { status: 1 }, _sum: { amountUsdc: '5.000000', platformFee: '0.500000' } },
]

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.referralEarning.count).mockResolvedValue(4)
  vi.mocked(prisma.referralEarning.groupBy).mockResolvedValue(grouped as any)
  vi.mocked(prisma.referralEarning.findMany).mockResolvedValue(earnings as any)
})

describe('GET /api/referral-earnings', () => {
  it('returns earnings restricted to the caller as referrer', async () => {
    const res = await GET(makeRequest('http://localhost/api/referral-earnings'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.earnings).toHaveLength(2)
    const where = vi.mocked(prisma.referralEarning.findMany).mock.calls[0][0].where
    expect(where).toEqual({ referrerId: 'user-1' })
    const countWhere = vi.mocked(prisma.referralEarning.count).mock.calls[0][0].where
    expect(countWhere).toEqual({ referrerId: 'user-1' })
    const groupWhere = vi.mocked(prisma.referralEarning.groupBy).mock.calls[0][0].where
    expect(groupWhere).toEqual({ referrerId: 'user-1' })
  })

  it('groups totals by earned, paid and clawed_back', async () => {
    const res = await GET(makeRequest('http://localhost/api/referral-earnings'))
    const data = await res.json()

    expect(data.totals.earned.count).toBe(2)
    expect(data.totals.earned.amountUsdc).toBe('50.000000')
    expect(data.totals.paid.count).toBe(1)
    expect(data.totals.clawed_back.count).toBe(1)
  })

  it('returns zeroed totals for statuses with no rows', async () => {
    vi.mocked(prisma.referralEarning.groupBy).mockResolvedValue([grouped[1]] as any)
    const res = await GET(makeRequest('http://localhost/api/referral-earnings'))
    const data = await res.json()

    expect(data.totals.earned.count).toBe(0)
    expect(data.totals.paid.count).toBe(1)
    expect(data.totals.clawed_back.count).toBe(0)
  })

  it('supports pagination with defaults', async () => {
    const res = await GET(makeRequest('http://localhost/api/referral-earnings'))
    const data = await res.json()

    expect(data.pagination).toEqual({ page: 1, pageSize: 25, totalRows: 4, totalPages: 1 })
    const findManyArgs = vi.mocked(prisma.referralEarning.findMany).mock.calls[0][0]
    expect(findManyArgs.skip).toBe(0)
    expect(findManyArgs.take).toBe(25)
  })

  it('applies page and pageSize query params', async () => {
    await GET(makeRequest('http://localhost/api/referral-earnings?page=2&pageSize=10'))
    const findManyArgs = vi.mocked(prisma.referralEarning.findMany).mock.calls[0][0]

    expect(findManyArgs.skip).toBe(10)
    expect(findManyArgs.take).toBe(10)
  })

  it('caps pageSize at the maximum', async () => {
    await GET(makeRequest('http://localhost/api/referral-earnings?pageSize=999'))
    const findManyArgs = vi.mocked(prisma.referralEarning.findMany).mock.calls[0][0]
    expect(findManyArgs.take).toBe(100)
  })

  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/referral-earnings')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.referralEarning.findMany).mockRejectedValue(new Error('DB error'))
    const res = await GET(makeRequest('http://localhost/api/referral-earnings'))
    expect(res.status).toBe(500)
  })
})
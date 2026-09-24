import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockCompliance = { id: 'admin-1', email: 'compliance@example.com', role: 'compliance' }
const mockNonCompliance = { id: 'user-1', email: 'user@example.com', role: 'freelancer' }
const mockClaims = { userId: 'privy-1' }

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/compliance/structuring-detection', {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCompliance as any)
  vi.mocked(prisma.transaction.findMany).mockResolvedValue([] as any)
})

describe('GET /api/compliance/structuring-detection', () => {
  it('flags a user with multiple near-threshold withdrawals to different accounts', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: 't1', userId: 'flagged-user', amount: 9500, bankAccountId: 'bank-a', createdAt: daysAgo(1) },
      { id: 't2', userId: 'flagged-user', amount: 9200, bankAccountId: 'bank-b', createdAt: daysAgo(3) },
      { id: 't3', userId: 'flagged-user', amount: 9800, bankAccountId: 'bank-c', createdAt: daysAgo(5) },
    ] as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.flaggedUsers).toBe(1)
    expect(data.flags[0].userId).toBe('flagged-user')
    expect(data.flags[0].matchCount).toBe(3)
  })

  it('never includes the reporting threshold value in the response', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: 't1', userId: 'flagged-user', amount: 9500, bankAccountId: 'bank-a', createdAt: daysAgo(1) },
      { id: 't2', userId: 'flagged-user', amount: 9200, bankAccountId: 'bank-b', createdAt: daysAgo(3) },
      { id: 't3', userId: 'flagged-user', amount: 9800, bankAccountId: 'bank-c', createdAt: daysAgo(5) },
    ] as any)

    const res = await GET(makeRequest())
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/10000|threshold/i)
  })

  it('does not flag a small number of near-threshold withdrawals below the cluster minimum', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: 't1', userId: 'user-a', amount: 9500, bankAccountId: 'bank-a', createdAt: daysAgo(1) },
    ] as any)

    const res = await GET(makeRequest())
    const data = await res.json()
    expect(data.flaggedUsers).toBe(0)
  })

  it('does not flag steady recurring withdrawals to the same single account', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: 't1', userId: 'user-a', amount: 9500, bankAccountId: 'bank-a', createdAt: daysAgo(1) },
      { id: 't2', userId: 'user-a', amount: 9500, bankAccountId: 'bank-a', createdAt: daysAgo(2) },
      { id: 't3', userId: 'user-a', amount: 9500, bankAccountId: 'bank-a', createdAt: daysAgo(3) },
    ] as any)

    const res = await GET(makeRequest())
    const data = await res.json()
    expect(data.flaggedUsers).toBe(0)
  })

  it('does not flag amounts well below the near-threshold band', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: 't1', userId: 'user-a', amount: 50, bankAccountId: 'bank-a', createdAt: daysAgo(1) },
      { id: 't2', userId: 'user-a', amount: 75, bankAccountId: 'bank-b', createdAt: daysAgo(2) },
      { id: 't3', userId: 'user-a', amount: 60, bankAccountId: 'bank-c', createdAt: daysAgo(3) },
    ] as any)

    const res = await GET(makeRequest())
    const data = await res.json()
    expect(data.flaggedUsers).toBe(0)
  })

  it('excludes recurring invoice payments from consideration via the query filter', async () => {
    await GET(makeRequest())
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: 'withdrawal', invoiceId: null }),
      }),
    )
  })

  it('returns 403 for a non-admin, non-compliance user', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockNonCompliance as any)
    const res = await GET(makeRequest())
    expect(res.status).toBe(403)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(new NextRequest('http://localhost/api/compliance/structuring-detection'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when the acting user record is missing', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 500 when the database call fails', async () => {
    vi.mocked(prisma.transaction.findMany).mockRejectedValue(new Error('db down'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})

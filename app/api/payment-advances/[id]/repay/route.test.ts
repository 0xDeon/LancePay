import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    paymentAdvance: { findFirst: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const disbursedAdvance = {
  id: 'adv-1',
  userId: 'user-1',
  invoiceId: 'inv-1',
  status: 'disbursed',
  advancedAmountUSDC: '1000.00',
  totalRepaymentUSDC: '1030.00',
}
const repaidResult = {
  id: 'adv-1',
  status: 'repaid',
  repaidAt: new Date('2026-09-02T00:00:00Z'),
  totalRepaymentUSDC: '1030.00',
}

function makeRequest(body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest('http://localhost/api/payment-advances/adv-1/repay', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })
  const ctx = { params: Promise.resolve({ id: 'adv-1' }) }
  return [req, ctx]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(disbursedAdvance as any)
  vi.mocked(prisma.paymentAdvance.update).mockResolvedValue(repaidResult as any)
})

describe('POST /api/payment-advances/[id]/repay', () => {
  it('records a repayment that covers totalRepaymentUSDC', async () => {
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 1030 })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.paymentAdvance.status).toBe('repaid')
    expect(data.paymentAdvance.repaidAt).toBeDefined()

    const updateData = vi.mocked(prisma.paymentAdvance.update).mock.calls[0][1].data
    expect(updateData.status).toBe('repaid')
    expect(updateData.repaidAt).toBeDefined()
  })

  it('accepts a repayment larger than totalRepaymentUSDC', async () => {
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 1100 })
    const res = await POST(req, ctx)
    expect(res.status).toBe(200)
  })

  it('rejects a partial repayment below totalRepaymentUSDC', async () => {
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 500 })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toMatch(/Partial repayment/)
    expect(prisma.paymentAdvance.update).not.toHaveBeenCalled()
  })

  it('rejects a repayment covering only advancedAmountUSDC when total includes fees', async () => {
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 1000 })
    const res = await POST(req, ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 when repaymentAmountUSDC is missing or invalid', async () => {
    const [req, ctx] = makeRequest({})
    const res = await POST(req, ctx)
    expect(res.status).toBe(400)

    const [req2, ctx2] = makeRequest({ repaymentAmountUSDC: 0 })
    const res2 = await POST(req2, ctx2)
    expect(res2.status).toBe(400)
  })

  it('returns 409 when the advance was already repaid', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue({ ...disbursedAdvance, status: 'repaid' } as any)
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 1030 })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.error).toMatch(/already been repaid/)
  })

  it('returns 409 when the advance has not been disbursed', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue({ ...disbursedAdvance, status: 'approved' } as any)
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 1030 })
    const res = await POST(req, ctx)
    expect(res.status).toBe(409)
  })

  it('returns 404 when the advance is not found', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(null)
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 1030 })
    const res = await POST(req, ctx)
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/payment-advances/adv-1/repay', {
      method: 'POST',
      body: '{"repaymentAmountUSDC":1030}',
    })
    const ctx = { params: Promise.resolve({ id: 'adv-1' }) }
    const res = await POST(req, ctx)
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.paymentAdvance.update).mockRejectedValue(new Error('DB error'))
    const [req, ctx] = makeRequest({ repaymentAmountUSDC: 1030 })
    const res = await POST(req, ctx)
    expect(res.status).toBe(500)
  })
})
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
vi.mock('nanoid', () => ({ nanoid: () => 'stub_ref' }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { nanoid } from 'nanoid'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const pendingAdvance = {
  id: 'adv-1',
  userId: 'user-1',
  invoiceId: 'inv-1',
  status: 'pending',
  requestedAmountUSDC: '500.00',
}
const approvedAdvance = { ...pendingAdvance, status: 'approved' }
const disbursedAdvance = { ...pendingAdvance, status: 'disbursed' }
const disbursedResult = {
  id: 'adv-1',
  status: 'disbursed',
  yellowCardTransactionId: 'yd_tx_123',
  disbursedAt: new Date('2026-09-01T00:00:00Z'),
}

function makeRequest(body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest('http://localhost/api/payment-advances/adv-1/disburse', {
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
  vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(approvedAdvance as any)
  vi.mocked(prisma.paymentAdvance.update).mockResolvedValue(disbursedResult as any)
})

describe('POST /api/payment-advances/[id]/disburse', () => {
  it('disburses an approved advance atomically', async () => {
    const [req, ctx] = makeRequest({ yellowCardTransactionId: 'yd_tx_123' })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.paymentAdvance.status).toBe('disbursed')
    expect(data.paymentAdvance.yellowCardTransactionId).toBe('yd_tx_123')
    expect(data.paymentAdvance.disbursedAt).toBeDefined()

    const updateData = vi.mocked(prisma.paymentAdvance.update).mock.calls[0][1].data
    expect(updateData.status).toBe('disbursed')
    expect(updateData.yellowCardTransactionId).toBe('yd_tx_123')
    expect(updateData.disbursedAt).toBeDefined()
  })

  it('disburses a pending advance', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(pendingAdvance as any)
    const [req, ctx] = makeRequest({ yellowCardTransactionId: 'yd_tx_123' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(200)
  })

  it('returns 409 when the advance is already disbursed', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(disbursedAdvance as any)
    const [req, ctx] = makeRequest({ yellowCardTransactionId: 'yd_tx_123' })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.disbursableStatuses).toBeDefined()
  })

  it('returns 409 when the advance is in an unexpected status', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue({ ...approvedAdvance, status: 'repaid' } as any)
    const [req, ctx] = makeRequest({ yellowCardTransactionId: 'yd_tx_123' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(409)
  })

  it('returns 404 when results advance is not found', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(null)
    const [req, ctx] = makeRequest({ yellowCardTransactionId: 'yd_tx_123' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(404)
  })

  it('returns 400 when yellowCardTransactionId is missing', async () => {
    const [req, ctx] = makeRequest({})
    const res = await POST(req, ctx)
    expect(res.status).toBe(400)
  })

  it('persists the error field on downstream failure', async () => {
    vi.mocked(nanoid).mockImplementation(() => {
      throw new Error('provider timeout')
    })
    const [req, ctx] = makeRequest({ yellowCardTransactionId: 'yd_tx_123' })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(502)
    expect(data.error).toBe('provider timeout')

    const updateData = vi.mocked(prisma.paymentAdvance.update).mock.calls[0][1].data
    expect(updateData.error).toBe('provider timeout')
    expect(updateData.status).toBeUndefined()
  })

  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/payment-advances/adv-1/disburse', {
      method: 'POST',
      body: '{"yellowCardTransactionId":"yd_tx_123"}',
    })
    const ctx = { params: Promise.resolve({ id: 'adv-1' }) }
    const res = await POST(req, ctx)
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockRejectedValue(new Error('DB error'))
    const [req, ctx] = makeRequest({ yellowCardTransactionId: 'yd_tx_123' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(500)
  })
})
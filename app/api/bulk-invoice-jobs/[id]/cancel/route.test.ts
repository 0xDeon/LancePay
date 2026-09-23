import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bulkInvoiceJob: { findFirst: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const processingJob = {
  id: 'job-1',
  userId: 'user-1',
  status: 'processing',
  totalCount: 10,
  successCount: 4,
  failedCount: 1,
  results: [{ id: 'inv-1' }],
}
const completedJob = { ...processingJob, status: 'completed' }
const cancelledJob = { ...processingJob, status: 'cancelled' }
const cancelledResult = { ...processingJob, status: 'cancelled', completedAt: new Date() }

function makeRequest(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(`http://localhost/api/bulk-invoice-jobs/${id}/cancel`, {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })
  const ctx = { params: Promise.resolve({ id }) }
  return [req, ctx]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(processingJob as any)
  vi.mocked(prisma.bulkInvoiceJob.update).mockResolvedValue(cancelledResult as any)
})

describe('POST /api/bulk-invoice-jobs/[id]/cancel', () => {
  it('cancels a processing job', async () => {
    const [req, ctx] = makeRequest('job-1')
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.job.status).toBe('cancelled')
    expect(data.job.completedAt).toBeDefined()
  })

  it('returns 409 when the job is not processing', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(completedJob as any)
    const [req, ctx] = makeRequest('job-1')
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.cancellableStatus).toBe('processing')
  })

  it('returns 409 when the job is already cancelled', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(cancelledJob as any)
    const [req, ctx] = makeRequest('job-1')
    const res = await POST(req, ctx)
    expect(res.status).toBe(409)
  })

  it('returns 404 when the job belongs to another user', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(null)
    const [req, ctx] = makeRequest('job-1')
    const res = await POST(req, ctx)
    expect(res.status).toBe(404)
  })

  it('preserves already-created invoices (no rollback)', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(processingJob as any)
    const [req, ctx] = makeRequest('job-1')
    const res = await POST(req, ctx)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.job.successCount).toBe(4)
    expect(prisma.bulkInvoiceJob.update).toHaveBeenCalledTimes(1)
    const updateData = vi.mocked(prisma.bulkInvoiceJob.update).mock.calls[0][1].data
    expect(updateData.status).toBe('cancelled')
    expect(updateData.successCount).toBeUndefined()
    expect(updateData.results).toBeUndefined()
  })

  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/bulk-invoice-jobs/job-1/cancel', { method: 'POST' })
    const ctx = { params: Promise.resolve({ id: 'job-1' }) }
    const res = await POST(req, ctx)
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.bulkInvoiceJob.update).mockRejectedValue(new Error('DB error'))
    const [req, ctx] = makeRequest('job-1')
    const res = await POST(req, ctx)
    expect(res.status).toBe(500)
  })
})
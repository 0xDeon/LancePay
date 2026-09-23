import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bulkInvoiceJob: { findFirst: vi.fn(), update: vi.fn() },
    invoice: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const mockFailedResults = [
  { recipientEmail: 'client1@example.com', invoiceId: 'inv-1', invoiceNumber: 'INV-001' },
  { recipientEmail: 'client2@example.com', error: 'Invalid email domain' },
  { recipientEmail: 'client3@example.com', error: 'Email already used' },
]

const mockJobWithFailures = {
  id: 'job-1',
  userId: 'user-1',
  status: 'completed',
  totalCount: 3,
  successCount: 1,
  failedCount: 2,
  results: mockFailedResults,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T01:00:00Z'),
}

const mockJobNoFailures = {
  id: 'job-2',
  userId: 'user-1',
  status: 'completed',
  totalCount: 2,
  successCount: 2,
  failedCount: 0,
  results: [
    { recipientEmail: 'client1@example.com', invoiceId: 'inv-1', invoiceNumber: 'INV-001' },
    { recipientEmail: 'client2@example.com', invoiceId: 'inv-2', invoiceNumber: 'INV-002' },
  ],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T01:00:00Z'),
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
})

describe('POST /api/bulk-invoice-jobs/[id]/retry-failed', () => {
  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed', {
      method: 'POST',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'job-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 when job ID is missing', async () => {
    const res = await POST(makeRequest('http://localhost/api/bulk-invoice-jobs//retry-failed'), {
      params: Promise.resolve({ id: '' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Job ID is required')
  })

  it('returns 404 when job not found', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(null)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/nonexistent/retry-failed'),
      { params: Promise.resolve({ id: 'nonexistent' }) },
    )
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })

  it('returns 409 when job has no failed rows', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJobNoFailures as any)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-2/retry-failed'),
      { params: Promise.resolve({ id: 'job-2' }) },
    )
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toContain('No failed rows to retry')
  })

  it('identifies failed rows from results array', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJobWithFailures as any)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed'),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.job.failedRowCount).toBe(2)
  })

  it('returns job details with retry metadata', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJobWithFailures as any)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed'),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.job).toHaveProperty('id')
    expect(data.job).toHaveProperty('status')
    expect(data.job).toHaveProperty('totalCount')
    expect(data.job).toHaveProperty('successCount')
    expect(data.job).toHaveProperty('failedCount')
    expect(data.job).toHaveProperty('completed')
    expect(data.job).toHaveProperty('retryInProgress')
    expect(data.job.retryInProgress).toBe(true)
  })

  it('queries job with correct userId filter', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJobWithFailures as any)

    await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed'),
      { params: Promise.resolve({ id: 'job-1' }) },
    )

    expect(vi.mocked(prisma.bulkInvoiceJob.findFirst).mock.calls[0][0]).toEqual({
      where: { id: 'job-1', userId: 'user-1' },
    })
  })

  it('returns 404 when accessing another user\'s job', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(null)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/other-user-job/retry-failed'),
      { params: Promise.resolve({ id: 'other-user-job' }) },
    )
    expect(res.status).toBe(404)
  })

  it('handles job with only errors in results array', async () => {
    const allErrorResults = [
      { recipientEmail: 'client1@example.com', error: 'Failed' },
      { recipientEmail: 'client2@example.com', error: 'Failed' },
    ]
    const jobAllErrors = {
      ...mockJobWithFailures,
      successCount: 0,
      failedCount: 2,
      results: allErrorResults,
    }
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(jobAllErrors as any)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed'),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.job.failedRowCount).toBe(2)
  })

  it('includes completed flag in response', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJobWithFailures as any)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed'),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    const data = await res.json()

    expect(data.job).toHaveProperty('completed')
    expect(typeof data.job.completed).toBe('boolean')
  })

  it('preserves succeeded rows while retrying only failed ones', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJobWithFailures as any)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed'),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    expect(res.status).toBe(200)
    const data = await res.json()

    // Verify that the failed row count is 2 (not including the successful one)
    expect(data.job.failedRowCount).toBe(2)
    // And the original counts are unchanged (retry is async)
    expect(data.job.successCount).toBe(1)
    expect(data.job.failedCount).toBe(2)
  })

  it('calculates completed flag correctly', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJobWithFailures as any)

    const res = await POST(
      makeRequest('http://localhost/api/bulk-invoice-jobs/job-1/retry-failed'),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    const data = await res.json()

    // 1 success + 2 failed = 3 total, so not complete
    expect(data.job.completed).toBe(false)
  })
})

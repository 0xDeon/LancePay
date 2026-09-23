import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bulkInvoiceJob: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const mockResults = [
  {
    recipientEmail: 'client1@example.com',
    invoiceId: 'inv-1',
    invoiceNumber: 'INV-001',
  },
  {
    recipientEmail: 'client2@example.com',
    error: 'Invalid email domain',
  },
]

const mockJob = {
  id: 'job-1',
  userId: 'user-1',
  status: 'completed',
  totalCount: 2,
  successCount: 1,
  failedCount: 1,
  results: mockResults,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T01:00:00Z'),
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
})

describe('GET /api/bulk-invoice-jobs/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/bulk-invoice-jobs/job-1')
    const res = await GET(req, { params: Promise.resolve({ id: 'job-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 when job ID is missing', async () => {
    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/'), {
      params: Promise.resolve({ id: '' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Job ID is required')
  })

  it('returns 404 when job not found', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(null)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/nonexistent'), {
      params: Promise.resolve({ id: 'nonexistent' }),
    })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })

  it('returns 404 when accessing another user\'s job', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(null)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns job details with completed flag set to true when all rows are terminal', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJob as any)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.job.completed).toBe(true)
    expect(data.job.successCount).toBe(1)
    expect(data.job.failedCount).toBe(1)
    expect(data.job.totalCount).toBe(2)
  })

  it('returns completed flag as false when processing', async () => {
    const processingJob = {
      ...mockJob,
      status: 'processing',
      successCount: 0,
      failedCount: 0,
      completedAt: null,
    }
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(processingJob as any)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })
    const data = await res.json()

    expect(data.job.completed).toBe(false)
  })

  it('includes per-row results in response', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJob as any)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })
    const data = await res.json()

    expect(data.job.results).toHaveLength(2)
    expect(data.job.results[0]).toHaveProperty('recipientEmail')
    expect(data.job.results[0]).toHaveProperty('invoiceId')
    expect(data.job.results[1]).toHaveProperty('error')
  })

  it('queries job with correct userId filter', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJob as any)

    await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })

    expect(vi.mocked(prisma.bulkInvoiceJob.findFirst).mock.calls[0][0]).toEqual({
      where: { id: 'job-1', userId: 'user-1' },
    })
  })

  it('returns all required fields in response', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJob as any)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })
    const data = await res.json()

    expect(data.job).toHaveProperty('id')
    expect(data.job).toHaveProperty('status')
    expect(data.job).toHaveProperty('totalCount')
    expect(data.job).toHaveProperty('successCount')
    expect(data.job).toHaveProperty('failedCount')
    expect(data.job).toHaveProperty('completed')
    expect(data.job).toHaveProperty('results')
    expect(data.job).toHaveProperty('createdAt')
    expect(data.job).toHaveProperty('completedAt')
  })

  it('converts completedAt to ISO string or null', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(mockJob as any)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })
    const data = await res.json()

    expect(typeof data.job.completedAt).toBe('string')

    const processingJob = { ...mockJob, completedAt: null }
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(processingJob as any)

    const res2 = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-2'), {
      params: Promise.resolve({ id: 'job-2' }),
    })
    const data2 = await res2.json()

    expect(data2.job.completedAt).toBeNull()
  })

  it('completed flag reflects partial progress', async () => {
    const partialJob = {
      ...mockJob,
      status: 'processing',
      successCount: 5,
      failedCount: 2,
      totalCount: 10,
      completedAt: null,
    }
    vi.mocked(prisma.bulkInvoiceJob.findFirst).mockResolvedValue(partialJob as any)

    const res = await GET(makeRequest('http://localhost/api/bulk-invoice-jobs/job-1'), {
      params: Promise.resolve({ id: 'job-1' }),
    })
    const data = await res.json()

    expect(data.job.completed).toBe(false)
  })
})

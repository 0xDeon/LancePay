import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bulkInvoiceJob: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    invoice: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', email: 'user@example.com' }
const mockClaims = { userId: 'privy-1' }

const mockJob = {
  id: 'job-1',
  userId: 'user-1',
  status: 'processing',
  totalCount: 2,
  successCount: 0,
  failedCount: 0,
  results: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: null,
}

function makeRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function makeGetRequest(url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
})

describe('GET /api/bulk-invoice-jobs', () => {
  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/bulk-invoice-jobs')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns list of jobs for user', async () => {
    const mockJobs = [
      { ...mockJob, id: 'job-1', status: 'completed' },
      { ...mockJob, id: 'job-2', status: 'processing' },
    ]
    vi.mocked(prisma.bulkInvoiceJob.findMany).mockResolvedValue(mockJobs as any)

    const res = await GET(makeGetRequest('http://localhost/api/bulk-invoice-jobs'))
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.jobs).toHaveLength(2)
    expect(data.jobs[0].id).toBe('job-1')
    expect(data.jobs[0].status).toBe('completed')
  })

  it('returns empty list when user has no jobs', async () => {
    vi.mocked(prisma.bulkInvoiceJob.findMany).mockResolvedValue([])

    const res = await GET(makeGetRequest('http://localhost/api/bulk-invoice-jobs'))
    const data = await res.json()

    expect(data.jobs).toHaveLength(0)
  })

  it('calculates progress correctly', async () => {
    const mockJobs = [
      { ...mockJob, successCount: 1, failedCount: 1, totalCount: 4 },
    ]
    vi.mocked(prisma.bulkInvoiceJob.findMany).mockResolvedValue(mockJobs as any)

    const res = await GET(makeGetRequest('http://localhost/api/bulk-invoice-jobs'))
    const data = await res.json()

    expect(data.jobs[0].progress).toBe(50)
  })
})

describe('POST /api/bulk-invoice-jobs', () => {
  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/bulk-invoice-jobs', {
      method: 'POST',
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 when totalCount does not match recipients length', async () => {
    const body = {
      recipients: [
        {
          clientEmail: 'client@example.com',
          clientName: 'Client',
          description: 'Work',
          amount: 100,
          currency: 'USD',
        },
      ],
      totalCount: 2,
    }

    const res = await POST(makeRequest('http://localhost/api/bulk-invoice-jobs', body))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('totalCount')
  })

  it('creates a bulk invoice job with processing status', async () => {
    vi.mocked(prisma.bulkInvoiceJob.create).mockResolvedValue(mockJob as any)

    const body = {
      recipients: [
        {
          clientEmail: 'client1@example.com',
          clientName: 'Client 1',
          description: 'Work',
          amount: 100,
          currency: 'USD',
        },
        {
          clientEmail: 'client2@example.com',
          clientName: 'Client 2',
          description: 'Work',
          amount: 200,
          currency: 'USD',
        },
      ],
      totalCount: 2,
    }

    const res = await POST(makeRequest('http://localhost/api/bulk-invoice-jobs', body))
    expect(res.status).toBe(201)
    const data = await res.json()

    expect(data.job.status).toBe('processing')
    expect(data.job.totalCount).toBe(2)
    expect(data.job.completedAt).toBeNull()
    expect(vi.mocked(prisma.bulkInvoiceJob.create).mock.calls[0][0]).toEqual({
      data: {
        userId: 'user-1',
        status: 'processing',
        totalCount: 2,
        successCount: 0,
        failedCount: 0,
        results: [],
      },
    })
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/bulk-invoice-jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'invalid json',
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid JSON body')
  })

  it('returns 400 for invalid recipient data', async () => {
    const body = {
      recipients: [
        {
          clientEmail: 'not-an-email',
          clientName: 'Client',
          description: 'Work',
          amount: 100,
        },
      ],
      totalCount: 1,
    }

    const res = await POST(makeRequest('http://localhost/api/bulk-invoice-jobs', body))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
  })

  it('accepts optional fields in recipients', async () => {
    vi.mocked(prisma.bulkInvoiceJob.create).mockResolvedValue(mockJob as any)

    const body = {
      recipients: [
        {
          clientEmail: 'client@example.com',
          description: 'Work',
          amount: 100,
        },
      ],
      totalCount: 1,
    }

    const res = await POST(makeRequest('http://localhost/api/bulk-invoice-jobs', body))
    expect(res.status).toBe(201)
  })

  it('initializes job with empty results array and zero counts', async () => {
    vi.mocked(prisma.bulkInvoiceJob.create).mockResolvedValue(mockJob as any)

    const body = {
      recipients: [
        {
          clientEmail: 'client@example.com',
          clientName: 'Client',
          description: 'Work',
          amount: 100,
        },
      ],
      totalCount: 1,
    }

    await POST(makeRequest('http://localhost/api/bulk-invoice-jobs', body))

    const createCall = vi.mocked(prisma.bulkInvoiceJob.create).mock.calls[0][0]
    expect(createCall.data.successCount).toBe(0)
    expect(createCall.data.failedCount).toBe(0)
    expect(createCall.data.results).toEqual([])
  })

  it('includes progress in response', async () => {
    vi.mocked(prisma.bulkInvoiceJob.create).mockResolvedValue(mockJob as any)

    const body = {
      recipients: [{ clientEmail: 'c@e.com', description: 'Work', amount: 100 }],
      totalCount: 1,
    }

    const res = await POST(makeRequest('http://localhost/api/bulk-invoice-jobs', body))
    const data = await res.json()

    expect(data.job.progress).toBe(0)
  })
})

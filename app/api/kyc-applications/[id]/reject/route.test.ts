import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, REJECTION_REASON_CODES } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    kycApplication: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function request(body: unknown = { rejectionReason: 'document_unreadable' }, withAuth = true) {
  return new NextRequest('http://localhost/api/kyc-applications/app-1/reject', {
    method: 'POST',
    headers: {
      ...(withAuth ? { authorization: 'Bearer token' } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

const context = { params: Promise.resolve({ id: 'app-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-reviewer' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'reviewer-1', role: 'compliance' } as any)
  vi.mocked(prisma.kycApplication.updateMany).mockResolvedValue({ count: 1 })
})

describe('POST /api/kyc-applications/[id]/reject', () => {
  it('rejects a reviewable application with a structured reason and review timestamp', async () => {
    const response = await POST(request(), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.application.status).toBe('rejected')
    expect(prisma.kycApplication.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-1', status: { in: ['pending', 'submitted', 'under_review'] } },
      data: {
        status: 'rejected',
        rejectionReason: 'document_unreadable',
        reviewedAt: expect.any(Date),
      },
    })
  })

  it('allows administrators to reject applications', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-1', role: 'admin' } as any)
    expect((await POST(request(), context)).status).toBe(200)
  })

  it('rejects free text and empty reasons with the supported codes', async () => {
    const response = await POST(request({ rejectionReason: 'The photo looks wrong' }), context)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.allowedReasons).toEqual(REJECTION_REASON_CODES)
    expect((await POST(request({ rejectionReason: '' }), context)).status).toBe(400)
  })

  it('rejects unauthenticated and unauthorized users', async () => {
    expect((await POST(request({}, false), context)).status).toBe(401)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', role: 'freelancer' } as any)
    expect((await POST(request(), context)).status).toBe(403)
  })

  it('returns 404 when the application does not exist', async () => {
    vi.mocked(prisma.kycApplication.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue(null)
    expect((await POST(request(), context)).status).toBe(404)
  })

  it('returns 409 rather than overwriting a resolved application', async () => {
    vi.mocked(prisma.kycApplication.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({ status: 'approved' } as any)
    expect((await POST(request(), context)).status).toBe(409)
  })

  it('returns 500 when the database update fails', async () => {
    vi.mocked(prisma.kycApplication.updateMany).mockRejectedValue(new Error('database unavailable'))
    expect((await POST(request(), context)).status).toBe(500)
  })
})

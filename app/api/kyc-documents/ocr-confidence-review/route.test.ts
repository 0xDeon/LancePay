import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    kycDocument: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function request(withAuth = true) {
  return new NextRequest('http://localhost/api/kyc-documents/ocr-confidence-review', {
    headers: withAuth ? { authorization: 'Bearer token' } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-reviewer' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'reviewer-1', role: 'compliance' } as any)
  vi.mocked(prisma.kycDocument.findMany).mockResolvedValue([])
})

describe('GET /api/kyc-documents/ocr-confidence-review', () => {
  it('returns unresolved low-confidence documents least reliable first', async () => {
    vi.mocked(prisma.kycDocument.findMany).mockResolvedValue([
      { id: 'doc-low', ocrConfidence: 0.2 },
      { id: 'doc-higher', ocrConfidence: 0.7 },
    ] as any)

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.documents.map((document: { id: string }) => document.id)).toEqual(['doc-low', 'doc-higher'])
    expect(body.threshold).toBe(0.85)
    expect(prisma.kycDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        ocrConfidence: { lt: 0.85 },
        ocrReviewedAt: null,
        status: { notIn: ['approved', 'verified', 'rejected'] },
      },
      orderBy: { ocrConfidence: 'asc' },
    }))
  })

  it('allows administrators to review the queue', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-1', role: 'admin' } as any)
    expect((await GET(request())).status).toBe(200)
  })

  it('rejects unauthenticated and unauthorized users', async () => {
    expect((await GET(request(false))).status).toBe(401)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', role: 'freelancer' } as any)
    expect((await GET(request())).status).toBe(403)
  })

  it('returns 404 when the reviewer profile does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    expect((await GET(request())).status).toBe(404)
  })

  it('returns 500 when the database query fails', async () => {
    vi.mocked(prisma.kycDocument.findMany).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})

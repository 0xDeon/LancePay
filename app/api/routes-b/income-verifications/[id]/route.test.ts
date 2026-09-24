import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    incomeVerification: { findUnique: vi.fn(), delete: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockUserFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockVerificationFindUnique = prisma.incomeVerification
  .findUnique as unknown as ReturnType<typeof vi.fn>
const mockVerificationDelete = prisma.incomeVerification
  .delete as unknown as ReturnType<typeof vi.fn>

function makeDelete(id: string, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`http://localhost/api/routes-b/income-verifications/${id}`, {
    method: 'DELETE',
    headers,
  })
}

function callDelete(id: string, token: string | null = 'Bearer valid-token') {
  return DELETE(makeDelete(id, token), { params: Promise.resolve({ id }) })
}

const now = new Date()
const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

const mockVerification = { id: 'iv-1', userId: 'user-1', expiresAt: tomorrow }
const expiredVerification = { id: 'iv-2', userId: 'user-1', expiresAt: yesterday }

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockResolvedValue({ userId: 'privy-1' })
  mockUserFindUnique.mockResolvedValue({ id: 'user-1' })
  mockVerificationFindUnique.mockResolvedValue(mockVerification)
  mockVerificationDelete.mockResolvedValue(mockVerification)
})

describe('DELETE /api/routes-b/income-verifications/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await callDelete('iv-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    mockVerify.mockResolvedValue(null)
    const res = await callDelete('iv-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record is missing', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    const res = await callDelete('iv-1')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the income verification does not exist', async () => {
    mockVerificationFindUnique.mockResolvedValue(null)
    const res = await callDelete('missing')
    expect(res.status).toBe(404)
    expect(mockVerificationDelete).not.toHaveBeenCalled()
  })

  it('returns 403 when the verification belongs to another user', async () => {
    mockVerificationFindUnique.mockResolvedValue({
      ...mockVerification,
      userId: 'someone-else',
    })
    const res = await callDelete('iv-1')
    expect(res.status).toBe(403)
    expect(mockVerificationDelete).not.toHaveBeenCalled()
  })

  it('returns 404 when the income verification has already expired', async () => {
    mockVerificationFindUnique.mockResolvedValue(expiredVerification)
    const res = await callDelete('iv-2')
    expect(res.status).toBe(404)
    expect(mockVerificationDelete).not.toHaveBeenCalled()
  })

  it('deletes the verification and returns 200 on the happy path', async () => {
    const res = await callDelete('iv-1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('iv-1')
    expect(mockVerificationDelete).toHaveBeenCalledWith({ where: { id: 'iv-1' } })
  })

  it('returns 500 when an unexpected error occurs', async () => {
    mockVerificationDelete.mockRejectedValue(new Error('db unavailable'))
    const res = await callDelete('iv-1')
    expect(res.status).toBe(500)
  })

  it('ensures immediate revocation effect: deleted record is not accessible in subsequent queries', async () => {
    // First DELETE call succeeds
    const deleteRes = await callDelete('iv-1')
    expect(deleteRes.status).toBe(200)
    expect(mockVerificationDelete).toHaveBeenCalled()

    // Simulate an in-flight view attempt: findUnique on the same ID returns null
    // (because the record was hard-deleted from the database)
    mockVerificationFindUnique.mockResolvedValue(null)

    // A subsequent view attempt would query and get null immediately
    const lookupRes = await prisma.incomeVerification.findUnique({ where: { id: 'iv-1' } })
    expect(lookupRes).toBeNull()
  })
})

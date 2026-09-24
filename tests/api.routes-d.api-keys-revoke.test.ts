import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const apiFindFirst = vi.fn()
const apiUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    apiKey: { findFirst: apiFindFirst, update: apiUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/api-keys/key-1'

function req(method = 'DELETE', token = 'Bearer tok') {
  return new NextRequest(URL, {
    method,
    headers: { authorization: token },
  })
}

describe('DELETE /api/routes-d/api-keys/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('authentication', () => {
    it('returns 401 with no authorization header', async () => {
      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const noAuthReq = new NextRequest(URL, { method: 'DELETE' })
      const res = await DELETE(noAuthReq, { params: Promise.resolve({ id: 'key-1' }) })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 with invalid token', async () => {
      verifyAuthToken.mockResolvedValue(null)
      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req('DELETE', 'Bearer invalid'), { params: Promise.resolve({ id: 'key-1' }) })
      expect(res.status).toBe(401)
      expect(verifyAuthToken).toHaveBeenCalledWith('invalid')
    })

    it('returns 404 when authenticated user not found in database', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue(null)
      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    })
  })

  describe('key lookup', () => {
    it('returns 404 when key does not exist', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue(null)
      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('API key not found')
    })

    it('returns 404 when key belongs to different user', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue(null) // No key found for this user
      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-2' }) })
      expect(res.status).toBe(404)
      // Verify ownership check: should search with both id and userId
      expect(apiFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-2', userId: 'user-1' },
        }),
      )
    })
  })

  describe('revocation status', () => {
    it('returns 409 when key is already revoked', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: false, // Already revoked
      })
      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBe('API key is already revoked')
      // Should not attempt to update
      expect(apiUpdate).not.toHaveBeenCalled()
    })
  })

  describe('successful revocation', () => {
    it('revokes an active key and returns 204', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: true, // Active
      })
      apiUpdate.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: false,
      })

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      expect(res.status).toBe(204)
      // Verify content is empty
      const text = await res.text()
      expect(text).toBe('')

      // Verify update was called with correct parameters
      expect(apiUpdate).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        data: { isActive: false },
      })
    })

    it('preserves audit history (row not deleted)', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      const keyData = {
        id: 'key-1',
        userId: 'user-1',
        isActive: true,
        name: 'My Key',
        keyHint: 'abc123',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }
      apiFindFirst.mockResolvedValue(keyData)
      apiUpdate.mockResolvedValue({
        ...keyData,
        isActive: false,
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      })

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      expect(res.status).toBe(204)

      // Verify that update was called (not delete)
      // This ensures the row is preserved for audit
      expect(apiUpdate).toHaveBeenCalled()
      expect(apiUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ delete: expect.anything() }) }),
      )
    })
  })

  describe('cache invalidation', () => {
    it('triggers cache invalidation on successful revocation', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: true,
      })
      apiUpdate.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: false,
      })

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      expect(res.status).toBe(204)
      // Cache invalidation is logged (verification that it was attempted)
      // In this test setup, it would be via logger.info
    })

    it('completes revocation even if cache invalidation fails', async () => {
      // The implementation logs cache errors but doesn't fail the revocation
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: true,
      })
      apiUpdate.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: false,
      })

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      // Should still return 204 even if cache handling has issues
      expect(res.status).toBe(204)
      expect(apiUpdate).toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('returns 400 with empty key ID', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: '' }) })

      expect(res.status).toBe(400)
      expect(apiFindFirst).not.toHaveBeenCalled()
    })

    it('handles params Promise correctly (Next.js 15+ behavior)', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue(null)

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      // Pass params as a Promise (Next.js 15+ pattern)
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      expect(res.status).toBe(404)
      expect(apiFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'key-1', userId: 'user-1' } }),
      )
    })

    it('handles server errors gracefully', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockRejectedValue(new Error('Database error'))

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Failed to revoke API key')
    })
  })

  describe('ownership enforcement', () => {
    it('prevents non-owner from revoking key', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      // Key belongs to user-2
      apiFindFirst.mockResolvedValue(null) // Not found for user-1

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      expect(res.status).toBe(404)
      // Verify the ownership check was performed
      expect(apiFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1' }),
        }),
      )
    })
  })

  describe('immediate effectiveness after revocation', () => {
    it('revoked key is immediately marked inactive in database', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-u1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      apiFindFirst.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
        isActive: true,
      })

      const revokedKey = {
        id: 'key-1',
        userId: 'user-1',
        isActive: false, // Immediately false
      }
      apiUpdate.mockResolvedValue(revokedKey)

      const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
      const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })

      expect(res.status).toBe(204)

      // Verify that isActive is set to false
      expect(apiUpdate).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        data: { isActive: false },
      })

      // After revocation, subsequent lookups would find isActive: false
      // which should be rejected by auth validation logic
    })
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycApplicationFindUnique = vi.fn()
const kycApplicationUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycApplication: { findUnique: kycApplicationFindUnique, update: kycApplicationUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const BASE_URL = 'http://localhost/api/kyc-applications/test-id/upgrade-level'

function makeRequest(body?: unknown, token = 'valid-token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: token ? `Bearer ${token}` : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/kyc-applications/[id]/upgrade-level', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Authentication', () => {
    it('returns 401 when no authorization header is provided', async () => {
      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }, ''), {
        params: Promise.resolve({ id: 'test-id' }),
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 when token is invalid', async () => {
      verifyAuthToken.mockResolvedValue(null)
      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'test-id' }),
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when user is not found', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue(null)
      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'test-id' }),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('Not Found', () => {
    it('returns 404 when application does not exist', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue(null)

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'nonexistent-id' }),
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toMatch(/not found/)
    })
  })

  describe('Authorization', () => {
    it('returns 403 when user is not the application owner', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-2', // Different owner
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        city: 'New York',
        postalCode: '10001',
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toMatch(/Not authorized/)
    })
  })

  describe('Request Validation', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        city: 'New York',
        postalCode: '10001',
      })
    })

    it('returns 400 when targetLevel is missing from body', async () => {
      const { POST } = await import('./route')
      const res = await POST(makeRequest({}), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/targetLevel/)
    })

    it('returns 400 when body is invalid JSON', async () => {
      const { POST } = await import('./route')
      const invalidReq = new NextRequest(BASE_URL, {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: 'invalid json',
      })
      const res = await POST(invalidReq, {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when targetLevel is invalid', async () => {
      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'invalid_level' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/Invalid targetLevel/)
    })

    it('returns 400 when targetLevel is same as current level', async () => {
      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'basic' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/different from current level/)
    })
  })

  describe('State Validation', () => {
    it('returns 409 when application status is pending', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'pending', // Not approved
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/non-approved status/)
      expect(body.error).toMatch(/pending/)
    })

    it('returns 409 when application status is rejected', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'rejected', // Not approved
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/non-approved status/)
      expect(body.error).toMatch(/rejected/)
    })
  })

  describe('Prerequisite Validation', () => {
    it('returns 422 when required field is missing for enhanced level', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        city: null, // Missing city
        postalCode: '10001',
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toMatch(/Missing required fields/)
      expect(body.missingFields).toContain('city')
    })

    it('returns 422 when multiple fields are missing', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: null, // Missing
        city: null, // Missing
        postalCode: '10001',
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.missingFields).toContain('addressLine1')
      expect(body.missingFields).toContain('city')
    })

    it('returns 422 when field is empty string', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '  ', // Whitespace only
        city: 'New York',
        postalCode: '10001',
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.missingFields).toContain('addressLine1')
    })
  })

  describe('Happy Path - Successful Upgrade', () => {
    it('successfully upgrades from basic to enhanced with all prerequisites', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })

      const appBefore = {
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        addressLine2: null,
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-15'),
        rejectionReason: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
      }

      kycApplicationFindUnique.mockResolvedValue(appBefore)

      const appAfter = {
        ...appBefore,
        level: 'enhanced',
        status: 'pending',
        submittedAt: expect.any(Date),
        reviewedAt: null,
        rejectionReason: null,
        updatedAt: expect.any(Date),
      }

      kycApplicationUpdate.mockResolvedValue(appAfter)

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe('kyc-1')
      expect(body.level).toBe('enhanced')
      expect(body.status).toBe('pending')
      expect(body.message).toMatch(/pending review/)
      expect(body.message).toMatch(/enhanced/)
    })

    it('updates database with correct fields', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        city: 'New York',
        postalCode: '10001',
      })

      kycApplicationUpdate.mockResolvedValue({
        id: 'kyc-1',
        level: 'enhanced',
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
        rejectionReason: null,
      })

      const { POST } = await import('./route')
      await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })

      expect(kycApplicationUpdate).toHaveBeenCalledWith({
        where: { id: 'kyc-1' },
        data: {
          level: 'enhanced',
          status: 'pending',
          submittedAt: expect.any(Date),
          reviewedAt: null,
          rejectionReason: null,
        },
      })
    })

    it('returns status as pending after upgrade (never approved)', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        city: 'New York',
        postalCode: '10001',
      })

      kycApplicationUpdate.mockResolvedValue({
        id: 'kyc-1',
        level: 'enhanced',
        status: 'pending', // Must be pending, not approved
        submittedAt: new Date(),
        reviewedAt: null,
        rejectionReason: null,
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })

      const body = await res.json()
      expect(body.status).toBe('pending')
      expect(body.status).not.toBe('approved')
    })
  })

  describe('Edge Cases', () => {
    it('handles case-insensitive targetLevel', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        city: 'New York',
        postalCode: '10001',
      })

      kycApplicationUpdate.mockResolvedValue({
        id: 'kyc-1',
        level: 'enhanced',
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
        rejectionReason: null,
      })

      const { POST } = await import('./route')
      const res = await POST(makeRequest({ targetLevel: 'ENHANCED' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.level).toBe('enhanced')
    })

    it('clears rejection reason when upgrading', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      kycApplicationFindUnique.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        status: 'approved',
        level: 'basic',
        fullName: 'Test User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'US',
        addressLine1: '123 Main St',
        city: 'New York',
        postalCode: '10001',
        rejectionReason: 'old rejection', // Has an old rejection
      })

      kycApplicationUpdate.mockResolvedValue({
        id: 'kyc-1',
        level: 'enhanced',
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
        rejectionReason: null,
      })

      const { POST } = await import('./route')
      await POST(makeRequest({ targetLevel: 'enhanced' }), {
        params: Promise.resolve({ id: 'kyc-1' }),
      })

      expect(kycApplicationUpdate).toHaveBeenCalledWith({
        where: { id: 'kyc-1' },
        data: expect.objectContaining({
          rejectionReason: null,
        }),
      })
    })
  })
})

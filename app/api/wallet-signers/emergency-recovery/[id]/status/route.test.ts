import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    emergencyRecoveryRequest: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockAdmin = { id: 'admin-1', email: 'admin@example.com', role: 'admin' }
const mockOtherAdmin = { id: 'admin-2', email: 'admin2@example.com', role: 'admin' }
const mockNonAdmin = { id: 'user-1', email: 'user@example.com', role: 'freelancer' }
const mockClaims = { userId: 'privy-1' }

function makeRecoveryRequest(overrides: Partial<any> = {}) {
  return {
    id: 'recovery-1',
    walletId: 'wallet-1',
    status: 'pending',
    requiredApprovals: 2,
    approvals: [{ adminId: 'admin-1', decision: 'approved', createdAt: new Date() }],
    wallet: { signers: [{ userId: 'admin-1' }, { userId: 'admin-2' }] },
    createdAt: new Date(),
    executedAt: null,
    ...overrides,
  }
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/wallet-signers/emergency-recovery/recovery-1/status', {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

function callGet(id = 'recovery-1') {
  return GET(makeRequest(), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdmin as any)
  vi.mocked(prisma.emergencyRecoveryRequest.findUnique).mockResolvedValue(makeRecoveryRequest() as any)
})

describe('GET /api/wallet-signers/emergency-recovery/[id]/status', () => {
  it('returns pending status with the approval count when below the required threshold', async () => {
    const res = await callGet()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('pending')
    expect(data.approvalsCollected).toBe(1)
    expect(data.requiredApprovals).toBe(2)
  })

  it('returns approved-and-executing once required approvals are collected', async () => {
    vi.mocked(prisma.emergencyRecoveryRequest.findUnique).mockResolvedValue(
      makeRecoveryRequest({
        approvals: [
          { adminId: 'admin-1', decision: 'approved', createdAt: new Date() },
          { adminId: 'admin-2', decision: 'approved', createdAt: new Date() },
        ],
      }) as any,
    )
    const res = await callGet()
    const data = await res.json()
    expect(data.status).toBe('approved-and-executing')
  })

  it('returns executed status once the request has been executed', async () => {
    vi.mocked(prisma.emergencyRecoveryRequest.findUnique).mockResolvedValue(
      makeRecoveryRequest({ status: 'executed', executedAt: new Date() }) as any,
    )
    const res = await callGet()
    const data = await res.json()
    expect(data.status).toBe('executed')
  })

  it('returns rejected status when the request was rejected', async () => {
    vi.mocked(prisma.emergencyRecoveryRequest.findUnique).mockResolvedValue(
      makeRecoveryRequest({
        status: 'rejected',
        approvals: [{ adminId: 'admin-1', decision: 'rejected', createdAt: new Date() }],
      }) as any,
    )
    const res = await callGet()
    const data = await res.json()
    expect(data.status).toBe('rejected')
  })

  it('allows an eligible admin signer on the wallet even without a prior decision', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockOtherAdmin as any)
    const res = await callGet()
    expect(res.status).toBe(200)
  })

  it('returns 403 for an admin not in the approval chain', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-3', role: 'admin' } as any)
    vi.mocked(prisma.emergencyRecoveryRequest.findUnique).mockResolvedValue(
      makeRecoveryRequest({ wallet: { signers: [{ userId: 'admin-1' }] } }) as any,
    )
    const res = await callGet()
    expect(res.status).toBe(403)
  })

  it('returns 403 for a non-admin user', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockNonAdmin as any)
    const res = await callGet()
    expect(res.status).toBe(403)
  })

  it('returns 404 when the recovery request does not exist', async () => {
    vi.mocked(prisma.emergencyRecoveryRequest.findUnique).mockResolvedValue(null)
    const res = await callGet('missing')
    expect(res.status).toBe(404)
  })

  it('returns 400 when the id param is blank', async () => {
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: '' }) })
    expect(res.status).toBe(400)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/wallet-signers/emergency-recovery/recovery-1/status'),
      { params: Promise.resolve({ id: 'recovery-1' }) },
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await callGet()
    expect(res.status).toBe(401)
  })

  it('returns 404 when the acting user record is missing', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await callGet()
    expect(res.status).toBe(404)
  })

  it('returns 500 when the database call fails', async () => {
    vi.mocked(prisma.emergencyRecoveryRequest.findUnique).mockRejectedValue(new Error('db down'))
    const res = await callGet()
    expect(res.status).toBe(500)
  })
})

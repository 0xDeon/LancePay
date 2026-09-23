import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findUnique: vi.fn() },
    autoSwapRule: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', privyId: 'privy-1', email: 'user@example.com' }
const mockBankAccount = { id: 'bank-1', userId: 'user-1', bankName: 'Test Bank', accountNumber: '1234567890' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(method: string = 'GET', body?: any): NextRequest {
  return new NextRequest('http://localhost/api/auto-swap-rules', {
    method,
    headers: { authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.bankAccount.findUnique).mockResolvedValue(mockBankAccount as any)
})

describe('GET /api/auto-swap-rules', () => {
  it('returns the auto swap rule for the authenticated user', async () => {
    const mockRule = {
      id: 'rule-1',
      userId: 'user-1',
      percentage: 50,
      bankAccountId: 'bank-1',
      isActive: true,
      bankAccount: mockBankAccount,
    }
    vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.autoSwapRule).toEqual(mockRule)
  })

  it('returns null when no auto swap rule exists', async () => {
    vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.autoSwapRule).toBeNull()
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })
})

describe('POST /api/auto-swap-rules', () => {
  it('creates a new auto swap rule with default isActive=true', async () => {
    const mockNewRule = {
      id: 'rule-1',
      userId: 'user-1',
      percentage: 50,
      bankAccountId: 'bank-1',
      isActive: true,
      bankAccount: mockBankAccount,
    }
    vi.mocked(prisma.autoSwapRule.upsert).mockResolvedValue(mockNewRule as any)

    const res = await POST(makeRequest('POST', { percentage: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.percentage).toBe(50)
    expect(data.isActive).toBe(true)
  })

  it('upserts existing rule instead of failing', async () => {
    const mockUpdatedRule = {
      id: 'rule-1',
      userId: 'user-1',
      percentage: 75,
      bankAccountId: 'bank-1',
      isActive: true,
      bankAccount: mockBankAccount,
    }
    vi.mocked(prisma.autoSwapRule.upsert).mockResolvedValue(mockUpdatedRule as any)

    const res = await POST(makeRequest('POST', { percentage: 75, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.percentage).toBe(75)
    expect(vi.mocked(prisma.autoSwapRule.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        update: expect.any(Object),
        create: expect.any(Object),
      })
    )
  })

  it('validates percentage is between 1 and 100', async () => {
    const res1 = await POST(makeRequest('POST', { percentage: 0, bankAccountId: 'bank-1' }))
    expect(res1.status).toBe(400)
    const data1 = await res1.json()
    expect(data1.error).toBe('Invalid request body')

    const res2 = await POST(makeRequest('POST', { percentage: 101, bankAccountId: 'bank-1' }))
    expect(res2.status).toBe(400)
    const data2 = await res2.json()
    expect(data2.error).toBe('Invalid request body')
  })

  it('returns 404 when bank account does not exist', async () => {
    vi.mocked(prisma.bankAccount.findUnique).mockResolvedValue(null)

    const res = await POST(makeRequest('POST', { percentage: 50, bankAccountId: 'invalid-bank' }))
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('Bank account not found')
  })

  it('returns 403 when bank account does not belong to the user', async () => {
    const otherUserBankAccount = { ...mockBankAccount, userId: 'other-user' }
    vi.mocked(prisma.bankAccount.findUnique).mockResolvedValue(otherUserBankAccount as any)

    const res = await POST(makeRequest('POST', { percentage: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.error).toBe('Bank account does not belong to this user')
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/auto-swap-rules', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'invalid json',
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid JSON body')
  })

  it('returns 400 when percentage is missing', async () => {
    const res = await POST(makeRequest('POST', { bankAccountId: 'bank-1' }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
  })

  it('returns 400 when bankAccountId is missing', async () => {
    const res = await POST(makeRequest('POST', { percentage: 50 }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest('POST', { percentage: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', { percentage: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(404)
  })
})

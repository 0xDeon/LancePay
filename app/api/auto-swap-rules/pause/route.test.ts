import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PATCH } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    autoSwapRule: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const mockRule = {
  id: 'rule-1',
  userId: 'user-1',
  percentage: 50,
  bankAccountId: 'bank-1',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer token' },
    method: 'PATCH',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(mockRule as any)
})

describe('PATCH /api/auto-swap-rules/pause', () => {
  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/auto-swap-rules/pause', {
      method: 'PATCH',
    })
    const res = await PATCH(req)
    expect(res.status).toBe(401)
  })

  it('returns 404 when no AutoSwapRule exists for user', async () => {
    vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(null)
    const res = await PATCH(makeRequest('http://localhost/api/auto-swap-rules/pause'))
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('AutoSwapRule not found')
  })

  it('pauses an active rule', async () => {
    vi.mocked(prisma.autoSwapRule.update).mockResolvedValue({
      ...mockRule,
      isActive: false,
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    } as any)

    const res = await PATCH(makeRequest('http://localhost/api/auto-swap-rules/pause'))
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.isActive).toBe(false)
    expect(vi.mocked(prisma.autoSwapRule.update).mock.calls[0][0]).toEqual({
      where: { userId: 'user-1' },
      data: { isActive: false },
    })
  })

  it('resumes a paused rule', async () => {
    const pausedRule = { ...mockRule, isActive: false }
    vi.mocked(prisma.autoSwapRule.findUnique).mockResolvedValue(pausedRule as any)
    vi.mocked(prisma.autoSwapRule.update).mockResolvedValue({
      ...pausedRule,
      isActive: true,
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    } as any)

    const res = await PATCH(makeRequest('http://localhost/api/auto-swap-rules/pause'))
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.isActive).toBe(true)
    expect(vi.mocked(prisma.autoSwapRule.update).mock.calls[0][0]).toEqual({
      where: { userId: 'user-1' },
      data: { isActive: true },
    })
  })

  it('confirms the new isActive state in response', async () => {
    vi.mocked(prisma.autoSwapRule.update).mockResolvedValue({
      ...mockRule,
      isActive: false,
    } as any)

    const res = await PATCH(makeRequest('http://localhost/api/auto-swap-rules/pause'))
    const data = await res.json()

    expect(data).toHaveProperty('isActive')
    expect(data).toHaveProperty('id')
    expect(data).toHaveProperty('userId')
    expect(data).toHaveProperty('percentage')
    expect(data).toHaveProperty('bankAccountId')
    expect(data).toHaveProperty('createdAt')
    expect(data).toHaveProperty('updatedAt')
  })

  it('queries for rule with correct userId', async () => {
    await PATCH(makeRequest('http://localhost/api/auto-swap-rules/pause'))

    expect(vi.mocked(prisma.autoSwapRule.findUnique).mock.calls[0][0]).toEqual({
      where: { userId: 'user-1' },
    })
  })
})

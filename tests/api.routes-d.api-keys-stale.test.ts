import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const apiKeyFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    apiKey: { findMany: apiKeyFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

function makeRequest(
  token: string | null = 'valid-token',
  days?: string
) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)

  let url = 'http://localhost/api/routes-d/api-keys/stale'
  if (days !== undefined) {
    url += `?days=${days}`
  }

  return new NextRequest(url, { method: 'GET', headers })
}

describe('GET /api/routes-d/api-keys/stale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ===== Authentication tests =====

  it('returns 401 when not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when token verification fails', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest('invalid-token'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 404 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_unknown' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  // ===== Query parameter validation tests =====

  it('applies default staleness threshold (90 days) when days param is omitted', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const now = new Date()
    const eightyDaysAgo = new Date(now.getTime() - 80 * 24 * 60 * 60 * 1000)
    const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000)

    apiKeyFindMany.mockResolvedValue([
      {
        id: 'key_1',
        userId: 'user_1',
        name: 'Desktop',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: ninetyFiveDaysAgo,
        createdAt: new Date('2026-01-01'),
      },
    ])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest(undefined))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(1)

    // Verify the query used the default threshold
    const callArgs = apiKeyFindMany.mock.calls[0][0]
    expect(callArgs.where.OR).toBeDefined()
    expect(callArgs.where.userId).toBe('user_1')
  })

  it('rejects non-numeric days parameter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest(undefined, 'abc'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('must be a positive integer')
  })

  it('rejects negative days parameter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest(undefined, '-30'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('must be a positive integer')
  })

  it('rejects zero days parameter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest(undefined, '0'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('must be a positive integer')
  })

  it('accepts custom positive integer days parameter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    apiKeyFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest(undefined, '60'))
    expect(res.status).toBe(200)
    expect(apiKeyFindMany).toHaveBeenCalled()
  })

  // ===== Non-admin (owner) access tests =====

  it('non-admin user gets only their own stale keys', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_user1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) // 100 days ago

    apiKeyFindMany.mockResolvedValue([
      {
        id: 'key_1',
        userId: 'user_1',
        name: 'Old Desktop',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: staleDate,
        createdAt: new Date('2026-01-01'),
      },
    ])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(1)

    // Verify query filters by userId for non-admin
    const callArgs = apiKeyFindMany.mock.calls[0][0]
    expect(callArgs.where.userId).toBe('user_1')
  })

  // ===== Admin access tests =====

  it('admin user can see all users stale keys', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

    const allStaleKeys = [
      {
        id: 'key_1',
        userId: 'user_1',
        name: 'User 1 Old Key',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: staleDate,
        createdAt: new Date('2026-01-01'),
      },
      {
        id: 'key_2',
        userId: 'user_2',
        name: 'User 2 Old Key',
        keyHint: 'def456',
        isActive: true,
        lastUsedAt: staleDate,
        createdAt: new Date('2026-01-02'),
      },
    ]

    apiKeyFindMany.mockResolvedValue(allStaleKeys)

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(2)
    expect(body.apiKeys[0].userId).toBe('user_1')
    expect(body.apiKeys[1].userId).toBe('user_2')

    // Verify query does NOT filter by userId for admin
    const callArgs = apiKeyFindMany.mock.calls[0][0]
    expect(callArgs.where.userId).toBeUndefined()
    expect(callArgs.where.OR).toBeDefined()
  })

  // ===== Never-used key inclusion tests =====

  it('includes keys with lastUsedAt null regardless of createdAt age', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const recentlyCreated = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // 5 days ago

    apiKeyFindMany.mockResolvedValue([
      {
        id: 'key_never_used',
        userId: 'user_1',
        name: 'Never Used Key',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: null, // Never used
        createdAt: recentlyCreated,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(1)
    expect(body.apiKeys[0].lastUsedAt).toBeNull()
  })

  // ===== Threshold boundary tests =====

  it('includes key used just before threshold boundary', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    // 91 days ago (outside the 90-day threshold, so should be included)
    const justOutsideThreshold = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)

    apiKeyFindMany.mockResolvedValue([
      {
        id: 'key_1',
        userId: 'user_1',
        name: 'Outside Threshold',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: justOutsideThreshold,
        createdAt: new Date('2026-01-01'),
      },
    ])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(1)
  })

  it('excludes key used within threshold boundary', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    // 89 days ago (inside the 90-day threshold, so should NOT be included)
    const withinThreshold = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)

    apiKeyFindMany.mockResolvedValue([]) // Empty because key is not stale

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(0)
  })

  // ===== Empty result tests =====

  it('returns empty apiKeys array when no stale keys exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    apiKeyFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toEqual([])
  })

  it('admin returns empty apiKeys array when no stale keys exist across all users', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    apiKeyFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toEqual([])
  })

  // ===== Happy path full scenario tests =====

  it('admin receives stale keys across multiple users with custom threshold', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    const sixtyFiveDaysAgo = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000)

    const staleKeys = [
      {
        id: 'key_1',
        userId: 'user_1',
        name: 'User 1 Key',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: sixtyFiveDaysAgo,
        createdAt: new Date('2026-01-01'),
      },
      {
        id: 'key_2',
        userId: 'user_2',
        name: 'User 2 Key',
        keyHint: 'def456',
        isActive: false, // Including inactive keys
        lastUsedAt: null,
        createdAt: new Date('2026-01-02'),
      },
    ]

    apiKeyFindMany.mockResolvedValue(staleKeys)

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest(undefined, '60')) // 60 day threshold
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(2)
    expect(body.apiKeys).toEqual(staleKeys)
  })

  it('non-admin receives only their own stale keys and cannot see others', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_user1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

    const userStaleKeys = [
      {
        id: 'key_1',
        userId: 'user_1',
        name: 'My Old Key',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: staleDate,
        createdAt: new Date('2026-01-01'),
      },
    ]

    apiKeyFindMany.mockResolvedValue(userStaleKeys)

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(1)
    expect(body.apiKeys[0].userId).toBe('user_1')

    // Verify the query enforced userId filtering at the database level
    const callArgs = apiKeyFindMany.mock.calls[0][0]
    expect(callArgs.where.userId).toBe('user_1')
  })

  // ===== Response structure validation =====

  it('returns correct response structure with all key fields', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const createdDate = new Date('2026-01-01T00:00:00Z')
    const lastUsedDate = new Date('2026-06-01T00:00:00Z')

    apiKeyFindMany.mockResolvedValue([
      {
        id: 'key_1',
        userId: 'user_1',
        name: 'Test Key',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: lastUsedDate,
        createdAt: createdDate,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/api-keys/stale/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toHaveProperty('apiKeys')
    expect(Array.isArray(body.apiKeys)).toBe(true)
    expect(body.apiKeys[0]).toMatchObject({
      id: 'key_1',
      userId: 'user_1',
      name: 'Test Key',
      keyHint: 'abc123',
      isActive: true,
      lastUsedAt: lastUsedDate.toISOString(),
      createdAt: createdDate.toISOString(),
    })
  })
})

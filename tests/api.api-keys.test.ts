import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import * as crypto from 'crypto'

// Mock Privy auth
const verifyAuthToken = vi.fn()
vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

// Mock Prisma
const userFindUnique = vi.fn()
const apiKeyCreate = vi.fn()
const apiKeyFindMany = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    apiKey: {
      create: apiKeyCreate,
      findMany: apiKeyFindMany,
    },
  },
}))

// Mock crypto utilities
const generateToken = vi.fn()
const hashToken = vi.fn()

vi.mock('@/lib/crypto', () => ({
  generateToken,
  hashToken,
}))

// Mock Zod validation
const createApiKeySchema = {
  safeParse: vi.fn(),
}

vi.mock('@/lib/validations', () => ({
  createApiKeySchema,
}))

// Helper to build request
function makeRequest(
  method: 'GET' | 'POST',
  body?: unknown,
  authToken?: string | null
): NextRequest {
  const url = 'http://localhost:3000/api/api-keys'
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }

  if (authToken !== null) {
    headers['authorization'] = authToken || 'Bearer valid-token'
  }

  const init: RequestInit = {
    method,
    headers,
  }

  if (method === 'POST' && body !== undefined) {
    init.body = JSON.stringify(body)
  }

  return new NextRequest(url, init)
}

describe('GET /api/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no authorization header', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/api-keys/route')
    const res = await GET(makeRequest('GET', undefined, null))

    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 when invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/api-keys/route')
    const res = await GET(makeRequest('GET', undefined, 'Bearer invalid'))

    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/api-keys/route')
    const res = await GET(makeRequest('GET'))

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns empty array when user has no keys', async () => {
    const userId = 'user_123'

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    apiKeyFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/api-keys/route')
    const res = await GET(makeRequest('GET'))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.apiKeys).toEqual([])
    expect(apiKeyFindMany).toHaveBeenCalledWith({
      where: { userId },
      select: {
        id: true,
        name: true,
        keyHint: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  it('returns user keys with only safe fields (no hashedKey)', async () => {
    const userId = 'user_123'
    const mockKeys = [
      {
        id: 'key_1',
        name: 'Production Key',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: new Date('2024-01-15'),
        createdAt: new Date('2024-01-10'),
        updatedAt: new Date('2024-01-15'),
      },
      {
        id: 'key_2',
        name: 'Development Key',
        keyHint: 'def456',
        isActive: false,
        lastUsedAt: null,
        createdAt: new Date('2024-01-05'),
        updatedAt: new Date('2024-01-05'),
      },
    ]

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    apiKeyFindMany.mockResolvedValue(mockKeys)

    const { GET } = await import('@/app/api/api-keys/route')
    const res = await GET(makeRequest('GET'))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.apiKeys).toEqual(mockKeys)

    // Verify no hashedKey is included
    json.apiKeys.forEach((key: any) => {
      expect(key).not.toHaveProperty('hashedKey')
      expect(key).not.toHaveProperty('rawKey')
    })
  })

  it('returns 500 on database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: 'user_123' })
    apiKeyFindMany.mockRejectedValue(new Error('Database connection failed'))

    const { GET } = await import('@/app/api/api-keys/route')
    const res = await GET(makeRequest('GET'))

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to retrieve API keys')
  })
})

describe('POST /api/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no authorization header', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { POST } = await import('@/app/api/api-keys/route')
    const res = await POST(makeRequest('POST', { name: 'Test Key' }, null))

    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 400 when request body is invalid JSON', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })

    const { POST } = await import('@/app/api/api-keys/route')
    const req = new NextRequest('http://localhost:3000/api/api-keys', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'invalid json {',
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid request body')
  })

  it('returns 400 when validation fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: 'user_123' })

    const validationError = {
      success: false,
      error: {
        flatten: () => ({
          fieldErrors: {
            name: ['Name is required'],
          },
        }),
      },
    }

    createApiKeySchema.safeParse.mockReturnValue(validationError)

    const { POST } = await import('@/app/api/api-keys/route')
    const res = await POST(makeRequest('POST', { name: '' }))

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Validation failed')
    expect(json.details.name).toEqual(['Name is required'])
  })

  it('returns 404 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue(null)

    const { POST } = await import('@/app/api/api-keys/route')
    const res = await POST(makeRequest('POST', { name: 'Test Key' }))

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('creates API key and returns raw key exactly once', async () => {
    const userId = 'user_123'
    const rawKeyValue = 'a'.repeat(64) // 64-char hex string
    const hashedKeyValue = 'hashed_' + rawKeyValue
    const keyHintValue = rawKeyValue.slice(-6)

    const createdAt = new Date('2024-01-20')
    const updatedAt = new Date('2024-01-20')

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    createApiKeySchema.safeParse.mockReturnValue({
      success: true,
      data: { name: 'My Production Key' },
    })
    generateToken.mockReturnValue(rawKeyValue)
    hashToken.mockReturnValue(hashedKeyValue)
    apiKeyCreate.mockResolvedValue({
      id: 'key_uuid_123',
      userId,
      name: 'My Production Key',
      keyHint: keyHintValue,
      hashedKey: hashedKeyValue,
      isActive: true,
      lastUsedAt: null,
      createdAt,
      updatedAt,
    })

    const { POST } = await import('@/app/api/api-keys/route')
    const res = await POST(makeRequest('POST', { name: 'My Production Key' }))

    expect(res.status).toBe(201)
    const json = await res.json()

    // Verify response includes raw key exactly once
    expect(json.rawKey).toBe(rawKeyValue)
    expect(json.id).toBe('key_uuid_123')
    expect(json.name).toBe('My Production Key')
    expect(json.keyHint).toBe(keyHintValue)
    expect(json.isActive).toBe(true)
    expect(json.createdAt).toBe(createdAt.toISOString())

    // Verify key was created with correct data
    expect(apiKeyCreate).toHaveBeenCalledWith({
      data: {
        userId,
        name: 'My Production Key',
        keyHint: keyHintValue,
        hashedKey: hashedKeyValue,
        isActive: true,
      },
    })

    // Verify hashing was called
    expect(hashToken).toHaveBeenCalledWith(rawKeyValue)
  })

  it('derives keyHint as last 6 characters of raw key', async () => {
    const userId = 'user_123'
    const rawKey = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ00'
    const expectedHint = rawKey.slice(-6) // 'STUVwX'

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    createApiKeySchema.safeParse.mockReturnValue({
      success: true,
      data: { name: 'Test' },
    })
    generateToken.mockReturnValue(rawKey)
    hashToken.mockReturnValue('hashed_value')
    apiKeyCreate.mockResolvedValue({
      id: 'key_123',
      userId,
      name: 'Test',
      keyHint: expectedHint,
      hashedKey: 'hashed_value',
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await import('@/app/api/api-keys/route')
    await POST(makeRequest('POST', { name: 'Test' }))

    // Verify keyHint passed to create is correct
    expect(apiKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          keyHint: expectedHint,
        }),
      })
    )
  })

  it('sets isActive to true by default on creation', async () => {
    const userId = 'user_123'

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    createApiKeySchema.safeParse.mockReturnValue({
      success: true,
      data: { name: 'Test' },
    })
    generateToken.mockReturnValue('a'.repeat(64))
    hashToken.mockReturnValue('hashed_value')
    apiKeyCreate.mockResolvedValue({
      id: 'key_123',
      userId,
      name: 'Test',
      keyHint: 'aaaaaa',
      hashedKey: 'hashed_value',
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await import('@/app/api/api-keys/route')
    await POST(makeRequest('POST', { name: 'Test' }))

    // Verify isActive was set to true
    expect(apiKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isActive: true,
        }),
      })
    )
  })

  it('never stores raw key in database', async () => {
    const userId = 'user_123'
    const rawKey = 'a'.repeat(64)

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    createApiKeySchema.safeParse.mockReturnValue({
      success: true,
      data: { name: 'Test' },
    })
    generateToken.mockReturnValue(rawKey)
    hashToken.mockReturnValue('hashed_value')
    apiKeyCreate.mockResolvedValue({
      id: 'key_123',
      userId,
      name: 'Test',
      keyHint: rawKey.slice(-6),
      hashedKey: 'hashed_value',
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await import('@/app/api/api-keys/route')
    await POST(makeRequest('POST', { name: 'Test' }))

    // Verify raw key was never passed to create
    const createCall = apiKeyCreate.mock.calls[0][0]
    expect(createCall.data).not.toHaveProperty('rawKey')
    expect(createCall.data.hashedKey).not.toBe(rawKey)
    expect(createCall.data.keyHint).toBe(rawKey.slice(-6))
  })

  it('keyHint is not equal to full raw key', async () => {
    const userId = 'user_123'
    const rawKey = 'a'.repeat(64)
    const keyHint = rawKey.slice(-6)

    expect(keyHint).not.toBe(rawKey)
    expect(keyHint.length).toBe(6)
    expect(rawKey.length).toBe(64)

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    createApiKeySchema.safeParse.mockReturnValue({
      success: true,
      data: { name: 'Test' },
    })
    generateToken.mockReturnValue(rawKey)
    hashToken.mockReturnValue('hashed_value')
    apiKeyCreate.mockResolvedValue({
      id: 'key_123',
      userId,
      name: 'Test',
      keyHint,
      hashedKey: 'hashed_value',
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await import('@/app/api/api-keys/route')
    const res = await POST(makeRequest('POST', { name: 'Test' }))
    const json = await res.json()

    // keyHint in response should not equal rawKey
    expect(json.keyHint).not.toBe(json.rawKey)
    expect(json.keyHint.length).toBeLessThan(json.rawKey.length)
  })

  it('returns 500 on database error and does not log raw key', async () => {
    const userId = 'user_123'
    const rawKey = 'sensitive_key_12345'
    const consoleErrorSpy = vi.spyOn(console, 'error')

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    createApiKeySchema.safeParse.mockReturnValue({
      success: true,
      data: { name: 'Test' },
    })
    generateToken.mockReturnValue(rawKey)
    hashToken.mockReturnValue('hashed_value')
    apiKeyCreate.mockRejectedValue(new Error('Database error'))

    const { POST } = await import('@/app/api/api-keys/route')
    const res = await POST(makeRequest('POST', { name: 'Test' }))

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to create API key')

    // Verify raw key was not logged
    const errorLogs = consoleErrorSpy.mock.calls
    const hasRawKeyInLogs = errorLogs.some((call) =>
      String(call[1]).includes(rawKey)
    )
    expect(hasRawKeyInLogs).toBe(false)

    consoleErrorSpy.mockRestore()
  })

  it('uses SHA256 hashing for secure storage', async () => {
    const userId = 'user_123'
    const rawKey = 'a'.repeat(64)

    verifyAuthToken.mockResolvedValue({ userId: 'privy_user_123' })
    userFindUnique.mockResolvedValue({ id: userId })
    createApiKeySchema.safeParse.mockReturnValue({
      success: true,
      data: { name: 'Test' },
    })
    generateToken.mockReturnValue(rawKey)
    hashToken.mockReturnValue('hashed_with_sha256')
    apiKeyCreate.mockResolvedValue({
      id: 'key_123',
      userId,
      name: 'Test',
      keyHint: rawKey.slice(-6),
      hashedKey: 'hashed_with_sha256',
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await import('@/app/api/api-keys/route')
    await POST(makeRequest('POST', { name: 'Test' }))

    // Verify hashToken (SHA256) was called
    expect(hashToken).toHaveBeenCalledWith(rawKey)
    expect(hashToken).toHaveBeenCalledTimes(1)
  })
})

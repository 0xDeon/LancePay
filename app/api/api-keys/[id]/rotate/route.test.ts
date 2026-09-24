import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/crypto', () => ({
  generateToken: vi.fn(),
  hashToken: vi.fn(),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateToken, hashToken } from '@/lib/crypto'

const mockUser = { id: 'user-1', privyId: 'privy-1', email: 'user@example.com' }
const mockClaims = { userId: 'privy-1' }
const mockOldApiKey = {
  id: 'key-1',
  userId: 'user-1',
  name: 'Production Key',
  isActive: true,
}
const mockRawToken = 'test-token-1234567890abcdef-test-token'
const mockHashedToken = 'hashed-test-token-1234567890abcdef'
const mockKeyHint = 'test-to...cdef'

function makeRequest(method: string = 'POST', keyId: string = 'key-1'): NextRequest {
  return new NextRequest(`http://localhost/api/api-keys/${keyId}/rotate`, {
    method,
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(generateToken).mockReturnValue(mockRawToken)
  vi.mocked(hashToken).mockReturnValue(mockHashedToken)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/api-keys/[id]/rotate', () => {
  describe('Happy Path', () => {
    it('successfully rotates an API key with grace period', async () => {
      const newApiKeyResponse = {
        id: 'key-2',
        name: 'Production Key',
        keyHint: mockKeyHint,
        isActive: true,
        createdAt: new Date(),
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      // Mock transaction
      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        return callback({
          apiKey: {
            create: vi.fn().mockResolvedValue(newApiKeyResponse),
            update: vi.fn().mockResolvedValue({}),
          },
        })
      })

      const res = await POST(makeRequest())
      expect(res.status).toBe(201)

      const data = await res.json()
      expect(data.message).toBe('API key rotated successfully')
      expect(data.newApiKey.rawKey).toBe(mockRawToken)
      expect(data.newApiKey.keyHint).toBe(mockKeyHint)
      expect(data.newApiKey.isActive).toBe(true)
      expect(data.graceInfo.gracePeriodHours).toBe(24)
      expect(data.graceInfo.oldKeyDeactivatesAt).toBeDefined()
    })

    it('returns new key raw value exactly once in response', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        return callback({
          apiKey: {
            create: vi.fn().mockResolvedValue({
              id: 'key-2',
              name: 'Production Key',
              keyHint: mockKeyHint,
              isActive: true,
              createdAt: new Date(),
            }),
            update: vi.fn(),
          },
        })
      })

      const res = await POST(makeRequest())
      const data = await res.json()

      // Verify raw key is in response
      expect(data.newApiKey.rawKey).toBe(mockRawToken)

      // Verify it uses generateToken and hashToken
      expect(generateToken).toHaveBeenCalled()
      expect(hashToken).toHaveBeenCalledWith(mockRawToken)
    })

    it('schedules old key deactivation with 24-hour grace period', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      let updateCall: any
      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        const tx = {
          apiKey: {
            create: vi.fn().mockResolvedValue({
              id: 'key-2',
              name: 'Production Key',
              keyHint: mockKeyHint,
              isActive: true,
              createdAt: new Date(),
            }),
            update: vi.fn().mockImplementation((args) => {
              updateCall = args
              return Promise.resolve({})
            }),
          },
        }
        return callback(tx)
      })

      const beforeRotation = Date.now()
      const res = await POST(makeRequest())
      const afterRotation = Date.now()

      expect(res.status).toBe(201)
      expect(updateCall).toBeDefined()
      expect(updateCall.where.id).toBe('key-1')

      // Verify deactivatesAt is approximately 24 hours in future
      const deactivatesAtTime = updateCall.data.deactivatesAt.getTime()
      const expectedTime = beforeRotation + 24 * 60 * 60 * 1000
      const tolerance = 5000 // 5 second tolerance

      expect(deactivatesAtTime).toBeGreaterThan(expectedTime - tolerance)
      expect(deactivatesAtTime).toBeLessThan(expectedTime + tolerance)
    })

    it('keeps old key isActive=true during grace period (only sets deactivatesAt)', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      let updateCall: any
      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        const tx = {
          apiKey: {
            create: vi.fn().mockResolvedValue({
              id: 'key-2',
              name: 'Production Key',
              keyHint: mockKeyHint,
              isActive: true,
              createdAt: new Date(),
            }),
            update: vi.fn().mockImplementation((args) => {
              updateCall = args
              return Promise.resolve({})
            }),
          },
        }
        return callback(tx)
      })

      await POST(makeRequest())

      // Verify old key update only sets deactivatesAt, not isActive
      expect(updateCall.data.deactivatesAt).toBeDefined()
      expect(updateCall.data.isActive).toBeUndefined()
    })

    it('creates new key with same name as old key', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      let createCall: any
      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        const tx = {
          apiKey: {
            create: vi.fn().mockImplementation((args) => {
              createCall = args
              return Promise.resolve({
                id: 'key-2',
                name: mockOldApiKey.name,
                keyHint: mockKeyHint,
                isActive: true,
                createdAt: new Date(),
              })
            }),
            update: vi.fn(),
          },
        }
        return callback(tx)
      })

      await POST(makeRequest())

      expect(createCall.data.name).toBe(mockOldApiKey.name)
      expect(createCall.data.userId).toBe(mockUser.id)
      expect(createCall.data.hashedKey).toBe(mockHashedToken)
      expect(createCall.data.keyHint).toBe(mockKeyHint)
      expect(createCall.data.isActive).toBe(true)
      expect(createCall.data.deactivatesAt).toBeNull()
    })
  })

  describe('Authorization & Ownership', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

      const res = await POST(makeRequest())
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      const res = await POST(makeRequest())
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('User not found')
    })

    it('returns 403 when rotating another user\'s key', async () => {
      const otherUserKey = { ...mockOldApiKey, userId: 'other-user' }
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(otherUserKey as any)

      const res = await POST(makeRequest())
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data.error).toContain('Forbidden')
      expect(data.error).toContain('do not own')
    })

    it('returns 404 when API key does not exist', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null)

      const res = await POST(makeRequest())
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('API key not found')
    })
  })

  describe('Inactive Key Handling', () => {
    it('returns 400 when rotating an inactive key', async () => {
      const inactiveKey = { ...mockOldApiKey, isActive: false }
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(inactiveKey as any)

      const res = await POST(makeRequest())
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Cannot rotate')
      expect(data.error).toContain('inactive')
    })
  })

  describe('Atomicity & Transaction', () => {
    it('executes create and update within a single transaction', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      const transactionCallback = vi.fn()
      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        transactionCallback(callback)
        const tx = {
          apiKey: {
            create: vi.fn().mockResolvedValue({
              id: 'key-2',
              name: 'Production Key',
              keyHint: mockKeyHint,
              isActive: true,
              createdAt: new Date(),
            }),
            update: vi.fn(),
          },
        }
        return callback(tx)
      })

      await POST(makeRequest())

      expect(vi.mocked(prisma.$transaction)).toHaveBeenCalled()
      expect(transactionCallback).toHaveBeenCalled()
    })

    it('returns 500 on transaction error with safe error message', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)
      vi.mocked(prisma.$transaction).mockRejectedValue(new Error('Database error'))

      const res = await POST(makeRequest())
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Failed to rotate API key. Please try again.')

      // Verify raw key is never exposed in error
      expect(JSON.stringify(data)).not.toContain(mockRawToken)
    })

    it('does not expose raw key in error logs', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)
      vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB failed'))

      await POST(makeRequest())

      // Verify error log doesn't contain raw key
      const errorLogCall = consoleErrorSpy.mock.calls[0]
      if (errorLogCall) {
        const logString = JSON.stringify(errorLogCall)
        expect(logString).not.toContain(mockRawToken)
      }

      consoleErrorSpy.mockRestore()
    })
  })

  describe('Grace Period Validation', () => {
    it('returns grace period info in response', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        return callback({
          apiKey: {
            create: vi.fn().mockResolvedValue({
              id: 'key-2',
              name: 'Production Key',
              keyHint: mockKeyHint,
              isActive: true,
              createdAt: new Date(),
            }),
            update: vi.fn(),
          },
        })
      })

      const res = await POST(makeRequest())
      const data = await res.json()

      expect(data.graceInfo).toBeDefined()
      expect(data.graceInfo.oldKeyDeactivatesAt).toBeDefined()
      expect(data.graceInfo.gracePeriodHours).toBe(24)
      expect(data.graceInfo.message).toContain('grace period')
    })
  })

  describe('Key Generation & Hashing', () => {
    it('generates new key with correct hint format', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      // Mock custom token and hash
      const customToken = 'abcdefgh1234567890ijklmnopqrstuv'
      const customHash = 'hash-of-custom-token'
      const expectedHint = customToken.slice(0, 8) + '...' + customToken.slice(-4)

      vi.mocked(generateToken).mockReturnValue(customToken)
      vi.mocked(hashToken).mockReturnValue(customHash)

      let createCall: any
      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        const tx = {
          apiKey: {
            create: vi.fn().mockImplementation((args) => {
              createCall = args
              return Promise.resolve({
                id: 'key-2',
                name: 'Production Key',
                keyHint: expectedHint,
                isActive: true,
                createdAt: new Date(),
              })
            }),
            update: vi.fn(),
          },
        }
        return callback(tx)
      })

      await POST(makeRequest())

      expect(createCall.data.keyHint).toBe(expectedHint)
      expect(generateToken).toHaveBeenCalled()
      expect(hashToken).toHaveBeenCalledWith(customToken)
    })
  })

  describe('Request Validation', () => {
    it('extracts keyId from URL parameters correctly', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      const customKeyId = 'custom-key-id-12345'
      const res = await POST(makeRequest('POST', customKeyId))

      expect(vi.mocked(prisma.apiKey.findUnique)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: customKeyId },
        })
      )
    })
  })

  describe('Response Format', () => {
    it('returns 201 Created status', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        return callback({
          apiKey: {
            create: vi.fn().mockResolvedValue({
              id: 'key-2',
              name: 'Production Key',
              keyHint: mockKeyHint,
              isActive: true,
              createdAt: new Date(),
            }),
            update: vi.fn(),
          },
        })
      })

      const res = await POST(makeRequest())
      expect(res.status).toBe(201)
    })

    it('response includes all required fields', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldApiKey as any)

      const createdDate = new Date()
      vi.mocked(prisma.$transaction).mockImplementation((callback: any) => {
        return callback({
          apiKey: {
            create: vi.fn().mockResolvedValue({
              id: 'key-2',
              name: 'Production Key',
              keyHint: mockKeyHint,
              isActive: true,
              createdAt: createdDate,
            }),
            update: vi.fn(),
          },
        })
      })

      const res = await POST(makeRequest())
      const data = await res.json()

      expect(data.message).toBeDefined()
      expect(data.newApiKey).toBeDefined()
      expect(data.newApiKey.rawKey).toBeDefined()
      expect(data.newApiKey.id).toBeDefined()
      expect(data.newApiKey.name).toBeDefined()
      expect(data.newApiKey.keyHint).toBeDefined()
      expect(data.newApiKey.isActive).toBeDefined()
      expect(data.newApiKey.createdAt).toBeDefined()
      expect(data.graceInfo).toBeDefined()
    })
  })
})

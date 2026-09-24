import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    whitelistAddress: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/stellar', () => ({
  isValidStellarAddress: vi.fn(),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { isValidStellarAddress } from '@/lib/stellar'

const mockUser = { id: 'user-1', privyId: 'privy-1', email: 'user@example.com' }
const mockClaims = { userId: 'privy-1' }

const VALID_STELLAR_ADDRESS = 'GBRPYHIL2CI3WHSKEYNEM2QN5BQ5Q5M5MSGKMP4ZWTIALO47ZG5RHFA'
const VALID_BANK_ADDRESS = '1234567890'

function makeRequest(method: string = 'GET', body?: any): NextRequest {
  return new NextRequest('http://localhost/api/whitelist-addresses', {
    method,
    headers: { authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(isValidStellarAddress).mockReturnValue(true)
})

describe('GET /api/whitelist-addresses', () => {
  it('returns all whitelisted addresses for the authenticated user', async () => {
    const mockAddresses = [
      {
        id: 'addr-1',
        userId: 'user-1',
        label: 'Main Stellar Wallet',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
        createdAt: new Date('2026-09-20T00:00:00Z'),
        activatesAt: new Date('2026-09-21T00:00:00Z'),
        updatedAt: new Date('2026-09-20T00:00:00Z'),
      },
      {
        id: 'addr-2',
        userId: 'user-1',
        label: 'My Bank Account',
        address: VALID_BANK_ADDRESS,
        network: 'bank',
        createdAt: new Date('2026-09-19T00:00:00Z'),
        activatesAt: new Date('2026-09-20T00:00:00Z'),
        updatedAt: new Date('2026-09-19T00:00:00Z'),
      },
    ]
    vi.mocked(prisma.whitelistAddress.findMany).mockResolvedValue(mockAddresses as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.whitelistAddresses).toHaveLength(2)
    expect(data.whitelistAddresses[0].label).toBe('Main Stellar Wallet')
    expect(data.whitelistAddresses[1].label).toBe('My Bank Account')
  })

  it('returns empty array when user has no whitelist addresses', async () => {
    vi.mocked(prisma.whitelistAddress.findMany).mockResolvedValue([])

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.whitelistAddresses).toEqual([])
  })

  it('returns addresses ordered by createdAt descending', async () => {
    const mockAddresses = [
      {
        id: 'addr-1',
        userId: 'user-1',
        label: 'Newer',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
        createdAt: new Date('2026-09-20T12:00:00Z'),
        activatesAt: new Date('2026-09-21T12:00:00Z'),
        updatedAt: new Date('2026-09-20T12:00:00Z'),
      },
      {
        id: 'addr-2',
        userId: 'user-1',
        label: 'Older',
        address: VALID_BANK_ADDRESS,
        network: 'bank',
        createdAt: new Date('2026-09-19T12:00:00Z'),
        activatesAt: new Date('2026-09-20T12:00:00Z'),
        updatedAt: new Date('2026-09-19T12:00:00Z'),
      },
    ]
    vi.mocked(prisma.whitelistAddress.findMany).mockResolvedValue(mockAddresses as any)

    const res = await GET(makeRequest())
    const data = await res.json()
    expect(data.whitelistAddresses[0].label).toBe('Newer')
    expect(data.whitelistAddresses[1].label).toBe('Older')
    expect(vi.mocked(prisma.whitelistAddress.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      })
    )
  })

  it('returns only the authenticated user\'s addresses, not other users\'', async () => {
    const mockAddresses = [
      {
        id: 'addr-1',
        userId: 'user-1',
        label: 'My Address',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
        createdAt: new Date('2026-09-20T00:00:00Z'),
        activatesAt: new Date('2026-09-21T00:00:00Z'),
        updatedAt: new Date('2026-09-20T00:00:00Z'),
      },
    ]
    vi.mocked(prisma.whitelistAddress.findMany).mockResolvedValue(mockAddresses as any)

    await GET(makeRequest())

    expect(vi.mocked(prisma.whitelistAddress.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
      })
    )
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('User not found')
  })
})

describe('POST /api/whitelist-addresses', () => {
  it('creates a Stellar whitelist address with correct activation timestamp', async () => {
    const mockCreated = {
      id: 'addr-1',
      userId: 'user-1',
      label: 'My Stellar Wallet',
      address: VALID_STELLAR_ADDRESS,
      network: 'stellar',
      createdAt: new Date('2026-09-20T10:00:00Z'),
      activatesAt: new Date('2026-09-21T10:00:00Z'),
      updatedAt: new Date('2026-09-20T10:00:00Z'),
    }
    vi.mocked(prisma.whitelistAddress.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.whitelistAddress.create).mockResolvedValue(mockCreated as any)

    const res = await POST(
      makeRequest('POST', {
        label: 'My Stellar Wallet',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
      })
    )

    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.id).toBe('addr-1')
    expect(data.address).toBe(VALID_STELLAR_ADDRESS)
    expect(data.network).toBe('stellar')
    expect(data.activatesAt).toBe('2026-09-21T10:00:00.000Z')
    expect(data.message).toContain('24 hour cooldown')
  })

  it('creates a bank whitelist address with correct activation timestamp', async () => {
    const mockCreated = {
      id: 'addr-2',
      userId: 'user-1',
      label: 'My Bank Account',
      address: VALID_BANK_ADDRESS,
      network: 'bank',
      createdAt: new Date('2026-09-20T10:00:00Z'),
      activatesAt: new Date('2026-09-21T10:00:00Z'),
      updatedAt: new Date('2026-09-20T10:00:00Z'),
    }
    vi.mocked(prisma.whitelistAddress.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.whitelistAddress.create).mockResolvedValue(mockCreated as any)

    const res = await POST(
      makeRequest('POST', {
        label: 'My Bank Account',
        address: VALID_BANK_ADDRESS,
        network: 'bank',
      })
    )

    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.address).toBe(VALID_BANK_ADDRESS)
    expect(data.network).toBe('bank')
    expect(data.activatesAt).toBe('2026-09-21T10:00:00.000Z')
  })

  it('rejects invalid Stellar address with 400', async () => {
    vi.mocked(isValidStellarAddress).mockReturnValue(false)

    const res = await POST(
      makeRequest('POST', {
        label: 'Invalid Stellar',
        address: 'INVALID_ADDRESS',
        network: 'stellar',
      })
    )

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Invalid Stellar address')
  })

  it('rejects invalid bank account format (not 10 digits) with 400', async () => {
    const res1 = await POST(
      makeRequest('POST', {
        label: 'Invalid Bank',
        address: '123456789', // only 9 digits
        network: 'bank',
      })
    )
    expect(res1.status).toBe(400)
    const data1 = await res1.json()
    expect(data1.error).toContain('Invalid bank account format')

    const res2 = await POST(
      makeRequest('POST', {
        label: 'Invalid Bank',
        address: 'abcd1234567', // non-numeric
        network: 'bank',
      })
    )
    expect(res2.status).toBe(400)
    const data2 = await res2.json()
    expect(data2.error).toContain('Invalid bank account format')
  })

  it('rejects mismatched network and address combo with 400', async () => {
    vi.mocked(isValidStellarAddress).mockReturnValue(false)

    const res = await POST(
      makeRequest('POST', {
        label: 'Mismatched',
        address: VALID_BANK_ADDRESS,
        network: 'stellar', // wrong network for bank address
      })
    )

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Invalid Stellar address')
  })

  it('returns 409 Conflict when duplicate address (same userId + address) already exists', async () => {
    const existingAddress = {
      id: 'addr-1',
      userId: 'user-1',
      label: 'Existing',
      address: VALID_STELLAR_ADDRESS,
      network: 'stellar',
      createdAt: new Date('2026-09-19T00:00:00Z'),
      activatesAt: new Date('2026-09-20T00:00:00Z'),
      updatedAt: new Date('2026-09-19T00:00:00Z'),
    }
    vi.mocked(prisma.whitelistAddress.findFirst).mockResolvedValue(existingAddress as any)

    const res = await POST(
      makeRequest('POST', {
        label: 'New Label',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
      })
    )

    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toContain('already whitelisted')
  })

  it('returns 400 for missing label', async () => {
    const res = await POST(
      makeRequest('POST', {
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
      })
    )

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
    expect(data.details.label).toBeDefined()
  })

  it('returns 400 for missing address', async () => {
    const res = await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        network: 'stellar',
      })
    )

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
    expect(data.details.address).toBeDefined()
  })

  it('returns 400 for missing network', async () => {
    const res = await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        address: VALID_STELLAR_ADDRESS,
      })
    )

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
    expect(data.details.network).toBeDefined()
  })

  it('returns 400 for invalid network enum', async () => {
    const res = await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        address: VALID_STELLAR_ADDRESS,
        network: 'invalid_network',
      })
    )

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
    expect(data.details.network).toBeDefined()
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/whitelist-addresses', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'invalid json',
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid JSON body')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

    const res = await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
      })
    )

    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    const res = await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
      })
    )

    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('User not found')
  })

  it('trims whitespace from address on creation', async () => {
    const mockCreated = {
      id: 'addr-1',
      userId: 'user-1',
      label: 'My Wallet',
      address: VALID_STELLAR_ADDRESS,
      network: 'stellar',
      createdAt: new Date('2026-09-20T10:00:00Z'),
      activatesAt: new Date('2026-09-21T10:00:00Z'),
      updatedAt: new Date('2026-09-20T10:00:00Z'),
    }
    vi.mocked(prisma.whitelistAddress.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.whitelistAddress.create).mockResolvedValue(mockCreated as any)

    const res = await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        address: `  ${VALID_STELLAR_ADDRESS}  `,
        network: 'stellar',
      })
    )

    expect(res.status).toBe(201)
    expect(vi.mocked(prisma.whitelistAddress.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          address: VALID_STELLAR_ADDRESS,
        }),
      })
    )
  })

  it('checks for duplicates using trimmed address', async () => {
    vi.mocked(prisma.whitelistAddress.findFirst).mockResolvedValue(null)

    await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        address: `  ${VALID_STELLAR_ADDRESS}  `,
        network: 'stellar',
      })
    )

    expect(vi.mocked(prisma.whitelistAddress.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          address: VALID_STELLAR_ADDRESS,
        }),
      })
    )
  })

  it('activatesAt is set exactly 24 hours after createdAt', async () => {
    const mockCreated = {
      id: 'addr-1',
      userId: 'user-1',
      label: 'My Wallet',
      address: VALID_STELLAR_ADDRESS,
      network: 'stellar',
      createdAt: new Date('2026-09-20T15:30:45Z'),
      activatesAt: new Date('2026-09-21T15:30:45Z'),
      updatedAt: new Date('2026-09-20T15:30:45Z'),
    }
    vi.mocked(prisma.whitelistAddress.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.whitelistAddress.create).mockResolvedValue(mockCreated as any)

    const res = await POST(
      makeRequest('POST', {
        label: 'My Wallet',
        address: VALID_STELLAR_ADDRESS,
        network: 'stellar',
      })
    )

    const data = await res.json()
    const createdTime = new Date(data.createdAt).getTime()
    const activatesTime = new Date(data.activatesAt).getTime()
    const cooldownMs = activatesTime - createdTime

    // Should be 24 hours = 86400000 milliseconds
    expect(cooldownMs).toBe(24 * 60 * 60 * 1000)
  })
})

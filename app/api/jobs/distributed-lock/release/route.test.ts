import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const lockFindUnique = vi.fn()
const lockUpdateMany = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    distributedJobLock: {
      findUnique: lockFindUnique,
      updateMany: lockUpdateMany,
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function makeRequest(body: unknown = { lockName: 'invoice-sync', lockToken: 'holder-token' }) {
  return new NextRequest('http://localhost/api/jobs/distributed-lock/release', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/jobs/distributed-lock/release', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lockFindUnique.mockResolvedValue({
      id: 'lock-1',
      tokenHash: tokenHash('holder-token'),
      previousTokenHashes: [],
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
    lockUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('atomically releases a lock held by the presented token', async () => {
    const { POST } = await import('./route')
    const response = await POST(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ lockName: 'invoice-sync', state: 'released', released: true })
    expect(lockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'lock-1', tokenHash: tokenHash('holder-token') },
      data: expect.objectContaining({
        tokenHash: null,
        previousTokenHashes: { push: tokenHash('holder-token') },
        holderId: null,
        expiresAt: null,
      }),
    })
  })

  it('rejects a token that does not belong to the current holder', async () => {
    const { POST } = await import('./route')
    const response = await POST(
      makeRequest({ lockName: 'invoice-sync', lockToken: 'different-token' }),
    )

    expect(response.status).toBe(403)
    expect(lockUpdateMany).not.toHaveBeenCalled()
  })

  it('returns already_released when the same token is used twice', async () => {
    lockFindUnique.mockResolvedValue({
      id: 'lock-1',
      tokenHash: null,
      previousTokenHashes: [tokenHash('holder-token')],
      expiresAt: null,
    })

    const { POST } = await import('./route')
    const response = await POST(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      lockName: 'invoice-sync',
      state: 'already_released',
      released: false,
      reason: 'released',
    })
    expect(lockUpdateMany).not.toHaveBeenCalled()
  })

  it('returns already_released for an expired prior holder after reassignment', async () => {
    lockFindUnique.mockResolvedValue({
      id: 'lock-1',
      tokenHash: tokenHash('new-holder-token'),
      previousTokenHashes: [tokenHash('holder-token')],
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })

    const { POST } = await import('./route')
    const response = await POST(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.state).toBe('already_released')
    expect(body.reason).toBe('expired_or_reassigned')
    expect(lockUpdateMany).not.toHaveBeenCalled()
  })

  it('clears an expired current lock and reports it as already released', async () => {
    lockFindUnique.mockResolvedValue({
      id: 'lock-1',
      tokenHash: tokenHash('holder-token'),
      previousTokenHashes: [],
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    })

    const { POST } = await import('./route')
    const response = await POST(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.state).toBe('already_released')
    expect(lockUpdateMany).toHaveBeenCalledOnce()
  })

  it('returns already_released when the lock no longer exists', async () => {
    lockFindUnique.mockResolvedValue(null)

    const { POST } = await import('./route')
    const response = await POST(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ state: 'already_released', reason: 'not_found' })
  })

  it('requires both the lock name and token', async () => {
    const { POST } = await import('./route')
    const response = await POST(makeRequest({ lockName: 'invoice-sync' }))

    expect(response.status).toBe(400)
    expect(lockFindUnique).not.toHaveBeenCalled()
  })

  it('returns 500 when persistence fails', async () => {
    lockUpdateMany.mockRejectedValue(new Error('database unavailable'))

    const { POST } = await import('./route')
    const response = await POST(makeRequest())

    expect(response.status).toBe(500)
  })
})

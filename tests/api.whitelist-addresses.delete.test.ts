import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const whitelistAddressFindFirst = vi.fn()
const whitelistAddressDelete = vi.fn()
const loggerInfo = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    whitelistAddress: { findFirst: whitelistAddressFindFirst, delete: whitelistAddressDelete },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: loggerInfo, error: loggerError } }))

function deleteReq(id: string) {
  return new NextRequest(`http://localhost/api/whitelist-addresses/${id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer tok' },
  })
}

describe('DELETE /api/whitelist-addresses/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/whitelist-addresses/[id]/route')
    const res = await DELETE(
      new NextRequest('http://localhost/api/whitelist-addresses/wa1', { method: 'DELETE' }),
      { params: { id: 'wa1' } },
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 404 when whitelisted address not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    whitelistAddressFindFirst.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/whitelist-addresses/[id]/route')
    const res = await DELETE(deleteReq('gone'), { params: { id: 'gone' } })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Whitelisted address not found')
  })

  it('returns 404 when whitelisted address belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    // Simulate address belonging to user_2, not user_1
    whitelistAddressFindFirst.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/whitelist-addresses/[id]/route')
    const res = await DELETE(deleteReq('wa1'), { params: { id: 'wa1' } })
    expect(res.status).toBe(404)
    // Verify that we queried with both id and userId (ownership check)
    expect(whitelistAddressFindFirst).toHaveBeenCalledWith({
      where: { id: 'wa1', userId: 'user_1' },
    })
  })

  it('deletes the whitelisted address and returns 204', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    whitelistAddressFindFirst.mockResolvedValue({
      id: 'wa1',
      userId: 'user_1',
      label: 'My Wallet',
      address: 'GD7Q3TJLAXJF3E4Z5EKS4L2JFQJVQBH2QZ5GYBGJHP3KWDQO3LNI7WO',
      network: 'stellar',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    whitelistAddressDelete.mockResolvedValue({ id: 'wa1' })
    const { DELETE } = await import('@/app/api/whitelist-addresses/[id]/route')
    const res = await DELETE(deleteReq('wa1'), { params: { id: 'wa1' } })
    expect(res.status).toBe(204)
    expect(whitelistAddressDelete).toHaveBeenCalledWith({ where: { id: 'wa1' } })
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_1',
        addressId: 'wa1',
      }),
      'DELETE /api/whitelist-addresses/[id]',
    )
  })

  it('returns 400 when address ID is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { DELETE } = await import('@/app/api/whitelist-addresses/[id]/route')
    const res = await DELETE(deleteReq(''), { params: { id: '' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Address ID is required')
  })

  it('returns 500 on database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    whitelistAddressFindFirst.mockRejectedValue(new Error('DB connection lost'))
    const { DELETE } = await import('@/app/api/whitelist-addresses/[id]/route')
    const res = await DELETE(deleteReq('wa1'), { params: { id: 'wa1' } })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to remove whitelisted address')
    expect(loggerError).toHaveBeenCalled()
  })

  it('is safe to delete even with in-flight withdrawals (withdrawal has snapshot address)', async () => {
    // This test documents the design decision: withdrawals store
    // a snapshot of the address value at creation time (withdrawAddress field),
    // not a foreign key reference to WhitelistAddress. Therefore, deleting
    // a WhitelistAddress does not affect in-flight withdrawals.
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    whitelistAddressFindFirst.mockResolvedValue({
      id: 'wa1',
      userId: 'user_1',
      label: 'My Wallet',
      address: 'GD7Q3TJLAXJF3E4Z5EKS4L2JFQJVQBH2QZ5GYBGJHP3KWDQO3LNI7WO',
      network: 'stellar',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    whitelistAddressDelete.mockResolvedValue({ id: 'wa1' })
    const { DELETE } = await import('@/app/api/whitelist-addresses/[id]/route')
    const res = await DELETE(deleteReq('wa1'), { params: { id: 'wa1' } })
    // Deletion succeeds without checking for in-flight withdrawals
    // because the withdrawal has already captured the address value
    expect(res.status).toBe(204)
    expect(whitelistAddressDelete).toHaveBeenCalled()
  })
})

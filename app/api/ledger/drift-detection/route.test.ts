import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const walletFindMany = vi.fn()
const findingCreate = vi.fn()
const getAccountBalance = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    wallet: { findMany: walletFindMany },
    ledgerDriftFinding: { create: findingCreate },
  },
}))
vi.mock('@/lib/stellar', () => ({ getAccountBalance }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function makeRequest(token: string | null = 'token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/ledger/drift-detection', { headers })
}

describe('GET /api/ledger/drift-detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy-admin' })
    userFindUnique.mockResolvedValue({ id: 'admin-1', role: 'admin' })
  })

  it('reports and persists drift sorted by absolute amount descending', async () => {
    walletFindMany.mockResolvedValue([
      {
        id: 'wallet-small',
        address: 'G-SMALL',
        user: {
          id: 'user-small',
          email: 'small@example.com',
          transactions: [{ amount: 100, status: 'completed', type: 'payment' }],
        },
      },
      {
        id: 'wallet-large',
        address: 'G-LARGE',
        user: {
          id: 'user-large',
          email: 'large@example.com',
          transactions: [
            { amount: 200, status: 'completed', type: 'payment' },
            { amount: 20, status: 'completed', type: 'withdrawal' },
          ],
        },
      },
    ])
    getAccountBalance
      .mockResolvedValueOnce([{ asset_code: 'USDC', balance: '103' }])
      .mockResolvedValueOnce([{ asset_code: 'USDC', balance: '150' }])
    findingCreate
      .mockResolvedValueOnce({ id: 'finding-small', detectedAt: new Date('2026-09-24T00:00:00Z') })
      .mockResolvedValueOnce({ id: 'finding-large', detectedAt: new Date('2026-09-24T00:00:01Z') })

    const { GET } = await import('./route')
    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.driftedWallets).toBe(2)
    expect(body.comparisons.map((entry: { userId: string }) => entry.userId)).toEqual([
      'user-large',
      'user-small',
    ])
    expect(body.comparisons[0]).toMatchObject({
      ledgerBalance: 180,
      onChainBalance: 150,
      driftAmount: -30,
      findingId: 'finding-large',
    })
    expect(findingCreate).toHaveBeenCalledTimes(2)
  })

  it('uses pending transfers as tolerance and does not persist tolerated drift', async () => {
    walletFindMany.mockResolvedValue([
      {
        id: 'wallet-1',
        address: 'G-WALLET',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          transactions: [
            { amount: 100, status: 'completed', type: 'payment' },
            { amount: 5, status: 'pending', type: 'withdrawal' },
          ],
        },
      },
    ])
    getAccountBalance.mockResolvedValue([{ asset_code: 'USDC', balance: '96' }])

    const { GET } = await import('./route')
    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.comparisons[0]).toMatchObject({
      driftAmount: -4,
      tolerance: 5,
      hasDrift: false,
      findingId: null,
    })
    expect(findingCreate).not.toHaveBeenCalled()
  })

  it('rejects callers outside admin and finance roles', async () => {
    userFindUnique.mockResolvedValue({ id: 'user-1', role: 'freelancer' })

    const { GET } = await import('./route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(403)
    expect(walletFindMany).not.toHaveBeenCalled()
  })

  it('returns 401 without an authentication token', async () => {
    const { GET } = await import('./route')
    const response = await GET(makeRequest(null))

    expect(response.status).toBe(401)
    expect(verifyAuthToken).not.toHaveBeenCalled()
  })

  it('returns 500 when a live on-chain balance cannot be read', async () => {
    walletFindMany.mockResolvedValue([
      {
        id: 'wallet-1',
        address: 'G-WALLET',
        user: { id: 'user-1', email: 'user@example.com', transactions: [] },
      },
    ])
    getAccountBalance.mockRejectedValue(new Error('Horizon unavailable'))

    const { GET } = await import('./route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(500)
    expect(findingCreate).not.toHaveBeenCalled()
  })
})

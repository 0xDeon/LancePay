import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const findingFindUnique = vi.fn()
const proposalFindFirst = vi.fn()
const proposalCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    ledgerDriftFinding: { findUnique: findingFindUnique },
    ledgerDriftCorrectionProposal: {
      findFirst: proposalFindFirst,
      create: proposalCreate,
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function makeRequest(
  body: unknown = { driftFindingId: 'finding-1', reason: 'Align ledger to wallet balance' },
  token: string | null = 'token',
) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/ledger/drift-corrections/propose', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/ledger/drift-corrections/propose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy-finance' })
    userFindUnique.mockResolvedValue({ id: 'finance-1', role: 'finance' })
    findingFindUnique.mockResolvedValue({
      id: 'finding-1',
      driftAmount: { toString: () => '-12.5000000' },
      currency: 'USDC',
      status: 'open',
    })
    proposalFindFirst.mockResolvedValue(null)
    proposalCreate.mockResolvedValue({
      id: 'proposal-1',
      driftFindingId: 'finding-1',
      amount: { toString: () => '-12.5000000' },
      currency: 'USDC',
      reason: 'Align ledger to wallet balance',
      status: 'pending',
      proposedById: 'finance-1',
      createdAt: new Date('2026-09-24T01:00:00Z'),
    })
  })

  it('records a pending proposal linked to the drift finding without applying it', async () => {
    const { POST } = await import('./route')
    const response = await POST(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.proposal).toMatchObject({
      id: 'proposal-1',
      driftFindingId: 'finding-1',
      amount: '-12.5000000',
      status: 'pending',
    })
    expect(proposalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          driftFindingId: 'finding-1',
          proposedById: 'finance-1',
          status: 'pending',
        }),
      }),
    )
  })

  it('rejects callers outside admin and finance roles', async () => {
    userFindUnique.mockResolvedValue({ id: 'user-1', role: 'freelancer' })

    const { POST } = await import('./route')
    const response = await POST(makeRequest())

    expect(response.status).toBe(403)
    expect(findingFindUnique).not.toHaveBeenCalled()
    expect(proposalCreate).not.toHaveBeenCalled()
  })

  it('requires a specific drift finding reference', async () => {
    const { POST } = await import('./route')
    const response = await POST(makeRequest({ reason: 'Missing finding' }))

    expect(response.status).toBe(400)
    expect(findingFindUnique).not.toHaveBeenCalled()
  })

  it('rejects a finding that is no longer open', async () => {
    findingFindUnique.mockResolvedValue({
      id: 'finding-1',
      driftAmount: 4,
      currency: 'USDC',
      status: 'resolved',
    })

    const { POST } = await import('./route')
    const response = await POST(makeRequest())

    expect(response.status).toBe(409)
    expect(proposalCreate).not.toHaveBeenCalled()
  })

  it('does not create a second pending proposal for the same finding', async () => {
    proposalFindFirst.mockResolvedValue({ id: 'proposal-existing' })

    const { POST } = await import('./route')
    const response = await POST(makeRequest())

    expect(response.status).toBe(409)
    expect(proposalCreate).not.toHaveBeenCalled()
  })

  it('returns 500 when the proposal cannot be stored', async () => {
    proposalCreate.mockRejectedValue(new Error('database unavailable'))

    const { POST } = await import('./route')
    const response = await POST(makeRequest())

    expect(response.status).toBe(500)
  })
})

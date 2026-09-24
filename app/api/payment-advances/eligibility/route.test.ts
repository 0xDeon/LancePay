import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    userTrustScore: { findUnique: vi.fn() },
    clientReputation: { findUnique: vi.fn() },
    paymentAdvance: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', privyId: 'privy-1', email: 'user@example.com' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(invoiceId: string): NextRequest {
  return new NextRequest(`http://localhost/api/payment-advances/eligibility?invoiceId=${invoiceId}`, {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(null)
})

describe('GET /api/payment-advances/eligibility', () => {
  describe('happy path', () => {
    it('returns eligible=true with maxSafeAmount for a qualifying invoice', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 70,
        totalVolumeUsdc: new Decimal('5000'),
        successfulInvoices: 5,
        disputeCount: 0,
      }
      const mockClientRep = {
        clientEmail: 'client@example.com',
        paymentScore: 80,
        isVerified: true,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)
      vi.mocked(prisma.clientReputation.findUnique).mockResolvedValue(mockClientRep as any)

      const res = await GET(makeRequest('inv-1'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.eligible).toBe(true)
      expect(data.reason).toBeUndefined()
      expect(data.maxSafeAmount).toBeDefined()
      expect(Number(data.maxSafeAmount)).toBeGreaterThan(0)
      expect(Number(data.maxSafeAmount)).toBeLessThanOrEqual(700) // 70% of 1000
    })

    it('calculates maxSafeAmount based on trust score', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 40, // minimum
        totalVolumeUsdc: new Decimal('5000'),
        successfulInvoices: 5,
        disputeCount: 0,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)
      vi.mocked(prisma.clientReputation.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(true)
      // At score 40 (trust factor 0.3) with no client rep, should be 1000 * 0.3 * 0.7 = 210
      expect(Number(data.maxSafeAmount)).toBeLessThanOrEqual(210)
    })
  })

  describe('invoice eligibility checks', () => {
    it('returns ineligible when invoice status is not pending', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'paid',
        paidAt: new Date(),
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain("status is 'paid'")
    })

    it('returns ineligible when invoice has been paid', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: new Date('2024-01-01'),
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('already been paid')
    })

    it('returns ineligible when invoice has been cancelled', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: new Date(),
        lienActive: false,
        dispute: null,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('cancelled')
    })

    it('returns ineligible when invoice has active dispute', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: { id: 'dispute-1', status: 'open' },
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('active dispute')
    })

    it('returns ineligible when invoice has active lien', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: true,
        dispute: null,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('active lien')
    })
  })

  describe('advance constraint checks', () => {
    it('returns ineligible when an active advance already exists', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockExistingAdvance = {
        id: 'adv-1',
        status: 'pending',
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(mockExistingAdvance as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('active advance already exists')
    })

    it('allows new advance if previous one is repaid', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockRepaidAdvance = {
        id: 'adv-1',
        status: 'repaid',
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 70,
        totalVolumeUsdc: new Decimal('5000'),
        successfulInvoices: 5,
        disputeCount: 0,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(mockRepaidAdvance as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)
      vi.mocked(prisma.clientReputation.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(true)
    })
  })

  describe('user trust score checks', () => {
    it('returns ineligible when trust score is below minimum', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 30, // below 40 minimum
        totalVolumeUsdc: new Decimal('5000'),
        successfulInvoices: 5,
        disputeCount: 0,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('trust score is below the minimum')
    })

    it('returns ineligible when user has insufficient successful invoices', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 70,
        totalVolumeUsdc: new Decimal('100'),
        successfulInvoices: 1, // below 2 minimum
        disputeCount: 0,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('at least 2 successful invoices')
    })

    it('returns ineligible when trust score is null', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('trust score is below the minimum')
    })
  })

  describe('client reputation checks', () => {
    it('returns ineligible when client has poor payment score', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 70,
        totalVolumeUsdc: new Decimal('5000'),
        successfulInvoices: 5,
        disputeCount: 0,
      }
      const mockClientRep = {
        clientEmail: 'client@example.com',
        paymentScore: -20, // below -10 minimum
        isVerified: false,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)
      vi.mocked(prisma.clientReputation.findUnique).mockResolvedValue(mockClientRep as any)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(false)
      expect(data.reason).toContain('poor payment history')
    })

    it('allows advance when client reputation is not found', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'unknown@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 70,
        totalVolumeUsdc: new Decimal('5000'),
        successfulInvoices: 5,
        disputeCount: 0,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)
      vi.mocked(prisma.clientReputation.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest('inv-1'))
      const data = await res.json()
      expect(data.eligible).toBe(true)
    })
  })

  describe('error handling', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
      const res = await GET(makeRequest('inv-1'))
      expect(res.status).toBe(401)
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
      const res = await GET(makeRequest('inv-1'))
      expect(res.status).toBe(404)
    })

    it('returns 400 when invoiceId query parameter is missing', async () => {
      const req = new NextRequest('http://localhost/api/payment-advances/eligibility', {
        method: 'GET',
        headers: { authorization: 'Bearer token' },
      })
      const res = await GET(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('invoiceId query parameter is required')
    })

    it('returns 404 when invoice not found', async () => {
      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(null)
      const res = await GET(makeRequest('inv-1'))
      expect(res.status).toBe(404)
    })

    it('returns 403 when invoice does not belong to user', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'other-user',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)

      const res = await GET(makeRequest('inv-1'))
      expect(res.status).toBe(403)
    })

    it('does not expose internal scoring weights in response', async () => {
      const mockInvoice = {
        id: 'inv-1',
        userId: 'user-1',
        clientEmail: 'client@example.com',
        amount: new Decimal('1000'),
        status: 'pending',
        paidAt: null,
        cancelledAt: null,
        lienActive: false,
        dispute: null,
      }
      const mockTrustScore = {
        userId: 'user-1',
        score: 70,
        totalVolumeUsdc: new Decimal('5000'),
        successfulInvoices: 5,
        disputeCount: 0,
      }

      vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
      vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(mockTrustScore as any)
      vi.mocked(prisma.clientReputation.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest('inv-1'))
      const responseText = JSON.stringify(await res.json())

      // Verify scoring weights and internal constants are not exposed
      expect(responseText).not.toMatch(/trustFactor|clientFactor|MIN_TRUST_SCORE|MIN_SUCCESSFUL_INVOICES|MIN_CLIENT_PAYMENT_SCORE/i)
    })
  })
})

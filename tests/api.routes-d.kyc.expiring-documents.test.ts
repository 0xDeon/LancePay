import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycApplicationFindMany = vi.fn()
const kycDocumentFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycApplication: { findMany: kycApplicationFindMany },
    kycDocument: { findMany: kycDocumentFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/kyc/expiring-documents'

function makeRequest(queryParams: Record<string, string> = {}, authHeader: string = 'Bearer valid-token') {
  const url = new URL(BASE_URL)
  Object.entries(queryParams).forEach(([k, v]) => url.searchParams.append(k, v))

  const headers: Record<string, string> = {}
  if (authHeader) {
    headers.authorization = authHeader
  }

  return new NextRequest(url.toString(), {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/kyc/expiring-documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Authorization', () => {
    it('returns 401 when authorization header is missing', async () => {
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({}, ''))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 when token is invalid', async () => {
      verifyAuthToken.mockResolvedValue(null)
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(401)
    })

    it('returns 404 when user is not found', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_unknown' })
      userFindUnique.mockResolvedValue(null)
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(404)
    })

    it('returns 403 when user role is freelancer', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_user' })
      userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('Forbidden')
    })

    it('returns 200 when user role is admin', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
    })

    it('returns 200 when user role is compliance', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_compliance' })
      userFindUnique.mockResolvedValue({ id: 'compliance_1', role: 'compliance' })
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
    })
  })

  describe('Query Parameter Validation', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    })

    it('returns 400 when days is negative', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '-5' }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid request parameters')
    })

    it('returns 400 when days is zero', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '0' }))
      expect(res.status).toBe(400)
    })

    it('returns 400 when days is non-numeric', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: 'invalid' }))
      expect(res.status).toBe(400)
    })

    it('returns 400 when days is a float', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '30.5' }))
      expect(res.status).toBe(400)
    })

    it('uses default lookahead of 30 days when omitted', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.lookaheadDays).toBe(30)
    })

    it('accepts positive integer days value', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])
      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '60' }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.lookaheadDays).toBe(60)
    })
  })

  describe('Happy Path - Applications with Expiring Documents', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    })

    it('returns applications with documents nearing expiry (within 30-day window)', async () => {
      const now = new Date('2026-09-24T00:00:00Z')
      const applicationCreatedAt = new Date('2026-06-20T00:00:00Z')
      const documentCreatedAt = new Date('2026-08-25T00:00:00Z') // expires in 30 days (utility_bill: 90 days)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: applicationCreatedAt,
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(1)
      expect(body.applications[0].id).toBe('kyc_1')
      expect(body.applications[0].documents).toHaveLength(1)
      expect(body.applications[0].documents[0].documentType).toBe('utility_bill')
      expect(body.applications[0].documents[0].daysRemaining).toBe(30)
    })

    it('includes multiple applications with expiring documents', async () => {
      const documentCreatedAt1 = new Date('2026-08-25T00:00:00Z') // expires in 30 days
      const documentCreatedAt2 = new Date('2026-08-20T00:00:00Z') // expires in 35 days

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
        {
          id: 'kyc_2',
          userId: 'user_2',
          status: 'approved',
          level: 'advanced',
          fullName: 'John Smith',
          createdAt: new Date('2026-07-01T00:00:00Z'),
          user: {
            id: 'user_2',
            email: 'john@example.com',
            name: 'John Smith',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt1,
        },
        {
          id: 'doc_2',
          userId: 'user_2',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt2,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(2)
      expect(body.count).toBe(2)
    })

    it('includes multiple documents per application', async () => {
      const documentCreatedAt1 = new Date('2026-08-25T00:00:00Z') // utility_bill expires in 30 days
      const documentCreatedAt2 = new Date('2026-08-30T00:00:00Z') // passport expires in 1 year

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt1,
        },
        {
          id: 'doc_2',
          userId: 'user_1',
          documentType: 'passport',
          createdAt: documentCreatedAt2,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(1)
      expect(body.applications[0].documents).toHaveLength(1) // only utility_bill is within 30-day window
      expect(body.applications[0].documents[0].documentType).toBe('utility_bill')
    })
  })

  describe('Exclusion - Rejected Applications', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    })

    it('excludes applications with rejected status even if documents are expiring', async () => {
      const documentCreatedAt = new Date('2026-08-25T00:00:00Z') // expires in 30 days

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_rejected',
          userId: 'user_rejected',
          status: 'rejected',
          level: 'basic',
          fullName: 'Rejected User',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_rejected',
            email: 'rejected@example.com',
            name: 'Rejected User',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_rejected',
          userId: 'user_rejected',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0)

      // Verify the where clause excluded rejected status
      expect(kycApplicationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            NOT: { status: 'rejected' },
          }),
        })
      )
    })
  })

  describe('Exclusion - Out of Window', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    })

    it('excludes applications with documents beyond the lookahead window', async () => {
      const now = new Date('2026-09-24T00:00:00Z')
      const documentCreatedAt = new Date('2026-07-25T00:00:00Z') // expires on 2026-10-24 (60 days away)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '30' })) // 30-day window
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0) // document expires outside 30-day window
    })

    it('excludes applications with already-expired documents', async () => {
      const now = new Date('2026-09-24T00:00:00Z')
      const documentCreatedAt = new Date('2026-06-20T00:00:00Z') // utility_bill expires 2026-09-18 (6 days ago)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-15T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0) // already expired, not "nearing" expiry
    })
  })

  describe('Boundary Conditions', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    })

    it('includes documents expiring exactly at the start of the window (today)', async () => {
      const now = new Date('2026-09-24T00:00:00Z')
      const documentCreatedAt = new Date('2026-06-26T00:00:00Z') // utility_bill expires today (90 days later)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '30' }))
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(1)
      expect(body.applications[0].documents[0].daysRemaining).toBe(0)
    })

    it('includes documents expiring exactly at the end of the window', async () => {
      const now = new Date('2026-09-24T00:00:00Z')
      const documentCreatedAt = new Date('2026-08-25T00:00:00Z') // utility_bill expires in 30 days (2026-10-24)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '30' }))
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(1)
      expect(body.applications[0].documents[0].daysRemaining).toBe(30)
    })

    it('excludes documents expiring just before the window (yesterday relative to window end)', async () => {
      const now = new Date('2026-09-24T00:00:00Z')
      const documentCreatedAt = new Date('2026-08-24T00:00:00Z') // utility_bill expires 2026-10-23 (29 days away)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '29' })) // 29-day window
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0) // expires at day 30, outside 29-day window
    })

    it('excludes documents expiring just after the window (1 day after window end)', async () => {
      const now = new Date('2026-09-24T00:00:00Z')
      const documentCreatedAt = new Date('2026-08-26T00:00:00Z') // utility_bill expires 2026-10-25 (31 days away)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '30' })) // 30-day window
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0) // expires at day 31, outside 30-day window
    })
  })

  describe('Regression - Empty Results', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    })

    it('returns empty array when no applications exist', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0)
      expect(body.count).toBe(0)
    })

    it('returns empty array when no documents are expiring', async () => {
      const documentCreatedAt = new Date('2026-07-01T00:00:00Z') // utility_bill expires in 85 days (outside 30-day window)

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0)
      expect(body.count).toBe(0)
    })

    it('returns empty array when all applications are rejected', async () => {
      const documentCreatedAt = new Date('2026-08-25T00:00:00Z') // expires in 30 days

      kycApplicationFindMany.mockResolvedValue([])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_rejected',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.applications).toHaveLength(0)
    })
  })

  describe('Response Structure', () => {
    beforeEach(() => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
      userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    })

    it('includes lookaheadDays and generatedAt in response', async () => {
      kycApplicationFindMany.mockResolvedValue([])
      kycDocumentFindMany.mockResolvedValue([])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest({ days: '45' }))
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.lookaheadDays).toBe(45)
      expect(body.generatedAt).toBeDefined()
      expect(body.count).toBe(0)
    })

    it('includes all required fields in application response', async () => {
      const documentCreatedAt = new Date('2026-08-25T00:00:00Z')

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      const app = body.applications[0]
      expect(app).toHaveProperty('id', 'kyc_1')
      expect(app).toHaveProperty('userId', 'user_1')
      expect(app).toHaveProperty('status', 'pending')
      expect(app).toHaveProperty('level', 'basic')
      expect(app).toHaveProperty('fullName', 'Jane Doe')
      expect(app).toHaveProperty('createdAt')
      expect(app).toHaveProperty('user')
      expect(app).toHaveProperty('documents')
    })

    it('includes all required fields in document response', async () => {
      const documentCreatedAt = new Date('2026-08-25T00:00:00Z')

      kycApplicationFindMany.mockResolvedValue([
        {
          id: 'kyc_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          createdAt: new Date('2026-06-20T00:00:00Z'),
          user: {
            id: 'user_1',
            email: 'jane@example.com',
            name: 'Jane Doe',
          },
        },
      ])

      kycDocumentFindMany.mockResolvedValue([
        {
          id: 'doc_1',
          userId: 'user_1',
          documentType: 'utility_bill',
          createdAt: documentCreatedAt,
        },
      ])

      const { GET } = await import('@/app/api/routes-d/kyc/expiring-documents/route')
      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      const body = await res.json()
      const doc = body.applications[0].documents[0]
      expect(doc).toHaveProperty('id', 'doc_1')
      expect(doc).toHaveProperty('documentType', 'utility_bill')
      expect(doc).toHaveProperty('expiresAt')
      expect(doc).toHaveProperty('daysRemaining', 30)
    })
  })
})

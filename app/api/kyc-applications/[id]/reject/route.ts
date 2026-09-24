import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_ROLES = new Set(['admin', 'compliance'])
const REVIEWABLE_STATUSES = ['pending', 'submitted', 'under_review']
export const REJECTION_REASON_CODES = [
  'identity_mismatch',
  'document_unreadable',
  'document_expired',
  'unsupported_document',
  'sanctions_match',
  'information_incomplete',
  'fraud_suspected',
] as const

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const actor = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!actor) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (!ALLOWED_ROLES.has(actor.role)) {
      return NextResponse.json({ error: 'Forbidden: admin or compliance access required' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json().catch(() => null)
    const rejectionReason = body?.rejectionReason
    if (typeof rejectionReason !== 'string' || !(REJECTION_REASON_CODES as readonly string[]).includes(rejectionReason)) {
      return NextResponse.json(
        { error: 'rejectionReason must be a supported reason code', allowedReasons: REJECTION_REASON_CODES },
        { status: 400 },
      )
    }

    const reviewedAt = new Date()
    const result = await prisma.kycApplication.updateMany({
      where: { id, status: { in: REVIEWABLE_STATUSES } },
      data: { status: 'rejected', rejectionReason, reviewedAt },
    })
    if (result.count === 0) {
      const application = await prisma.kycApplication.findUnique({ where: { id }, select: { status: true } })
      if (!application) return NextResponse.json({ error: 'KYC application not found' }, { status: 404 })
      return NextResponse.json(
        { error: `KYC application in status '${application.status}' cannot be rejected` },
        { status: 409 },
      )
    }

    return NextResponse.json({ application: { id, status: 'rejected', rejectionReason, reviewedAt } })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/kyc-applications/[id]/reject error')
    return NextResponse.json({ error: 'Failed to reject KYC application' }, { status: 500 })
  }
}

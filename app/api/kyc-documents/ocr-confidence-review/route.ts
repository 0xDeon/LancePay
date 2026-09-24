import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_ROLES = new Set(['admin', 'compliance'])
const configuredThreshold = Number(process.env.OCR_AUTO_APPROVAL_THRESHOLD ?? 0.85)
const AUTO_APPROVAL_THRESHOLD = configuredThreshold > 0 && configuredThreshold <= 1
  ? configuredThreshold
  : 0.85

export async function GET(request: NextRequest) {
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

    const documents = await prisma.kycDocument.findMany({
      where: {
        ocrConfidence: { lt: AUTO_APPROVAL_THRESHOLD },
        ocrReviewedAt: null,
        status: { notIn: ['approved', 'verified', 'rejected'] },
      },
      orderBy: { ocrConfidence: 'asc' },
      select: {
        id: true,
        userId: true,
        documentType: true,
        status: true,
        fileUrl: true,
        fileName: true,
        ocrConfidence: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ threshold: AUTO_APPROVAL_THRESHOLD, documents })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/kyc-documents/ocr-confidence-review error')
    return NextResponse.json({ error: 'Failed to fetch OCR confidence review queue' }, { status: 500 })
  }
}

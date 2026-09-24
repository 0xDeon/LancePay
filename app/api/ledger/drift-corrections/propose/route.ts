import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const ALLOWED_ROLES = new Set(['admin', 'finance'])

type ProposalBody = {
  driftFindingId?: unknown
  reason?: unknown
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const actor = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })
    if (!actor) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (!ALLOWED_ROLES.has(actor.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    let body: ProposalBody
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }

    const driftFindingId =
      typeof body.driftFindingId === 'string' ? body.driftFindingId.trim() : ''
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!driftFindingId) {
      return NextResponse.json({ error: 'driftFindingId is required' }, { status: 400 })
    }
    if (!reason) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 })
    }

    const finding = await prisma.ledgerDriftFinding.findUnique({
      where: { id: driftFindingId },
      select: { id: true, driftAmount: true, currency: true, status: true },
    })
    if (!finding) {
      return NextResponse.json({ error: 'Drift finding not found' }, { status: 404 })
    }
    if (finding.status !== 'open') {
      return NextResponse.json(
        { error: 'Drift finding is no longer open' },
        { status: 409 },
      )
    }

    const existingProposal = await prisma.ledgerDriftCorrectionProposal.findFirst({
      where: { driftFindingId, status: 'pending' },
      select: { id: true },
    })
    if (existingProposal) {
      return NextResponse.json(
        { error: 'A correction proposal is already awaiting approval' },
        { status: 409 },
      )
    }

    const proposal = await prisma.ledgerDriftCorrectionProposal.create({
      data: {
        driftFindingId,
        proposedById: actor.id,
        amount: finding.driftAmount,
        currency: finding.currency,
        reason,
        status: 'pending',
      },
      select: {
        id: true,
        driftFindingId: true,
        amount: true,
        currency: true,
        reason: true,
        status: true,
        proposedById: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        proposal: {
          ...proposal,
          amount: proposal.amount.toString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/ledger/drift-corrections/propose error')
    return NextResponse.json({ error: 'Failed to propose drift correction' }, { status: 500 })
  }
}

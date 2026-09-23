import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { nanoid } from 'nanoid'

const DISBURSABLE_STATUSES = ['pending', 'approved']

// Placeholder for the real downstream advance payout (e.g. a YellowCard transfer
// to the user). In production this would call the payout provider and return the
// generated reference id instead of stubbing it.
async function payoutToUser(advance: { id: string }) {
  // TODO: Replace with a real payout provider call.
  return { downstreamReferenceId: `yd_${nanoid(10)}` }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Payment advance ID is required' }, { status: 400 })
    }

    const advance = await prisma.paymentAdvance.findFirst({
      where: { id, userId: user.id },
    })
    if (!advance) {
      return NextResponse.json({ error: 'Payment advance not found' }, { status: 404 })
    }

    if (!DISBURSABLE_STATUSES.includes(advance.status)) {
      return NextResponse.json(
        {
          error: `Payment advance in status '${advance.status}' cannot be disbursed`,
          disbursableStatuses: DISBURSABLE_STATUSES,
        },
        { status: 409 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const yellowCardTransactionId = body.yellowCardTransactionId
    if (typeof yellowCardTransactionId !== 'string' || yellowCardTransactionId.trim() === '') {
      return NextResponse.json({ error: 'yellowCardTransactionId is required' }, { status: 400 })
    }

    // Run the downstream payout before touching the row so it is never left
    // ambiguous: on success the status/yellowCardTransactionId/disbursedAt are
    // persisted atomically, on failure the error field is persisted instead.
    let downstream
    try {
      downstream = await payoutToUser(advance)
    } catch (error: any) {
      const message = error?.message || 'Failed to disburse payment advance'
      await prisma.paymentAdvance.update({
        where: { id },
        data: { error: message, updatedAt: new Date() },
      })
      logger.error({ err: error, advanceId: id }, 'Payment advance payout failed')
      return NextResponse.json({ error: message }, { status: 502 })
    }

    const updated = await prisma.paymentAdvance.update({
      where: { id },
      data: {
        status: 'disbursed',
        yellowCardTransactionId,
        disbursedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      },
    })

    return NextResponse.json({
      paymentAdvance: {
        id: updated.id,
        status: updated.status,
        yellowCardTransactionId: updated.yellowCardTransactionId,
        disbursedAt: updated.disbursedAt,
        downstreamReferenceId: downstream.downstreamReferenceId,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payment-advances/[id]/disburse error')
    return NextResponse.json({ error: 'Failed to disburse payment advance' }, { status: 500 })
  }
}
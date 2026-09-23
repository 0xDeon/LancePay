import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// Repayment decision: partial repayments are explicitly rejected. A repayment is
// only recorded once the caller confirms the full totalRepaymentUSDC (advanced
// amount + fee) is covered, at which point repaidAt is set atomically. Tracking a
// remaining balance would require a dedicated column and a partial-repayment
// flow; that is intentionally out of scope here.
const REPAYABLE_STATUSES = ['disbursed']

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

    if (!REPAYABLE_STATUSES.includes(advance.status)) {
      return NextResponse.json(
        {
          error:
            advance.status === 'repaid'
              ? 'Payment advance has already been repaid'
              : `Payment advance in status '${advance.status}' cannot be repaid`,
          repayableStatuses: REPAYABLE_STATUSES,
        },
        { status: 409 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const repaymentAmountUSDC = body.repaymentAmountUSDC
    if (typeof repaymentAmountUSDC !== 'number' || repaymentAmountUSDC <= 0) {
      return NextResponse.json(
        { error: 'A positive repaymentAmountUSDC is required' },
        { status: 400 },
      )
    }

    const totalRepaymentUSDC = Number(advance.totalRepaymentUSDC)
    // The full repayment amount must be confirmed before repaidAt is set; anything
    // below totalRepaymentUSDC is treated as an unsupported partial repayment.
    if (repaymentAmountUSDC < totalRepaymentUSDC) {
      return NextResponse.json(
        {
          error: `Partial repayment is not supported; repaymentAmountUSDC must cover totalRepaymentUSDC (${totalRepaymentUSDC})`,
          totalRepaymentUSDC,
        },
        { status: 400 },
      )
    }

    const updated = await prisma.paymentAdvance.update({
      where: { id },
      data: {
        status: 'repaid',
        repaidAt: new Date(),
        error: null,
        updatedAt: new Date(),
      },
    })

    return NextResponse.json({
      paymentAdvance: {
        id: updated.id,
        status: updated.status,
        repaidAt: updated.repaidAt,
        totalRepaymentUSDC: updated.totalRepaymentUSDC,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payment-advances/[id]/repay error')
    return NextResponse.json({ error: 'Failed to record payment advance repayment' }, { status: 500 })
  }
}
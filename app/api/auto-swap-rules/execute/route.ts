import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getUsdToNgnRate } from '@/lib/exchange-rate'
import { z } from 'zod'
import { Decimal } from '@prisma/client/runtime/library'

const executeAutoSwapSchema = z.object({
  transactionId: z.string().min(1),
})

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = executeAutoSwapSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { transactionId } = parsed.data

    // Fetch the transaction
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
    })

    if (!transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    // Verify transaction belongs to user
    if (transaction.userId !== user.id) {
      return NextResponse.json({ error: 'Transaction does not belong to this user' }, { status: 403 })
    }

    // Fetch auto swap rule
    const autoSwapRule = await prisma.autoSwapRule.findUnique({
      where: { userId: user.id },
    })

    // Return skipped result if no rule or rule is not active
    if (!autoSwapRule || !autoSwapRule.isActive) {
      return NextResponse.json(
        {
          executed: false,
          skipped: true,
          reason: autoSwapRule ? 'Auto-swap rule is disabled' : 'No active auto-swap rule configured',
          transactionId,
        },
        { status: 200 }
      )
    }

    // Guard against re-execution: check if already executed
    if (transaction.autoSwapTriggered) {
      return NextResponse.json(
        {
          executed: false,
          skipped: true,
          reason: 'Auto-swap already executed for this transaction',
          transactionId,
        },
        { status: 200 }
      )
    }

    // Get the current exchange rate
    const { rate } = await getUsdToNgnRate()

    // Calculate swap amount based on percentage
    const swapAmount = transaction.amount.mul(new Decimal(autoSwapRule.percentage).div(100))

    // Calculate NGN equivalent
    const ngnAmount = swapAmount.mul(new Decimal(rate))

    // Update transaction with swap details
    const updatedTransaction = await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        autoSwapTriggered: true,
        ngnAmount: ngnAmount.toDecimalPlaces(2),
        exchangeRate: new Decimal(rate).toDecimalPlaces(4),
        type: 'conversion',
      },
    })

    logger.info(
      {
        transactionId,
        userId: user.id,
        percentage: autoSwapRule.percentage,
        amount: swapAmount.toString(),
        rate: rate.toString(),
        ngnAmount: ngnAmount.toString(),
      },
      'Auto-swap executed'
    )

    return NextResponse.json(
      {
        executed: true,
        transactionId: updatedTransaction.id,
        swapAmount: swapAmount.toDecimalPlaces(2),
        ngnAmount: ngnAmount.toDecimalPlaces(2),
        exchangeRate: new Decimal(rate).toDecimalPlaces(4),
        percentage: autoSwapRule.percentage,
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/auto-swap-rules/execute error')
    return NextResponse.json({ error: 'Failed to execute auto-swap' }, { status: 500 })
  }
}

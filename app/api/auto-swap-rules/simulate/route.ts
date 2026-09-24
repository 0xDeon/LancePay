import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getUsdToNgnRate } from '@/lib/exchange-rate'
import { z } from 'zod'
import { Decimal } from '@prisma/client/runtime/library'

const simulateAutoSwapSchema = z.object({
  depositAmount: z.number().positive('Deposit amount must be positive'),
  percentage: z.number().int().min(1).max(100, 'Percentage must be between 1 and 100'),
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

    const parsed = simulateAutoSwapSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { depositAmount, percentage } = parsed.data

    // Get current exchange rate
    const { rate } = await getUsdToNgnRate()

    // Calculate swap amount based on percentage
    const depositDecimal = new Decimal(depositAmount)
    const swapAmount = depositDecimal.mul(new Decimal(percentage).div(100))

    // Calculate NGN equivalent
    const ngnAmount = swapAmount.mul(new Decimal(rate))

    // Calculate remaining USDC after swap
    const remainingUSDC = depositDecimal.sub(swapAmount)

    logger.info(
      {
        userId: user.id,
        depositAmount: depositAmount.toString(),
        percentage,
        rate: rate.toString(),
        swapAmount: swapAmount.toString(),
        ngnAmount: ngnAmount.toString(),
      },
      'Auto-swap simulation'
    )

    return NextResponse.json(
      {
        estimate: true,
        depositAmount: depositDecimal.toDecimalPlaces(2),
        percentage,
        exchangeRate: new Decimal(rate).toDecimalPlaces(4),
        swapAmount: swapAmount.toDecimalPlaces(2),
        ngnAmount: ngnAmount.toDecimalPlaces(2),
        remainingUSDC: remainingUSDC.toDecimalPlaces(2),
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/auto-swap-rules/simulate error')
    return NextResponse.json({ error: 'Failed to simulate auto-swap' }, { status: 500 })
  }
}

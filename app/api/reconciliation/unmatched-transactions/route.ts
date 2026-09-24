import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const ALLOWED_ROLES = new Set(['admin', 'finance'])
const UNMATCHED_REASONS = ['amount_mismatch', 'no_candidate'] as const

function parseDate(value: string | null, endOfDay = false): Date | null | undefined {
  if (value === null) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined

  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999)
  }
  return date
}

export async function GET(request: NextRequest) {
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

    const { searchParams } = new URL(request.url)
    const from = parseDate(searchParams.get('from'))
    const to = parseDate(searchParams.get('to'), true)

    if (from === undefined) {
      return NextResponse.json({ error: 'from must be a valid ISO 8601 date' }, { status: 400 })
    }
    if (to === undefined) {
      return NextResponse.json({ error: 'to must be a valid ISO 8601 date' }, { status: 400 })
    }
    if (from && to && from > to) {
      return NextResponse.json({ error: 'from must not be later than to' }, { status: 400 })
    }

    const createdAt =
      from || to
        ? {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          }
        : undefined

    const transactions = await prisma.transaction.findMany({
      where: {
        reconciliationStatus: 'unmatched',
        reconciliationReason: { in: [...UNMATCHED_REASONS] },
        ...(createdAt ? { createdAt } : {}),
      },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        externalId: true,
        txHash: true,
        createdAt: true,
        reconciliationReason: true,
        reconciliationAttemptedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    const unmatchedTransactions = transactions.map((transaction) => ({
      ...transaction,
      amount: transaction.amount.toString(),
      unmatchedReason: transaction.reconciliationReason,
    }))

    return NextResponse.json({
      unmatchedTransactions,
      summary: {
        total: unmatchedTransactions.length,
        amountMismatch: unmatchedTransactions.filter(
          (transaction) => transaction.unmatchedReason === 'amount_mismatch',
        ).length,
        noCandidate: unmatchedTransactions.filter(
          (transaction) => transaction.unmatchedReason === 'no_candidate',
        ).length,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/reconciliation/unmatched-transactions error')
    return NextResponse.json(
      { error: 'Failed to fetch unmatched transactions' },
      { status: 500 },
    )
  }
}

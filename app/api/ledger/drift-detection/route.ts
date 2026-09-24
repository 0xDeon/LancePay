import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { getAccountBalance } from '@/lib/stellar'

const ALLOWED_ROLES = new Set(['admin', 'finance'])
const ASSET_CODE = 'USDC'
const MINIMUM_TOLERANCE = 0.01
const DEBIT_TRANSACTION_TYPES = new Set(['withdrawal', 'payout', 'refund'])

type LedgerTransaction = {
  amount: unknown
  status: string
  type: string
}

function roundAmount(value: number): number {
  return Math.round(value * 10_000_000) / 10_000_000
}

function deriveLedgerBalance(transactions: LedgerTransaction[]): number {
  return roundAmount(
    transactions
      .filter((transaction) => transaction.status === 'completed')
      .reduce((balance, transaction) => {
        const amount = Number(transaction.amount)
        return balance + (DEBIT_TRANSACTION_TYPES.has(transaction.type) ? -amount : amount)
      }, 0),
  )
}

function deriveTolerance(transactions: LedgerTransaction[]): number {
  const pendingAmount = transactions
    .filter((transaction) => transaction.status === 'pending')
    .reduce((total, transaction) => total + Math.abs(Number(transaction.amount)), 0)

  return roundAmount(Math.max(MINIMUM_TOLERANCE, pendingAmount))
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

    const wallets = await prisma.wallet.findMany({
      select: {
        id: true,
        address: true,
        user: {
          select: {
            id: true,
            email: true,
            transactions: {
              where: { status: { in: ['completed', 'pending'] }, currency: ASSET_CODE },
              select: { amount: true, status: true, type: true },
            },
          },
        },
      },
    })

    const comparisons = await Promise.all(
      wallets.map(async (wallet) => {
        const balances = await getAccountBalance(wallet.address)
        const assetBalance = balances.find((balance) => balance.asset_code === ASSET_CODE)
        const onChainBalance = roundAmount(Number(assetBalance?.balance ?? 0))
        const ledgerBalance = deriveLedgerBalance(wallet.user.transactions)
        const tolerance = deriveTolerance(wallet.user.transactions)
        const driftAmount = roundAmount(onChainBalance - ledgerBalance)
        const hasDrift = Math.abs(driftAmount) > tolerance

        const finding = hasDrift
          ? await prisma.ledgerDriftFinding.create({
              data: {
                userId: wallet.user.id,
                walletId: wallet.id,
                currency: ASSET_CODE,
                ledgerBalance,
                onChainBalance,
                driftAmount,
                tolerance,
              },
              select: { id: true, detectedAt: true },
            })
          : null

        return {
          findingId: finding?.id ?? null,
          userId: wallet.user.id,
          email: wallet.user.email,
          walletAddress: wallet.address,
          currency: ASSET_CODE,
          ledgerBalance,
          onChainBalance,
          driftAmount,
          tolerance,
          hasDrift,
          detectedAt: finding?.detectedAt ?? null,
        }
      }),
    )

    comparisons.sort((a, b) => Math.abs(b.driftAmount) - Math.abs(a.driftAmount))

    return NextResponse.json({
      checkedWallets: comparisons.length,
      driftedWallets: comparisons.filter((comparison) => comparison.hasDrift).length,
      comparisons,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/ledger/drift-detection error')
    return NextResponse.json({ error: 'Failed to detect ledger drift' }, { status: 500 })
  }
}

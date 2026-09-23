import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { Decimal } from '@prisma/client/runtime/library'

interface EligibilityResult {
  invoiceId: string
  eligible: boolean
  reason?: string
  maxSafeAmount?: Decimal
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const invoiceId = searchParams.get('invoiceId')

    if (!invoiceId) {
      return NextResponse.json({ error: 'invoiceId query parameter is required' }, { status: 400 })
    }

    // Fetch invoice
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { dispute: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Invoice does not belong to this user' }, { status: 403 })
    }

    // Check basic invoice eligibility
    const result: EligibilityResult = {
      invoiceId,
      eligible: false,
    }

    // Invoice must be pending
    if (invoice.status !== 'pending') {
      result.reason = `Invoice status is '${invoice.status}', must be 'pending'`
      return NextResponse.json(result, { status: 200 })
    }

    // Invoice must not be paid
    if (invoice.paidAt !== null) {
      result.reason = 'Invoice has already been paid'
      return NextResponse.json(result, { status: 200 })
    }

    // Invoice must not be cancelled
    if (invoice.cancelledAt !== null) {
      result.reason = 'Invoice has been cancelled'
      return NextResponse.json(result, { status: 200 })
    }

    // Invoice must not have active dispute
    if (invoice.dispute) {
      result.reason = 'Invoice has an active dispute'
      return NextResponse.json(result, { status: 200 })
    }

    // Invoice must not have active lien
    if (invoice.lienActive) {
      result.reason = 'Invoice has an active lien'
      return NextResponse.json(result, { status: 200 })
    }

    // Check for existing advance
    const existingAdvance = await prisma.paymentAdvance.findFirst({
      where: { invoiceId, userId: user.id },
    })

    if (existingAdvance && existingAdvance.status !== 'repaid') {
      result.reason = `An active advance already exists for this invoice (status: ${existingAdvance.status})`
      return NextResponse.json(result, { status: 200 })
    }

    // Get user trust score
    const trustScore = await prisma.userTrustScore.findUnique({
      where: { userId: user.id },
    })

    // Check minimum trust score
    const MIN_TRUST_SCORE = 40
    if (!trustScore || trustScore.score < MIN_TRUST_SCORE) {
      result.reason = `Your trust score is below the minimum required for advances`
      return NextResponse.json(result, { status: 200 })
    }

    // Check minimum successful invoices
    const MIN_SUCCESSFUL_INVOICES = 2
    if (!trustScore || trustScore.successfulInvoices < MIN_SUCCESSFUL_INVOICES) {
      result.reason = `You need at least ${MIN_SUCCESSFUL_INVOICES} successful invoices to be eligible for advances`
      return NextResponse.json(result, { status: 200 })
    }

    // Get client reputation
    const clientReputation = await prisma.clientReputation.findUnique({
      where: { clientEmail: invoice.clientEmail },
    })

    // Check client payment score if known
    const MIN_CLIENT_PAYMENT_SCORE = -10
    if (clientReputation && clientReputation.paymentScore < MIN_CLIENT_PAYMENT_SCORE) {
      result.reason = 'Client has a poor payment history and is not eligible for advances'
      return NextResponse.json(result, { status: 200 })
    }

    // Calculate maximum safe amount based on trust score and client reputation
    let maxAmount = new Decimal(invoice.amount)

    // Apply trust score factor (40-100 maps to 0.3-1.0)
    const trustFactor = Math.max(0.3, Math.min(1.0, (trustScore.score - 40) / 100))
    maxAmount = maxAmount.mul(new Decimal(trustFactor))

    // Apply client reputation factor if available
    if (clientReputation) {
      // paymentScore typically 0-100, normalize to 0.7-1.0 multiplier
      const clientFactor = Math.max(0.7, Math.min(1.0, clientReputation.paymentScore / 150))
      maxAmount = maxAmount.mul(new Decimal(clientFactor))
    }

    // Cap at 70% of invoice amount
    maxAmount = maxAmount.mul(new Decimal(0.7))

    // Round down to 2 decimal places (cents)
    maxAmount = maxAmount.toDecimalPlaces(2, 0) // 0 = ROUND_DOWN

    result.eligible = true
    result.maxSafeAmount = maxAmount

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payment-advances/eligibility error')
    return NextResponse.json({ error: 'Failed to check eligibility' }, { status: 500 })
  }
}

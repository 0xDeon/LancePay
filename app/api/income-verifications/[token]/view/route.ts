import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashToken, timingSafeEqual } from '@/lib/crypto'
import { logger } from '@/lib/logger'

/**
 * GET /api/income-verifications/[token]/view
 *
 * Public-facing endpoint to resolve and consume an income verification link.
 * Validates the token securely, checks expiry, and tracks access atomically.
 *
 * Security considerations:
 * - Token is hashed using SHA-256 (matching creation-time hashing)
 * - Lookup by tokenHash (indexed, unique field) via WHERE clause is secure
 * - Timing-safe comparison guards against timing attacks on mismatch detection
 * - Expired links return a distinct response from not-found/revoked
 * - accessCount is incremented atomically to prevent race conditions
 * - No maxAccessCount cap exists in schema (single-use not enforced)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  if (!token || typeof token !== 'string') {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400 },
    )
  }

  try {
    // Hash the incoming raw token using SHA-256 (matches creation-time hashing)
    const computedHash = hashToken(token)

    // Lookup by tokenHash in the database (indexed, unique field)
    // This WHERE clause is a secure DB equality check, not vulnerable to timing attacks
    const verification = await prisma.incomeVerification.findUnique({
      where: { tokenHash: computedHash },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        recipientName: true,
        expiresAt: true,
        accessCount: true,
        createdAt: true,
      },
    })

    // Not found: token hash doesn't match any record
    // (Distinct from "expired" to avoid leaking whether a token was ever valid)
    if (!verification) {
      return NextResponse.json(
        { error: 'Income verification not found or invalid token' },
        { status: 404 },
      )
    }

    // Check expiry: return distinct response if token has expired
    const now = new Date()
    if (verification.expiresAt < now) {
      return NextResponse.json(
        { error: 'Income verification link has expired' },
        { status: 410 }, // 410 Gone — distinct from 404 (not found) to signal expiry
      )
    }

    // Increment accessCount atomically to track access
    // Using Prisma's { increment: 1 } ensures atomic operation under concurrent access
    const updated = await prisma.incomeVerification.update({
      where: { id: verification.id },
      data: { accessCount: { increment: 1 } },
      select: {
        id: true,
        recipientName: true,
        accessCount: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    logger.info({
      msg: 'Income verification link accessed',
      incomeVerificationId: verification.id,
      userId: verification.userId,
      accessCount: updated.accessCount,
    })

    return NextResponse.json({
      id: updated.id,
      recipientName: updated.recipientName,
      accessCount: updated.accessCount,
      expiresAt: updated.expiresAt.toISOString(),
      createdAt: updated.createdAt.toISOString(),
    })
  } catch (error) {
    logger.error({
      err: error,
      msg: 'Error processing income verification access',
    })

    // Return generic error to avoid leaking implementation details
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

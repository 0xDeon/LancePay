import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { isValidStellarAddress } from '@/lib/stellar'
import { createWhitelistAddressSchema } from '@/lib/validations'
import { logger } from '@/lib/logger'

/**
 * Cooldown duration in milliseconds (24 hours)
 * This determines how long after creation an address becomes usable for withdrawals
 */
const WHITELIST_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Validate bank account format.
 * For now, this validates Nigerian bank account format:
 * - 10 digits
 * - matches common format for Nigerian banks
 *
 * Note: This can be extended in the future to support other formats
 * (IBAN for EU accounts, etc.) as needed.
 */
function isValidBankAccountFormat(address: string): boolean {
  // Nigerian bank account format: 10 digits
  return /^\d{10}$/.test(address)
}

/**
 * Validate address based on network type
 */
function validateAddressForNetwork(address: string, network: string): { valid: boolean; error?: string } {
  const trimmed = address.trim()

  if (network === 'stellar') {
    if (!isValidStellarAddress(trimmed)) {
      return {
        valid: false,
        error: 'Invalid Stellar address. Must be a 56-character address starting with "G".',
      }
    }
    return { valid: true }
  }

  if (network === 'bank') {
    if (!isValidBankAccountFormat(trimmed)) {
      return {
        valid: false,
        error: 'Invalid bank account format. Must be a 10-digit account number.',
      }
    }
    return { valid: true }
  }

  return {
    valid: false,
    error: `Unknown network type: ${network}`,
  }
}

/**
 * GET /api/whitelist-addresses
 * List all whitelisted addresses for the authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const whitelistAddresses = await prisma.whitelistAddress.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ whitelistAddresses }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'Error fetching whitelist addresses')
    return NextResponse.json(
      { error: 'Failed to fetch whitelist addresses' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whitelist-addresses
 * Create a new whitelisted address with activation cooldown
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Parse request body
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Validate request body
    const parsed = createWhitelistAddressSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    }

    const { label, address, network } = parsed.data

    // Validate address format based on network
    const validation = validateAddressForNetwork(address, network)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      )
    }

    // Check for duplicate (same user + address)
    const existing = await prisma.whitelistAddress.findFirst({
      where: {
        userId: user.id,
        address: address.trim(),
      },
    })

    if (existing) {
      return NextResponse.json(
        {
          error: 'This address is already whitelisted for your account',
          details: `Address ${address} was added on ${existing.createdAt.toISOString()}`,
        },
        { status: 409 }
      )
    }

    // Create whitelist entry with activation time
    const now = new Date()
    const activatesAt = new Date(now.getTime() + WHITELIST_COOLDOWN_MS)

    const whitelistAddress = await prisma.whitelistAddress.create({
      data: {
        userId: user.id,
        label,
        address: address.trim(),
        network,
        createdAt: now,
        activatesAt,
      },
    })

    return NextResponse.json(
      {
        id: whitelistAddress.id,
        label: whitelistAddress.label,
        address: whitelistAddress.address,
        network: whitelistAddress.network,
        createdAt: whitelistAddress.createdAt,
        activatesAt: whitelistAddress.activatesAt,
        message: `Address added successfully. It will become usable for withdrawals at ${activatesAt.toISOString()} (after ${WHITELIST_COOLDOWN_MS / 1000 / 60 / 60} hour cooldown).`,
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Error creating whitelist address')

    // Handle Prisma unique constraint errors
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return NextResponse.json(
        { error: 'This address is already whitelisted for your account' },
        { status: 409 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to create whitelist address' },
      { status: 500 }
    )
  }
}

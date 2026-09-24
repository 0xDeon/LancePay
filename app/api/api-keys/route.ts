import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateToken, hashToken } from '@/lib/crypto'
import { createApiKeySchema } from '@/lib/validations'

/**
 * GET /api/api-keys
 * List all API keys for the authenticated user.
 * Returns only safe fields (never includes hashedKey or raw key).
 */
export async function GET(request: NextRequest) {
  try {
    // Extract and verify auth token
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Look up user by Privy ID
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })
    
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Fetch user's API keys (only safe fields)
    const apiKeys = await prisma.apiKey.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        name: true,
        keyHint: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
        // Explicitly exclude: hashedKey
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ apiKeys }, { status: 200 })
  } catch (error) {
    console.error('GET /api/api-keys error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve API keys' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/api-keys
 * Create a new API key for the authenticated user.
 * 
 * Generation & Storage Flow:
 * 1. Generate a raw key using crypto.randomBytes(32) → 64-char hex string
 * 2. Hash the raw key using SHA256 to produce hashedKey
 * 3. Derive keyHint as the last 6 characters of the raw key
 * 4. Store only hashedKey and keyHint (never store raw key)
 * 5. Return raw key exactly once in the response; caller must save it immediately
 * 
 * Raw Key Format: 64-character hexadecimal string (256 bits of entropy)
 * keyHint Format: Last 6 hex characters of raw key (enables safe list display)
 */
export async function POST(request: NextRequest) {
  let rawKey: string | null = null

  try {
    // Extract and verify auth token
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Look up user by Privy ID
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })
    
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Parse and validate request body
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      )
    }

    // Validate against schema
    const validationResult = createApiKeySchema.safeParse(body)
    if (!validationResult.success) {
      const errors = validationResult.error.flatten().fieldErrors
      return NextResponse.json(
        { error: 'Validation failed', details: errors },
        { status: 400 }
      )
    }

    const { name } = validationResult.data

    // Generate raw key (64-char hex, 256 bits of entropy)
    rawKey = generateToken()

    // Hash the raw key for storage
    const hashedKey = hashToken(rawKey)

    // Derive keyHint from the last 6 characters of raw key
    const keyHint = rawKey.slice(-6)

    // Create the API key in the database
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: user.id,
        name,
        keyHint,
        hashedKey,
        isActive: true, // Default to active
      },
    })

    // Return the raw key exactly once; it will never be recoverable after this
    return NextResponse.json(
      {
        id: apiKey.id,
        name: apiKey.name,
        keyHint: apiKey.keyHint,
        isActive: apiKey.isActive,
        createdAt: apiKey.createdAt,
        updatedAt: apiKey.updatedAt,
        // Raw key returned exactly once - caller must save immediately
        rawKey,
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('POST /api/api-keys error:', error)
    // Ensure rawKey is never logged
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    )
  }
}

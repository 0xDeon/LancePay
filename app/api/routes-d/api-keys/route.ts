import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

/**
 * GET /api/routes-d/api-keys - List API keys for the authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

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
      },
    })

    return NextResponse.json({ apiKeys }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/api-keys error')
    return NextResponse.json({ error: 'Failed to list API keys' }, { status: 500 })
  }
}

/**
 * POST /api/routes-d/api-keys - Create a new API key
 *
 * Returns the raw secret once (format: rk_<hash>).
 * Only the secret is shown in this response.
 */
export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const name = typeof payload.name === 'string' ? payload.name.trim() : null

    if (!name) {
      return NextResponse.json(
        { error: 'name is required and must be a non-empty string' },
        { status: 400 },
      )
    }

    // Generate a random secret key
    const secret = crypto.randomBytes(32).toString('hex')
    const secretWithPrefix = `rk_${secret}`

    // Hash the secret for storage
    const hashedKey = crypto
      .createHash('sha256')
      .update(secretWithPrefix)
      .digest('hex')

    // Generate a hint (first 6 chars of the secret, shown to user)
    const keyHint = secret.substring(0, 6)

    const apiKey = await prisma.apiKey.create({
      data: {
        userId: user.id,
        name,
        keyHint,
        hashedKey,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        keyHint: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    logger.info({ userId: user.id, keyId: apiKey.id }, 'API key created')

    return NextResponse.json(
      {
        apiKey: secretWithPrefix,
        key: apiKey,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/api-keys error')
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createApiKeySchema } from '@/lib/validations'
import { generateToken, hashToken } from '@/lib/crypto'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const apiKeys = await prisma.apiKey.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      keyHint: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ apiKeys })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createApiKeySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    )
  }

  const { name } = parsed.data

  // Generate a new API key
  const apiKey = generateToken()
  const hashedKey = hashToken(apiKey)
  const keyHint = apiKey.slice(0, 8) + '...' + apiKey.slice(-4)

  // Create the API key in the database
  const newApiKey = await prisma.apiKey.create({
    data: {
      userId: user.id,
      name,
      keyHint,
      hashedKey,
    },
    select: {
      id: true,
      name: true,
      keyHint: true,
      isActive: true,
      createdAt: true,
    },
  })

  // Return the full API key only once - it cannot be retrieved later
  return NextResponse.json(
    {
      apiKey,
      ...newApiKey,
    },
    { status: 201 }
  )
}

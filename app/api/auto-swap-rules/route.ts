import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'

const createAutoSwapRuleSchema = z.object({
  percentage: z.number().int().min(1).max(100),
  bankAccountId: z.string().min(1),
})

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const autoSwapRule = await prisma.autoSwapRule.findUnique({
    where: { userId: user.id },
    include: { bankAccount: true },
  })

  if (!autoSwapRule) {
    return NextResponse.json({ autoSwapRule: null }, { status: 200 })
  }

  return NextResponse.json({ autoSwapRule }, { status: 200 })
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

  const parsed = createAutoSwapRuleSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    )
  }

  const { percentage, bankAccountId } = parsed.data

  // Verify bank account belongs to the authenticated user
  const bankAccount = await prisma.bankAccount.findUnique({
    where: { id: bankAccountId },
  })

  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  if (bankAccount.userId !== user.id) {
    return NextResponse.json({ error: 'Bank account does not belong to this user' }, { status: 403 })
  }

  // Upsert auto swap rule
  const autoSwapRule = await prisma.autoSwapRule.upsert({
    where: { userId: user.id },
    update: {
      percentage,
      bankAccountId,
      isActive: true,
    },
    create: {
      userId: user.id,
      percentage,
      bankAccountId,
      isActive: true,
    },
    include: { bankAccount: true },
  })

  return NextResponse.json(autoSwapRule, { status: 201 })
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }
  return { user }
}

export async function PATCH(request: NextRequest) {
  const auth = await resolveUser(request)
  if ('error' in auth) return auth.error

  const rule = await prisma.autoSwapRule.findUnique({
    where: { userId: auth.user.id },
  })

  if (!rule) {
    return NextResponse.json({ error: 'AutoSwapRule not found' }, { status: 404 })
  }

  const updated = await prisma.autoSwapRule.update({
    where: { userId: auth.user.id },
    data: { isActive: !rule.isActive },
  })

  return NextResponse.json({
    id: updated.id,
    userId: updated.userId,
    percentage: updated.percentage,
    bankAccountId: updated.bankAccountId,
    isActive: updated.isActive,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  })
}

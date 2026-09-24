import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

type ReleaseBody = {
  lockName?: unknown
  lockToken?: unknown
  key?: unknown
  token?: unknown
}

type LockState = {
  id: string
  tokenHash: string | null
  previousTokenHashes: string[]
  expiresAt: Date | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashesMatch(left: string | null, right: string): boolean {
  if (!left || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function wasPreviousHolder(lock: LockState, tokenHash: string): boolean {
  return lock.previousTokenHashes.some((previousHash) => hashesMatch(previousHash, tokenHash))
}

function alreadyReleased(
  lockName: string,
  reason: 'not_found' | 'released' | 'expired_or_reassigned',
) {
  return NextResponse.json({
    lockName,
    state: 'already_released',
    released: false,
    reason,
  })
}

export async function POST(request: NextRequest) {
  try {
    let body: ReleaseBody
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }

    const nameValue = body.lockName ?? body.key
    const tokenValue = body.lockToken ?? body.token
    const lockName = typeof nameValue === 'string' ? nameValue.trim() : ''
    const lockToken = typeof tokenValue === 'string' ? tokenValue.trim() : ''

    if (!lockName) {
      return NextResponse.json({ error: 'lockName is required' }, { status: 400 })
    }
    if (!lockToken) {
      return NextResponse.json({ error: 'lockToken is required' }, { status: 400 })
    }

    const presentedHash = hashToken(lockToken)
    const lock = await prisma.distributedJobLock.findUnique({
      where: { name: lockName },
      select: {
        id: true,
        tokenHash: true,
        previousTokenHashes: true,
        expiresAt: true,
      },
    })

    if (!lock) return alreadyReleased(lockName, 'not_found')
    if (!lock.tokenHash) return alreadyReleased(lockName, 'released')
    if (wasPreviousHolder(lock, presentedHash)) {
      return alreadyReleased(lockName, 'expired_or_reassigned')
    }
    if (!hashesMatch(lock.tokenHash, presentedHash)) {
      return NextResponse.json(
        { error: 'Lock token does not belong to the current holder' },
        { status: 403 },
      )
    }

    const expired = lock.expiresAt !== null && lock.expiresAt <= new Date()
    const releasedAt = new Date()
    const result = await prisma.distributedJobLock.updateMany({
      where: { id: lock.id, tokenHash: presentedHash },
      data: {
        tokenHash: null,
        previousTokenHashes: { push: presentedHash },
        holderId: null,
        acquiredAt: null,
        expiresAt: null,
        releasedAt,
      },
    })

    if (result.count === 1) {
      if (expired) return alreadyReleased(lockName, 'expired_or_reassigned')
      return NextResponse.json({ lockName, state: 'released', released: true, releasedAt })
    }

    const currentLock = await prisma.distributedJobLock.findUnique({
      where: { name: lockName },
      select: {
        id: true,
        tokenHash: true,
        previousTokenHashes: true,
        expiresAt: true,
      },
    })
    if (
      !currentLock ||
      !currentLock.tokenHash ||
      wasPreviousHolder(currentLock, presentedHash)
    ) {
      return alreadyReleased(lockName, 'expired_or_reassigned')
    }

    return NextResponse.json(
      { error: 'Lock token does not belong to the current holder' },
      { status: 403 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/jobs/distributed-lock/release error')
    return NextResponse.json({ error: 'Failed to release distributed lock' }, { status: 500 })
  }
}

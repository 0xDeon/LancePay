import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) return auth.error

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Bulk invoice job ID is required' }, { status: 400 })
    }

    const job = await prisma.bulkInvoiceJob.findFirst({
      where: { id, userId: auth.user.id },
    })

    if (!job) {
      return NextResponse.json({ error: 'Bulk invoice job not found' }, { status: 404 })
    }

    const completed = job.successCount + job.failedCount === job.totalCount

    return NextResponse.json({
      job: {
        id: job.id,
        status: job.status,
        totalCount: job.totalCount,
        successCount: job.successCount,
        failedCount: job.failedCount,
        completed,
        results: job.results,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() || null,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/bulk-invoice-jobs/[id] error')
    return NextResponse.json({ error: 'Failed to fetch bulk invoice job' }, { status: 500 })
  }
}

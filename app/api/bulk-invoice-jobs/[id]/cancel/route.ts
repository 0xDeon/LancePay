import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const CANCELLABLE_STATUS = 'processing'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Bulk invoice job ID is required' }, { status: 400 })
    }

    const job = await prisma.bulkInvoiceJob.findFirst({
      where: { id, userId: user.id },
    })
    if (!job) {
      return NextResponse.json({ error: 'Bulk invoice job not found' }, { status: 404 })
    }

    if (job.status !== CANCELLABLE_STATUS) {
      return NextResponse.json(
        {
          error: `Bulk invoice job in status '${job.status}' cannot be cancelled`,
          cancellableStatus: CANCELLABLE_STATUS,
        },
        { status: 409 },
      )
    }

    // Cancellation only stops further row processing. Invoices already created by
    // the job are never rolled back, and the existing results/aggregate counters
    // are preserved as-is. `cancelled` is a distinct terminal status from
    // `completed` so callers can tell the difference.
    const cancelled = await prisma.bulkInvoiceJob.update({
      where: { id },
      data: { status: 'cancelled', completedAt: new Date() },
    })

    logger.info({ userId: user.id, jobId: id }, 'Bulk invoice job cancelled')

    return NextResponse.json({
      job: {
        id: cancelled.id,
        status: cancelled.status,
        totalCount: cancelled.totalCount,
        successCount: cancelled.successCount,
        failedCount: cancelled.failedCount,
        completedAt: cancelled.completedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/bulk-invoice-jobs/[id]/cancel error')
    return NextResponse.json({ error: 'Failed to cancel bulk invoice job' }, { status: 500 })
  }
}
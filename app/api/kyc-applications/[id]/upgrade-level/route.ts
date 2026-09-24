import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// POST /api/kyc-applications/[id]/upgrade-level — request a KYC tier upgrade with eligibility checks

// Define prerequisite fields for each KYC level
const LEVEL_PREREQUISITES: Record<string, string[]> = {
  basic: ['fullName', 'dateOfBirth', 'countryCode'],
  enhanced: ['fullName', 'dateOfBirth', 'countryCode', 'addressLine1', 'city', 'postalCode'],
}

// Define the valid upgrade path (next level after each level)
const NEXT_LEVEL: Record<string, string> = {
  basic: 'enhanced',
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function validatePrerequisites(application: Record<string, unknown>, level: string): string[] {
  const required = LEVEL_PREREQUISITES[level]
  if (!required) return []

  const missing: string[] = []
  for (const field of required) {
    const value = application[field as keyof typeof application]
    // Check if field is null, undefined, or empty string
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
      missing.push(field)
    }
  }
  return missing
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params

    // Look up the KycApplication by ID
    const application = await prisma.kycApplication.findUnique({
      where: { id },
    })

    if (!application) {
      return NextResponse.json({ error: 'KYC application not found' }, { status: 404 })
    }

    // Verify that the requester is authorized for this application
    if (application.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to upgrade this application' },
        { status: 403 },
      )
    }

    // Parse request body to get target level
    const body = (await request.json().catch(() => null)) as {
      targetLevel?: string
    } | null

    if (!body || !body.targetLevel || typeof body.targetLevel !== 'string') {
      return NextResponse.json({ error: 'targetLevel is required in request body' }, { status: 400 })
    }

    const targetLevel = body.targetLevel.toLowerCase()

    // Validate that target level is a valid value
    if (!LEVEL_PREREQUISITES[targetLevel]) {
      return NextResponse.json(
        { error: `Invalid targetLevel. Must be one of: ${Object.keys(LEVEL_PREREQUISITES).join(', ')}` },
        { status: 400 },
      )
    }

    // Reject if current level is the same as target level
    if (application.level === targetLevel) {
      return NextResponse.json(
        { error: 'Target level must be different from current level' },
        { status: 400 },
      )
    }

    // Reject if application is not currently approved at its existing level
    if (application.status !== 'approved') {
      return NextResponse.json(
        {
          error: `Cannot upgrade from non-approved status. Current status: ${application.status}`,
        },
        { status: 409 },
      )
    }

    // Validate that all prerequisite fields for the target level are present
    const missingFields = validatePrerequisites(
      application as Record<string, unknown>,
      targetLevel,
    )

    if (missingFields.length > 0) {
      return NextResponse.json(
        {
          error: 'Missing required fields for target level',
          missingFields,
        },
        { status: 422 },
      )
    }

    // Update the application: set level to target, status to pending (atomically)
    const updatedApplication = await prisma.kycApplication.update({
      where: { id },
      data: {
        level: targetLevel,
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
        rejectionReason: null,
      },
    })

    logger.info(
      {
        userId: user.id,
        applicationId: id,
        previousLevel: application.level,
        newLevel: targetLevel,
      },
      'POST /api/kyc-applications/[id]/upgrade-level submitted',
    )

    return NextResponse.json(
      {
        id: updatedApplication.id,
        userId: updatedApplication.userId,
        level: updatedApplication.level,
        status: updatedApplication.status,
        submittedAt: updatedApplication.submittedAt?.toISOString() ?? null,
        message: `Upgrade request submitted. Application moved to pending review for level ${targetLevel}`,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/kyc-applications/[id]/upgrade-level error')
    return NextResponse.json({ error: 'Failed to process upgrade request' }, { status: 500 })
  }
}

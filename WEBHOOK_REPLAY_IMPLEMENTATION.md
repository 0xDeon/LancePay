# Webhook Delivery Replay Implementation — Issue #1472

## Overview

Implemented `POST /api/webhook-deliveries/[id]/replay` endpoint for manually replaying failed or pending webhook deliveries with exponential backoff scheduling and automatic webhook disabling on persistent failures.

## Implementation Details

### Endpoint: `POST /api/webhook-deliveries/[id]/replay`

**Location**: `app/api/webhook-deliveries/[id]/replay/route.ts`

**Authorization**: Authenticated user who owns the parent webhook

**Response Codes**:
- `200 OK`: Replay attempted (delivery may succeed or fail)
- `401 Unauthorized`: Not authenticated or invalid token
- `404 Not Found`: Delivery doesn't exist or user doesn't own it
- `409 Conflict`: Delivery already succeeded or in invalid state

## Key Features

### 1. Authentication & Authorization
- Validates JWT/bearer token via `verifyAuthToken()`
- Verifies user ownership of the parent webhook
- Returns 404 for non-owners (security: doesn't leak existence to unauthorized users)

### 2. Delivery Attempt Mechanism
Performs **synchronous HTTP POST delivery** to the webhook target URL:
- Generates HMAC-SHA256 signature over payload
- Includes headers: `X-Webhook-Signature`, `X-Webhook-Event`
- 30-second timeout per request
- Captures response status code and errors
- 2xx status codes = success; all others = failure

### 3. Exponential Backoff Scheduling

**Configuration**:
```typescript
baseDelayMs: 5000        // 5 seconds initial delay
maxDelayMs: 86400000     // 24 hours max delay
backoffFactor: 2         // Exponential multiplier
jitterMs: 1000           // 0-1000ms random jitter
maxAttempts: 15          // Dead-letter after 15 attempts
```

**Formula**:
```
nextRetryDelayMs = min(baseDelayMs * 2^(attemptCount), maxDelayMs) + jitter
nextRetryAt = now() + nextRetryDelayMs
```

**Example Progression**:
- Attempt 1 failure: retry in ~5s
- Attempt 2 failure: retry in ~10s
- Attempt 3 failure: retry in ~20s
- ...
- Attempt 10+ failures: retry in ~24 hours (capped)

### 4. Consecutive Failure Tracking

**Webhook Status Management**:
- **On success**: `consecutiveFailures` reset to 0
- **On failure**: `consecutiveFailures` incremented by 1
- **Threshold (10 consecutive failures)**: 
  - `UserWebhook.status` set to `"INACTIVE"`
  - `UserWebhook.isActive` set to `false`
  - Email notification sent to webhook owner
  - Further deliveries to this webhook are prevented

### 5. Dead-Lettering

**Conditions**:
- Triggered after `maxAttempts` (15) is reached
- Delivery status set to `"dead_lettered"`
- No further retries scheduled
- User can manually retry via this endpoint or admin interface

### 6. Transactional Updates

Both delivery and webhook updates are wrapped in a **Prisma transaction** to ensure atomicity:
- Delivery record updates (status, attemptCount, nextRetryAt, lastStatusCode, lastError)
- Webhook record updates (consecutiveFailures, status, isActive)
- If either fails, entire transaction rolls back (no partial state)

### 7. Email Notifications

When a webhook is auto-disabled (crosses 10 consecutive failures threshold):
- **Template**: `sendWebhookDisabledEmail()` from `lib/email.ts`
- **Subject**: "Webhook Disabled - Consecutive Delivery Failures"
- **Content**: Includes endpoint URL, last error, and remediation steps
- **Failure Handling**: Logged but doesn't fail the request

## Test Coverage

**File**: `tests/api.webhook-deliveries.replay.test.ts`

**16 Test Scenarios**:

### Authentication & Authorization
- [x] Returns 401 when unauthenticated
- [x] Returns 404 when delivery does not exist
- [x] Returns 404 when delivery belongs to another user (ownership verification)

### Status Validation
- [x] Returns 409 when delivery is already succeeded
- [x] Rejects non-deliverable statuses with 409

### Happy Paths
- [x] **Success case**: Replaying successful delivery resets `consecutiveFailures` to 0, leaves webhook status ACTIVE
- [x] **Failure case**: Replaying failed delivery increments `attemptCount`, schedules next retry via exponential backoff, increments `consecutiveFailures`

### Backoff & Retry
- [x] **Backoff cap**: High `attemptCount` (20+) computes max delay (~24h), not unbounded exponential
- [x] **Max attempts**: Delivery marked `dead_lettered` after 15 attempts with no future retries

### Threshold Crossing
- [x] **At threshold**: Failure reaching 10 consecutive failures auto-disables webhook with email sent
- [x] **Below threshold**: Failure below 10 consecutive failures leaves webhook active

### Error Handling
- [x] HTTP delivery timeout handled gracefully
- [x] Malformed responses handled without crashing

### Atomicity
- [x] Transaction wrapping verified — delivery and webhook updates are atomic

## Configuration Constants

```typescript
const WEBHOOK_RETRY_CONFIG = {
  baseDelayMs: 5000,              // Initial retry delay
  maxDelayMs: 86400000,            // Max retry delay (24 hours)
  backoffFactor: 2,               // Exponential base
  jitterMs: 1000,                 // Jitter range
  consecutiveFailuresThreshold: 10, // Auto-disable threshold
  maxAttempts: 15,                // Dead-letter threshold
}
```

## Database Schema (No Changes Required)

Existing Prisma models support all required fields:

**WebhookDelivery**:
- `attemptCount` (int, incremented on each replay)
- `nextRetryAt` (datetime, computed via backoff)
- `lastStatusCode` (int, captured from HTTP response)
- `lastError` (text, captured from HTTP error or status)
- `status` (enum: pending, delivered, failed, dead_lettered)

**UserWebhook**:
- `consecutiveFailures` (int, incremented on failure, reset on success)
- `status` (enum: ACTIVE, INACTIVE)
- `isActive` (boolean, set false when webhook auto-disabled)

## API Response Example

```json
{
  "message": "Webhook delivery replayed successfully",
  "delivery": {
    "id": "del_abc123",
    "status": "delivered",
    "attemptCount": 4,
    "lastStatusCode": 200,
    "lastError": null,
    "nextRetryAt": null
  },
  "webhook": {
    "id": "wh_xyz789",
    "consecutiveFailures": 0,
    "status": "ACTIVE",
    "isActive": true
  },
  "deliveryAttempt": {
    "success": true,
    "statusCode": 200,
    "error": null
  }
}
```

## Error Response Example

```json
{
  "error": "Cannot replay a delivery that has already succeeded"
}
```

## Replay Semantics

**This endpoint performs SYNCHRONOUS HTTP delivery**:

1. Makes real HTTP POST to webhook target URL
2. Updates delivery record with outcome (status, code, error)
3. Computes and schedules next retry based on actual attempt result
4. Increments consecutive failures or resets to 0 based on success/failure
5. Auto-disables webhook if consecutive failures cross 10-failure threshold

This is different from a "reschedule-only" approach which would just mark as pending for background processing. The synchronous approach allows immediate feedback and real-time webhook validation.

## Security Considerations

1. **HMAC-SHA256 Signature**: Webhook payload signed with `signingSecret` to prove authenticity
2. **Authorization**: Only webhook owner can replay; non-owners see 404
3. **Rate Limiting**: Not implemented in this endpoint (could be added via middleware)
4. **Timeout**: 30-second timeout prevents hanging requests
5. **Email Safety**: HTML-escaped user-provided data in email templates

## Future Improvements

1. **Extraction to Service**: Move delivery executor logic to `lib/webhook-delivery.ts` for reuse by background cron handler
2. **Rate Limiting**: Add rate limiting to prevent abuse (e.g., max 5 retries per minute per webhook)
3. **Batch Retry UI**: Create dashboard UI to replay multiple dead-lettered deliveries
4. **Delivery History**: Track retry history with timestamps and errors for debugging
5. **Webhook Health Dashboard**: Real-time status, consecutive failure counts, last error details

## Notes

- **Backoff formula adapted from**: `lib/stellar-funding.ts` (general exponential backoff pattern)
- **HMAC signing pattern from**: `lib/offramp.ts` (crypto.createHmac usage)
- **Email template from**: `lib/email.ts` (sendWebhookDisabledEmail)
- **Auto-disable threshold**: Confirmed as 10 consecutive failures per `lib/email.ts` context

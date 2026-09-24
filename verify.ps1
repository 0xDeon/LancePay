#!/usr/bin/env pwsh
$ErrorActionPreference = "Continue"

Write-Host "=== Verifying Webhook Replay Implementation ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "1. Running linter..." -ForegroundColor Yellow
npm run lint
$lintResult = $LASTEXITCODE
Write-Host "Lint exit code: $lintResult" -ForegroundColor Gray
Write-Host ""

Write-Host "2. Running tests..." -ForegroundColor Yellow
npm test -- tests/api.webhook-deliveries.replay.test.ts --run 2>&1
$testResult = $LASTEXITCODE
Write-Host "Test exit code: $testResult" -ForegroundColor Gray
Write-Host ""

Write-Host "3. Building project..." -ForegroundColor Yellow
npm run build
$buildResult = $LASTEXITCODE
Write-Host "Build exit code: $buildResult" -ForegroundColor Gray
Write-Host ""

Write-Host "=== Verification Summary ===" -ForegroundColor Cyan
$allPassed = $lintResult -eq 0 -and $testResult -eq 0 -and $buildResult -eq 0

if ($allPassed) {
  Write-Host "✓ All checks passed!" -ForegroundColor Green
} else {
  Write-Host "✗ Some checks failed" -ForegroundColor Red
  if ($lintResult -ne 0) { Write-Host "  - Linter failed (exit code: $lintResult)" }
  if ($testResult -ne 0) { Write-Host "  - Tests failed (exit code: $testResult)" }
  if ($buildResult -ne 0) { Write-Host "  - Build failed (exit code: $buildResult)" }
}

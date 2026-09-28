# TeamChat verify loop - run after EVERY change to prove the app still works.
# Usage: powershell -File ./scripts/verify.ps1
$ErrorActionPreference = 'Stop'
$failures = 0

function Check($name, [scriptblock]$block) {
  try {
    & $block
    Write-Host "PASS: $name" -ForegroundColor Green
  } catch {
    Write-Host ("FAIL: " + $name + " - " + $_.Exception.Message) -ForegroundColor Red
    $script:failures++
  }
}

Check 'docker containers running' {
  $ps = docker ps --format '{{.Names}}' 2>$null
  foreach ($c in @('teamchat-mongo', 'teamchat-redis', 'teamchat-server', 'teamchat-desktop')) {
    if ($ps -notcontains $c) { throw "container $c not running (run: docker compose up -d --build)" }
  }
}

Check 'backend health ok' {
  $h = Invoke-RestMethod -Uri 'http://localhost:3000/health' -TimeoutSec 15
  if ($h.status -ne 'ok') { throw 'health status not ok - is Docker infra up?' }
  if (-not $h.deps.mongo.ok) { throw 'mongo dep not ok' }
  if (-not $h.deps.redis.ok) { throw 'redis dep not ok' }
}

Check 'backend version' {
  $v = Invoke-RestMethod -Uri 'http://localhost:3000/version' -TimeoutSec 10
  if ($v.name -ne 'teamchat-server') { throw 'unexpected version response' }
  if (-not $v.minAppVersion) { throw 'version missing minAppVersion (Phase 10 compat)' }
}

Check 'update feed reachable' {
  $u = Invoke-RestMethod -Uri 'http://localhost:3000/updates/latest?current=0.1.0' -TimeoutSec 10
  if ($null -eq $u.available) { throw 'updates feed malformed' }
}

Check 'crash endpoint live' {
  try {
    Invoke-RestMethod -Uri 'http://localhost:3000/crashes' -Method POST -ContentType 'application/json' -Body '{"error":""}' -TimeoutSec 10 | Out-Null
    throw 'crash endpoint accepted empty report'
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 400) { throw 'crash endpoint unexpected status' }
  }
}

Check 'frontend UI serves on 5173' {
  $r = Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 15
  if ($r.StatusCode -ne 200) { throw 'UI did not return HTTP 200' }
}

Check 'JS-only guard (no TypeScript)' {
  node ./scripts/no-ts-guard.js | Out-Null
}

Check 'backend unit tests' {
  pnpm --filter @teamchat/server test | Out-Null
}

if ($failures -gt 0) {
  Write-Host ($failures.ToString() + " check(s) FAILED - do not move to the next phase.") -ForegroundColor Red
  exit 1
}
Write-Host "All checks passed - safe to continue." -ForegroundColor Green

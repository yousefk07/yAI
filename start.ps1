# Brings yAI back online after a reboot: starts LM Studio's server, the bridge
# and a Cloudflare tunnel, then points Vercel at the new tunnel URL and redeploys.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\start.ps1

$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$logs = Join-Path $dir "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

# 1. LM Studio server (the app must be installed; this starts it headless if needed)
$lms = Join-Path $env:USERPROFILE ".lmstudio\bin\lms.exe"
& $lms server start | Out-Host

# 2. Stop any old bridge/tunnel, then start fresh ones in the background
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match "bridge\.js" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Process -FilePath "node" -ArgumentList "--env-file-if-exists=.env", "bridge.js" -WorkingDirectory $dir `
  -WindowStyle Hidden -RedirectStandardOutput "$logs\bridge.log" -RedirectStandardError "$logs\bridge.err.log"

Remove-Item "$logs\tunnel.log" -ErrorAction SilentlyContinue
$cloudflared = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
Start-Process -FilePath $cloudflared -ArgumentList "tunnel", "--no-autoupdate", "--url", "http://localhost:8787", "--logfile", "$logs\tunnel.log" `
  -WindowStyle Hidden

# 3. Wait for the tunnel's public URL
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep 1
  if (Test-Path "$logs\tunnel.log") {
    $m = Select-String -Path "$logs\tunnel.log" -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) { throw "Tunnel didn't start; see $logs\tunnel.log" }
Write-Host "Tunnel: $url"

# 4. Point Vercel at it and redeploy
Push-Location $dir
try {
  vercel env add LMSTUDIO_URL production --value "$url/v1" --force --yes | Out-Host
  vercel deploy --prod --yes | Out-Host
} finally {
  Pop-Location
}
Write-Host "`nyAI is online: https://yousef-llmai.vercel.app" -ForegroundColor Green

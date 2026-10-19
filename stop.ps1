# Takes yAI offline and frees the GPU (e.g. before gaming): unloads every model,
# stops LM Studio's server, the bridge and the Cloudflare tunnel, and quits LM Studio.
# Bring it back later with "Start yAI.cmd".

$lms = Join-Path $env:USERPROFILE ".lmstudio\bin\lms.exe"

if (Test-Path $lms) {
  Write-Host "Unloading models..."
  & $lms unload --all 2>&1 | Out-Host
  Write-Host "Stopping LM Studio server..."
  & $lms server stop 2>&1 | Out-Host
}

Write-Host "Stopping the bridge and tunnel..."
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match "bridge\.js|server\.js" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "Quitting LM Studio..."
Get-Process "LM Studio", "lms", "llmworker" -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Sleep 2
$gpu = try { (nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader) } catch { "unknown" }
Write-Host "`nyAI is offline. GPU memory in use now: $gpu" -ForegroundColor Green
Write-Host "Run 'Start yAI.cmd' to bring it back."

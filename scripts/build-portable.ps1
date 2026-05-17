$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$distRoot = Join-Path $root "dist"
$out = Join-Path $distRoot "weibo-monitor-win"

if (Test-Path $out) {
  Remove-Item -LiteralPath $out -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $out | Out-Null

$nodeExe = (Get-Command node).Source
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $out "node.exe")

Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $out
Copy-Item -LiteralPath (Join-Path $root "package-lock.json") -Destination $out
Copy-Item -LiteralPath (Join-Path $root "config.example.json") -Destination $out
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $out

Copy-Item -LiteralPath (Join-Path $root "src") -Destination $out -Recurse
Copy-Item -LiteralPath (Join-Path $root "scripts") -Destination $out -Recurse
Copy-Item -LiteralPath (Join-Path $root "node_modules") -Destination $out -Recurse

@'
@echo off
setlocal
cd /d "%~dp0"
if not exist config.json copy config.example.json config.json >nul
"%~dp0node.exe" src\server.js
'@ | Set-Content -LiteralPath (Join-Path $out "start-ui.cmd") -Encoding ASCII

@'
@echo off
setlocal
cd /d "%~dp0"
if not exist config.json copy config.example.json config.json >nul
"%~dp0node.exe" src\index.js monitor
'@ | Set-Content -LiteralPath (Join-Path $out "start-monitor.cmd") -Encoding ASCII

@'
@echo off
setlocal
cd /d "%~dp0"
if not exist config.json copy config.example.json config.json >nul
"%~dp0node.exe" src\index.js check
pause
'@ | Set-Content -LiteralPath (Join-Path $out "check-once.cmd") -Encoding ASCII

Compress-Archive -Path (Join-Path $out "*") -DestinationPath (Join-Path $distRoot "weibo-monitor-win.zip") -Force

Write-Host "Built: $out"
Write-Host "Zip:   $(Join-Path $distRoot "weibo-monitor-win.zip")"

param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
$goBinary = Join-Path $workspace '.tools/go/bin/go.exe'
if (-not (Test-Path -LiteralPath $goBinary)) { $goBinary = (Get-Command go).Source }
$env:GOPATH = Join-Path $workspace '.tools/gopath'
$env:GOCACHE = Join-Path $workspace '.tools/gocache'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Universal Client build failed' }
New-Item -ItemType Directory -Force 'artifacts' | Out-Null
& $goBinary build -trimpath -o artifacts/panestra-core.exe ./core/cmd/panestra-core
if ($LASTEXITCODE -ne 0) { throw 'Core build failed' }
& $goBinary build -trimpath -o artifacts/system-plugin.exe ./plugins/system
if ($LASTEXITCODE -ne 0) { throw 'System Plugin build failed' }
& $goBinary build -trimpath -o artifacts/panestra-release.exe ./core/cmd/panestra-release
if ($LASTEXITCODE -ne 0) { throw 'Release tool build failed' }
& $goBinary build -trimpath -o artifacts/panestra-sign.exe ./core/cmd/panestra-sign
if ($LASTEXITCODE -ne 0) { throw 'Publisher tool build failed' }
if ($Desktop) {
    Copy-Item -LiteralPath 'artifacts/panestra-core.exe' -Destination 'shell/desktop/binaries/panestra-core-x86_64-pc-windows-msvc.exe'
    Copy-Item -LiteralPath 'artifacts/system-plugin.exe' -Destination 'shell/desktop/binaries/system-plugin-x86_64-pc-windows-msvc.exe'
    . "$PSScriptRoot/native-env.ps1"
    Set-Location -LiteralPath 'shell/desktop'
    npm exec -- tauri build
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
}

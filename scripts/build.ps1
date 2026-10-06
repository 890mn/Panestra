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
    $localSigningKey = Join-Path $workspace '.tools/publisher/updater-key.protected'
    $loadedLocalKey = $false
    try {
        if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and (Test-Path -LiteralPath $localSigningKey)) {
            Add-Type -AssemblyName System.Security
            $env:TAURI_SIGNING_PRIVATE_KEY = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(
                [IO.File]::ReadAllBytes($localSigningKey), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
            $loadedLocalKey = $true
        }
        # Contributors can build locally without the publisher key. Public releases
        # must retain createUpdaterArtifacts=true and provide their signing secret.
        if ($env:TAURI_SIGNING_PRIVATE_KEY) { npm exec -- tauri build }
        else { npm exec -- tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' }
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    } finally {
        if ($loadedLocalKey) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY }
    }
}
Set-Location -LiteralPath $workspace

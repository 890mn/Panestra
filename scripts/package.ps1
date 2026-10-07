param([string]$Version = '0.1.17')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must contain three numeric components' }
$destination = Join-Path $workspace "artifacts/Panestra-$Version-windows-x64"
New-Item -ItemType Directory -Force (Join-Path $destination 'plugins/system') | Out-Null
Copy-Item -LiteralPath 'shell/desktop/target/release/panestra-desktop.exe' -Destination (Join-Path $destination 'Panestra.exe')
foreach ($name in @('panestra-core.exe', 'system-plugin.exe', 'panestra-release.exe', 'panestra-sign.exe')) {
    Copy-Item -LiteralPath (Join-Path $workspace "artifacts/$name") -Destination (Join-Path $destination $name)
}
Copy-Item -LiteralPath 'plugins/system/manifest.json' -Destination (Join-Path $destination 'plugins/system/manifest.json')
Copy-Item -LiteralPath 'README.md' -Destination (Join-Path $destination 'README.md')
Copy-Item -LiteralPath 'CHANGELOG.md' -Destination (Join-Path $destination 'CHANGELOG.md')
Copy-Item -LiteralPath "shell/desktop/target/release/bundle/nsis/Panestra_${Version}_x64-setup.exe" -Destination "artifacts/Panestra-$Version-windows-x64-setup.exe"
Copy-Item -LiteralPath 'shell/desktop/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk' -Destination "artifacts/Panestra-$Version-android-arm64-development.apk"
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $destination).FullName -DestinationPath "artifacts/Panestra-$Version-windows-x64.zip" -Force
$deliverables = Get-ChildItem -LiteralPath 'artifacts' -File | Where-Object { $_.Name -match "^Panestra-$([regex]::Escape($Version))-(windows-x64\.zip|windows-x64-setup\.exe|android-arm64-development\.apk)$" }
$checksums = $deliverables | Sort-Object Name | ForEach-Object { "$( (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() )  $($_.Name)" }
[IO.File]::WriteAllLines((Join-Path $workspace 'artifacts/SHA256SUMS.txt'), $checksums, [Text.UTF8Encoding]::new($false))
$deliverables | Select-Object Name, Length

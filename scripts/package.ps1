param([string]$Version = '0.1.34')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must contain three numeric components' }
$releaseDirectory = Join-Path $workspace "artifacts/archive/releases/$Version"
$destination = Join-Path $releaseDirectory "Panestra-$Version-windows-x64"
New-Item -ItemType Directory -Force (Join-Path $destination 'plugin-seed') | Out-Null
Copy-Item -LiteralPath 'shell/desktop/target/release/panestra-desktop.exe' -Destination (Join-Path $destination 'Panestra.exe')
foreach ($name in @('panestra-core.exe', 'panestra-release.exe', 'panestra-sign.exe')) {
    Copy-Item -LiteralPath (Join-Path $workspace "artifacts/build/$name") -Destination (Join-Path $destination $name)
}
Copy-Item -Path 'artifacts/build/plugin-seed/*' -Destination (Join-Path $destination 'plugin-seed') -Force
Copy-Item -LiteralPath 'README.md' -Destination (Join-Path $destination 'README.md')
Copy-Item -LiteralPath 'CHANGELOG.md' -Destination (Join-Path $destination 'CHANGELOG.md')
Copy-Item -LiteralPath "shell/desktop/target/release/bundle/nsis/Panestra_${Version}_x64-setup.exe" -Destination (Join-Path $releaseDirectory "Panestra-$Version-windows-x64-setup.exe")
Copy-Item -LiteralPath 'shell/desktop/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk' -Destination (Join-Path $releaseDirectory "Panestra-$Version-android-arm64-development.apk")
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $destination).FullName -DestinationPath (Join-Path $releaseDirectory "Panestra-$Version-windows-x64.zip") -Force
$deliverables = Get-ChildItem -LiteralPath $releaseDirectory -File | Where-Object { $_.Name -match "^Panestra-$([regex]::Escape($Version))-(windows-x64\.zip|windows-x64-setup\.exe|android-arm64-development\.apk)$" }
$checksums = $deliverables | Sort-Object Name | ForEach-Object { "$( (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() )  $($_.Name)" }
[IO.File]::WriteAllLines((Join-Path $releaseDirectory 'SHA256SUMS.txt'), $checksums, [Text.UTF8Encoding]::new($false))
& "$PSScriptRoot/organize-artifacts.ps1"
$deliverables | Select-Object Name, Length

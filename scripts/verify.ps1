$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
$env:GOPATH = Join-Path $workspace '.tools/gopath'
$env:GOCACHE = Join-Path $workspace '.tools/gocache'
$env:TEMP = Join-Path $workspace '.tools/test-tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
$goBinary = Join-Path $workspace '.tools/go/bin/go.exe'
if (-not (Test-Path -LiteralPath $goBinary)) { $goBinary = (Get-Command go).Source }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'TypeScript validation failed' }
npm run format:check
if ($LASTEXITCODE -ne 0) { throw 'Source formatting validation failed' }
node ./scripts/check-version.mjs
if ($LASTEXITCODE -ne 0) { throw 'Project version consistency failed' }
$goFiles = rg --files core plugins -g '*.go' -g '!core/web/dist/**'
$unformattedGo = & (Join-Path (Split-Path $goBinary) 'gofmt.exe') -l $goFiles
if ($unformattedGo) { throw "Go formatting failed: $unformattedGo" }
. "$PSScriptRoot/native-env.ps1"
cargo fmt --manifest-path shell/desktop/Cargo.toml --check
if ($LASTEXITCODE -ne 0) { throw 'Rust formatting failed' }
& $goBinary vet ./core/... ./plugins/...
if ($LASTEXITCODE -ne 0) { throw 'Go vet failed' }
& $goBinary test ./core/... ./plugins/... -count=1
if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
npm run test:ui
if ($LASTEXITCODE -ne 0) { throw 'Browser integration tests failed' }

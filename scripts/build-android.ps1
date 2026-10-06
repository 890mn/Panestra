param([switch]$Debug, [switch]$OptimizedNative)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot/android-env.ps1"
Set-Location -LiteralPath (Join-Path $workspace 'shell/desktop')
if (-not (Test-Path -LiteralPath 'gen/android/gradlew.bat')) {
    npm exec -- tauri android init --config ../android/tauri.conf.json
    if ($LASTEXITCODE -ne 0) { throw 'Android project initialization failed' }
}
node ../../scripts/prepare-android.mjs
$arguments = @('exec', '--', 'tauri', 'android', 'build', '--target', 'aarch64', '--apk', '--config', '../android/tauri.conf.json')
if ($Debug -and -not $OptimizedNative) { $arguments += '--debug' }
New-Item -ItemType Directory -Force (Join-Path $workspace 'artifacts') | Out-Null
$buildLog = Join-Path $workspace 'artifacts/android-build.log'
& npm @arguments 2>&1 | Tee-Object -FilePath $buildLog
$tauriBuildFailed = $LASTEXITCODE -ne 0
if ($tauriBuildFailed) {
    # Tauri's Windows symlink step may fail without Developer Mode. Copy the verified local build.
    if ((Get-Content -LiteralPath $buildLog -Raw) -notmatch '(?i)(creation symbolic link is not allowed|failed to create a symbolic link)') {
        throw "Android build failed; see $buildLog"
    }
}
if ($tauriBuildFailed -or ($Debug -and $OptimizedNative)) {
    # Keep the existing development signing identity and WebView inspection,
    # while packaging optimized native code rather than the huge dev library.
    $profile = if ($Debug -and -not $OptimizedNative) { 'debug' } else { 'release' }
    $library = Join-Path $PWD "target/aarch64-linux-android/$profile/libpanestra_shell.so"
    if (-not (Test-Path -LiteralPath $library)) { throw 'Android Rust build failed' }
    $destination = Join-Path $PWD 'gen/android/app/src/main/jniLibs/arm64-v8a'
    New-Item -ItemType Directory -Force $destination | Out-Null
    Copy-Item -LiteralPath $library -Destination (Join-Path $destination 'libpanestra_shell.so')
    node ../../scripts/prepare-android.mjs
    Set-Location -LiteralPath 'gen/android'
    $variant = if ($Debug) { 'Debug' } else { 'Release' }
    $gradleTasks = @()
    # APK incremental packaging may retain the discarded large native entry.
    if ($Debug -and $OptimizedNative) { $gradleTasks += ':app:clean' }
    $gradleTasks += ":app:assembleArm64$variant"
    & .\gradlew.bat @gradleTasks -x ":app:rustBuildArm64$variant" --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Android Gradle build failed' }
}

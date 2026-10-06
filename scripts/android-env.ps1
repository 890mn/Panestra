$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/native-env.ps1"
$workspace = Split-Path -Parent $PSScriptRoot
$javaRoot = Join-Path $workspace '.tools/jdk'
if (Test-Path -LiteralPath $javaRoot) { $env:JAVA_HOME = (Get-ChildItem -LiteralPath $javaRoot -Directory | Select-Object -First 1).FullName }
$portableSDK = Join-Path $workspace '.tools/android-sdk'
if (Test-Path -LiteralPath $portableSDK) { $env:ANDROID_HOME = $portableSDK }
if (-not $env:ANDROID_HOME) { throw 'Set ANDROID_HOME to an Android SDK 36 installation' }
$env:ANDROID_USER_HOME = Join-Path $workspace '.tools/android-user'
$env:GRADLE_USER_HOME = Join-Path $workspace '.tools/gradle'
$env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk/28.2.13676358'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

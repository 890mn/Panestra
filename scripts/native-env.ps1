$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$portableCargo = Join-Path $workspace '.tools/cargo'
if (Test-Path -LiteralPath $portableCargo) { $env:CARGO_HOME = $portableCargo }
$env:CARGO_HTTP_MULTIPLEXING = 'false'
$msvcRoot = Join-Path $workspace '.tools/msvc/Contents/VC/Tools/MSVC/14.44.35207'
$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10'
if (Test-Path -LiteralPath $msvcRoot) {
    $env:PATH = "$msvcRoot\bin\Hostx64\x64;$sdkRoot\bin\10.0.22621.0\x64;$env:PATH"
    $env:LIB = "$msvcRoot\lib\x64;$sdkRoot\Lib\10.0.22621.0\ucrt\x64;$sdkRoot\Lib\10.0.22621.0\um\x64"
    $env:INCLUDE = "$msvcRoot\include;$sdkRoot\Include\10.0.22621.0\ucrt;$sdkRoot\Include\10.0.22621.0\shared;$sdkRoot\Include\10.0.22621.0\um"
}

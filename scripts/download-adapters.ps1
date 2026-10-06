param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$adapters = @(@{ Name = 'go'; Port = 18573 }, @{ Name = 'cargo'; Port = 18574 })
foreach ($adapter in $adapters) {
    $script = Join-Path $PSScriptRoot "$($adapter.Name)-proxy.mjs"
    $pidFile = Join-Path $workspace ".tools/$($adapter.Name)-adapter.pid"
    if ($Stop) {
        if (Test-Path -LiteralPath $pidFile) {
            $adapterPID = [int](Get-Content -LiteralPath $pidFile -Raw)
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$adapterPID"
            if ($processInfo -and $processInfo.CommandLine.Contains($script)) {
                $adapterProcess = [Diagnostics.Process]::GetProcessById($adapterPID)
                try { $adapterProcess.Kill() } finally { $adapterProcess.Dispose() }
            }
            Remove-Item -LiteralPath $pidFile
        }
        continue
    }
    $probe = [Net.Sockets.TcpClient]::new()
    try { $probe.Connect('127.0.0.1', $adapter.Port); $listening = $true } catch { $listening = $false } finally { $probe.Dispose() }
    if ($listening) { continue }
    New-Item -ItemType Directory -Force (Join-Path $workspace '.tools') | Out-Null
    $processInfo = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("`"$script`"") -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($pidFile, [string]$processInfo.Id)
}
$env:GOPROXY = 'http://127.0.0.1:18573'
Write-Output 'Local development download adapters: Go 18573, Cargo 18574. Product TLS is unaffected.'

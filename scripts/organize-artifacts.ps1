$ErrorActionPreference = 'Stop'
$taskWorkspace = Split-Path -Parent $PSScriptRoot
$taskArtifacts = [IO.Path]::GetFullPath((Join-Path $taskWorkspace 'artifacts'))
if (-not (Test-Path -LiteralPath $taskArtifacts)) { return }
$taskPrefix = $taskArtifacts + [IO.Path]::DirectorySeparatorChar
$taskMoved = 0
function Assert-ArtifactPath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Artifact path escapes workspace: $resolved" }
    return $resolved
}
function Move-Artifact([IO.FileSystemInfo]$Item, [string]$RelativeDestination) {
    $source = Assert-ArtifactPath $Item.FullName
    $target = Assert-ArtifactPath (Join-Path $taskArtifacts $RelativeDestination)
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked artifact requires manual review: $source" }
    if ($Item.PSIsContainer -and (Get-ChildItem -LiteralPath $source -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1)) { throw "Linked artifact directory requires manual review: $source" }
    if (Test-Path -LiteralPath $target) {
        if (-not $Item.PSIsContainer -and (Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $target).Hash) {
            # Keep both copies rather than deleting a pre-existing artifact.
            $target = Assert-ArtifactPath (Join-Path (Split-Path $target) ('duplicate-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '-' + $Item.Name))
        } else { $target = Assert-ArtifactPath (Join-Path (Split-Path $target) ('previous-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '-' + $Item.Name)) }
    }
    New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
    try { Move-Item -LiteralPath $source -Destination $target -ErrorAction Stop; $script:taskMoved++ }
    catch [IO.IOException] { Write-Warning "Artifact is in use, left in place: $($Item.Name)" }
}

$taskFeedVersion = $null
if (Test-Path -LiteralPath (Join-Path $taskArtifacts 'latest.json')) {
    try { $taskFeedVersion = (Get-Content -LiteralPath (Join-Path $taskArtifacts 'latest.json') -Raw | ConvertFrom-Json).version } catch { }
}
foreach ($taskItem in Get-ChildItem -LiteralPath $taskArtifacts -Force) {
    if ($taskItem.Name -in @('latest', 'archive', 'build', 'README.txt')) { continue }
    $taskTarget = $null
    if ($taskItem.Name -match '^Panestra-(\d+\.\d+\.\d+)-') { $taskTarget = "archive/releases/$($Matches[1])/$($taskItem.Name)" }
    elseif ($taskItem.Name -eq 'plugin-seed' -or $taskItem.Name -match '^(panestra-core|panestra-release|panestra-sign|codex-fixture|system-plugin)\.exe$') { $taskTarget = "build/$($taskItem.Name)" }
    elseif ($taskItem.Name -in @('latest.json', 'UPDATE-SHA256SUMS.txt') -and $taskFeedVersion -match '^\d+\.\d+\.\d+$') { $taskTarget = "archive/releases/$taskFeedVersion/$($taskItem.Name)" }
    elseif ($taskItem.Name -eq 'SHA256SUMS.txt') {
        $taskChecksum = Get-Content -LiteralPath $taskItem.FullName -Raw
        if ($taskChecksum -match 'Panestra-(\d+\.\d+\.\d+)-') { $taskTarget = "archive/releases/$($Matches[1])/$($taskItem.Name)" }
        else { $taskTarget = "archive/reports/$($taskItem.Name)" }
    }
    elseif ($taskItem.Name -match '^页面截图-(\d+\.\d+\.\d+)$') { $taskTarget = "archive/screenshots/$($Matches[1])/$($taskItem.Name)" }
    elseif ($taskItem.Extension -in @('.png', '.jpg', '.jpeg', '.webp')) {
        $taskGroup = if ($taskItem.Name -match '(\d+\.\d+\.\d+)') { $Matches[1] } else { 'unversioned' }
        $taskTarget = "archive/screenshots/$taskGroup/$($taskItem.Name)"
    }
    elseif ($taskItem.Extension -eq '.log') { $taskTarget = "archive/logs/$($taskItem.Name)" }
    elseif ($taskItem.Extension -in @('.json', '.txt') -or $taskItem.Name -in @('test-results', 'universal-fleet-rerun')) { $taskTarget = "archive/reports/$($taskItem.Name)" }
    else { $taskTarget = "archive/other/$($taskItem.Name)" }
    Move-Artifact $taskItem $taskTarget
}

$taskReleases = Join-Path $taskArtifacts 'archive/releases'
$taskComplete = @()
if (Test-Path -LiteralPath $taskReleases) {
    $taskComplete = @(Get-ChildItem -LiteralPath $taskReleases -Directory | Where-Object {
        $_.Name -match '^\d+\.\d+\.\d+$' -and
        (Test-Path -LiteralPath (Join-Path $_.FullName "Panestra-$($_.Name)-windows-x64-setup.exe")) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName "Panestra-$($_.Name)-windows-x64.zip")) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName "Panestra-$($_.Name)-android-arm64-development.apk"))
    } | Sort-Object { [version]$_.Name } -Descending)
}
if ($taskComplete.Count) {
    $taskLatest = Assert-ArtifactPath (Join-Path $taskArtifacts 'latest')
    New-Item -ItemType Directory -Force $taskLatest | Out-Null
    $taskRelease = $taskComplete[0]
    $taskHashes = @()
    foreach ($taskSuffix in @('windows-x64-setup.exe', 'windows-x64.zip', 'android-arm64-development.apk')) {
        $taskSource = Assert-ArtifactPath (Join-Path $taskRelease.FullName "Panestra-$($taskRelease.Name)-$taskSuffix")
        $taskName = "Panestra-$taskSuffix"
        $taskTarget = Assert-ArtifactPath (Join-Path $taskLatest $taskName)
        $taskHash = (Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash
        if (-not (Test-Path -LiteralPath $taskTarget) -or (Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash -ne $taskHash) { Copy-Item -LiteralPath $taskSource -Destination $taskTarget -Force }
        if ((Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash -ne $taskHash) { throw "Latest package checksum mismatch: $taskName" }
        $taskHashes += "$($taskHash.ToLower())  $taskName"
    }
    [IO.File]::WriteAllLines((Join-Path $taskLatest 'SHA256SUMS.txt'), $taskHashes, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $taskLatest 'VERSION.txt'), $taskRelease.Name + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Latest: $($taskRelease.Name)"
}
[IO.File]::WriteAllLines((Join-Path $taskArtifacts 'README.txt'), @(
    'latest/   Current complete release, stable filenames; version in VERSION.txt',
    'archive/  Versioned releases, screenshots, logs and validation reports',
    'build/    Core executables, test fixtures and signed plugin seed used by build/test scripts',
    'Run scripts/organize-artifacts.ps1 to collect new test output; package.ps1 runs it automatically',
    'All artifacts remain local and ignored by Git'
), [Text.UTF8Encoding]::new($false))
Write-Output "Organized $taskMoved entries, preserved existing files"

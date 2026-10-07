$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$propertyType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$randomType = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$readerType = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$script:artworkKey = ''; $script:artwork = ''
$taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-WinRT($operation, [Type]$resultType) {
    $task = $taskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(8000)) { throw 'Media operation timed out' }
    return $task.GetAwaiter().GetResult()
}
function Get-NeteaseSession($manager) {
    foreach ($session in $manager.GetSessions()) {
        $source = [string]$session.SourceAppUserModelId
        $base = [IO.Path]::GetFileName($source)
        if ($base -match '^(cloudmusic|neteasecloudmusic)(\.exe)?$' -or $source -match '^NetEase\.CloudMusic_[A-Za-z0-9]+!') { return $session }
    }
    return $null
}
function Read-Media($session) {
    $properties = Await-WinRT ($session.TryGetMediaPropertiesAsync()) $propertyType
    $key = ([string]$properties.Title) + '|' + ([string]$properties.Artist) + '|' + ([string]$properties.AlbumTitle)
    if ($key -ne $script:artworkKey) {
        $script:artworkKey = $key; $script:artwork = ''
        if ($properties.Thumbnail) {
            $reader = $null; $stream = $null
            try {
                $stream = Await-WinRT ($properties.Thumbnail.OpenReadAsync()) $streamType
                $size = $randomType.GetProperty('Size').GetValue($stream, $null)
                if ($size -gt 0 -and $size -le 98304) {
                    $inputStream = $randomType.GetMethod('GetInputStreamAt').Invoke($stream, @([uint64]0))
                    $reader = $readerType.GetConstructors()[0].Invoke(@($inputStream))
                    $loaded = Await-WinRT ($reader.LoadAsync([uint32]$size)) ([uint32])
                    $bytes = New-Object byte[] $loaded
                    $reader.ReadBytes($bytes)
                    $mime = if ($loaded -ge 3 -and $bytes[0] -eq 255 -and $bytes[1] -eq 216 -and $bytes[2] -eq 255) { 'image/jpeg' }
                        elseif ($loaded -ge 8 -and $bytes[0] -eq 137 -and $bytes[1] -eq 80 -and $bytes[2] -eq 78 -and $bytes[3] -eq 71) { 'image/png' }
                        else { '' }
                    if ($mime) { $script:artwork = 'data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes) }
                }
            } catch { $script:artwork = '' }
            finally {
                if ($reader) { $reader.Dispose() }
                if ($stream) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream) }
            }
        }
    }
    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    $duration = [Math]::Max(0, ($timeline.EndTime - $timeline.StartTime).TotalSeconds)
    $position = [Math]::Min($duration, [Math]::Max(0, ($timeline.Position - $timeline.StartTime).TotalSeconds))
    if ($duration -le 0) { $duration = $null; $position = $null }
    return @{
        state='ready'; title=[string]$properties.Title; artist=[string]$properties.Artist;
        album=[string]$properties.AlbumTitle; artworkDataUrl=$script:artwork; playback=[string]$playback.PlaybackStatus;
        positionSeconds=$position; durationSeconds=$duration;
        controls=@{
            toggle=[bool]$playback.Controls.IsPlayPauseToggleEnabled;
            previous=[bool]$playback.Controls.IsPreviousEnabled;
            next=[bool]$playback.Controls.IsNextEnabled;
            seek=($null -ne $duration -and [bool]$playback.Controls.IsPlaybackPositionEnabled);
        }
    }
}
try {
    $manager = Await-WinRT ($managerType::RequestAsync()) $managerType
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            if ($line.Length -gt 8192) { throw 'Invalid request' }
            $request = $line | ConvertFrom-Json
            if ($request.action -notin @('read','toggle','previous','next','seek')) { throw 'Unsupported action' }
            $session = Get-NeteaseSession $manager
            if ($null -eq $session) {
                $response = @{state='not_found';message='未找到网易云音乐媒体会话';success=($request.action -eq 'read')}
            } else {
                $before = Read-Media $session
                $success = $true
                if ($request.action -ne 'read') {
                    if (-not $before.controls[$request.action]) { throw 'Control unavailable' }
                    switch ($request.action) {
                        'toggle' { $success = Await-WinRT ($session.TryTogglePlayPauseAsync()) ([bool]) }
                        'previous' { $success = Await-WinRT ($session.TrySkipPreviousAsync()) ([bool]) }
                        'next' { $success = Await-WinRT ($session.TrySkipNextAsync()) ([bool]) }
                        'seek' {
                            $seconds = [double]$request.positionSeconds
                            if ([double]::IsNaN($seconds) -or [double]::IsInfinity($seconds) -or $seconds -lt 0 -or $seconds -gt $before.durationSeconds) { throw 'Invalid playback position' }
                            $timeline = $session.GetTimelineProperties()
                            $target = $timeline.StartTime.Ticks + [long]($seconds * 10000000)
                            $success = Await-WinRT ($session.TryChangePlaybackPositionAsync($target)) ([bool])
                        }
                    }
                }
                $response = Read-Media $session
                if ($success -and $request.action -ne 'read') {
                    # The media API acknowledges before CloudMusic updates its session.
                    # Wait for feedback without sending a second control command.
                    for ($attempt = 0; $attempt -lt 10; $attempt++) {
                        $changed = if ($request.action -eq 'toggle') { $response.playback -ne $before.playback }
                            elseif ($request.action -in @('previous','next')) { $response.title -ne $before.title }
                            else { $true }
                        if ($changed) { break }
                        Start-Sleep -Milliseconds 120
                        $response = Read-Media $session
                    }
                    if ($request.action -eq 'toggle' -and $response.playback -eq $before.playback) { $success = $false }
                }
                $response.success = [bool]$success
                if (-not $success) { $response.message='播放器未接受操作，请稍后重试' }
            }
        } catch { $response = @{state='unavailable';message='无法读取或控制网易云音乐媒体会话';success=$false} }
        [Console]::WriteLine(($response | ConvertTo-Json -Depth 5 -Compress))
    }
} catch { [Console]::WriteLine('{"state":"unavailable","message":"Windows 媒体接口不可用","success":false}') }

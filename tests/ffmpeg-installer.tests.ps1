$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('frame-ffmpeg-test-' + [Guid]::NewGuid().ToString('N'))
$originalPath = $env:Path
New-Item -ItemType Directory -Path $root | Out-Null
try {
    . (Join-Path $PSScriptRoot '..\scripts\install-ffmpeg.ps1') -InstallRoot $root
    if ($InstallRoot -ne $root) { throw 'Import replaced the explicitly supplied installation directory.' }
    $archive = Join-Path $root 'tampered.zip'
    [IO.File]::WriteAllBytes($archive, [Text.Encoding]::UTF8.GetBytes('not the official FFmpeg package'))
    $existing = Join-Path $root 'tools\user-file.txt'
    New-Item -ItemType Directory -Path (Split-Path -Parent $existing) | Out-Null
    [IO.File]::WriteAllText($existing, 'preserve existing files')
    $rejected = $false
    try { $null = Install-FrameFfmpeg -Root $root -LocalArchive $archive }
    catch {
        if ($_.Exception.Message -notmatch 'checksum') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'A tampered archive was accepted.' }
    if (-not (Test-Path -LiteralPath $archive)) { throw 'The user-supplied archive was deleted.' }
    if ([IO.File]::ReadAllText($existing) -ne 'preserve existing files') { throw 'An existing user file was modified.' }
    if ($env:Path -ne $originalPath) { throw 'PATH changed before archive verification succeeded.' }
    if (Test-Path (Join-Path $root 'tools\ffmpeg-9.0.2-essentials_build')) { throw 'An unverified archive was extracted.' }
    Write-Host 'PASS: invalid checksum rejected before extraction or PATH changes; supplied archive and existing files preserved.'
} finally {
    $env:Path = $originalPath
    Remove-Item -LiteralPath $root -Recurse -Force
}

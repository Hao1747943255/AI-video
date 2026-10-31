param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\FrameAI",
    [string]$ArchivePath
)
$ErrorActionPreference = 'Stop'

function Install-FrameFfmpeg {
    param([string]$Root, [string]$LocalArchive)
    # SHA-256 from the official GyanD/codexffmpeg 9.0.2 release asset metadata.
    $version = '9.0.2'
    $expectedHash = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
    $url = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
    if (-not [IO.Path]::IsPathRooted($Root)) { throw 'InstallRoot must be an absolute path.' }
    $downloadDir = Join-Path $Root 'downloads'
    $toolsDir = Join-Path $Root 'tools'
    $target = Join-Path $toolsDir "ffmpeg-$version-essentials_build"
    New-Item -ItemType Directory -Force -Path $downloadDir, $toolsDir | Out-Null
    $archive = Join-Path $downloadDir "ffmpeg-$version-essentials_build.zip"
    if ($LocalArchive) {
        $archive = (Resolve-Path -LiteralPath $LocalArchive).Path
    } elseif (-not (Test-Path -LiteralPath $archive)) {
        if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'curl.exe was not found. Download the official essentials ZIP in a browser, then rerun with -ArchivePath. See the Windows guide.' }
        $partial = "$archive.part"
        Write-Host 'Downloading official FFmpeg essentials with curl (about 115 MB); TLS verification remains enabled.'
        & curl.exe --fail --location --retry 2 --retry-delay 2 --connect-timeout 30 --continue-at - --output $partial $url
        if ($LASTEXITCODE -ne 0) { throw "FFmpeg download failed (curl exit $LASTEXITCODE). Partial data is kept for resume. Download the official ZIP in your browser and use -ArchivePath if necessary." }
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
            Remove-Item -LiteralPath $partial -Force
            throw 'FFmpeg SHA-256 verification failed. The unverified download was removed; do not disable verification.'
        }
        Move-Item -LiteralPath $partial -Destination $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'Existing ZIP does not match the official 9.0.2 essentials checksum. It was preserved; select the exact official ZIP using -ArchivePath.'
    }

    $staging = Join-Path $toolsDir ('.ffmpeg-extract-' + [Guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $staging
        $extracted = Join-Path $staging "ffmpeg-$version-essentials_build"
        foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe')) {
            $candidate = Join-Path $extracted "bin\$name"
            if (-not (Test-Path -LiteralPath $candidate)) { throw "The official archive is missing bin/$name." }
            if (Test-Path -LiteralPath $target) {
                $installed = Join-Path $target "bin\$name"
                if (-not (Test-Path -LiteralPath $installed) -or (Get-FileHash -LiteralPath $candidate).Hash -ne (Get-FileHash -LiteralPath $installed).Hash) {
                    throw 'An existing FFmpeg directory contains different or incomplete files. Preserve it and choose a different InstallRoot.'
                }
            }
        }
        if (-not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $extracted -Destination $target }
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    }

    $bin = Join-Path $target 'bin'
    $executable = Join-Path $bin 'ffmpeg.exe'
    & $executable -version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The verified FFmpeg executable could not run on this computer.' }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (@($userPath -split ';') -notcontains $bin) {
        $newUserPath = (@($userPath, $bin) | Where-Object { $_ }) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    }
    $env:Path = $bin + ';' + $env:Path
    Write-Host "FFmpeg installed and SHA-256 verified: $executable"
    return $executable
}

if ($MyInvocation.InvocationName -ne '.') {
    try { $null = Install-FrameFfmpeg -Root $InstallRoot -LocalArchive $ArchivePath }
    catch { Write-Error $_; exit 1 }
}

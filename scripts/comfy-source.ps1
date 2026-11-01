function Initialize-FrameComfySource {
    param([string]$Target, [int]$RetryDelaySeconds = 2)
    $release = 'v0.3.59'
    $expectedCommit = '72212fef660bcd7d9702fa52011d089c027a64d8'
    $repository = 'https://github.com/Comfy-Org/ComfyUI.git'
    if (-not [IO.Path]::IsPathRooted($Target)) { throw 'ComfyUI target must be an absolute path.' }
    if (Test-Path -LiteralPath (Join-Path $Target 'main.py')) {
        try { $head = & git.exe -C $Target rev-parse --verify 'HEAD^{commit}' 2>$null }
        catch { throw 'The existing ComfyUI Git metadata could not be read. Existing files were preserved; choose another InstallRoot.' }
        if ($LASTEXITCODE -ne 0 -or $head -ne $expectedCommit) {
            throw 'Existing ComfyUI is not the pinned release commit. Existing files were preserved; choose another InstallRoot.'
        }
        Write-Host 'Reusing the existing ComfyUI source checkout.'
        return
    }
    if (Test-Path -LiteralPath $Target) {
        # Preserve every file from an interrupted checkout rather than deleting it.
        $backup = $Target + '.incomplete-' + [Guid]::NewGuid().ToString('N')
        Move-Item -LiteralPath $Target -Destination $backup
        Write-Warning "Preserved the incomplete ComfyUI directory at $backup"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $staging = $Target + '.download-' + [Guid]::NewGuid().ToString('N')
        Write-Host "Downloading ComfyUI source (attempt $attempt/3, shallow clone, HTTP/1.1)."
        # Apply transport settings only to this clone; retain TLS/CA verification.
        & git.exe -c 'http.version=HTTP/1.1' -c 'http.sslVerify=true' clone --depth 1 --single-branch --branch $release $repository $staging
        $cloneCode = $LASTEXITCODE
        if ($cloneCode -eq 0) {
            $head = & git.exe -C $staging rev-parse --verify 'HEAD^{commit}'
            if ($LASTEXITCODE -ne 0 -or $head -ne $expectedCommit) {
                throw "Downloaded source does not match the pinned commit. It was not activated; files remain at $staging"
            }
            foreach ($file in @('main.py', 'requirements.txt')) {
                if (-not (Test-Path -LiteralPath (Join-Path $staging $file))) { throw "Source is missing $file. Files remain at $staging" }
            }
            Move-Item -LiteralPath $staging -Destination $Target
            Write-Host 'ComfyUI source downloaded and pinned commit verified.'
            return
        }
        Write-Warning "Git clone failed (exit $cloneCode). Any partial source remains at $staging"
        if ($attempt -lt 3) { Start-Sleep -Seconds $RetryDelaySeconds }
    }
    throw 'ComfyUI download failed after 3 attempts. Existing tools and partial source were preserved. Check GitHub connectivity and rerun; do not disable TLS verification.'
}

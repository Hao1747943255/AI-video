$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\comfy-source.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('frame-comfy-test-' + [Guid]::NewGuid().ToString('N'))
$script:cloneAttempts = 0
$script:failAll = $false
$script:mockHead = '72212fef660bcd7d9702fa52011d089c027a64d8'
New-Item -ItemType Directory -Path $fixture | Out-Null

# Simulate interrupted native Git transfers without downloading or installing models.
function git.exe {
    if ($args -contains 'clone') {
        if ($args -notcontains 'http.version=HTTP/1.1' -or $args -notcontains 'http.sslVerify=true') { throw 'Clone transport or TLS verification settings missing.' }
        $script:cloneAttempts++
        $destination = $args[-1]
        New-Item -ItemType Directory -Path $destination | Out-Null
        if ($script:failAll -or $script:cloneAttempts -eq 1) {
            [IO.File]::WriteAllText((Join-Path $destination 'partial.txt'), 'partial source')
            $global:LASTEXITCODE = 128
            return
        }
        [IO.File]::WriteAllText((Join-Path $destination 'main.py'), 'verified source fixture')
        [IO.File]::WriteAllText((Join-Path $destination 'requirements.txt'), '')
        $global:LASTEXITCODE = 0
        return
    }
    if ($args -contains 'rev-parse') {
        $global:LASTEXITCODE = 0
        return $script:mockHead
    }
    throw 'Unexpected Git operation.'
}

try {
    $target = Join-Path $fixture 'ComfyUI'
    New-Item -ItemType Directory -Path $target | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'user-notes.txt'), 'preserve me')
    Initialize-FrameComfySource -Target $target -RetryDelaySeconds 0
    if ($script:cloneAttempts -ne 2) { throw 'A failed connection was not retried.' }
    if (-not (Test-Path (Join-Path $target 'main.py'))) { throw 'Verified source was not activated.' }
    $backups = @(Get-ChildItem -LiteralPath $fixture -Directory -Filter 'ComfyUI.incomplete-*')
    if ($backups.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'user-notes.txt')) -ne 'preserve me') { throw 'Existing files were not preserved.' }
    if (@(Get-ChildItem -LiteralPath $fixture -Directory -Filter 'ComfyUI.download-*').Count -ne 1) { throw 'Partial source was not retained.' }
    Initialize-FrameComfySource -Target $target -RetryDelaySeconds 0
    if ($script:cloneAttempts -ne 2) { throw 'A valid checkout was downloaded again.' }
    Write-Host 'PASS: interrupted clone retried; old files and partial source retained; valid checkout reused.'

    $script:mockHead = '0000000000000000000000000000000000000000'
    $blocked = $false
    try { Initialize-FrameComfySource -Target $target -RetryDelaySeconds 0 }
    catch { if ($_.Exception.Message -notmatch 'pinned') { throw }; $blocked = $true }
    if (-not $blocked -or [IO.File]::ReadAllText((Join-Path $target 'main.py')) -ne 'verified source fixture') { throw 'A mismatched checkout was accepted or overwritten.' }
    Write-Host 'PASS: mismatched existing commit blocked without overwriting source.'

    $script:failAll = $true
    $script:cloneAttempts = 0
    $failedTarget = Join-Path $fixture 'AlwaysFails'
    $blocked = $false
    try { Initialize-FrameComfySource -Target $failedTarget -RetryDelaySeconds 0 }
    catch { if ($_.Exception.Message -notmatch 'after 3 attempts') { throw }; $blocked = $true }
    if (-not $blocked -or $script:cloneAttempts -ne 3 -or (Test-Path $failedTarget)) { throw 'Retry limit was not enforced or partial source was activated.' }
    Write-Host 'PASS: repeated failures stop after three attempts without activating partial source.'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Remove-Item Function:git.exe
}

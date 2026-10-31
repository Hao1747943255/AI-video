$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\python-deps.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('frame-python-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$requirements = Join-Path $fixture 'requirements.txt'
[IO.File]::WriteAllText($requirements, 'aiohttp>=3.11.8')
$script:calls = [System.Collections.Generic.List[object]]::new()
$script:cudaReady = $true
$script:failRequirements = $false

function frame-test-python {
    $script:calls.Add(@($args))
    if ($args[0] -eq '-c') {
        $global:LASTEXITCODE = $(if ($script:cudaReady) { 0 } else { 1 })
        return
    }
    $global:LASTEXITCODE = $(if ($script:failRequirements -and $args -contains '-r') { 1 } else { 0 })
}
function Find-TestCall([string]$Token) {
    foreach ($call in $script:calls) { if ($call -contains $Token) { return ,$call } }
    throw "Expected invocation not found: $Token"
}
function Assert-Index($Call, [string]$Expected) {
    $position = [Array]::IndexOf($Call, '--index-url')
    if ($position -lt 0 -or $Call[$position + 1] -ne $Expected) { throw 'Unexpected package index.' }
}
try {
    Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture
    foreach ($call in $script:calls) {
        if ($call -contains 'install') {
            if ($call[[Array]::IndexOf($call, '--timeout') + 1] -ne '120' -or $call[[Array]::IndexOf($call, '--retries') + 1] -ne '5') { throw 'Network retry settings are missing.' }
        }
        if ($call -contains 'torch==2.8.0') { throw 'Existing CUDA packages were downloaded again.' }
    }
    Assert-Index (Find-TestCall '-r') 'https://pypi.org/simple'
    $null = Find-TestCall 'check'
    Write-Host 'PASS: existing CUDA packages reused; ordinary dependencies use official PyPI with longer timeout and dependency validation.'

    $script:calls.Clear()
    $script:cudaReady = $false
    Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture -IndexUrl 'https://pypi.tuna.tsinghua.edu.cn/simple'
    Assert-Index (Find-TestCall 'torch==2.8.0') 'https://download.pytorch.org/whl/cu128'
    Assert-Index (Find-TestCall '-r') 'https://pypi.tuna.tsinghua.edu.cn/simple'
    Assert-Index (Find-TestCall '--upgrade') 'https://pypi.tuna.tsinghua.edu.cn/simple'
    Write-Host 'PASS: selected mirror used only for ordinary dependencies; CUDA packages keep the official CUDA index.'

    $script:calls.Clear()
    $script:cudaReady = $true
    $script:failRequirements = $true
    $blocked = $false
    try { Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture }
    catch { if ($_.Exception.Message -notmatch 'pip exit 1') { throw }; $blocked = $true }
    if (-not $blocked -or [IO.File]::ReadAllText($requirements) -ne 'aiohttp>=3.11.8') { throw 'Failed installation was ignored or repository requirements were modified.' }
    foreach ($call in $script:calls) { if ($call -contains 'check') { throw 'Validation ran after an unsuccessful install.' } }
    Write-Host 'PASS: failed install stops the workflow and preserves requirements.'

    foreach ($url in @('http://pypi.org/simple', 'https://user:password@example.test/simple', 'https://example.test/simple?secret=token')) {
        $script:calls.Clear()
        $blocked = $false
        try { Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture -IndexUrl $url }
        catch { if ($_.Exception.Message -notmatch 'HTTPS') { throw }; $blocked = $true }
        if (-not $blocked -or $script:calls.Count -ne 0) { throw 'Invalid package index was used.' }
    }
    Write-Host 'PASS: non-HTTPS or credential-bearing index rejected before invoking pip.'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Remove-Item Function:frame-test-python
}

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\python-deps.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('frame-python-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$requirements = Join-Path $fixture 'requirements.txt'
[IO.File]::WriteAllText($requirements, 'aiohttp>=3.11.8')
$script:calls = [System.Collections.Generic.List[object]]::new()
$script:cudaReady = $true
$script:failRequirements = $false
$script:failCheck = $false
$script:failRequestsImport = $false

function frame-test-python {
    $script:calls.Add(@($args))
    if ($args[0] -eq '-c') {
        if ($args[1] -match '^import requests\b') {
            $global:LASTEXITCODE = $(if ($script:failRequestsImport) { 1 } else { 0 })
        } else {
            $global:LASTEXITCODE = $(if ($script:cudaReady) { 0 } else { 1 })
        }
        return
    }
    $global:LASTEXITCODE = $(if (($script:failRequirements -and $args -contains '-r') -or ($script:failCheck -and $args -contains 'check')) { 1 } else { 0 })
}
function Find-TestCall([string]$Token) {
    foreach ($call in $script:calls) { if ($call -contains $Token) { return ,$call } }
    throw "Expected invocation not found: $Token"
}
function Assert-Index($Call, [string]$Expected) {
    $position = [Array]::IndexOf($Call, '--index-url')
    if ($position -lt 0 -or $Call[$position + 1] -ne $Expected) { throw 'Unexpected package index.' }
}
function Assert-RequestsValidation {
    $checkPosition = -1
    $importPosition = -1
    for ($i = 0; $i -lt $script:calls.Count; $i++) {
        $call = $script:calls[$i]
        if ($call -contains 'check') { $checkPosition = $i }
        if ($call[0] -eq '-c' -and $call[1] -match '^import requests\b') { $importPosition = $i }
    }
    if ($checkPosition -lt 0 -or $importPosition -le $checkPosition) { throw 'requests import was not validated after pip check.' }
}
function Assert-NoRequestsImport {
    foreach ($call in $script:calls) {
        if ($call[0] -eq '-c' -and $call[1] -match '^import requests\b') { throw 'requests import ran after a failed dependency step.' }
    }
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
    $requestsCall = Find-TestCall 'requests>=2.32.5,<3'
    if ($requestsCall -notcontains '-r') { throw 'requests must be installed together with ComfyUI requirements.' }
    Assert-Index $requestsCall 'https://pypi.org/simple'
    Assert-RequestsValidation
    if ([IO.File]::ReadAllText($requirements) -ne 'aiohttp>=3.11.8') { throw 'Repository requirements were modified.' }
    Write-Host 'PASS: existing CUDA packages reused; official PyPI installs requests explicitly and validates its import after pip check.'

    $script:calls.Clear()
    $script:cudaReady = $false
    Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture -IndexUrl 'https://pypi.tuna.tsinghua.edu.cn/simple'
    Assert-Index (Find-TestCall 'torch==2.8.0') 'https://download.pytorch.org/whl/cu128'
    Assert-Index (Find-TestCall '-r') 'https://pypi.tuna.tsinghua.edu.cn/simple'
    Assert-Index (Find-TestCall '--upgrade') 'https://pypi.tuna.tsinghua.edu.cn/simple'
    Assert-Index (Find-TestCall 'requests>=2.32.5,<3') 'https://pypi.tuna.tsinghua.edu.cn/simple'
    Assert-RequestsValidation
    Write-Host 'PASS: selected mirror covers requests and ordinary dependencies; CUDA keeps its official index and a missing CUDA probe does not fail the requests probe.'

    $script:calls.Clear()
    $script:cudaReady = $true
    $script:failRequirements = $true
    $blocked = $false
    try { Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture }
    catch { if ($_.Exception.Message -notmatch 'pip exit 1') { throw }; $blocked = $true }
    if (-not $blocked -or [IO.File]::ReadAllText($requirements) -ne 'aiohttp>=3.11.8') { throw 'Failed installation was ignored or repository requirements were modified.' }
    foreach ($call in $script:calls) { if ($call -contains 'check') { throw 'Validation ran after an unsuccessful install.' } }
    Assert-NoRequestsImport
    Write-Host 'PASS: failed install stops the workflow and preserves requirements.'

    $script:calls.Clear()
    $script:failRequirements = $false
    $script:failCheck = $true
    $blocked = $false
    try { Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture }
    catch { if ($_.Exception.Message -notmatch 'pip exit 1') { throw }; $blocked = $true }
    if (-not $blocked) { throw 'pip check failure was ignored.' }
    Assert-NoRequestsImport
    Write-Host 'PASS: pip check failure stops before importing requests.'

    $script:calls.Clear()
    $script:failCheck = $false
    $script:failRequestsImport = $true
    $blocked = $false
    try { Install-FramePythonDependencies -Python frame-test-python -ComfyDir $fixture }
    catch { if ($_.Exception.Message -notmatch 'requests') { throw }; $blocked = $true }
    if (-not $blocked) { throw 'requests import failure was ignored after a successful pip check.' }
    Assert-RequestsValidation
    if ([IO.File]::ReadAllText($requirements) -ne 'aiohttp>=3.11.8') { throw 'Failed import modified repository requirements.' }
    Write-Host 'PASS: requests import failure is reported even when CUDA and pip check succeed.'

    $script:failRequestsImport = $false
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

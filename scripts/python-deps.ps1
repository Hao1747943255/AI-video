function Invoke-FramePip {
    param([string]$Python, [string[]]$Arguments)
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed (pip exit $LASTEXITCODE). Review the pip error above; installed packages and download cache were preserved." }
}

function Install-FramePythonDependencies {
    param(
        [string]$Python,
        [string]$ComfyDir,
        [string]$IndexUrl = 'https://pypi.org/simple'
    )
    $index = $null
    if (-not [Uri]::TryCreate($IndexUrl, [UriKind]::Absolute, [ref]$index) -or $index.Scheme -ne 'https' -or $index.UserInfo -or $index.Query -or $index.Fragment) {
        throw 'PipIndexUrl must be an HTTPS package index without credentials, query or fragment.'
    }
    $requirements = Join-Path $ComfyDir 'requirements.txt'
    if (-not (Test-Path -LiteralPath $requirements)) { throw 'ComfyUI requirements.txt was not found.' }
    # These options apply only to the current invocation, not global pip settings.
    $network = @('--timeout', '120', '--retries', '5')
    $base = @('-m', 'pip') + $network
    Invoke-FramePip -Python $Python -Arguments ($base + @('install', '--upgrade', 'pip', '--index-url', $IndexUrl))

    $probe = "from importlib.metadata import version; expected = {'torch':'2.8.0+cu128','torchvision':'0.23.0+cu128','torchaudio':'2.8.0+cu128'}; assert all(version(name) == value for name,value in expected.items())"
    $cudaInstalled = $false
    try {
        & $Python -c $probe 2>$null | Out-Null
        $cudaInstalled = $LASTEXITCODE -eq 0
    } catch { $cudaInstalled = $false }
    if ($cudaInstalled) {
        Write-Host 'Reusing installed PyTorch 2.8.0 CUDA 12.8 packages.'
    } else {
        Invoke-FramePip -Python $Python -Arguments ($base + @('install', 'torch==2.8.0', 'torchvision==0.23.0', 'torchaudio==2.8.0', '--index-url', 'https://download.pytorch.org/whl/cu128'))
    }
    Write-Host "Installing ComfyUI dependencies using $IndexUrl (timeout 120 seconds, up to 5 retries)."
    # ComfyUI v0.3.59 imports requests directly but does not declare it in requirements.txt.
    Invoke-FramePip -Python $Python -Arguments ($base + @('install', '-r', $requirements, 'requests>=2.32.5,<3', '--index-url', $IndexUrl))
    Invoke-FramePip -Python $Python -Arguments @('-m', 'pip', 'check')
    & $Python -c "import requests; print('ComfyUI requests import: OK')"
    if ($LASTEXITCODE -ne 0) { throw 'ComfyUI startup dependency validation failed: requests could not be imported. Check the virtual environment before starting ComfyUI.' }
}

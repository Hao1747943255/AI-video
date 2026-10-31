param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\FrameAI",
    [string]$PipIndexUrl = 'https://pypi.org/simple',
    [string]$ModelEndpoint = 'https://huggingface.co',
    [switch]$SkipModels
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$comfyDir = Join-Path $InstallRoot 'ComfyUI'

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Command" }
}
function Refresh-Path {
    $parts = (@($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';') -split ';'
    $env:Path = ($parts | Where-Object { $_ } | Select-Object -Unique) -join ';'
}
function Ensure-Tool {
    param([string]$Command, [string]$Package)
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Install Windows App Installer from Microsoft Store to enable winget, then rerun.' }
    Invoke-Checked 'winget.exe' @('install', '--id', $Package, '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--silent')
    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "Installed $Package. Close and reopen PowerShell, then rerun this script." }
}
function Test-Endpoint([string]$Uri) {
    try { $null = Invoke-RestMethod -Uri $Uri -TimeoutSec 3; return $true } catch { return $false }
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required.' }
    if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be an absolute path, e.g. D:\AI\FrameRuntime.' }
    Write-Host 'Frame local setup: Qwen3 4B + Wan 2.1 1.3B. No paid API token is needed.'
    Write-Host 'Models and runtimes may use over 20 GB. Reserve 50 GB including pagefile/output space.'
    Write-Host 'RTX 3060 Ti 8 GB / 16 GB RAM: close games, enable system-managed pagefile, start with 2-second 288p video.'
    Write-Host 'Install a current NVIDIA driver before continuing. This script does not change your driver or pagefile.'
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    $drive = Get-PSDrive -Name ((Split-Path -Qualifier $InstallRoot).TrimEnd(':'))
    if ($drive.Free -lt 50GB) { throw 'Less than 50 GB free on the installation drive. Select another -InstallRoot.' }

    Refresh-Path
    Ensure-Tool 'git.exe' 'Git.Git'
    Ensure-Tool 'node.exe' 'OpenJS.NodeJS.LTS'
    Ensure-Tool 'py.exe' 'Python.Python.3.12'
    try { Ensure-Tool 'ffmpeg.exe' 'Gyan.FFmpeg' }
    catch {
        Write-Warning 'Winget could not install FFmpeg. Switching to the smaller official essentials archive with SHA-256 verification.'
        . (Join-Path $PSScriptRoot 'install-ffmpeg.ps1') -InstallRoot $InstallRoot
        $null = Install-FrameFfmpeg -Root $InstallRoot
        Refresh-Path
    }
    Ensure-Tool 'ollama.exe' 'Ollama.Ollama'
    $nodeMajor = [int]((& node.exe -p 'parseInt(process.versions.node)').Trim())
    if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required. Update Node.js LTS and rerun.' }
    & py.exe -3.12 -c 'import sys; print(sys.version)'
    if ($LASTEXITCODE -ne 0) {
        Invoke-Checked 'winget.exe' @('install', '--id', 'Python.Python.3.12', '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--silent')
        Refresh-Path
        Invoke-Checked 'py.exe' @('-3.12', '-c', 'import sys; print(sys.version)')
    }
    . (Join-Path $PSScriptRoot 'comfy-source.ps1')
    Initialize-FrameComfySource -Target $comfyDir
    $venvDir = Join-Path $comfyDir '.venv'
    if (-not (Test-Path (Join-Path $venvDir 'Scripts\python.exe'))) { Invoke-Checked 'py.exe' @('-3.12', '-m', 'venv', $venvDir) }
    $python = Join-Path $venvDir 'Scripts\python.exe'
    . (Join-Path $PSScriptRoot 'python-deps.ps1')
    Install-FramePythonDependencies -Python $python -ComfyDir $comfyDir -IndexUrl $PipIndexUrl
    Write-Host 'Checking CUDA support. If this fails, update the NVIDIA driver and rerun.'
    Invoke-Checked $python @('-c', 'import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))')

    Push-Location $projectDir
    try {
        Invoke-Checked 'npm.cmd' @('ci')
        $envFile = Join-Path $projectDir '.env'
        if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $projectDir '.env.example') $envFile }
        $settings = @{
            COMFYUI_DIR = $comfyDir.Replace('\', '/')
            COMFYUI_PYTHON = $python.Replace('\', '/')
            FFMPEG_PATH = (Get-Command ffmpeg.exe).Source.Replace('\', '/')
        }
        foreach ($name in $settings.Keys) {
            if (-not (Select-String -Path $envFile -Pattern "^\s*$name\s*=" -Quiet)) {
                Add-Content -Path $envFile -Value ("`n$name=`"" + $settings[$name] + '"') -Encoding UTF8
            } else { Write-Host "Keeping your existing $name configuration." }
        }
        if (-not (Test-Endpoint 'http://127.0.0.1:11434/api/tags')) {
            $null = Start-Process -FilePath (Get-Command ollama.exe).Source -ArgumentList 'serve' -WindowStyle Hidden -PassThru
            $ready = $false
            for ($i = 0; $i -lt 30; $i++) {
                if (Test-Endpoint 'http://127.0.0.1:11434/api/tags') { $ready = $true; break }
                Start-Sleep -Seconds 1
            }
            if (-not $ready) { throw 'Ollama did not start. Open the Ollama desktop app, then rerun.' }
        }
        if (-not $SkipModels) {
            Invoke-Checked 'ollama.exe' @('pull', 'qwen3:4b')
            Invoke-Checked 'npm.cmd' @('run', 'models:download', '--', $comfyDir, '--endpoint', $ModelEndpoint)
        }
        Invoke-Checked 'npm.cmd' @('run', 'build')
        Write-Host 'Setup files prepared. Run: npm.cmd run local:start'
        Write-Host 'Open http://127.0.0.1:3001 and check Generation Settings. A real test generation is still required.'
    } finally { Pop-Location }
} catch {
    Write-Error $_
    exit 1
}

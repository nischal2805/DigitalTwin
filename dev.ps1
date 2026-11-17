param([string]$Task = "dev")

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"

function Invoke-Python([string]$Dir, [string[]]$PyArgs) {
    Push-Location $Dir
    try {
        & python @PyArgs
        if ($LASTEXITCODE -ne 0) { throw "python exited with code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

switch ($Task) {
    "install" {
        Invoke-Python $backend @("-m", "pip", "install", "-r", "requirements.txt")
    }
    "dev" {
        # Open the browser after uvicorn has had a moment to bind the port.
        Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 4; Start-Process 'http://localhost:8000'"
        Invoke-Python $backend @("-m", "uvicorn", "app.main:app", "--reload", "--reload-dir", "app", "--port", "8000")
    }
    "train" {
        Invoke-Python $backend @("-m", "app.ml.train")
    }
    "report" {
        Invoke-Python $backend @("-m", "app.ml.evaluate")
    }
    "test" {
        Invoke-Python $backend @("-m", "pytest", "-q")
    }
    "docker" {
        Push-Location $root
        try {
            & docker compose up --build
            if ($LASTEXITCODE -ne 0) { throw "docker compose exited with code $LASTEXITCODE" }
        }
        finally { Pop-Location }
    }
    "clean-models" {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $root "models"), (Join-Path $root "reports")
    }
    default {
        throw "Unknown task '$Task'. Use: install | dev | train | report | test | docker | clean-models"
    }
}

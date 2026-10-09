param(
  [string]$VenvDir = 'venv'
)

$ErrorActionPreference = 'Stop'
Write-Host 'Creating a local Python environment for faster-whisper...' -ForegroundColor Cyan

python -m venv $VenvDir
if ($LASTEXITCODE -ne 0) { throw 'Failed to create Python virtualenv.' }

& "$VenvDir\Scripts\python.exe" -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Failed to upgrade pip.' }

& "$VenvDir\Scripts\python.exe" -m pip install faster-whisper
if ($LASTEXITCODE -ne 0) { throw 'Failed to install faster-whisper.' }

# faster-whisper calls av.open(..., metadata_errors=...), which PyAV 17+ removed.
# Without this pin, transcription dies with:
#   TypeError: open() got an unexpected keyword argument 'metadata_errors'
& "$VenvDir\Scripts\python.exe" -m pip install "av<17"
if ($LASTEXITCODE -ne 0) { throw 'Failed to install a compatible PyAV.' }

& "$VenvDir\Scripts\python.exe" -c "import av, sys; major = int(av.__version__.split('.')[0]); print('PyAV', av.__version__); sys.exit(0 if major <= 16 else 1)"
if ($LASTEXITCODE -ne 0) { throw 'PyAV is too new for faster-whisper. Install a PyAV older than 17.' }

Write-Host 'Verifying faster-whisper import...' -ForegroundColor Cyan
& "$VenvDir\Scripts\python.exe" -c "import faster_whisper; print('faster-whisper OK')"
if ($LASTEXITCODE -ne 0) { throw 'faster-whisper failed to import.' }


Write-Host 'Done.' -ForegroundColor Green
Write-Host "Set GEMINI_LOCAL_PYTHON='$VenvDir\Scripts\python.exe' and start the server." -ForegroundColor Yellow
@echo off
title LingoScribe Server - DO NOT CLOSE THIS WINDOW
cd /d "C:\Users\Hassaan\video-transcript-generator"

echo ================================================
echo   LingoScribe Server
echo ================================================
echo.

echo [1/3] Freeing port 3000 if something is stuck...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo       Closing old process %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 >nul

echo [2/3] Starting server on http://localhost:3000 ...
echo.
echo   >>> Open this in your browser: http://localhost:3000
echo.
echo   KEEP THIS WINDOW OPEN while using the app.
echo   Press Ctrl+C to stop the server.
echo ================================================
echo.

node server.js

echo.
echo ================================================
echo   Server stopped. If you see an error above, copy it.
echo ================================================
pause

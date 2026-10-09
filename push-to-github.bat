@echo off
title Push LingoScribe to GitHub
cd /d "%~dp0"

echo ============================================================
echo    LingoScribe - Push to GitHub
echo ============================================================
echo.
echo A browser window will open. Log in to GitHub to authorize.
echo (If it says "repository not found", first create an EMPTY repo
echo  named  video-transcript-generator  at https://github.com/new )
echo.
pause
echo.
git push -u origin main
echo.
if %ERRORLEVEL%==0 (
    echo.
    echo ============================================================
    echo    SUCCESS! Your code is live on GitHub:
    echo    https://github.com/meermohsinali/video-transcript-generator
    echo ============================================================
) else (
    echo.
    echo ============================================================
    echo    Push failed. Checklist:
    echo    1. Create the repo  video-transcript-generator  on github.com/new
    echo       (Public, do NOT add README/.gitignore/license)
    echo    2. Make sure you approve the browser login popup.
    echo ============================================================
)
echo.
pause

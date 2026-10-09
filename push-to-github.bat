@echo off
title Push LingoScribe to GitHub
cd /d "%~dp0"

echo ============================================================
echo    LingoScribe - Push to GitHub
echo ============================================================
echo.
echo A browser window will open. Log in to GitHub to authorize.
echo (If it says "repository not found", first create an EMPTY repo
echo  named  video-transcript-generator  at https://github.com/new
echo  with "Add README" turned OFF)
echo.
pause
echo.
git push -u origin main
if %ERRORLEVEL%==0 goto :success

echo.
echo Normal push failed - GitHub may already have an auto README.
echo Overwriting it with your code (safe for a new repo)...
echo.
git push -u origin main --force
if %ERRORLEVEL%==0 goto :success

echo.
echo ============================================================
echo    Push still failed. Checklist:
echo    1. Create the repo  video-transcript-generator  on github.com/new
echo       (keep "Add README" OFF, or we will overwrite it for you)
echo    2. Approve the browser login popup.
echo ============================================================
goto :end

:success
echo.
echo ============================================================
echo    SUCCESS! Your code is live on GitHub:
echo    https://github.com/meermohsinali/video-transcript-generator
echo ============================================================

:end
echo.
pause

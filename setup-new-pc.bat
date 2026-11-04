@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   Meal4One - one-time setup on a new computer
echo ============================================
echo.

set MISSING=
echo [1/5] Checking Git and Node.js...
where git >nul 2>nul
if errorlevel 1 (
    echo   [MISSING] Git. Install it, then run this file again:
    echo             winget install --id Git.Git -e
    set MISSING=1
)
where node >nul 2>nul
if errorlevel 1 (
    echo   [MISSING] Node.js. Install it, then run this file again:
    echo             winget install --id OpenJS.NodeJS.LTS -e
    set MISSING=1
)
if defined MISSING (
    echo.
    echo   After installing, CLOSE this window and open a new one so Windows finds them.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo   Node.js %%v
for /f "delims=" %%v in ('git --version') do echo   %%v

echo.
echo [2/5] Installing the script's packages (googleapis, xlsx, crypto-js)...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo   [FAILED] npm install failed. Check the internet connection and run this file again.
    pause
    exit /b 1
)

echo.
echo [3/5] Checking the private files copied from the old computer...
set MISSINGFILE=
for %%F in (service-account.json config.local.js password.local.js) do (
    if exist "%%F" (
        echo   [OK]      %%F
    ) else (
        echo   [MISSING] %%F
        set MISSINGFILE=1
    )
)
if defined MISSINGFILE (
    echo.
    echo   Copy the missing file^(s^) from the old computer's dashboard folder into:
    echo   %CD%
    echo   Use a USB stick or similar - never email, chat or GitHub. Then run this file again.
    pause
    exit /b 1
)

echo.
echo [4/5] Git identity for the "Update dashboard data" commits...
set GITNAME=
for /f "delims=" %%n in ('git config --global user.name 2^>nul') do set GITNAME=%%n
if not defined GITNAME (
    set /p GITNAME=  Your name for git commits:
    git config --global user.name "!GITNAME!"
    set /p GITEMAIL=  Your GitHub email:
    git config --global user.email "!GITEMAIL!"
)
echo   Commits will be made as: !GITNAME!

echo.
echo [5/5] Dashboard logins found in password.local.js:
call node make-users.js list

echo.
echo ============================================
echo   Setup done. Next: run refresh-dashboard.bat
echo   (the first push asks you to sign in to GitHub once).
echo ============================================
echo.
pause

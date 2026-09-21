@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   Fix git conflict (keep local data, sync code)
echo ============================================
echo.

if not exist dashboard_data.enc (
    echo [FAILED] dashboard_data.enc not found in this folder.
    pause
    exit /b 1
)

echo [1/5] Backing up dashboard_data.enc...
copy /y dashboard_data.enc "%USERPROFILE%\Desktop\dashboard_data.enc.bak" >nul
if errorlevel 1 (
    echo [FAILED] Could not back up dashboard_data.enc.
    pause
    exit /b 1
)

echo [2/5] Fetching latest from GitHub...
git fetch origin
if errorlevel 1 (
    echo [FAILED] git fetch failed. Check your internet connection.
    pause
    exit /b 1
)

echo [3/5] Resetting this folder to match GitHub (main)...
git reset --hard origin/main
if errorlevel 1 (
    echo [FAILED] git reset failed.
    pause
    exit /b 1
)

echo [4/5] Restoring your backed-up dashboard_data.enc...
copy /y "%USERPROFILE%\Desktop\dashboard_data.enc.bak" dashboard_data.enc >nul
if errorlevel 1 (
    echo [FAILED] Could not restore dashboard_data.enc from backup.
    pause
    exit /b 1
)

echo [5/5] Committing and pushing...
git add dashboard_data.enc
git commit -m "Update dashboard data"
if errorlevel 1 (
    echo [INFO] Nothing new to commit - dashboard_data.enc is already up to date.
    goto :done
)
git push origin main
if errorlevel 1 (
    echo [FAILED] git push failed. Check your internet connection or GitHub login.
    pause
    exit /b 1
)

:done
echo.
echo ============================================
echo   Done. Your folder is now in sync with GitHub.
echo   Live dashboard: https://mortal-esi.github.io/M41Dashboard/dashboard.html
echo ============================================
echo.
pause

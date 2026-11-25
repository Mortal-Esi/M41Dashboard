@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   Meal4One Dashboard - Refresh ^& Publish
echo ============================================
echo.

echo [1/4] Updating dashboard code before refreshing...
git pull origin main --ff-only
if errorlevel 1 (
    echo.
    echo [FAILED] Could not fast-forward local dashboard code.
    echo Resolve local edits or divergent commits before refreshing.
    pause
    exit /b 1
)

echo.
echo [2/4] Pulling fresh data from Google Sheets and encrypting...
call node update_dashboard.js
if errorlevel 1 (
    echo.
    echo [FAILED] update_dashboard.js reported an error. Nothing was published.
    pause
    exit /b 1
)

echo.
echo [3/4] Committing encrypted data (dashboard_data.json stays local, never pushed)...
git add dashboard_data.enc
git commit -m "Update dashboard data"
if errorlevel 1 (
    echo.
    echo [INFO] Nothing new to commit ^(data unchanged since last refresh^).
    goto :done
)

echo.
echo [4/4] Pushing to GitHub Pages...
git push origin main
if errorlevel 1 (
    echo.
    echo [FAILED] git push failed. Check your network/GitHub login and try again.
    pause
    exit /b 1
)

:done
echo.
echo ============================================
echo   Done. Live dashboard:
echo   https://mortal-esi.github.io/M41Dashboard/dashboard.html
echo ============================================
echo.
pause

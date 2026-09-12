@echo off
REM ============================================================
REM  Meal4One Dashboard - one-click refresh script
REM  1. Pulls fresh data from Google Sheets (node update_dashboard.js)
REM  2. Commits the updated dashboard_data.json
REM  3. Pushes it to GitHub, which updates the live GitHub Pages site
REM ============================================================

echo.
echo === Step 1/3: Fetching latest data from Google Sheets ===
node update_dashboard.js
if errorlevel 1 (
    echo.
    echo [FAILED] update_dashboard.js reported an error - stopping before commit.
    pause
    exit /b 1
)

echo.
echo === Step 2/3: Committing changes ===
git add dashboard_data.json
git commit -m "Update dashboard data"
if errorlevel 1 (
    echo.
    echo [INFO] Nothing to commit - dashboard_data.json is unchanged since last run.
    pause
    exit /b 0
)

echo.
echo === Step 3/3: Pushing to GitHub (this updates the live site) ===
git push origin main
if errorlevel 1 (
    echo.
    echo [FAILED] git push failed - check your internet connection or GitHub login.
    pause
    exit /b 1
)

echo.
echo === Done! The live dashboard will update in a minute or two: ===
echo https://mortal-esi.github.io/M41Dashboard/dashboard.html
echo.
pause

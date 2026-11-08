@echo off
rem install-all.bat - sets up a new Windows PC for the Meal4One dashboard,
rem (Git, Node.js, Python 3.13, VS Code + the dashboard and its libraries)
rem using only Command Prompt (no PowerShell). Run it in a normal cmd window:
rem   curl -L -o "%TEMP%\m41-install.bat" https://raw.githubusercontent.com/Mortal-Esi/M41Dashboard/main/install-all.bat && "%TEMP%\m41-install.bat"
rem Only the program installs (Git, Node.js, Python, VS Code) run as administrator, in
rem one elevated window; everything else runs as you. Safe to run again.

setlocal EnableExtensions EnableDelayedExpansion
set "SELF=%~f0"
if /i "%~1"=="admin" goto :admin_mode

title Meal4One setup
set "DIR=%USERPROFILE%\M41Dashboard"
set "REPO=https://github.com/Mortal-Esi/M41Dashboard.git"
set "FLAGDIR=%PUBLIC%"

echo ============================================
echo   Meal4One dashboard - new PC setup
echo ============================================

echo.
echo == 1/7  Git, Node.js, Python, VS Code
call :refreshpath
set "NEED="
where git  >nul 2>nul && (echo    [OK] Git already installed)    || set "NEED=!NEED! git"
where node >nul 2>nul && (echo    [OK] Node.js already installed) || set "NEED=!NEED! node"
where py   >nul 2>nul && (echo    [OK] Python already installed)  || set "NEED=!NEED! python"
where code >nul 2>nul && (echo    [OK] VS Code already installed) || set "NEED=!NEED! vscode"
if defined NEED (
    call :install_programs
    call :refreshpath
)
set "STILL="
where git  >nul 2>nul || set "STILL=!STILL! Git"
where node >nul 2>nul || set "STILL=!STILL! Node.js"
where py   >nul 2>nul || set "STILL=!STILL! Python"
if defined STILL goto :manual_install
rem VS Code is optional - the dashboard works without it.
where code >nul 2>nul || echo    [WARN] VS Code did not install - optional, get it from https://code.visualstudio.com

echo.
echo == 2/7  Dashboard code ^> %DIR%
if exist "%DIR%\.git" (
    git -C "%DIR%" pull --ff-only origin main
    if errorlevel 1 (echo    [WARN] git pull failed - keeping the existing copy) else (echo    [OK] Updated)
) else (
    git clone "%REPO%" "%DIR%"
    if errorlevel 1 (set "ERR=git clone failed. Check the internet connection." & goto :fail)
    echo    [OK] Downloaded
)
cd /d "%DIR%"

echo.
echo == 3/7  Dashboard packages (npm install)
call npm install --no-audit --no-fund
if errorlevel 1 (set "ERR=npm install failed. Check the internet connection and run this again." & goto :fail)
echo    [OK] googleapis, xlsx, crypto-js installed

echo.
echo == 4/7  Python libraries (a few minutes)
py -m pip install --user --upgrade pip --quiet
py -m pip install --user -r requirements-python.txt
if errorlevel 1 (set "ERR=Some Python libraries did not install - the message above says which." & goto :fail)
py -c "import pandas, numpy, openpyxl, matplotlib, gspread; print('   [OK] pandas', pandas.__version__, '- numpy', numpy.__version__)"

echo.
echo == 5/7  VS Code extensions (Python, Jupyter)
where code >nul 2>nul && (
    call code --install-extension ms-python.python --force >nul 2>nul
    call code --install-extension ms-toolsai.jupyter --force >nul 2>nul
    echo    [OK] Python and Jupyter extensions installed
) || echo    [WARN] Skipped - VS Code not found

echo.
echo == 6/7  Git name/email for the "Update dashboard data" commits
set "GITNAME="
for /f "delims=" %%n in ('git config --global user.name 2^>nul') do set "GITNAME=%%n"
if not defined GITNAME (
    set /p "GITNAME=   Your name: "
    git config --global user.name "!GITNAME!"
    set /p "GITEMAIL=   Your GitHub email: "
    git config --global user.email "!GITEMAIL!"
)
echo    [OK] Commits as: !GITNAME!

echo.
echo == 7/7  Private files from the old computer
set "MISSING="
for %%F in (service-account.json config.local.js password.local.js) do (
    if exist "%DIR%\%%F" (echo    [OK] %%F) else (echo    [WARN]  missing: %%F & set "MISSING=1")
)
if defined MISSING (
    echo.
    echo    Copy the missing files from the old computer's dashboard folder into the folder
    echo    that opens now ^(USB stick or similar - never email, chat or GitHub^),
    echo    plus the latest Daily*.xlsx. Then run refresh-dashboard.bat.
    start "" explorer "%DIR%"
) else (
    call node make-users.js list
    echo.
    echo    Next: run refresh-dashboard.bat ^(the first push asks you to sign in to GitHub once^).
)

echo.
echo ============================================
echo   Done. Dashboard folder: %DIR%
echo   Notebooks: py -m jupyter lab
echo ============================================
pause
exit /b 0

rem ---------------------------------------------------------------
:install_programs
where winget >nul 2>nul
if errorlevel 1 (
    echo    [WARN] winget is not available on this PC.
    exit /b 1
)
echo    Installing:%NEED%
echo    An administrator window will open - enter the admin password once.
del "%FLAGDIR%\m41_setup.started" "%FLAGDIR%\m41_setup.done" >nul 2>nul
> "%TEMP%\m41_elevate.vbs" echo CreateObject("Shell.Application").ShellExecute "cmd.exe", "/c """"%SELF%"" admin%NEED%""", "", "runas", 1
cscript //nologo "%TEMP%\m41_elevate.vbs" >nul 2>nul
if errorlevel 1 goto :direct_install
set /a WAITED=0
:wait_start
if exist "%FLAGDIR%\m41_setup.started" goto :wait_done
timeout /t 3 /nobreak >nul
set /a WAITED+=3
if !WAITED! GEQ 120 (
    echo    [WARN] The administrator window did not start ^(cancelled?^). Trying one installer at a time instead.
    goto :direct_install
)
goto :wait_start
:wait_done
echo    Waiting for the installs to finish ^(this window continues by itself^)...
:wait_loop
if exist "%FLAGDIR%\m41_setup.done" exit /b 0
timeout /t 5 /nobreak >nul
set /a WAITED+=5
if !WAITED! GEQ 2700 (
    echo    [WARN] Still not finished after 45 minutes - continuing; anything missing is listed next.
    exit /b 0
)
goto :wait_loop

:direct_install
rem Fallback: each installer asks for the admin password itself.
for %%P in (%NEED%) do call :winget_one winget %%P
exit /b 0

:winget_one
if /i "%~2"=="git"    "%~1" install --id Git.Git -e --silent --scope machine --accept-package-agreements --accept-source-agreements
if /i "%~2"=="node"   "%~1" install --id OpenJS.NodeJS.LTS -e --silent --scope machine --accept-package-agreements --accept-source-agreements
if /i "%~2"=="vscode" "%~1" install --id Microsoft.VisualStudioCode -e --silent --scope machine --accept-package-agreements --accept-source-agreements
if /i "%~2"=="python" "%~1" install --id Python.Python.3.13 -e --scope machine --accept-package-agreements --accept-source-agreements --override "/quiet InstallAllUsers=1 PrependPath=1 Include_launcher=1"
exit /b 0

rem ---------------------------------------------------------------
:admin_mode
rem Runs elevated. If the admin password is another account's, winget may not
rem be registered for it - fall back to App Installer's own winget.exe.
echo started> "%PUBLIC%\m41_setup.started"
title Meal4One setup - installing programs (administrator)
set "WG="
where winget >nul 2>nul && set "WG=winget"
if not defined WG for /d %%D in ("%ProgramFiles%\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe") do if exist "%%D\winget.exe" set "WG=%%D\winget.exe"
if not defined WG (
    echo winget was not found for the administrator account.
    echo done> "%PUBLIC%\m41_setup.done"
    pause
    exit /b 1
)
:admin_loop
shift
if "%~1"=="" goto :admin_end
echo.
echo Installing %~1 ...
call :winget_one "%WG%" %~1
goto :admin_loop
:admin_end
echo done> "%PUBLIC%\m41_setup.done"
exit /b 0

rem ---------------------------------------------------------------
:refreshpath
rem Re-read PATH from the registry so programs installed a moment ago are found.
set "MP=" & set "UP="
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MP=%%B"
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "UP=%%B"
if defined MP call set "PATH=%MP%;%UP%"
exit /b 0

:manual_install
echo.
echo    [WARN] Still missing:%STILL%
echo    Install them from these pages ^(each asks for the admin password^), then run this again:
echo      Git      https://git-scm.com/download/win
echo      Node.js  https://nodejs.org   ^(the LTS version^)
echo      Python   https://www.python.org/downloads/   ^(tick "Add python.exe to PATH"^)
echo      VS Code  https://code.visualstudio.com   ^(optional^)
echo    If the company blocks installing programs, ask IT to install these.
pause
exit /b 1

:fail
echo.
echo    [FAILED] %ERR%
pause
exit /b 1

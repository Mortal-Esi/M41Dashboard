@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Python + analysis libraries (optional)
echo   The dashboard itself does not need this.
echo ============================================
echo.

echo [1/3] Checking Python...
where py >nul 2>nul
if errorlevel 1 (
    echo   Python not found - installing Python 3.13 with winget...
    winget install --id Python.Python.3.13 -e --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo   [FAILED] Could not install Python. Install it from python.org ^(tick "Add python.exe to PATH"^),
        echo            then run this file again.
        pause
        exit /b 1
    )
    echo.
    echo   Python installed. CLOSE this window, open a new one and run setup-python.bat again
    echo   so Windows can find it.
    pause
    exit /b 0
)
set "PY="
for %%V in (3.13 3.14 3.12) do if not defined PY py -%%V -c "import sys" >nul 2>nul && set "PY=py -%%V"
if not defined PY (
    echo   No stable Python ^(3.12 - 3.14^) found - the newest one may be a pre-release. Installed:
    py --list
    echo   Install "Python 3.13 - Windows installer ^(64-bit^)" from python.org, then run this again.
    pause
    exit /b 1
)
echo   Using %PY%

echo.
echo [2/3] Updating pip...
%PY% -m pip install --upgrade pip --quiet
if errorlevel 1 (
    echo   [FAILED] pip update failed. Check the internet connection and run this file again.
    pause
    exit /b 1
)

echo.
echo [3/3] Installing libraries from requirements-python.txt (takes a few minutes)...
%PY% -m pip install -r requirements-python.txt
if errorlevel 1 (
    echo   [FAILED] Some libraries did not install - the message above says which.
    pause
    exit /b 1
)

echo.
%PY% -c "import pandas, numpy, openpyxl, matplotlib, gspread; print('  Check OK: pandas', pandas.__version__, '- numpy', numpy.__version__)"
echo.
echo ============================================
echo   Done. Start notebooks with:  %PY% -m jupyter lab
echo ============================================
echo.
pause

# install-all.ps1 - sets up a new Windows PC for the Meal4One dashboard.
#
# Run in a normal (NOT administrator) PowerShell window:
#   [Net.ServicePointManager]::SecurityProtocol='Tls12'; irm https://raw.githubusercontent.com/Mortal-Esi/M41Dashboard/main/install-all.ps1 | iex
#
# Only the program installs (Git, Node.js, Python, VS Code) run as administrator - one
# password prompt. Everything else (code, packages, libraries, git name) runs
# as you, so it lands in YOUR user profile, not the admin account's.
# Safe to run again: anything already installed is skipped.

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/Mortal-Esi/M41Dashboard.git'
$Dir     = Join-Path $env:USERPROFILE 'M41Dashboard'

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   [!]  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "`n   [FAILED] $t" -ForegroundColor Red; Read-Host "`nPress Enter to close"; exit 1 }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host '============================================'
Write-Host '  Meal4One dashboard - new PC setup'
Write-Host '============================================'

# ---------- 1. Programs (administrator, one prompt) ----------
Step '1/7  Git, Node.js, Python, VS Code'
RefreshPath
$need = @()
if (Has git)  { Ok "Git already installed" }     else { $need += 'git' }
if (Has node) { Ok "Node.js already installed" } else { $need += 'node' }
if (Has py)   { Ok "Python already installed" }  else { $need += 'python' }
if (Has code) { Ok "VS Code already installed" } else { $need += 'vscode' }

if ($need.Count -gt 0) {
  if (-not (Has winget)) {
    Fail "winget is missing. Install 'App Installer' from the Microsoft Store, then run this again."
  }
  Write-Host "   Installing: $($need -join ', ') - Windows will ask for the administrator password once." -ForegroundColor Yellow
  $admin = @'
$ErrorActionPreference = 'Continue'
# When the admin password belongs to another account, winget may not be
# registered for it - fall back to the installed App Installer's own winget.exe.
$wg = (Get-Command winget -ErrorAction SilentlyContinue).Source
if (-not $wg) {
  $wg = Get-ChildItem 'C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName
}
if (-not $wg) { Write-Host 'winget not found for the administrator account.' -ForegroundColor Red; Read-Host 'Press Enter'; exit 1 }
$common = @('-e', '--accept-package-agreements', '--accept-source-agreements', '--scope', 'machine')
$failed = $false
foreach ($n in $args) {
  Write-Host "Installing $n ..." -ForegroundColor Cyan
  switch ($n) {
    'git'    { & $wg install --id Git.Git @common --silent }
    'node'   { & $wg install --id OpenJS.NodeJS.LTS @common --silent }
    'vscode' { & $wg install --id Microsoft.VisualStudioCode @common --silent }
    'python' { & $wg install --id Python.Python.3.13 @common --override '/quiet InstallAllUsers=1 PrependPath=1 Include_launcher=1' }
  }
  if ($LASTEXITCODE -ne 0) { $failed = $true; Write-Host "  $n exit code $LASTEXITCODE" -ForegroundColor Yellow }
}
if ($failed) { Read-Host 'Something did not install (see above). Press Enter to go back' } else { Start-Sleep -Seconds 2 }
'@
  $script = "& { $admin } " + ($need -join ' ')
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc
  } catch {
    Fail "The administrator prompt was cancelled. Run this again and enter the admin password."
  }
  RefreshPath
  foreach ($c in @{ git = 'Git'; node = 'Node.js'; py = 'Python' }.GetEnumerator()) {
    if (Has $c.Key) { Ok "$($c.Value) ready" } else { Fail "$($c.Value) did not install. Close this window, open a new one and run the command again." }
  }
  # VS Code is optional - the dashboard works without it.
  if (Has code) { Ok 'VS Code ready' } else { Warn 'VS Code did not install - optional, get it from https://code.visualstudio.com' }
}

# ---------- 2. Code ----------
Step "2/7  Dashboard code -> $Dir"
if (Test-Path (Join-Path $Dir '.git')) {
  git -C $Dir pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { Warn "git pull failed - keeping the existing copy (run fix-git-conflict.bat later)." } else { Ok 'Updated' }
} else {
  git clone $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed. Check the internet connection.' }
  Ok 'Downloaded'
}
Set-Location $Dir

# ---------- 3. Node packages ----------
Step '3/7  Dashboard packages (npm install)'
# npm.cmd, not npm: a restricted ExecutionPolicy blocks the npm.ps1 shim.
npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. Check the internet connection and run this again.' }
Ok 'googleapis, xlsx, crypto-js installed'

# ---------- 4. Python libraries ----------
Step '4/7  Python libraries (a few minutes)'
# Use a stable Python: the newest installed one can be a pre-release (e.g. 3.15)
# that pandas and numpy don't publish packages for yet. Python is optional -
# the dashboard works without it - so problems here only warn.
$pyVer = $null
foreach ($v in '3.13', '3.14', '3.12') { py "-$v" -c "import sys" *> $null; if ($LASTEXITCODE -eq 0) { $pyVer = "-$v"; break } }
if ($pyVer) {
  Write-Host "   Using Python: py $pyVer"
  py $pyVer -m pip install --user --upgrade pip --quiet --no-warn-script-location
  py $pyVer -m pip install --user --no-warn-script-location -r requirements-python.txt
  if ($LASTEXITCODE -ne 0) { Warn 'Some Python libraries did not install - see the message above. The dashboard does not need them.' } else { py $pyVer -c "import pandas, numpy, openpyxl, matplotlib, gspread; print('   [OK] pandas', pandas.__version__, '- numpy', numpy.__version__)" }
} else {
  Warn 'No stable Python (3.12 - 3.14) found. Installed versions:'
  py --list
  Warn 'Python libraries skipped - the dashboard does not need them. For analysis, install Python 3.13 64-bit and run this again.'
}

# ---------- 5. VS Code extensions ----------
Step '5/7  VS Code extensions (Python, Jupyter)'
if (Has code) {
  code.cmd --install-extension ms-python.python --force *> $null
  code.cmd --install-extension ms-toolsai.jupyter --force *> $null
  Ok 'Python and Jupyter extensions installed'
} else { Warn 'Skipped - VS Code not found' }

# ---------- 6. Git identity ----------
Step '6/7  Git name/email for "Update dashboard data" commits'
$gitName = git config --global user.name
if (-not $gitName) {
  $gitName = Read-Host '   Your name'
  git config --global user.name $gitName
  git config --global user.email (Read-Host '   Your GitHub email')
}
Ok "Commits as: $gitName"

# ---------- 7. Private files ----------
Step '7/7  Private files from the old computer'
$missing = @('service-account.json', 'config.local.js', 'password.local.js') | Where-Object { -not (Test-Path (Join-Path $Dir $_)) }
if ($missing) {
  foreach ($m in $missing) { Warn "missing: $m" }
  Write-Host "`n   Copy these from the old computer's dashboard folder into the folder that opens now"
  Write-Host '   (USB stick or similar - never email, chat or GitHub), plus the latest Daily*.xlsx.'
  Start-Process explorer.exe $Dir
} else {
  Ok 'All three present'
  node make-users.js list
}

Write-Host "`n============================================" -ForegroundColor Green
Write-Host "  Done. Dashboard folder: $Dir" -ForegroundColor Green
if ($missing) { Write-Host '  After copying the private files: run refresh-dashboard.bat' -ForegroundColor Green } else { Write-Host '  Next: run refresh-dashboard.bat (first push asks you to sign in to GitHub once)' -ForegroundColor Green }
Write-Host '  Notebooks: py -3.13 -m jupyter lab' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Read-Host "`nPress Enter to close"

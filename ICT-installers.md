# Installers for the Meal4One dashboard PC (for ICT)

Please install these four programs (64-bit, official publishers, free):

| Program | Download | Install options |
|---|---|---|
| Git for Windows | https://git-scm.com/download/win (starts the latest 64-bit installer) | Defaults are fine |
| Node.js LTS | https://nodejs.org/dist/v26.13.0/node-v26.13.0-x64.msi (or the **LTS** button on https://nodejs.org) | Defaults are fine |
| Python 3.13 | https://www.python.org/downloads/windows/ → latest **Python 3.13 — Windows installer (64-bit)** | Tick **"Add python.exe to PATH"**; choose *Customize installation* → tick **"Install Python for all users"** |
| Visual Studio Code | https://code.visualstudio.com/download → **System Installer, x64** | Keep **"Add to PATH"** ticked |

After installation the user runs, in a normal Command Prompt (no admin rights needed):

```
curl -L -o "%TEMP%\m41-install.bat" https://raw.githubusercontent.com/Mortal-Esi/M41Dashboard/main/install-all.bat && "%TEMP%\m41-install.bat"
```

It detects the four programs, skips installing them, and only sets up the
dashboard code, its packages and the Python libraries in the user's profile.

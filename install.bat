@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "UV_BIN="
set "NODE_CMD="
set "NODE_DIR="
set "NODE_SOURCE="
set "NODE_VERSION="
set "NPM_CMD="
set "NPM_VERSION="
set "FORCE_INSTALL_VLO_NODE=0"
set "PYTHON_CMD="
set "PYTHON_SOURCE="
set "PY_VER="
set "VLO_HOME=%LocalAppData%\Programs\VLO"
set "VLO_NODE_VERSION=22.22.1"
set "VLO_NODE_DOWNLOAD_DIR=%TEMP%\vlo-installer"
set "VLO_NODE_ARCH="
set "VLO_NODE_BASENAME="
set "VLO_NODE_HOME="
set "VLO_NODE_EXE="
set "VLO_NODE_ZIP_NAME="
set "VLO_NODE_ZIP_PATH="
set "VLO_NODE_URL="
set "VLO_PYTHON_VERSION=3.13.12"
set "VLO_PYTHON_MINOR=3.13"
set "VLO_PYTHON_INSTALL_DIR=%VLO_HOME%\python"

:: Parse arguments
:parse_args
if "%~1"=="" goto :done_args
if /I "%~1"=="--update-node" set "FORCE_INSTALL_VLO_NODE=1"
shift
goto :parse_args
:done_args

echo [INFO]  VLO Installer
echo.

:: -- 1. Check prerequisites -----------------------------------------

:: Node.js
call :configure_vlo_node_distribution
if "%FORCE_INSTALL_VLO_NODE%"=="1" (
    echo [INFO]  --update-node requested. Installing VLO-managed Node.js %VLO_NODE_VERSION%...
    call :install_vlo_node
    if errorlevel 1 goto :eof
    goto :node_found
)
call :try_node_path "%VLO_NODE_EXE%" "VLO-managed Node.js"
if not errorlevel 1 (
    call :prompt_existing_node_choice
    if errorlevel 1 goto :eof
    goto :node_found
)

for /f "tokens=*" %%F in ('where node 2^>nul') do (
    call :try_node_path "%%~fF" "node"
    if !errorlevel! equ 0 (
        call :prompt_existing_node_choice
        if !errorlevel! neq 0 goto :eof
        goto :node_found
    )
)

call :prompt_install_vlo_node
if errorlevel 1 goto :eof
:node_found
set "PATH=%NODE_DIR%;%PATH%"
echo [INFO]  Node.js %NODE_VERSION% found via %NODE_SOURCE%
echo [INFO]  npm %NPM_VERSION% found via %NPM_CMD%

:: -- 2. Install uv --------------------------------------------------

where uv >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%U in ('where uv') do (
        set "UV_BIN=%%U"
        goto :uv_found
    )
) else (
    echo [INFO]  Installing uv...
    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    set "UV_BIN=%USERPROFILE%\.local\bin\uv.exe"
)
:uv_found
if not exist "%UV_BIN%" (
    call :fail "uv was not found after installation."
    goto :eof
)
set "UV_PYTHON_INSTALL_DIR=%VLO_PYTHON_INSTALL_DIR%"
for /f "tokens=*" %%V in ('"%UV_BIN%" --version') do set "UV_VERSION=%%V"
echo [INFO]  %UV_VERSION% found at %UV_BIN%

:: -- 3. Check Python 3.10+ -----------------------------------------

echo [INFO]  Checking Python 3.10+...
call :find_vlo_python
if not errorlevel 1 goto :python_found

for %%P in (python python3) do (
    for /f "tokens=*" %%F in ('where %%P 2^>nul') do (
        call :try_python_path "%%~fF" "%%P"
        if !errorlevel! equ 0 goto :python_found
    )
)

for /f "tokens=*" %%F in ('where py 2^>nul') do (
    echo %%~fF | find /I "\WindowsApps\" >nul
    if errorlevel 1 (
        call :try_py_launcher "%%~fF"
        if !errorlevel! equ 0 goto :python_found
    )
)

for /f "tokens=*" %%F in ('where pymanager 2^>nul') do (
    echo %%~fF | find /I "\WindowsApps\" >nul
    if errorlevel 1 (
        call :try_pymanager_launcher "%%~fF"
        if !errorlevel! equ 0 goto :python_found
    )
)

call :try_python_registry_paths
if not errorlevel 1 goto :python_found

call :prompt_install_vlo_python
if errorlevel 1 goto :eof
:python_found
echo [INFO]  Python %PY_VER% found via %PYTHON_SOURCE%

:: -- 4. Install frontend dependencies -------------------------------

echo [INFO]  Installing npm dependencies...
cd /d "%SCRIPT_DIR%"
call "%NPM_CMD%" install
if %errorlevel% neq 0 (
    call :fail "npm install failed"
    goto :eof
)
call "%NPM_CMD%" install --prefix frontend
if %errorlevel% neq 0 (
    call :fail "npm install --prefix frontend failed"
    goto :eof
)

:: -- 5. Build frontend ----------------------------------------------

echo [INFO]  Building frontend...
call "%NPM_CMD%" run build --prefix frontend
if %errorlevel% neq 0 (
    call :fail "Frontend build failed"
    goto :eof
)

:: -- 6. Install backend dependencies --------------------------------

echo [INFO]  Installing backend Python dependencies...
cd /d "%SCRIPT_DIR%backend"
call "%UV_BIN%" sync --frozen --python "%PYTHON_CMD%"
if %errorlevel% neq 0 (
    call :fail "uv sync failed"
    goto :eof
)

:: -- 7. Environment config ------------------------------------------

if not exist "%SCRIPT_DIR%backend\.env" (
    copy "%SCRIPT_DIR%backend\.env.example" "%SCRIPT_DIR%backend\.env" >nul
    echo [INFO]  Created backend\.env from .env.example
) else (
    echo [INFO]  backend\.env already exists, skipping
)

:: -- 8. Projects directory ------------------------------------------

if not exist "%SCRIPT_DIR%projects" mkdir "%SCRIPT_DIR%projects"

:: -- Done -----------------------------------------------------------

echo.
echo [INFO]  Installation complete!
echo [INFO]  Run run.bat to start VLO
echo [INFO]  Make sure ComfyUI is running separately (default: http://127.0.0.1:8188)

endlocal

goto :eof

:configure_vlo_node_distribution
set "VLO_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "VLO_ARCH=%PROCESSOR_ARCHITEW6432%"
if /I "%VLO_ARCH%"=="ARM64" (
    set "VLO_NODE_ARCH=arm64"
) else if /I "%VLO_ARCH%"=="X86" (
    set "VLO_NODE_ARCH=x86"
) else (
    set "VLO_NODE_ARCH=x64"
)
set "VLO_NODE_BASENAME=node-v%VLO_NODE_VERSION%-win-%VLO_NODE_ARCH%"
set "VLO_NODE_HOME=%VLO_HOME%\%VLO_NODE_BASENAME%"
set "VLO_NODE_EXE=%VLO_NODE_HOME%\node.exe"
set "VLO_NODE_ZIP_NAME=%VLO_NODE_BASENAME%.zip"
set "VLO_NODE_ZIP_PATH=%VLO_NODE_DOWNLOAD_DIR%\%VLO_NODE_ZIP_NAME%"
set "VLO_NODE_URL=https://nodejs.org/dist/v%VLO_NODE_VERSION%/%VLO_NODE_ZIP_NAME%"
exit /b 0

:try_node_path
set "CANDIDATE_NODE=%~1"
set "CANDIDATE_SOURCE=%~2"
set "CANDIDATE_DIR=%~dp1"
set "CANDIDATE_NPM=%CANDIDATE_DIR%npm.cmd"
set "CANDIDATE_MAJOR="
set "CANDIDATE_MINOR="
if not exist "%CANDIDATE_NODE%" exit /b 1
if not exist "%CANDIDATE_NPM%" exit /b 1
echo %CANDIDATE_NODE% | find /I "\WindowsApps\" >nul
if not errorlevel 1 exit /b 1
for /f "tokens=1,2 delims=v." %%A in ('"%CANDIDATE_NODE%" -v 2^>nul') do (
    set "CANDIDATE_MAJOR=%%A"
    set "CANDIDATE_MINOR=%%B"
)
if not defined CANDIDATE_MAJOR exit /b 1
if !CANDIDATE_MAJOR! lss 20 exit /b 1
if !CANDIDATE_MAJOR! equ 20 if !CANDIDATE_MINOR! lss 19 exit /b 1
if !CANDIDATE_MAJOR! equ 21 exit /b 1
if !CANDIDATE_MAJOR! equ 22 if !CANDIDATE_MINOR! lss 13 exit /b 1
for /f "tokens=*" %%V in ('"%CANDIDATE_NODE%" -v') do set "NODE_VERSION=%%V"
for /f "tokens=*" %%V in ('"%CANDIDATE_NPM%" -v') do set "NPM_VERSION=%%V"
set "NODE_CMD=%CANDIDATE_NODE%"
set "NODE_DIR=%CANDIDATE_DIR%"
set "NPM_CMD=%CANDIDATE_NPM%"
set "NODE_SOURCE=%CANDIDATE_SOURCE% (%CANDIDATE_NODE%)"
exit /b 0

:prompt_install_vlo_node
echo [WARN]  No compatible Node.js runtime was found.
echo [INFO]  VLO can download Node.js %VLO_NODE_VERSION% into:
echo [INFO]    %VLO_NODE_HOME%
echo [INFO]  This install is per-user and VLO-managed.
echo [INFO]  It will not modify your system PATH.
echo.
set "INSTALL_VLO_NODE="
set /p INSTALL_VLO_NODE=Install VLO-managed Node.js %VLO_NODE_VERSION% now? [Y/n]:
if /I "!INSTALL_VLO_NODE!"=="N" (
    call :fail "Node.js 20.19+ or 22.13+ is required but was not installed."
    exit /b 1
)
if /I "!INSTALL_VLO_NODE!"=="NO" (
    call :fail "Node.js 20.19+ or 22.13+ is required but was not installed."
    exit /b 1
)
call :install_vlo_node
exit /b %errorlevel%

:prompt_existing_node_choice
echo [INFO]  Detected compatible Node.js %NODE_VERSION%.
echo [INFO]  Source: %NODE_SOURCE%
echo [INFO]  VLO can also install its own managed Node.js %VLO_NODE_VERSION%.
echo [INFO]  This is useful if you want VLO to avoid your existing global Node.js setup.
echo.
set "USE_MANAGED_NODE="
set /p USE_MANAGED_NODE=Install or update VLO-managed Node.js %VLO_NODE_VERSION% instead? [y/N]:
if /I "!USE_MANAGED_NODE!"=="Y" (
    call :install_vlo_node
    exit /b %errorlevel%
)
if /I "!USE_MANAGED_NODE!"=="YES" (
    call :install_vlo_node
    exit /b %errorlevel%
)
exit /b 0

:install_vlo_node
if not exist "%VLO_NODE_DOWNLOAD_DIR%" mkdir "%VLO_NODE_DOWNLOAD_DIR%"
if not exist "%VLO_HOME%" mkdir "%VLO_HOME%"

echo [INFO]  Downloading Node.js %VLO_NODE_VERSION% from nodejs.org...
powershell -NoProfile -ExecutionPolicy ByPass -Command "Invoke-WebRequest -Uri '%VLO_NODE_URL%' -OutFile '%VLO_NODE_ZIP_PATH%'"
if errorlevel 1 (
    call :fail "Failed to download Node.js %VLO_NODE_VERSION%."
    exit /b 1
)

echo [INFO]  Extracting VLO-managed Node.js %VLO_NODE_VERSION%...
powershell -NoProfile -ExecutionPolicy ByPass -Command "Expand-Archive -Path '%VLO_NODE_ZIP_PATH%' -DestinationPath '%VLO_HOME%' -Force"
if errorlevel 1 (
    call :fail "Failed to extract Node.js %VLO_NODE_VERSION%."
    exit /b 1
)

call :try_node_path "%VLO_NODE_EXE%" "VLO-managed Node.js"
if errorlevel 1 (
    call :fail "Node.js %VLO_NODE_VERSION% was extracted, but VLO could not find a usable node.exe."
    exit /b 1
)

echo [INFO]  Installed VLO-managed Node.js %NODE_VERSION%.
exit /b 0

:try_python_path
set "CANDIDATE_PATH=%~1"
set "CANDIDATE_SOURCE=%~2"
if not exist "%CANDIDATE_PATH%" exit /b 1
echo %CANDIDATE_PATH% | find /I "\WindowsApps\" >nul
if not errorlevel 1 exit /b 1
"%CANDIDATE_PATH%" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 exit /b 1
for /f "tokens=2" %%V in ('"%CANDIDATE_PATH%" --version 2^>^&1') do set "PY_VER=%%V"
set "PYTHON_CMD=%CANDIDATE_PATH%"
set "PYTHON_SOURCE=%CANDIDATE_SOURCE% (%CANDIDATE_PATH%)"
exit /b 0

:find_vlo_python
set "FOUND_PYTHON="
set "UV_PYTHON_DIR="
set "UV_PYTHON_BIN_DIR="
if not exist "%UV_BIN%" exit /b 1

for /f "tokens=*" %%V in ('"%UV_BIN%" python find --managed-python --no-python-downloads "%VLO_PYTHON_VERSION%" 2^>nul') do (
    set "FOUND_PYTHON=%%V"
)
if defined FOUND_PYTHON (
    call :try_python_path "%FOUND_PYTHON%" "VLO-managed Python"
    if !errorlevel! equ 0 exit /b 0
)

for /f "tokens=*" %%V in ('"%UV_BIN%" python dir 2^>nul') do (
    set "UV_PYTHON_DIR=%%V"
)
for /f "tokens=*" %%V in ('"%UV_BIN%" python dir --bin 2^>nul') do (
    set "UV_PYTHON_BIN_DIR=%%V"
)

if defined UV_PYTHON_BIN_DIR (
    call :try_python_path "%UV_PYTHON_BIN_DIR%\python%VLO_PYTHON_MINOR%.exe" "VLO-managed Python"
    if !errorlevel! equ 0 exit /b 0
    call :try_python_path "%UV_PYTHON_BIN_DIR%\python.exe" "VLO-managed Python"
    if !errorlevel! equ 0 exit /b 0
)

if defined UV_PYTHON_DIR (
    for /f "delims=" %%V in ('dir /b /s "%UV_PYTHON_DIR%\python.exe" 2^>nul') do (
        call :try_python_path "%%V" "VLO-managed Python"
        if !errorlevel! equ 0 exit /b 0
    )
    for /f "delims=" %%V in ('dir /b /s "%UV_PYTHON_DIR%\python%VLO_PYTHON_MINOR%.exe" 2^>nul') do (
        call :try_python_path "%%V" "VLO-managed Python"
        if !errorlevel! equ 0 exit /b 0
    )
)

exit /b 1

:try_python_registry_paths
:: Registry discovery catches Python installs that are not on PATH or exposed by launchers.
for %%K in (
    HKCU\Software\Python\PythonCore
    HKLM\Software\Python\PythonCore
    HKLM\Software\WOW6432Node\Python\PythonCore
) do (
    call :try_python_registry_root "%%K"
    if !errorlevel! equ 0 exit /b 0
)
exit /b 1

:try_python_registry_root
for /l %%N in (30,-1,10) do (
    set "REG_PYTHON_TAG=3.%%N"
    call :try_python_registry_tag "%~1" "!REG_PYTHON_TAG!"
    if !errorlevel! equ 0 exit /b 0
)
exit /b 1

:try_python_registry_tag
call :try_python_registry_key "%~1\%~2" "Windows registry (%~1\%~2)"
if not errorlevel 1 exit /b 0
call :try_python_registry_key "%~1\%~2-64" "Windows registry (%~1\%~2-64)"
if not errorlevel 1 exit /b 0
call :try_python_registry_key "%~1\%~2-32" "Windows registry (%~1\%~2-32)"
if not errorlevel 1 exit /b 0
call :try_python_registry_key "%~1\%~2-arm64" "Windows registry (%~1\%~2-arm64)"
if not errorlevel 1 exit /b 0
call :try_python_registry_key "%~1\%~2t" "Windows registry (%~1\%~2t)"
if not errorlevel 1 exit /b 0
exit /b 1

:try_python_registry_key
set "REG_INSTALL_KEY=%~1\InstallPath"
set "REG_INSTALL_PATH="
set "REG_PYTHON_EXE="

for /f "tokens=1,2,*" %%A in ('reg query "%REG_INSTALL_KEY%" /v ExecutablePath 2^>nul ^| findstr /R /C:"ExecutablePath"') do (
    set "REG_PYTHON_EXE=%%C"
)

if not defined REG_PYTHON_EXE (
    for /f "tokens=1,2,*" %%A in ('reg query "%REG_INSTALL_KEY%" /ve 2^>nul ^| findstr /R /C:"REG_SZ"') do (
        set "REG_INSTALL_PATH=%%C"
    )
    if defined REG_INSTALL_PATH (
        if "!REG_INSTALL_PATH:~-1!"=="\" (
            set "REG_PYTHON_EXE=!REG_INSTALL_PATH!python.exe"
        ) else (
            set "REG_PYTHON_EXE=!REG_INSTALL_PATH!\python.exe"
        )
    )
)

if not defined REG_PYTHON_EXE exit /b 1
call :try_python_path "!REG_PYTHON_EXE!" "%~2"
exit /b !errorlevel!

:try_py_launcher
py -3 -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 exit /b 1
for /f "tokens=2" %%V in ('py -3 --version 2^>^&1') do set "PY_VER=%%V"
for /f "tokens=*" %%V in ('py -3 -c "import sys; print(sys.executable)"') do set "PYTHON_CMD=%%V"
set "PYTHON_SOURCE=py launcher (%~1)"
exit /b 0

:try_pymanager_launcher
pymanager exec -V:3 -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 exit /b 1
for /f "tokens=2" %%V in ('pymanager exec -V:3 --version 2^>^&1') do set "PY_VER=%%V"
for /f "tokens=*" %%V in ('pymanager exec -V:3 -c "import sys; print(sys.executable)"') do set "PYTHON_CMD=%%V"
set "PYTHON_SOURCE=Python install manager (%~1)"
exit /b 0

:prompt_install_vlo_python
echo [WARN]  No compatible Python 3.10+ runtime was found.
echo [INFO]  VLO can install Python %VLO_PYTHON_VERSION% via uv into:
echo [INFO]    %VLO_PYTHON_INSTALL_DIR%
echo [INFO]  This install is per-user and VLO-managed.
echo.
set "INSTALL_VLO_PYTHON="
set /p INSTALL_VLO_PYTHON=Install VLO-managed Python %VLO_PYTHON_VERSION% now? [Y/n]:
if /I "!INSTALL_VLO_PYTHON!"=="N" (
    call :fail "Python 3.10+ is required but was not installed."
    exit /b 1
)
if /I "!INSTALL_VLO_PYTHON!"=="NO" (
    call :fail "Python 3.10+ is required but was not installed."
    exit /b 1
)
call :install_vlo_python
exit /b %errorlevel%

:install_vlo_python
if not exist "%VLO_HOME%" mkdir "%VLO_HOME%"
if not exist "%VLO_PYTHON_INSTALL_DIR%" mkdir "%VLO_PYTHON_INSTALL_DIR%"

echo [INFO]  Installing VLO-managed Python %VLO_PYTHON_VERSION% via uv...
call "%UV_BIN%" python install "%VLO_PYTHON_VERSION%"
if errorlevel 1 (
    call :fail "Python %VLO_PYTHON_VERSION% installation failed."
    exit /b 1
)

call :find_vlo_python
if errorlevel 1 (
    call :fail "Python %VLO_PYTHON_VERSION% was installed, but VLO could not find a usable interpreter."
    exit /b 1
)

echo [INFO]  Python %PY_VER% is ready for VLO.
exit /b 0

:fail
echo.
echo [ERROR] %~1
echo [INFO]  The installer stopped before completion.
echo [INFO]  Rerun install.bat from cmd.exe or PowerShell to keep the full output visible.
echo.
pause
exit /b 1

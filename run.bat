@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "HOST=127.0.0.1"
set "PORT=6332"
set "NO_BROWSER=0"
set "PYTHON_BIN=%SCRIPT_DIR%backend\.venv\Scripts\python.exe"

:: Parse arguments
:parse_args
if "%~1"=="" goto :done_args
if "%~1"=="--no-browser" set "NO_BROWSER=1"
if "%~1"=="--host" (set "HOST=%~2" & shift)
if "%~1"=="--port" (set "PORT=%~2" & shift)
shift
goto :parse_args
:done_args

:: Verify installation
if not exist "%PYTHON_BIN%" (
    echo Error: Backend not installed. Run install.bat first.
    exit /b 1
)
if not exist "%SCRIPT_DIR%frontend\dist\index.html" (
    echo Warning: Frontend not built. Run install.bat or npm run build.
)

:: Open browser after delay
if "%NO_BROWSER%"=="0" (
    start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://%HOST%:%PORT%"
)

echo Starting VLO at http://%HOST%:%PORT%
echo Press Ctrl+C to stop.
echo.

cd /d "%SCRIPT_DIR%backend"
"%PYTHON_BIN%" -m uvicorn main:app --host %HOST% --port %PORT%

endlocal

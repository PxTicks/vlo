@echo off
setlocal EnableExtensions DisableDelayedExpansion

:: A Git update can replace update.bat while it runs, and cmd.exe reads a batch
:: file a line at a time from a saved offset. Run from a temporary copy, and
:: start it without `call` so cmd.exe never comes back to read this file.
set "SELF_NAME=%~n0"
if /I "%SELF_NAME:~0,18%"=="vlo-update-runner-" goto :update
set "VLO_UPDATE_ROOT=%~dp0"
set "UPDATE_RUNNER=%TEMP%\vlo-update-runner-%RANDOM%%RANDOM%.bat"
copy /y "%~f0" "%UPDATE_RUNNER%" >nul
if errorlevel 1 (
    echo [ERROR] Could not create the temporary update runner.
    exit /b 1
)
"%UPDATE_RUNNER%" %*
:: Only reached if the copy could not be started at all.
echo [ERROR] Could not start the temporary update runner.
exit /b 1

:update
:: `shift` below also moves %0, so remember this copy's own path first.
set "RUNNER_PATH=%~f0"
set "SCRIPT_DIR=%VLO_UPDATE_ROOT%"
set "VLO_UPDATE_ROOT="
set "PROJECT_DIR=%SCRIPT_DIR:~0,-1%"
set "DEFAULT_REPOSITORY=https://github.com/PxTicks/vlo.git"
set "DEFAULT_BRANCH=main"
if not defined VLO_UPDATE_REPOSITORY set "VLO_UPDATE_REPOSITORY=%DEFAULT_REPOSITORY%"
if not defined VLO_UPDATE_BRANCH set "VLO_UPDATE_BRANCH=%DEFAULT_BRANCH%"
set "RC=0"
set "REPLACE_LOCAL_FILES="
set "INSTALL_ARGS="

:: Keep the updater's own option; everything else goes to install.bat. cmd
:: splits `--profiles sam2,sam-audio` at the comma, and install.bat accepts
:: the values as separate arguments.
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="--help" goto :usage
if /I "%~1"=="--replace-local-files" (
    set "REPLACE_LOCAL_FILES=-ReplaceLocalFiles"
) else (
    set "INSTALL_ARGS=%INSTALL_ARGS% %1"
)
shift
goto :parse_args
:args_done

echo [INFO]  vlo Updater
echo.

where git >nul 2>&1
if errorlevel 1 goto :git_missing
git --version >nul 2>&1
if errorlevel 1 goto :git_missing

if not exist "%SCRIPT_DIR%install.bat" goto :not_installation
if not exist "%SCRIPT_DIR%package.json" goto :not_installation
if not exist "%SCRIPT_DIR%scripts\update-source.ps1" goto :not_installation

:: Fast-forward the Git checkout, or convert a ZIP download into one. Either
:: way, it lists every local file it would replace or move and asks before
:: touching any of them; see scripts\update-source.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\update-source.ps1" -Root "%PROJECT_DIR%" -Repository "%VLO_UPDATE_REPOSITORY%" -Branch "%VLO_UPDATE_BRANCH%" %REPLACE_LOCAL_FILES%
if errorlevel 1 goto :failed

echo.
echo [INFO]  Rebuilding vlo with the updated installer...
call "%SCRIPT_DIR%install.bat"%INSTALL_ARGS%
set "RC=%errorlevel%"
goto :finish

:not_installation
echo [ERROR] This script must remain in the root of a vlo installation.
goto :failed

:git_missing
echo [ERROR] Git is required to update vlo. Install it from:
echo [ERROR] https://git-scm.com/downloads
echo [ERROR] Then open a new terminal and rerun this script.
goto :failed

:usage
echo Usage: update.bat [--replace-local-files] [installer options]
echo.
echo Fetch the latest vlo source, then rerun install.bat to update dependencies
echo and rebuild the frontend. Installer options such as --profiles and
echo --update-node are passed through unchanged.
echo The installer ends by reporting whether the ComfyUI-vlo node pack in
echo your ComfyUI is new enough; it never changes ComfyUI.
echo.
echo If updating would replace or move a local file, the updater lists those
echo files and asks first; each one is saved under .vlo-update-backups\ before
echo it is touched. That covers tracked source files with local changes in a
echo Git checkout, and the first update of a folder downloaded as a GitHub ZIP,
echo which converts it into a Git checkout.
echo.
echo   --replace-local-files  Approve those changes without asking. Required
echo                          when the updater cannot prompt.
goto :finish

:failed
set "RC=1"
echo.
echo [INFO]  The updater stopped before completion.
pause
goto :finish

:finish
:: Delete this temporary copy on the way out. `(goto)` ends the batch context
:: first; the rest of the line was already parsed, so it still runs.
(goto) 2>nul & del /q "%RUNNER_PATH%" & cmd /d /c exit %RC%

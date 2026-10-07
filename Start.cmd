@echo off
cd /d "%~dp0"
setlocal
if not exist "%~dp0scripts\Start-Review.ps1" (
    echo The launcher is missing. Extract the complete ZIP and try again.
    echo Het startprogramma ontbreekt. Pak de volledige ZIP uit en probeer opnieuw.
    pause
    exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Review.ps1"
exit /b %errorlevel%

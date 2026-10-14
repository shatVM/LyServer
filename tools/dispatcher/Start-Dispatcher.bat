@echo off
setlocal
chcp 65001 >nul
title LyServer Dispatcher

set "SCRIPT_DIR=%~dp0"
set "SCRIPT=%SCRIPT_DIR%dispatcher.ps1"
set "CONFIG=%SCRIPT_DIR%config.psd1"

if not exist "%SCRIPT%" (
    echo [ERROR] Dispatcher script not found:
    echo "%SCRIPT%"
    pause
    exit /b 1
)

if not exist "%CONFIG%" (
    echo [ERROR] Configuration file not found:
    echo "%CONFIG%"
    echo.
    echo Create config.psd1 from config.example.psd1 first.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -ConfigPath "%CONFIG%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo [OK] Dispatcher finished successfully.
) else (
    echo [ERROR] Dispatcher exited with code %EXIT_CODE%.
)

echo.
pause
exit /b %EXIT_CODE%

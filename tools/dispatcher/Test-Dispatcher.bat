@echo off
setlocal
chcp 65001 >nul
title LyServer Dispatcher - Tests

set "SCRIPT_DIR=%~dp0"
set "TEST_SCRIPT=%SCRIPT_DIR%dispatcher.tests.ps1"

if not exist "%TEST_SCRIPT%" (
    echo [ERROR] Test script not found:
    echo "%TEST_SCRIPT%"
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%TEST_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo [OK] All tests passed.
) else (
    echo [ERROR] Tests failed. Exit code: %EXIT_CODE%.
)

echo.
pause
exit /b %EXIT_CODE%

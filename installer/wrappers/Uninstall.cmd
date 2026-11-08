@echo off
rem Double-click to remove BYO Stream from Discord.
if not exist "%~dp0install.ps1" (
  echo.
  echo Extract the zip first: right-click it, choose Extract All, then open Uninstall.cmd
  echo from the folder that appears.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
echo.
pause

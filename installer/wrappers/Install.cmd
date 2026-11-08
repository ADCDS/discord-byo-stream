@echo off
rem Double-click to install or update BYO Stream. Keep it next to the other files from the zip.
if not exist "%~dp0install.ps1" (
  echo.
  echo Extract the zip first: right-click it, choose Extract All, then open Install.cmd
  echo from the folder that appears.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause

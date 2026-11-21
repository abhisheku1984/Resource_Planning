@echo off
setlocal
cd /d "%~dp0"
title Resource Planning - Studio speaker upgrade
echo Installing the optional Studio voices for Indian English and Hindi.
echo One-time download: about 100 MB. No microphone or workbook data is accessed.
echo.
call npm.cmd run voice:studio
if errorlevel 1 (
  echo Setup did not finish. Check Node.js, your connection and disk space, then try again.
  pause
  exit /b 1
)
echo Restart the updated app, refresh Ask, then choose Test speaker.
pause

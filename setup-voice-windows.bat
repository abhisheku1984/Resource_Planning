@echo off
setlocal
cd /d "%~dp0"
title Resource Planning - optional offline voice setup
echo Install Indian English and Hindi for the Ask microphone and speaker.
echo This downloads about 155 MB from npm and GitHub to the voice folder.
echo No audio or workbook data is sent. No administrator access is needed.
echo.
call npm.cmd run voice:setup
if errorlevel 1 (
  echo Setup did not finish. Check the message above and run this file again.
  pause
  exit /b 1
)
echo Open Ask in your browser, choose a language and test the speaker or mic.
pause

@echo off
REM ===========================================================================
REM  Resource Planning - Windows launcher
REM  Double-click this file to install dependencies (first run) and start the
REM  server, then open it in your browser.
REM ===========================================================================
setlocal
cd /d "%~dp0"

title Resource Planning

echo.
echo  ==========================================
echo   Resource Planning - local server
echo  ==========================================
echo.

REM ---- 1. is Node.js installed? -------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js is not installed, or it is not on your PATH.
  echo.
  echo      Install the Node.js LTS build from https://nodejs.org
  echo      then close this window and double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo  Node.js %NODEVER% detected.

REM node:sqlite needs Node 22.5 or newer
for /f "tokens=1,2 delims=." %%a in ("%NODEVER%") do (
  set MAJOR=%%a
  set MINOR=%%b
)
if %MAJOR% LSS 22 (
  echo.
  echo  [X] Node.js 22.5 or newer is required. You have %NODEVER%.
  echo      Download the current LTS from https://nodejs.org and re-run.
  echo.
  pause
  exit /b 1
)
if %MAJOR% EQU 22 if %MINOR% LSS 5 (
  echo.
  echo  [X] Node.js 22.5 or newer is required. You have %NODEVER%.
  echo.
  pause
  exit /b 1
)

REM ---- 2. install dependencies once ---------------------------------------
if not exist "node_modules\express" (
  echo.
  echo  First run - installing dependencies ^(this may take a minute^)...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [X] npm install failed. Check your internet connection and try again.
    echo.
    pause
    exit /b 1
  )
)

REM ---- 3. start the server and open the browser ---------------------------
REM  By default the server only listens on this computer (127.0.0.1).
REM  Run  start-windows.bat --lan  to let other people on your network connect.
set BIND=127.0.0.1
if /i "%~1"=="--lan" set BIND=0.0.0.0
if "%BIND%"=="127.0.0.1" (
  echo  Privacy: the server will accept connections from THIS computer only.
) else (
  echo  WARNING: listening on all network interfaces - other machines on your
  echo           network can reach this app. Use only on a trusted network.
)
echo.
echo  Starting the server on http://localhost:4000
echo  Sign in with  priya.nair@resourceplanning.io  /  Super@12345
echo.
echo  Press Ctrl+C in this window to stop the server.
echo.

start "" /b cmd /c "timeout /t 4 >nul & start http://localhost:4000"

set HOST=%BIND%
call npm start
echo.
echo  Server stopped.
pause
endlocal

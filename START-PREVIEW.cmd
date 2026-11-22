@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Resource Planning - Guided Ask preview
pushd "%~dp0" || exit /b 1
if not exist "server\guide-review.js" goto :incomplete
if not exist "public\js\views\crm-guide.js" goto :incomplete
if not exist "package-lock.json" goto :incomplete

rem Keep this preview off the LAN and independent of any existing install.
set "HOST=127.0.0.1"
set "PORT=4110"
set "ARENA_PREVIEW="
set "DATA_DIR=%CD%\data"
set "DB_FILE=%DATA_DIR%\guided-preview.db"

echo Resource Planning - Guided Ask preview
echo Preview URL: http://localhost:4110
echo.
where node >nul 2>nul || goto :node
where npm.cmd >nul 2>nul || goto :node
node --disable-warning=ExperimentalWarning -e "require('node:sqlite')" >nul 2>nul || goto :node
if not exist "node_modules\express\package.json" goto :install
if not exist "node_modules\exceljs\package.json" goto :install
goto :run

:install
echo Installing app dependencies for this preview. Internet is needed once.
call npm.cmd ci --omit=dev --ignore-scripts --no-fund --no-audit
if errorlevel 1 goto :failed

:run
if /i "%~1"=="--workbook" (
  node --disable-warning=ExperimentalWarning scripts\prepare-workbook-preview.js
  if errorlevel 1 goto :failed
)
rem A completed workbook preview stays active on ordinary restarts. Its original
rem sibling is the rollback copy. Never move/delete live SQLite or WAL files.
if exist "%DATA_DIR%\workbook-preview\" (
  if not exist "%DATA_DIR%\workbook-preview\guided-preview.db" goto :workbookIncomplete
  set "DB_FILE=%DATA_DIR%\workbook-preview\guided-preview.db"
)
echo Active preview database: "%DB_FILE%"
echo.
echo When the server says it is running, open http://localhost:4110 in Chrome or Edge.
echo Leave this window open while testing. Press Ctrl+C here to stop the preview.
call npm.cmd start
if errorlevel 1 goto :failed
popd
exit /b 0

:node
echo A Node.js LTS installation with built-in SQLite and npm is needed.
echo Install Node.js 24 LTS or use a supported Node.js 22 LTS, then reopen this launcher.
goto :failed
:workbookIncomplete
echo Incomplete data\workbook-preview folder. Stop the preview and move that folder aside.
goto :failed
:incomplete
echo This checkout is incomplete. Use the full guided Ask branch or extract the entire preview ZIP.
:failed
echo.
echo The preview could not start. Read the error above.
echo If it says EADDRINUSE, port 4110 is already occupied.
pause
popd
exit /b 1

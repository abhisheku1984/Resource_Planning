@echo off
REM Runs the automated test suite on Windows.
setlocal
cd /d "%~dp0"
echo Running Resource Planning tests...
call npm test
echo.
pause
endlocal

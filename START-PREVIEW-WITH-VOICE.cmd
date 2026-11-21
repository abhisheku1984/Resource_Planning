@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0START-PREVIEW.cmd" --voice
exit /b %ERRORLEVEL%

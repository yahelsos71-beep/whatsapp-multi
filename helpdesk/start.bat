@echo off
title WhatsApp Helpdesk server - do not close
cd /d "%~dp0"
:loop
"%~dp0node\node.exe" server.js
if %errorlevel%==10 goto running
echo Server stopped (code %errorlevel%) - restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
:running
echo The helpdesk server is already running. Opening the browser...
start "" http://localhost:8080
timeout /t 5 >nul

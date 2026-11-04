@echo off
rem Run as administrator: starts the helpdesk server automatically when the Windows server boots
schtasks /Create /TN "WhatsApp Helpdesk" /TR "\"%~dp0start.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 goto err
schtasks /Run /TN "WhatsApp Helpdesk"
echo.
echo ===== OK - the server will start automatically on every boot =====
goto end
:err
echo.
echo ===== ERROR - right-click this file and choose Run as administrator =====
:end
pause

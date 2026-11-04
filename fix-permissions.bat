@echo off
echo.
echo  Giving all users access to the WhatsApp Multi folder ...
echo.
icacls "D:\kc\chaim\WhatsApp-Multi-Windows (1)" /grant *S-1-5-32-545:(OI)(CI)M
if errorlevel 1 goto err
echo.
echo  ===== OK - DONE =====
goto end
:err
echo.
echo  ===== ERROR - right-click the file and choose Run as administrator =====
:end
echo.
pause

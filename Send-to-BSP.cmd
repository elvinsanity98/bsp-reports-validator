@echo off
rem Opens the validator page with "Send to the BSP" buttons. Asks for the certificate password.
cd /d "%~dp0"
node submit.js ui
echo.
pause

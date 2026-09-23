@echo off
title Scaffold Yard
set "APP=C:\Users\tehai\OneDrive\Documents\ChatGPT\scaffold\SCAFFOLD_YARD_V1"
set "URL=http://127.0.0.1:3000/"

curl -s -o nul --max-time 2 %URL%health && goto open
wscript "%APP%\scripts\start-server-hidden.vbs"
for /l %%i in (1,1,40) do (
  curl -s -o nul --max-time 1 %URL%health && goto open
  timeout /t 1 /nobreak >nul
)
echo The Scaffold Yard server did not start. Details: %TEMP%\scaffold-yard.log
pause
exit /b 1

:open
rem Open as its own app window when Edge is available, otherwise in the default browser.
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (start "" "%EDGE%" --app=%URL%) else (start "" %URL%)
exit /b 0

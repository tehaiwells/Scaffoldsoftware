@echo off
title Scaffold Yard
rem The project folder is wherever this repo was cloned: the parent of this scripts folder.
for %%I in ("%~dp0..") do set "APP=%%~fI"
set "URL=http://127.0.0.1:3000/"
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

rem Server already running? Just open the app. (-f: while it is still starting it answers "not ready yet".)
curl -sf -o nul --max-time 2 %URL%health && goto open

rem Start the server in its own minimised window (close that window to stop it, e.g. after changing code in src/).
rem It listens on this PC only. Phones on the same Wi-Fi can open it only after the owner switches that on in Account; the server reads it when it starts.
start "Scaffold Yard server" /min cmd /k "cd /d "%APP%" && "%NODE%" src\server.js"
for /l %%i in (1,1,40) do (
  curl -sf -o nul --max-time 1 %URL%health && goto open
  timeout /t 1 /nobreak >nul
)
echo The Scaffold Yard server did not start. See the "Scaffold Yard server" window for the error.
pause
exit /b 1

:open
rem Open as its own app window when Edge is available, otherwise in the default browser.
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (start "" "%EDGE%" --app=%URL%) else (start "" %URL%)
exit /b 0

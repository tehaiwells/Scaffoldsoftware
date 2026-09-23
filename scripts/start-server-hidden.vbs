' Starts the Scaffold Yard server with no visible window. Used at Windows logon and by the desktop launcher.
Set sh = CreateObject("WScript.Shell")
app = "C:\Users\tehai\OneDrive\Documents\ChatGPT\scaffold\SCAFFOLD_YARD_V1"
node = "C:\Program Files\nodejs\node.exe"
sh.Run "cmd.exe /c cd /d """ & app & """ && set HOST=0.0.0.0 && """ & node & """ src\server.js > ""%TEMP%\scaffold-yard.log"" 2>&1", 0, False

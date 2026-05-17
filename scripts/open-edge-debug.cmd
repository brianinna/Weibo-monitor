@echo off
setlocal
set PORT=18788
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" set EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" (
  echo Edge not found.
  exit /b 1
)
start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%LOCALAPPDATA%\Microsoft\Edge\User Data" --profile-directory=Default "https://weibo.com/"

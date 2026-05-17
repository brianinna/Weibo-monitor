@echo off
setlocal
set PORT=18788
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" (
  echo Chrome not found.
  exit /b 1
)
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data" --profile-directory=Default "https://weibo.com/"

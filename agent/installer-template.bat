@echo off
title Lecture Room agent setup
set "DIR=%LOCALAPPDATA%\MCSCMS"
mkdir "%DIR%" 2>nul
set "PY="
for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY (echo %%i| find /i "WindowsApps" >nul || set "PY=%%i")
if not defined PY for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY for %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*" "%LOCALAPPDATA%\Python\pythoncore-*" "C:\Python3*" "%ProgramFiles%\Python3*") do for %%f in ("%%~d\python.exe") do if exist "%%~f" set "PY=%%~f"
if not defined PY (echo Python was not found. Install Python 3.10 or newer from python.org, tick Add python.exe to PATH, then run this file again. & pause & exit /b 1)
for %%i in ("%PY%") do set "PYDIR=%%~dpi"
set "PYW=%PYDIR%pythonw.exe"
echo Using Python at %PY%
echo Downloading the agent...
curl -fsS -o "%DIR%\agent.py" "{{SCHEME}}://{{HOST}}/agent.py?key={{KEY}}" || (echo Could not reach the server at {{HOST}}. Check the network and try again. & pause & exit /b 1)
> "%DIR%\config.json" echo {"server":"{{WSSCHEME}}://{{HOST}}","key":"{{KEY}}"}
echo Installing components, please wait...
"%PY%" -m pip install --quiet --disable-pip-version-check websockets mss pillow pywin32 || (echo Component installation failed. & pause & exit /b 1)
taskkill /f /im pythonw.exe >nul 2>&1
echo Testing the connection to the server...
"%PY%" "%DIR%\agent.py" --check
if errorlevel 1 (echo. & echo The test above found a problem. The agent is still installed and keeps retrying, but this room will show Offline until it is fixed. & echo Details are written to %DIR%\agent.log & echo.)
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\MCSCMS-Agent.vbs" echo CreateObject("WScript.Shell").Run """%PYW%"" ""%DIR%\agent.py""", 0, False
start "" "%PYW%" "%DIR%\agent.py"
> "%USERPROFILE%\Desktop\Lecture Room Login.url" echo [InternetShortcut]
>> "%USERPROFILE%\Desktop\Lecture Room Login.url" echo URL={{SCHEME}}://{{HOST}}/
echo.
echo Done. The agent is running and will start automatically at every sign-in.
echo A shortcut named Lecture Room Login was added to the desktop. Faculty sign in with it.
echo This lecture room will show as Online on the dashboard in a few seconds.
echo If it does not, open %DIR%\agent.log or run:  "%PY%" "%DIR%\agent.py" --check
echo.
pause

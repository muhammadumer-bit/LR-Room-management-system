@echo off
title Lecture Room VNC setup
rem Installs TightVNC as a Windows service for this lecture room (if it is not there yet), ALWAYS sets its password to the one MCSCMS uses,
rem and opens its port only to the MCSCMS server. Safe to run again at any time (it repairs a wrong password).
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
set "DIR=%TEMP%\MCSCMS-VNC"
mkdir "%DIR%" 2>nul

sc query tvnserver >nul 2>&1
if not errorlevel 1 (
  echo TightVNC is already installed on this PC - it will only be re-configured.
  goto configure
)

echo Downloading TightVNC from the MCSCMS server...
curl -fsS -o "%DIR%\tightvnc.msi" "{{SCHEME}}://{{HOST}}/vnc-setup.msi?key={{KEY}}" || (echo Could not download the TightVNC installer from {{HOST}}. Ask the administrator to put tightvnc.msi in the server's agent\vnc folder. & pause & exit /b 1)
echo Installing TightVNC Server as a service...
msiexec /i "%DIR%\tightvnc.msi" /quiet /norestart ADDLOCAL=Server SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=0 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD={{VNCPASS}} SET_USECONTROLAUTHENTICATION=1 VALUE_OF_USECONTROLAUTHENTICATION=1 SET_CONTROLPASSWORD=1 VALUE_OF_CONTROLPASSWORD={{CTLPASS}}
if errorlevel 1 (echo TightVNC installation failed. & pause & exit /b 1)

:configure
echo Setting the VNC password and port...
net stop tvnserver >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $fk=[byte[]](23,82,107,6,35,78,88,7); $rk=[byte[]]($fk | ForEach-Object { $b=$_; $r=0; for($i=0;$i -lt 8;$i++){ if(($b -band (1 -shl $i)) -ne 0){ $r=$r -bor (1 -shl (7-$i)) } }; [byte]$r }); $pw=[byte[]]::new(8); $t=[Text.Encoding]::ASCII.GetBytes('{{VNCPASS}}'); [Array]::Copy($t,$pw,[Math]::Min(8,$t.Length)); $d=[Security.Cryptography.DES]::Create(); $d.Mode='ECB'; $d.Padding='None'; $d.Key=$rk; $enc=$d.CreateEncryptor().TransformFinalBlock($pw,0,8); $keys=@('HKLM:\SOFTWARE\TightVNC\Server','HKLM:\SOFTWARE\WOW6432Node\TightVNC\Server') | Where-Object { Test-Path $_ }; if(-not $keys){ $null=New-Item -Path 'HKLM:\SOFTWARE\TightVNC\Server' -Force; $keys=@('HKLM:\SOFTWARE\TightVNC\Server') }; foreach($k in $keys){ Set-ItemProperty -Path $k -Name Password -Type Binary -Value $enc; Set-ItemProperty -Path $k -Name UseVncAuthentication -Type DWord -Value 1; Set-ItemProperty -Path $k -Name AcceptRfbConnections -Type DWord -Value 1; Set-ItemProperty -Path $k -Name RfbPort -Type DWord -Value {{PORT}}; Set-ItemProperty -Path $k -Name LoopbackOnly -Type DWord -Value 0 }"
if errorlevel 1 (echo Could not set the VNC password. Run this file as administrator. & pause & exit /b 1)

echo Opening port {{PORT}} for the MCSCMS server only ({{ALLOW}})...
netsh advfirewall firewall delete rule name="MCSCMS VNC" >nul 2>&1
netsh advfirewall firewall add rule name="MCSCMS VNC" dir=in action=allow protocol=TCP localport={{PORT}} remoteip={{ALLOW}} profile=any >nul
rem Starting the service fresh also clears TightVNC's temporary block after repeated wrong passwords.
net start tvnserver
echo.
echo Done. In a few seconds the Lecture rooms tab shows VNC as ready for this room.
echo.
pause

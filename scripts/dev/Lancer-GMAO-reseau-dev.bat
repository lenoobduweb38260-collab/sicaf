@echo off
rem =====================================================================
rem  GMAO SICAF - lanceur en mode reseau local
rem  Comme Lancer-GMAO.bat, mais accessible depuis les autres postes du
rem  reseau : http://<ip-de-ce-poste>:8585/  (ouvrir dans Edge ou Chrome).
rem  Pensez a autoriser le port dans le pare-feu Windows si necessaire.
rem =====================================================================
setlocal
cd /d "%~dp0\..\.."
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js est introuvable. Installez la version LTS depuis https://nodejs.org
  pause
  exit /b 1
)
if "%GMAO_PORT%"=="" set "GMAO_PORT=8585"
title GMAO SICAF - serveur reseau (ne pas fermer cette fenetre)
echo  GMAO SICAF - mode reseau, port %GMAO_PORT%
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo  Accessible sur http://%%a:%GMAO_PORT%/
node server\index.js --host 0.0.0.0 --port %GMAO_PORT% --open %*
pause

@echo off
rem =====================================================================
rem  GMAO SICAF - lanceur Windows 10/11
rem  Demarre le serveur local et ouvre l'application dans une fenetre
rem  Microsoft Edge en mode "application" (sans barre d'adresse).
rem  Pre-requis : Node.js (https://nodejs.org, version LTS).
rem =====================================================================
setlocal
cd /d "%~dp0\..\.."
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js est introuvable. Installez la version LTS depuis https://nodejs.org
  echo  puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

set "GMAO_PORT=%GMAO_PORT%"
if "%GMAO_PORT%"=="" set "GMAO_PORT=8585"

title GMAO SICAF - serveur (ne pas fermer cette fenetre)
echo.
echo  GMAO SICAF - demarrage sur http://127.0.0.1:%GMAO_PORT%/
echo  Laissez cette fenetre ouverte pendant l'utilisation. Ctrl+C pour arreter.
echo.
node server\index.js --port %GMAO_PORT% --open %*
pause

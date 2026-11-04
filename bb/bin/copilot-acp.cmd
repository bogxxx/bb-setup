@echo off
rem Windows shim for bb's Copilot ACP launcher; the logic is in copilot-acp.mjs.
rem install.ps1 copies this to %USERPROFILE%\.local\bin, which is on PATH, so
rem bb's provider-acp setting can use the bare command "copilot-acp" on every machine.
node "%USERPROFILE%\src\bb-setup\bb\bin\copilot-acp.mjs" %*
exit /b %ERRORLEVEL%

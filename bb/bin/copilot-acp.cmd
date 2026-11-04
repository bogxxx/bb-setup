@echo off
setlocal EnableExtensions

rem BB's GitHub Copilot provider. gh's active account is bogxxx, which has no
rem Copilot seat. Use the AkerBP account that has Copilot CLI enabled.
rem The token stays in this process; it is not printed or written to disk.

set "COPILOT_USER=bohdan-krechko-akerbp"
set "COPILOT_GITHUB_TOKEN="
for /f "usebackq delims=" %%T in (`gh auth token --user %COPILOT_USER% 2^>nul`) do set "COPILOT_GITHUB_TOKEN=%%T"
if not defined COPILOT_GITHUB_TOKEN (
  echo copilot-acp: could not read a GitHub token for %COPILOT_USER% 1>&2
  exit /b 1
)

set "GH_TOKEN=%COPILOT_GITHUB_TOKEN%"
set "GITHUB_TOKEN=%COPILOT_GITHUB_TOKEN%"
npx -y @github/copilot@1.0.105 --acp %*
exit /b %ERRORLEVEL%

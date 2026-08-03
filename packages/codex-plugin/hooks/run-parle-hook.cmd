@echo off
rem Parle Codex hook launcher for Windows. Mirrors run-parle-hook.sh: trusted
rem runtime discovery uses an explicit absolute override and fixed absolute
rem install locations, never PATH, and every failure fails open with {} so a
rem broken runtime can never block the host.
setlocal

if not defined PLUGIN_ROOT goto :noop

if defined PARLE_HOOK_RUNTIME (
  if exist "%PARLE_HOOK_RUNTIME%" (
    "%PARLE_HOOK_RUNTIME%" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
    goto :noop
  )
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
  goto :noop
)

if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  "%ProgramFiles(x86)%\nodejs\node.exe" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
  goto :noop
)

if exist "%LocalAppData%\Programs\nodejs\node.exe" (
  "%LocalAppData%\Programs\nodejs\node.exe" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
  goto :noop
)

:noop
echo {}
exit /b 0

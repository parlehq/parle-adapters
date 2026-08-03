@echo off
rem Parle Codex hook launcher for Windows. Mirrors run-parle-hook.sh: the
rem runtime comes from an explicit fully absolute override or fixed absolute
rem install locations, never PATH or the session cwd, and every failure fails
rem open with {} so a broken runtime can never block the host.
setlocal

if not defined PLUGIN_ROOT goto :noop
if not defined PARLE_HOOK_RUNTIME goto :fallbacks

set "PARLE_OVERRIDE=%PARLE_HOOK_RUNTIME%"
rem Accept only fully absolute overrides: UNC (\\server\share) or
rem drive-rooted (X:\ or X:/). Relative and drive-relative (X:name) values
rem would resolve against a hostile session cwd, so they fall through to the
rem fixed absolute install paths exactly like run-parle-hook.sh does.
if "%PARLE_OVERRIDE:~0,2%"=="\\" goto :override
if not "%PARLE_OVERRIDE:~1,1%"==":" goto :fallbacks
if "%PARLE_OVERRIDE:~2,1%"=="\" goto :override
if "%PARLE_OVERRIDE:~2,1%"=="/" goto :override
goto :fallbacks

:override
if not exist "%PARLE_OVERRIDE%" goto :fallbacks
"%PARLE_OVERRIDE%" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
goto :noop

:fallbacks
if exist "%ProgramFiles%\nodejs\node.exe" goto :programfiles
if exist "%ProgramFiles(x86)%\nodejs\node.exe" goto :programfilesx86
if exist "%LocalAppData%\Programs\nodejs\node.exe" goto :localappdata
goto :noop

:programfiles
"%ProgramFiles%\nodejs\node.exe" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
goto :noop

:programfilesx86
"%ProgramFiles(x86)%\nodejs\node.exe" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
goto :noop

:localappdata
"%LocalAppData%\Programs\nodejs\node.exe" "%PLUGIN_ROOT%\hooks\parle-hook.mjs" %* && exit /b 0
goto :noop

:noop
echo {}
exit /b 0

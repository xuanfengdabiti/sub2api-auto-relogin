@echo off
setlocal EnableExtensions

cd /d "%~dp0"

if /i "%~1"=="/?" goto :usage
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="--help" goto :usage

call :resolve_python
if errorlevel 1 goto :python_not_found

if "%~1"=="" (
  call :run_single 17373
  goto :eof
)

set "PORT_ARGS=%*"
set "PORT_ARGS=%PORT_ARGS:,= %"
set "PORT_ARGS=%PORT_ARGS:;= %"

for %%P in (%PORT_ARGS%) do (
  call :start_instance %%~P
)
goto :eof

:resolve_python
where py >nul 2>nul
if %errorlevel%==0 (
  set "PYTHON_EXE=py"
  set "PYTHON_ARGS=-3"
  exit /b 0
)

where python >nul 2>nul
if %errorlevel%==0 (
  set "PYTHON_EXE=python"
  set "PYTHON_ARGS="
  exit /b 0
)

exit /b 1

:run_single
"%PYTHON_EXE%" %PYTHON_ARGS% scripts\hotmail_helper.py --port %~1
exit /b %errorlevel%

:start_instance
start "Hotmail Helper %~1" cmd /k ""%PYTHON_EXE%" %PYTHON_ARGS% scripts\hotmail_helper.py --port %~1"
exit /b 0

:python_not_found
echo Python 3 not found. Please install Python 3.10+ and try again.
pause
exit /b 1

:usage
echo Usage:
echo   start-hotmail-helper.bat
echo   start-hotmail-helper.bat 17373
echo   start-hotmail-helper.bat 17373 17374 17375
echo   start-hotmail-helper.bat 17373,17374,17375
echo.
echo No arguments: start one helper on the default port 17373 in the current window.
echo One or more ports: launch one helper window per port.
exit /b 0

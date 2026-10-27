@echo off
chcp 936 >nul
rem 重启服务（改了 server.py / config.json / version.json 之后要用）。
rem 先停掉 8765 上的旧进程，等端口释放，再交给 start-server.bat 启动；
rem Python 查找、等待监听、打开页面都只保留在 start-server.bat 一处。
cd /d "%~dp0"

if not exist "start-server.bat" (
  echo 没找到 start-server.bat，请从项目根目录运行本脚本。
  pause
  exit /b 1
)

echo 正在停掉 8765 上的旧服务 ...
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":8765 " ^| findstr /i "LISTENING"') do (
  set "FOUND=1"
  echo   停掉 PID %%p
  taskkill /F /PID %%p >nul 2>&1
)
if not defined FOUND echo   8765 上没有正在运行的服务。

rem 等旧进程真正退出、端口释放（最多 10 秒）
set /a WAIT=0
:waitport
netstat -ano | findstr /c:":8765 " | findstr /i "LISTENING" >nul
if errorlevel 1 goto start
set /a WAIT+=1
if %WAIT% geq 10 goto portbusy
ping -n 2 127.0.0.1 >nul 2>&1
goto waitport

:portbusy
echo 端口 8765 仍被占用，旧服务可能没停掉。
echo 查看占用进程：netstat -ano ^| findstr :8765
pause
exit /b 1

:start
call "%~dp0start-server.bat"

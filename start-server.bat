@echo off
chcp 936 >nul
rem 启动「上图馆藏」本地服务，然后打开页面。
rem 打包版自带 runtime\python.exe，解压即用；源码目录没有 runtime 时，
rem 退回系统里的 py / python。
rem 默认监听 0.0.0.0 —— 手机同 WiFi 也能打开（设置面板里有二维码）。
rem 只想本机用：在命令行里跑 runtime\python.exe web\server.py --local
cd /d "%~dp0"

if not exist "web\server.py" (
  echo 没找到 web\server.py，请从项目根目录运行本脚本。
  pause
  exit /b 1
)

rem 找 Python：优先随包 runtime，其次 py -3，最后 python；并验证 3.9+
set "PYEXE="
set "PYARGS="
if exist "%~dp0runtime\python.exe" set "PYEXE=%~dp0runtime\python.exe"
if defined PYEXE goto pyready

where py >nul 2>&1
if errorlevel 1 goto trypython
py -3 -c "import sys; assert sys.hexversion >= 0x03090000" >nul 2>&1
if errorlevel 1 goto trypython
set "PYEXE=py"
set "PYARGS=-3"
goto pyready

:trypython
where python >nul 2>&1
if errorlevel 1 goto nopython
python -c "import sys; assert sys.hexversion >= 0x03090000" >nul 2>&1
if errorlevel 1 goto nopython
set "PYEXE=python"
goto pyready

:nopython
echo 没找到可用的 Python 3.9+，也没有随包携带的 runtime\python.exe。
echo 源码目录请安装 Python 3.9 或更高版本：
echo   https://www.python.org/downloads/
echo 安装时务必勾选 "Add python.exe to PATH"。
echo.
pause
exit /b 1

:pyready
rem 8765 上已经有服务就直接用它，不再起第二个（两个进程会抢同一个端口）
netstat -ano | findstr /c:":8765 " | findstr /i "LISTENING" >nul
if not errorlevel 1 goto open

rem --no-open：由下面统一开页面，避免服务自己再开一个标签页
start "" /min "%PYEXE%" %PYARGS% "web\server.py" --port 8765 --no-open

rem 等端口真正开始监听再开页面，避免浏览器先报「无法访问」
set /a WAIT=0
:wait
netstat -ano | findstr /c:":8765 " | findstr /i "LISTENING" >nul
if not errorlevel 1 goto open
set /a WAIT+=1
if %WAIT% geq 15 goto failed
ping -n 2 127.0.0.1 >nul 2>&1
goto wait

:failed
echo 服务没有在 15 秒内启动，浏览器未打开。
echo 请直接在本目录运行下面的命令查看报错：
echo   "%PYEXE%" %PYARGS% web\server.py --port 8765 --no-open
pause
exit /b 1

:open
start "" "http://127.0.0.1:8765/"

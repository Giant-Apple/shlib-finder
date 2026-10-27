#!/usr/bin/env bash
# macOS / Linux 启动脚本，行为对齐 start-server.bat：
# 找一个 Python 3.9+，把服务起在 8765，再打开浏览器。
# Windows 上请改用 start-server.bat。
set -u
cd "$(dirname "$0")" || exit 1

PORT=8765

if [ ! -f web/server.py ]; then
  echo "没找到 web/server.py，请在项目根目录运行本脚本。"
  exit 1
fi

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 &&
     "$c" -c 'import sys; raise SystemExit(0 if sys.hexversion >= 0x03090000 else 1)' >/dev/null 2>&1; then
    PY="$c"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "没找到 Python 3.9 或更高版本。"
  echo "  macOS：brew install python3，或到 https://www.python.org/downloads/ 下载"
  echo "  Debian/Ubuntu：sudo apt install python3"
  echo "  Fedora：sudo dnf install python3"
  exit 1
fi

# 用 Python 直接连一下来判断端口有没有人听：lsof/ss 在 Git Bash 下没有，
# Windows 的 netstat 又不认 -ltn，只有这条路子在三个平台都靠得住。
port_busy() {
  "$PY" - "$PORT" >/dev/null 2>&1 <<'PYEOF'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
raise SystemExit(s.connect_ex(('127.0.0.1', int(sys.argv[1]))))
PYEOF
}

open_browser() {
  url="http://127.0.0.1:$PORT/"
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1
  else
    echo "请手动打开 $url"
  fi
}

if port_busy; then
  echo "$PORT 端口已有服务在跑，直接打开浏览器。"
  open_browser
  exit 0
fi

# 日志留在 data/ 里，起来以后出问题有地方看（自动重启也写同一个文件）
mkdir -p data
nohup "$PY" web/server.py --port "$PORT" --no-open >>data/server.log 2>&1 &
PID=$!
echo "服务已启动（PID $PID），日志：data/server.log"
echo "停止：kill $PID（或者用 ./restart-server.sh 重启）"

for _ in $(seq 1 30); do
  if port_busy; then
    open_browser
    exit 0
  fi
  sleep 0.5
done
echo "等了 15 秒端口还没起来，可能启动失败了。直接运行下面这条看报错："
echo "  $PY web/server.py --port $PORT --no-open"
exit 1
#!/usr/bin/env bash
# 重启服务（改过 server.py / config.json / version.json 之后用）：
# 停掉 8765 上的旧进程，等端口释放，再交给 start-server.sh。
# Windows 上请改用 restart-server.bat。
set -u
cd "$(dirname "$0")" || exit 1

PORT=8765

if [ ! -f start-server.sh ]; then
  echo "没找到 start-server.sh，请在项目根目录运行本脚本。"
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
  echo "没找到 Python 3.9 或更高版本，直接运行 ./start-server.sh 会给出安装指引。"
  exit 1
fi

# 和 start-server.sh 里同一个探针：连一下端口，连得上就算有人听。
port_busy() {
  "$PY" - "$PORT" >/dev/null 2>&1 <<'PYEOF'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
raise SystemExit(s.connect_ex(('127.0.0.1', int(sys.argv[1]))))
PYEOF
}

listener_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$PORT/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$'
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | cut -d= -f2
  else
    netstat -ltnp 2>/dev/null | grep ":$PORT " | awk '{print $NF}' | cut -d/ -f1 | grep -E '^[0-9]+$'
  fi
}

echo "正在停掉 $PORT 上的旧服务 ..."
PIDS="$(listener_pids || true)"
if [ -z "$PIDS" ]; then
  if port_busy; then
    # 端口确实有人听，但本环境查不出进程号（Git Bash 下没有 lsof/fuser/ss）。
    # 与其说「没有正在跑的服务」把人骗过去，不如直接说清楚。
    echo "  $PORT 上确实有服务在跑，但在这个环境里查不到它的进程号。"
    echo "  Windows 上请改用 restart-server.bat；其他环境请手动停掉后重试。"
    exit 1
  fi
  echo "  $PORT 上没有正在跑的服务。"
else
  for p in $PIDS; do
    echo "  停掉 PID $p"
    kill "$p" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do
    listener_pids | grep -q . || break
    sleep 0.5
  done
  if listener_pids | grep -q .; then
    echo "端口 $PORT 还被占着，可能没停干净。"
    echo "查看占用：lsof -nP -iTCP:$PORT -sTCP:LISTEN"
    exit 1
  fi
fi

exec ./start-server.sh
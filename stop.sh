#!/usr/bin/env bash
# stop.sh — 停止所有桌宠相关服务

GRN='\033[0;32m'; YLW='\033[1;33m'; BLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "  ${GRN}✓${NC}  $*"; }
warn() { echo -e "  ${YLW}⚠${NC}  $*"; }

echo ""
echo -e "  ${BLD}🛑  停止桌宠服务${NC}"
echo ""

stop_port() {
  local name="$1" port="$2"
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    ok "$name :$port 已停止"
  else
    warn "$name :$port 未在运行"
  fi
}

stop_port "规则引擎" 4100
stop_port "Hermes AI" 8642

# 关闭 pet.app（macOS）
if osascript -e 'quit app "pet"' 2>/dev/null; then
  ok "pet.app 已关闭"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -f "$DIR/.logs/pids.txt"

echo ""
echo "  完成。再见喵～"
echo ""

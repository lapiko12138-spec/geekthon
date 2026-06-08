#!/usr/bin/env bash
# start.sh — 麦麦桌宠一键启动器
# 用法：./start.sh [--dev]
#   默认：使用已构建的 .app（若存在），否则自动进入开发模式
#   --dev：强制以 pnpm tauri dev 运行（热重载，首次编译需 3-5 分钟）

set -uo pipefail

# ── 颜色 ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
CYN='\033[0;36m'; BLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$DIR/.logs"
mkdir -p "$LOGS"

DEV_MODE=0
[[ "${1:-}" == "--dev" ]] && DEV_MODE=1

# ── 输出工具 ──────────────────────────────────────────────────────────────────
ok()   { echo -e "  ${GRN}✓${NC}  $*"; }
warn() { echo -e "  ${YLW}⚠${NC}  $*"; }
err()  { echo -e "  ${RED}✗${NC}  $*" >&2; }
info() { echo -e "  ${CYN}→${NC}  $*"; }
die()  { err "$*"; echo ""; exit 1; }
sep()  { echo -e "  ${DIM}────────────────────────────────────────${NC}"; }
hdr()  { echo -e "\n  ${BLD}$*${NC}"; }

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo ""
echo -e "  ${BLD}🐱  麦麦桌宠 — 一键启动器${NC}"
echo -e "  ${DIM}ver $(date +%Y-%m-%d)${NC}"
sep; echo ""

# ── [1/4] 检查运行环境 ────────────────────────────────────────────────────────
hdr "[1/4] 检查运行环境"

MISSING=0
check_cmd() {
  local cmd="$1" hint="${2:-}"
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd"
  else
    err "$cmd 未安装"
    [[ -n "$hint" ]] && warn "    安装：$hint"
    MISSING=1
  fi
}

check_cmd node  "https://nodejs.org"
check_cmd pnpm  "npm install -g pnpm"
check_cmd cargo "https://rustup.rs  （Tauri 需要 Rust）"

# tsx：优先用本地 node_modules/.bin/tsx（devDep），否则找全局
TSX_BIN="$DIR/node_modules/.bin/tsx"
if [[ -x "$TSX_BIN" ]]; then
  ok "tsx  (本地)"
elif command -v tsx &>/dev/null; then
  TSX_BIN="$(command -v tsx)"
  ok "tsx  (全局)"
else
  err "tsx 未找到"
  warn "    安装：npm install -g tsx  或先跑 npm install"
  MISSING=1
fi

[[ $MISSING -eq 1 ]] && { echo ""; die "请先安装缺失依赖，再重新运行 ./start.sh"; }

# ── [2/4] 配置文件检查 ────────────────────────────────────────────────────────
hdr "[2/4] 配置文件"

PET_ENV="$DIR/pet/.env"
PET_EXAMPLE="$DIR/pet/.env.example"

if [[ ! -f "$PET_ENV" ]]; then
  if [[ -f "$PET_EXAMPLE" ]]; then
    cp "$PET_EXAMPLE" "$PET_ENV"
    echo ""
    warn "pet/.env 不存在，已从模板创建："
    echo -e "  ${CYN}$PET_ENV${NC}"
    echo ""
    echo -e "  ${BLD}请填写以下配置（必填）：${NC}"
    echo "    VITE_HERMES_KEY      — Hermes API 密钥"
    echo ""
    echo -e "  ${BLD}可选（填了才有飞书功能）：${NC}"
    echo "    VITE_FEISHU_CHAT_ID       — 飞书机器人会话 openChatId"
    echo "    VITE_HERMES_SESSION_KEY   — 你的飞书 open_id"
    echo ""
    read -rp "  编辑好后按 Enter 继续，或 Ctrl-C 退出先去编辑 ..."
    echo ""
  else
    warn "未找到 pet/.env，将使用代码内默认值（聊天功能受限）"
  fi
else
  ok "pet/.env"
fi

# 检查 Hermes 的 API Server 配置
HERMES_ENV="$HOME/.hermes/.env"
if command -v hermes &>/dev/null; then
  if [[ -f "$HERMES_ENV" ]] && grep -q "^API_SERVER_ENABLED=true" "$HERMES_ENV" 2>/dev/null; then
    ok "Hermes API Server 已启用"
  else
    warn "Hermes API Server 未启用（聊天功能不可用）"
    warn "请在 $HERMES_ENV 中添加："
    echo ""
    echo "    API_SERVER_ENABLED=true"
    echo "    API_SERVER_KEY=<与 pet/.env VITE_HERMES_KEY 相同>"
    echo ""
  fi
fi

# 安装 npm 依赖（若 node_modules 缺失）
if [[ ! -d "$DIR/node_modules" ]]; then
  info "安装根目录依赖（npm install）…"
  cd "$DIR" && npm install --silent 2>&1 | tail -3
  ok "根目录依赖已就绪"
fi
if [[ ! -d "$DIR/pet/node_modules" ]]; then
  info "安装 pet 依赖（pnpm install）…"
  cd "$DIR/pet" && pnpm install --silent 2>&1 | tail -3
  ok "pet 依赖已就绪"
fi

# ── [3/4] 后端服务 ────────────────────────────────────────────────────────────
hdr "[3/4] 启动后端服务"

: > "$LOGS/pids.txt"   # 清空 PID 记录

port_live() { lsof -ti :"$1" &>/dev/null; }

start_service() {
  local name="$1" port="$2" cmd="$3" log="$4"
  if port_live "$port"; then
    ok "$name :$port — 已在运行（跳过重启）"
    return 0
  fi
  info "启动 $name :$port …"
  eval "$cmd" &>"$log" &
  local pid=$!
  # 等待最多 3 秒，确认端口确实监听
  for _ in 1 2 3; do
    sleep 1
    port_live "$port" && break
  done
  if kill -0 "$pid" 2>/dev/null && port_live "$port"; then
    ok "$name :$port — 已启动 (PID $pid)"
    echo "$pid" >> "$LOGS/pids.txt"
    return 0
  else
    err "$name 启动失败，查看日志：$log"
    kill "$pid" 2>/dev/null || true
    return 1
  fi
}

cd "$DIR"
start_service "规则引擎(mock)" 4100 \
  "\"$TSX_BIN\" mock/server.ts" \
  "$LOGS/mock.log" || warn "规则引擎未能启动，宠物表情将停在默认状态"

if command -v hermes &>/dev/null; then
  start_service "Hermes AI 网关" 8642 \
    "hermes gateway" \
    "$LOGS/hermes.log" || warn "Hermes 未能启动，聊天功能不可用（可改用飞书）"
else
  warn "hermes CLI 未安装 → 聊天功能不可用"
  warn "安装与配置方式见项目 README"
fi

# ── [4/4] 桌宠 App ────────────────────────────────────────────────────────────
hdr "[4/4] 启动桌宠"

APP_BUNDLE="$DIR/pet/src-tauri/target/release/bundle/macos/pet.app"
TAURI_PID=""

if [[ $DEV_MODE -eq 0 ]] && [[ -d "$APP_BUNDLE" ]]; then
  info "找到已构建的 .app，直接打开（传 --dev 强制开发模式）"
  open "$APP_BUNDLE"
  ok "pet.app 已启动"
else
  if [[ $DEV_MODE -eq 1 ]]; then
    info "开发模式（--dev）…"
  else
    info "未找到构建产物，以开发模式启动"
    warn "首次 Rust 编译需要 3-5 分钟，请耐心等待 ☕"
  fi
  cd "$DIR/pet"
  pnpm tauri dev &>"$LOGS/tauri-dev.log" &
  TAURI_PID=$!
  echo "$TAURI_PID" >> "$LOGS/pids.txt"
  ok "pnpm tauri dev 已在后台启动 (PID $TAURI_PID)"
  info "日志：$LOGS/tauri-dev.log"
fi

# ── 汇总 ──────────────────────────────────────────────────────────────────────
echo ""
sep
echo ""
ok  "全部服务已启动！"
echo ""
echo -e "  📊  规则引擎   ${DIM}http://localhost:4100${NC}"
port_live 8642 && echo -e "  🤖  Hermes AI  ${DIM}http://localhost:8642${NC}"
echo -e "  🐱  桌宠       已在桌面显示（透明窗口，拖到顺手的角落）"
echo ""
echo -e "  ${DIM}日志目录：$LOGS/${NC}"
echo -e "  ${DIM}停止所有：./stop.sh${NC}"
echo ""

# ── Ctrl-C 清理（仅当 tauri dev 模式才等待） ────────────────────────────────
if [[ -n "$TAURI_PID" ]]; then
  cleanup() {
    echo ""
    info "正在停止所有服务…"
    kill "$TAURI_PID" 2>/dev/null && ok "tauri dev 已停止"
    lsof -ti :4100 | xargs kill 2>/dev/null && ok "规则引擎已停止" || true
    lsof -ti :8642 | xargs kill 2>/dev/null && ok "Hermes 已停止" || true
  }
  trap cleanup EXIT INT TERM
  wait "$TAURI_PID"
fi

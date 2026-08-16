#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# deploy.sh — 一键部署脚本（默认 pm2 部署方式）
#
# 功能：
#   1. 拉取最新代码（git pull，可跳过）
#   2. 安装生产依赖（npm ci / npm install）
#   3. 清理旧实例（pm2 delete 旧 app，保留数据目录 data/）
#   4. 启动新实例（pm2 start ecosystem.config.cjs）
#   5. 保存进程列表（pm2 save）
#   6. 健康检查等待就绪（/api/health）
#
# 用法：
#   ./deploy.sh                 # 默认部署（git pull + 依赖 + pm2 重启）
#   ./deploy.sh --no-pull       # 跳过 git pull（本地直接部署）
#   ./deploy.sh --no-install    # 跳过依赖安装
#   ./deploy.sh --app NAME      # 指定 pm2 应用名（默认 video-downloader）
#   ./deploy.sh --port PORT     # 指定健康检查端口（默认 3456，读取 ecosystem）
#   ./deploy.sh --dry-run       # 演练模式：只打印将执行的命令，不执行
#   ./deploy.sh --help          # 显示帮助
#
# 环境变量：PM2_APP_NAME / DEPLOY_PORT 可替代 --app / --port
# ═══════════════════════════════════════════════════════════

set -euo pipefail

# ── 默认值 ─────────────────────────────────────────────
APP_NAME="${PM2_APP_NAME:-video-downloader}"
PORT="${DEPLOY_PORT:-3456}"
DO_PULL=1
DO_INSTALL=1
DRY_RUN=0
HEALTH_TRY=30      # 健康检查最大尝试次数
HEALTH_WAIT=2      # 每次尝试间隔（秒）

# ── 颜色输出 ───────────────────────────────────────────
C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
info()  { echo "${C_CYAN}[deploy]${C_RESET} $*"; }
ok()    { echo "${C_GREEN}[deploy] ✔ $*${C_RESET}"; }
warn()  { echo "${C_YELLOW}[deploy] ⚠ $*${C_RESET}"; }
err()   { echo "${C_RED}[deploy] ✘ $*${C_RESET}" >&2; }

# 解析 ecosystem.config.cjs 中的 PORT（若环境变量未覆盖）
parse_ecosystem_port() {
  if [ -n "${DEPLOY_PORT:-}" ]; then return 0; fi
  if [ -f "ecosystem.config.cjs" ]; then
    local p
    p="$(grep -oE 'PORT:\s*[0-9]+' ecosystem.config.cjs | head -1 | grep -oE '[0-9]+' || true)"
    if [ -n "$p" ]; then PORT="$p"; fi
  fi
}

# ── 参数解析 ───────────────────────────────────────────
usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull)    DO_PULL=0; shift ;;
    --no-install) DO_INSTALL=0; shift ;;
    --app)        APP_NAME="${2:?--app 需要参数}"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --help|-h)    usage ;;
    *) err "未知参数: $1（用 --help 查看用法）"; exit 2 ;;
  esac
done

# dry-run 时模拟执行
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "（演练）$*"
  else
    "$@"
  fi
}

# ── 前置检查 ───────────────────────────────────────────
cd "$(dirname "$0")"
parse_ecosystem_port
info "应用: ${APP_NAME} | 端口: ${PORT} | 目录: $(pwd)"

for cmd in node npm pm2; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "缺少依赖命令: $cmd（请先安装 node/npm/pm2）"; exit 1
  fi
done
ok "环境依赖检查通过（node=$(node -v 2>/dev/null || echo '?'), pm2=$(pm2 -v 2>/dev/null || echo '?')）"

# 确保日志目录
mkdir -p logs

# ── 1. 拉取最新代码 ────────────────────────────────────
if [ "$DO_PULL" -eq 1 ]; then
  if [ -d .git ]; then
    info "拉取最新代码…"
    run git pull --ff-only || { warn "git pull 失败（可能无远程/本地领先），继续部署"; }
    ok "代码已更新"
  else
    warn "非 git 仓库，跳过 git pull"
  fi
else
  info "跳过 git pull（--no-pull）"
fi

# ── 2. 安装生产依赖 ────────────────────────────────────
if [ "$DO_INSTALL" -eq 1 ]; then
  info "安装生产依赖…"
  if [ -f package-lock.json ]; then
    run npm ci --omit=dev || run npm install --omit=dev
  else
    run npm install --omit=dev
  fi
  ok "依赖安装完成"
else
  info "跳过依赖安装（--no-install）"
fi

# ── 3. 清理旧实例 ──────────────────────────────────────
info "清理旧实例 ${APP_NAME}…"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  run pm2 delete "$APP_NAME"
  ok "旧实例已清理（数据目录 data/ 保留）"
else
  info "未发现旧实例，跳过清理"
fi

# 清理非 pm2 托管的裸进程（如历史 nohup 启动的 node src/index.js），
# 防止旧进程占用端口导致新实例 EADDRINUSE 崩溃
info "清理非 pm2 裸进程（node src/index.js）…"
if command -v pkill >/dev/null 2>&1; then
  run pkill -f "node src/index.js" || true
  sleep 1
  ok "裸进程清理完成（如有）"
else
  info "无 pkill，跳过裸进程清理（请手动确认 3456 端口空闲）"
fi

# ── 4. 启动新实例 ──────────────────────────────────────
info "启动新实例（pm2 start ecosystem.config.cjs）…"
# ⚠️ 显式固定部署端口：本项目默认 3456（parse_ecosystem_port 已从
# ecosystem.config.cjs 解析）。防止外部 shell 环境变量 PORT 污染
# （如 PORT=52134）覆盖端口，导致 EADDRINUSE 崩溃。
export PORT="${PORT}"
run pm2 start ecosystem.config.cjs
run pm2 save
ok "pm2 进程列表已保存"

# ── 5. 健康检查等待就绪 ────────────────────────────────
info "健康检查 http://localhost:${PORT}/api/health …"
if [ "$DRY_RUN" -eq 1 ]; then
  info "（演练）跳过实际健康检查"
else
  ready=0
  for i in $(seq 1 "$HEALTH_TRY"); do
    if curl -fsS -m 3 "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep "$HEALTH_WAIT"
  done
  if [ "$ready" -eq 1 ]; then
    ok "服务已就绪（第 ${i} 次尝试）"
  else
    err "健康检查超时（${HEALTH_TRY} 次 × ${HEALTH_WAIT}s）— 请查看日志：pm2 logs ${APP_NAME} --lines 50"
    exit 1
  fi
fi

# ── 完成 ───────────────────────────────────────────────
echo
ok "部署完成！"
echo "  进程状态:  pm2 status ${APP_NAME}"
echo "  实时日志:  pm2 logs ${APP_NAME} --lines 50"
echo "  服务地址:  http://localhost:${PORT}"
echo "  数据目录:  $(pwd)/data（部署不触碰）"
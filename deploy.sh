#!/usr/bin/env bash
# ============================================================================
# WebRTC 信令 + TURN 服务 · 部署脚本
#
# 用法：
#   ./deploy.sh          构建并启动
#   ./deploy.sh logs     跟踪日志
#   ./deploy.sh status   查看状态与健康检查
#   ./deploy.sh verify   验证信令与 TURN 是否就绪
#   ./deploy.sh update   重新构建（不使用缓存）并重启
#   ./deploy.sh down     停止并移除容器
#
# 前置：已安装 Docker 与 Docker Compose v2（docker compose 子命令可用）。
#
# ---------------------------------------------------------------------------
# 关于构建方式
#
# 默认直接用 GitHub 仓库作构建上下文（compose 里的 context 字段），
# 服务器上无需克隆代码。
#
# 但 Docker 对「git 上下文 + 子目录 Dockerfile」的支持在不同版本间有差异。
# 若该方式失败，本脚本会**自动降级**为浅克隆到 .build/ 后本地构建 ——
# 这条路径在所有 Docker 版本上都可用。
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.yml"
OVERRIDE_FILE=".build/docker-compose.local.yml"
ENV_FILE=".env"
BUILD_DIR=".build"
REPO_URL="https://github.com/imtwa/rtc-server.git"
REPO_BRANCH="master"

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
    echo "[错误] 未找到 docker，请先安装：curl -fsSL https://get.docker.com | sh" >&2
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "[错误] 未找到 docker compose（v2）。请升级 Docker 到 20.10+。" >&2
    exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "[错误] 缺少 $ENV_FILE" >&2
    echo "       请先执行：./init-env.sh" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 环境变量校验
#
# 带着空值启动不会报错，只会让客户端「连不上」且无从排查 ——
# 因此这里提前拦住。
# ---------------------------------------------------------------------------

env_value() {
    grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true
}

check_env() {
    local missing=0
    for key in TURN_PUBLIC_IP TURN_DOMAIN TURN_SECRET; do
        if [ -z "$(env_value "$key")" ]; then
            echo "[错误] $ENV_FILE 中 $key 为空" >&2
            missing=1
        fi
    done
    if [ "$missing" -ne 0 ]; then
        echo "" >&2
        echo "  TURN_PUBLIC_IP  服务器公网 IP（不是域名、不是内网 IP）" >&2
        echo "  TURN_DOMAIN     下发给客户端的 TURN 域名" >&2
        echo "  TURN_SECRET     长期密钥（./init-env.sh 会自动生成）" >&2
        echo "" >&2
        echo "  重新配置：./init-env.sh --force" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# 构建
#
# 先试 git 上下文（无需克隆）；失败则浅克隆后本地构建。
# ---------------------------------------------------------------------------

prepare_local_build() {
    echo "[构建] git 上下文方式不可用，降级为本地克隆构建"

    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"

    if ! command -v git >/dev/null 2>&1; then
        echo "[错误] 需要 git 才能降级构建，请先安装 git" >&2
        exit 1
    fi

    echo "[构建] 克隆 $REPO_URL（分支 $REPO_BRANCH，浅克隆）"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$BUILD_DIR/src"

    # 生成覆盖文件：把 context 指向本地克隆目录
    cat > "$OVERRIDE_FILE" <<EOF
# 本文件由 deploy.sh 自动生成，请勿手工编辑。
# 作用：把 compose 里的 git 上下文替换为本地克隆目录，
# 兼容不支持「git 上下文 + 子目录 Dockerfile」的 Docker 版本。
services:
    signaling:
        build:
            context: ./src
            dockerfile: signaling/Dockerfile
    coturn:
        build:
            context: ./src
            dockerfile: coturn/Dockerfile
EOF
}

build_images() {
    echo "[构建] 尝试 git 上下文直接构建（无需克隆）"

    if docker compose -f "$COMPOSE_FILE" build; then
        echo "[构建] 完成（git 上下文）"
        return 0
    fi

    echo ""
    echo "[构建] git 上下文方式失败，改用本地克隆"
    prepare_local_build

    if docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" build; then
        echo "[构建] 完成（本地克隆）"
        return 0
    fi

    echo "[错误] 两种构建方式均失败，请检查上方输出" >&2
    exit 1
}

# 根据是否存在覆盖文件，决定用哪套 compose 参数
compose_args() {
    if [ -f "$OVERRIDE_FILE" ]; then
        echo "-f $COMPOSE_FILE -f $OVERRIDE_FILE"
    else
        echo "-f $COMPOSE_FILE"
    fi
}

# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------

cmd_up() {
    check_env
    build_images

    echo "[部署] 启动服务"
    # shellcheck disable=SC2046
    docker compose $(compose_args) up -d

    echo "[部署] 等待服务就绪"
    sleep 5
    # shellcheck disable=SC2046
    docker compose $(compose_args) ps

    echo ""
    echo "[部署] 完成"
    echo "  查看日志：./deploy.sh logs"
    echo "  验证服务：./deploy.sh verify"
}

cmd_logs() {
    # shellcheck disable=SC2046
    docker compose $(compose_args) logs -f --tail=100
}

cmd_status() {
    # shellcheck disable=SC2046
    docker compose $(compose_args) ps
    echo ""
    echo "--- 信令服务健康检查 ---"
    if curl -fsS --max-time 5 http://127.0.0.1:17300/health 2>/dev/null; then
        echo ""
    else
        echo "信令服务未响应（可能仍在启动，或端口被占用）"
    fi
}

cmd_verify() {
    check_env

    local domain port
    domain=$(env_value TURN_DOMAIN)
    port=$(env_value TURN_PORT)
    port=${port:-34780}

    echo "=== 1. 信令服务健康检查 ==="
    local health
    health=$(curl -fsS --max-time 5 http://127.0.0.1:17300/health 2>/dev/null || echo "")
    if [ -z "$health" ]; then
        echo "[失败] 信令服务无响应"
        echo "       排查：./deploy.sh logs"
        exit 1
    fi
    echo "$health"

    echo ""
    echo "=== 2. ICE 配置（关键：必须含 turn: 地址）==="
    local ice
    ice=$(curl -fsS --max-time 5 http://127.0.0.1:17300/rtc-config 2>/dev/null || echo "")
    if [ -z "$ice" ]; then
        echo "[失败] /rtc-config 无响应"
        exit 1
    fi
    echo "$ice"

    echo ""
    if echo "$ice" | grep -q '"turn:'; then
        echo "[通过] ICE 配置含 TURN 地址"
    else
        echo "[失败] ICE 配置不含 turn: 地址"
        echo "       检查 .env 的 TURN_SECRET 与 TURN_DOMAIN"
        exit 1
    fi

    echo ""
    echo "=== 3. TURN 端口可达性 ==="
    if command -v nc >/dev/null 2>&1; then
        if nc -zvu "$domain" "$port" 2>&1 | grep -qi 'succeeded\|open'; then
            echo "[通过] $domain:$port 可达"
        else
            echo "[提示] 本机探测 $domain:$port 未通过"
            echo "       若服务器在 NAT 后且未配回流，内网探测失败属正常。"
            echo "       请从**外部网络**复测：nc -vuz $domain $port"
        fi
    else
        echo "[跳过] 未安装 nc。请从外部网络验证：nc -vuz $domain $port"
    fi

    echo ""
    echo "=== 4. 安全组提醒 ==="
    echo "云控制台安全组与系统防火墙都需放行："
    echo "  $port          TCP + UDP   STUN / TURN"
    echo "  49152-65535    UDP         TURN 中继端口段"
    echo "  17300          TCP         信令（走反向代理时只需 443）"
}

cmd_update() {
    check_env

    echo "[更新] 清理本地克隆缓存，强制拉取最新代码"
    rm -rf "$BUILD_DIR"

    # shellcheck disable=SC2046
    docker compose $(compose_args) build --no-cache
    # shellcheck disable=SC2046
    docker compose $(compose_args) up -d

    echo "[更新] 完成"
}

cmd_down() {
    # shellcheck disable=SC2046
    docker compose $(compose_args) down
    echo "[停止] 容器已移除（镜像与 .build 缓存保留）"
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

case "${1:-up}" in
    up)     cmd_up ;;
    logs)   cmd_logs ;;
    status) cmd_status ;;
    verify) cmd_verify ;;
    update) cmd_update ;;
    down)   cmd_down ;;
    -h|--help)
        sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    *)
        echo "用法: $0 [up|logs|status|verify|update|down]" >&2
        exit 1
        ;;
esac

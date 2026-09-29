#!/bin/sh
# ============================================================================
# coturn 启动脚本
#
# coturn 的配置不支持环境变量插值，因此这里把模板里的占位符替换掉，
# 生成真正的配置文件后再启动 —— 这样密钥与公网 IP 都能通过环境变量注入，
# 不必把敏感值写进镜像或仓库。
# ============================================================================
set -e

TPL=/etc/coturn/turnserver.conf.tpl
OUT=/etc/coturn/turnserver.conf

if [ ! -f "$TPL" ]; then
    echo "[coturn] 找不到模板 $TPL" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 校验必填项 —— 缺失时直接退出，而不是带着空值启动
#
# 空 external-ip 会让 coturn 对外公布内网地址，ICE 必然失败；
# 空 secret 则所有中继请求都被拒。这两种情况在日志里都不明显，
# 与其让用户对着「连不上」猜，不如启动时就报错。
# ---------------------------------------------------------------------------
if [ -z "$TURN_PUBLIC_IP" ]; then
    echo "[coturn] 缺少 TURN_PUBLIC_IP（服务器公网 IP，不是域名）" >&2
    exit 1
fi
if [ -z "$TURN_SECRET" ]; then
    echo "[coturn] 缺少 TURN_SECRET（须与信令服务的同名变量一致）" >&2
    exit 1
fi

# 端口与中继段：给默认值，便于不配也能起来（与 server.js 的默认值保持一致）
TURN_PORT="${TURN_PORT:-34780}"
TURN_TLS_PORT="${TURN_TLS_PORT:-53490}"
TURN_RELAY_MIN="${TURN_RELAY_MIN:-49152}"
TURN_RELAY_MAX="${TURN_RELAY_MAX:-65535}"

echo "[coturn] 生成配置：external-ip=$TURN_PUBLIC_IP port=$TURN_PORT relay=$TURN_RELAY_MIN-$TURN_RELAY_MAX"

# 用 | 作分隔符，避免密钥含 / 或 & 时破坏 sed 表达式
sed \
    -e "s|\${TURN_PUBLIC_IP}|${TURN_PUBLIC_IP}|g" \
    -e "s|\${TURN_SECRET}|${TURN_SECRET}|g" \
    -e "s|\${TURN_PORT}|${TURN_PORT}|g" \
    -e "s|\${TURN_TLS_PORT}|${TURN_TLS_PORT}|g" \
    -e "s|\${TURN_RELAY_MIN}|${TURN_RELAY_MIN}|g" \
    -e "s|\${TURN_RELAY_MAX}|${TURN_RELAY_MAX}|g" \
    "$TPL" > "$OUT"

chmod 600 "$OUT"

# ---------------------------------------------------------------------------
# 启动
#
# --no-cli 与配置里的 no-cli 重复，但命令行参数优先级更高，
# 双保险避免某个版本忽略配置项而意外开启管理口。
# --log-file=stdout 让日志走 Docker 收集，便于 docker logs 直接看。
# ---------------------------------------------------------------------------
exec turnserver \
    -c "$OUT" \
    --log-file=stdout \
    --no-cli \
    --fingerprint

# ============================================================================
# 信令服务镜像
#
# 只做两件事：转发 WebRTC 信令 + 签发 TURN 临时凭据。
# 无状态、无数据库，重启只丢失内存房间表（客户端定时 rediscover 会重建）。
# ============================================================================
FROM node:20-alpine

# tini 作为 PID 1：Node 不会自动回收僵尸进程，也不处理 SIGTERM。
# 没有它时 `docker stop` 要等满超时才强杀，且退出码不干净。
RUN apk add --no-cache tini

WORKDIR /app

# 先只拷依赖清单再安装 —— 改代码不会让依赖层缓存失效
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

# 非 root 运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 17300

# 健康检查：容器编排与反向代理据此判断服务可用性
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:17300/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

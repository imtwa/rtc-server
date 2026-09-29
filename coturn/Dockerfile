# ============================================================================
# coturn 镜像
#
# 基于官方 coturn，叠加「配置模板 + 启动时注入密钥」的 entrypoint。
#
# 为什么不直接用官方镜像的环境变量：
# coturn 本身不读环境变量，配置全部来自配置文件。用 -e 传参需要手写
# 整条命令行，密钥一旦含特殊字符（/ & |）就会被 shell 拆错。
# 模板 + sed 更稳，也便于把配置完整留在仓库里审阅。
# ============================================================================
FROM coturn/coturn:4.6-alpine

USER root

# ---------------------------------------------------------------------------
# COPY 路径带 coturn/ 前缀
#
# 构建上下文根是**仓库根目录**（无论用 git 上下文还是本地目录），
# dockerfile 参数只指定用哪个文件作为 Dockerfile，不改变上下文根。
# 因此这里的路径必须从仓库根算起 —— 写成 COPY entrypoint.sh 会去仓库根找，
# 报 "/entrypoint.sh": not found。
# ---------------------------------------------------------------------------
COPY coturn/turnserver.conf.tpl /etc/coturn/turnserver.conf.tpl
COPY coturn/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

# ---------------------------------------------------------------------------
# 端口说明
#
# 本镜像以 host 网络模式运行（见 docker-compose.yml），因此这些 EXPOSE
# 只是文档用途，不参与实际端口映射 —— 端口由 turnserver.conf 的
# listening-port / min-port / max-port 决定，直接绑在宿主机上。
#
# 之所以不用 bridge + 端口映射：TURN 需要一整段 UDP 端口，Docker 的范围映射
# 会为每个端口逐条生成 iptables 规则，开到 16384 个时启动会卡几十秒甚至失败。
#
# 监听端口刻意避开 3478/5349 惯例值，减少公网扫描器的探测噪音。
# ---------------------------------------------------------------------------
EXPOSE 34780/tcp 34780/udp 53490/tcp 53490/udp
# 中继端口段（默认 49152-65535，实际值由 TURN_RELAY_MIN/MAX 环境变量决定）
EXPOSE 49152-65535/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

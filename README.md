# WebRTC 信令与 TURN 服务

自托管的 WebRTC 信令服务 + TURN 中继，一键 Docker 部署。

## 功能

- **信令转发**：实现 [simple-signal](https://github.com/feross/simple-signal) 协议，基于 socket.io v4。用于交换 SDP（offer/answer）与 ICE 候选。
- **多人房间**：按房间名分组，自动下发成员列表，支持 mesh 组网（N 人互连）。
- **TURN 凭据签发**：运行时下发含 TURN 临时凭据的 ICE 配置，凭据可轮换、密钥不落地客户端。
- **TURN 中继**：内置 coturn，用于 NAT 打洞失败时中转媒体。
- **无状态**：无数据库、无持久化卷。重启只丢失内存房间表，客户端重新 discover 即可恢复。

## 解决什么问题

WebRTC 建立连接依赖 ICE 收集三类候选：

| 类型 | 含义 | 适用场景 |
| --- | --- | --- |
| `host` | 本机内网地址（192.168.x.x） | 同一局域网内直接互通 |
| `srflx` | STUN 发现的公网地址 | 简单 NAT 下打洞 |
| `relay` | TURN 中继地址 | 打洞失败时的唯一出路 |

只配 STUN 时，STUN 只能发现公网地址，**无法在打洞失败时中转媒体**。而移动网络（4G/5G）普遍是对称型 NAT 或 CGNAT —— 每个目标的映射端口都不同，打洞必然失败。

结果：同一 WiFi 内能通话，跨网络必然连不上。

本服务同时提供信令与 TURN，解决上述问题。

## 快速开始

提供两种部署方式，按你的环境二选一。

| 方式 | 适用场景 | 需要的文件 |
| --- | --- | --- |
| [命令行部署](#方式一命令行部署) | 能 SSH 登录服务器 | `docker-compose.yml` + `.env` |
| [面板部署](#方式二面板部署) | 用 1Panel / 宝塔 / Portainer 等容器面板 | `docker-compose.panel.yml` |

### 前置

一台有公网 IP 的 Linux 服务器，已装 Docker：

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

### 必做的三件事

无论用哪种方式，都需要：

**1. 生成密钥**

```bash
openssl rand -hex 32
```

**2. 配置 DNS**

给 TURN 域名添加一条 A 记录，指向服务器公网 IP：

```
A    rtc    <服务器公网 IP>
```

**3. 放行端口**

云控制台安全组与系统防火墙**两处都要**放行：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 34780 | TCP + UDP | STUN / TURN |
| 49152-65535 | UDP | TURN 中继端口段 |
| 17300 | TCP | 信令（走反向代理时只需 443） |

---

### 方式一：命令行部署

适合能 SSH 登录服务器的场景，用 `.env` 文件管理配置。

```bash
git clone https://github.com/imtwa/rtc-server.git
cd rtc-server
```

**生成配置**（会自动生成密钥）：

```bash
./init-env.sh
```

或一步到位：

```bash
./init-env.sh --ip 1.2.3.4 --domain rtc.example.com
```

**部署**：

```bash
./deploy.sh
```

**验证**：

```bash
./deploy.sh verify
```

`deploy.sh` 的其他子命令：

```bash
./deploy.sh logs     # 跟踪日志
./deploy.sh status   # 状态与健康检查
./deploy.sh update   # 无缓存重建
./deploy.sh down     # 停止并移除容器
```

若不使用脚本，也可以手工执行：

```bash
cp .env.example .env    # 然后编辑填入三项必填
docker compose up -d --build
```

---

### 方式二：面板部署

适合使用 1Panel、宝塔、Portainer 等容器面板的场景。变量内联在编排文件里，不依赖 `.env`。

**步骤**

1. 打开 `docker-compose.panel.yml`，全文复制
2. 粘贴到面板的「容器编排 / Compose」输入框
3. 替换其中**三处占位符**（见下）
4. 点部署，等待构建完成（首次约 1-3 分钟）
5. 验证

**必改的三处**

| 占位符 | 替换为 |
| --- | --- |
| `替换为-openssl-rand-hex-32-的输出` | 第 1 步生成的密钥（**两处，必须完全一致**） |
| `rtc.example.com` | 你的 TURN 域名 |
| `1.2.3.4` | 服务器公网 IP（**不是域名**） |

`TURN_SECRET` 在 `signaling` 与 `coturn` 两处各出现一次。不一致会让 coturn 校验 HMAC 失败，所有中继请求被拒，而日志只显示认证失败，不易定位。

**验证**

面板部署后，SSH 到服务器执行：

```bash
# 健康检查：期望 {"ok":true,...,"turn":true}
curl http://127.0.0.1:17300/health

# ICE 配置：必须包含 turn: 开头的地址
curl http://127.0.0.1:17300/rtc-config
```

`/rtc-config` 若只返回 `stun:`，说明 `TURN_SECRET` 或 `TURN_DOMAIN` 未生效。

**日志里的正常现象**

```
Image rtc-signaling:latest Pulling
Image rtc-signaling:latest pull access denied ...
Image rtc-signaling:latest Building
```

这三行是正常的。compose 同时写了 `build:` 与 `image:`，Docker 会先尝试拉取现成镜像（本地没有，失败），再自动转为构建。`image:` 字段的作用是给构建产物命名。

**面板部署的限制**

`coturn` 使用 `network_mode: host`，有两个前提：

- 宿主机必须是 **Linux**。Docker Desktop for Windows/Mac 不支持 host 模式。
- 容器运行时**不能是 swarm 模式**。swarm 不支持 host 网络，会直接报错。

若你的面板是 swarm 或 Kubernetes，需要改用端口映射版本，代价是中继端口段必须逐个映射，只能开较小范围（如 100 个端口，支持约 10 人同时全中继）。

---

### 正常启动日志

```
[signal] 监听 :17300
[signal] TURN 已启用 -> rtc.example.com:34780
[coturn] 生成配置：external-ip=1.2.3.4 port=34780 relay=49152-65535
```

若 `[signal] TURN` 那行显示「未配置」，说明 `TURN_SECRET` 或 `TURN_DOMAIN` 没传进容器，跨网络将无法建立连接。

## 端口与网络

| 端口 | 协议 | 用途 | 可否反代 |
| --- | --- | --- | --- |
| 17300 | TCP | 信令 + ICE 配置接口 | 可以 |
| 34780 | TCP + UDP | STUN / TURN | 不可 |
| 49152-65535 | UDP | TURN 中继端口段 | 不可 |

**信令可以走反向代理**。用任意反代把域名指向 `127.0.0.1:17300` 即可，注意三点：

1. **支持 WebSocket 升级** —— socket.io 会从 polling 升到 websocket。Nginx 需转发 `Upgrade` 与 `Connection` 头；Caddy 的 `reverse_proxy` 原生支持。
2. **关闭响应缓冲** —— 长轮询是流式响应，缓冲会导致信令延迟。Nginx 用 `proxy_buffering off;`，Caddy 用 `flush_interval -1`。
3. **不要在反代层加 CORS 头** —— 后端已完整处理。代理层再加一份会导致响应中出现重复的 `Access-Control-Allow-Origin`，浏览器直接拒绝。

**TURN 不能走反向代理**。它是原生 UDP/TCP 协议，HTTP 反代无法转发。域名在这里只起 DNS 解析作用，端口需在安全组直接放行。

安全组与系统防火墙需放行：`34780`（TCP + UDP）、`49152-65535`（UDP）。信令端口若走反代则只需放行 443。

## 接口

### GET /rtc-config

下发 ICE 服务器列表，含 TURN 临时凭据。

```json
{
  "iceServers": [
    {
      "urls": ["stun:rtc.example.com:34780", "stun:stun.l.google.com:19302"]
    },
    {
      "urls": [
        "turn:rtc.example.com:34780?transport=udp",
        "turn:rtc.example.com:34780?transport=tcp"
      ],
      "username": "1735689600:guest",
      "credential": "base64-hmac"
    }
  ],
  "ttl": 43200
}
```

响应不缓存（`Cache-Control: no-store`），因为凭据有有效期。

### GET /health

探活接口，供容器编排与反代使用。

```json
{ "ok": true, "rooms": 3, "members": 5, "turn": true }
```

`turn: false` 表示 TURN 未配置，跨网络将无法建立连接。

### GET /

返回纯文本状态，便于人工确认服务存活。

```
Lobby server<br/>rooms: 3<br/>members: 5
```

## 信令协议

实现 simple-signal 协议。可使用 `simple-signal-client` 库，或自行实现。

### 客户端 → 服务端

| 事件 | 载荷 |
| --- | --- |
| `simple-signal[discover]` | 房间名字符串 |
| `simple-signal[offer]` | `{ signal, metadata, sessionId, target }` |
| `simple-signal[signal]` | `{ signal, metadata, sessionId, target }` |
| `simple-signal[reject]` | `{ metadata, sessionId, target }` |

### 服务端 → 客户端

| 事件 | 载荷 |
| --- | --- |
| `simple-signal[discover]` | `{ id, discoveryData: { peers: string[] } }` |
| `simple-signal[offer]` | `{ initiator, metadata, sessionId, signal }` |
| `simple-signal[signal]` | `{ sessionId, signal, metadata }` |
| `simple-signal[reject]` | `{ sessionId, metadata }` |

### 约定

- `discover` 的载荷必须是**字符串**。传对象会被拒绝（否则所有客户端会被塞进同一个伪房间）。
- `id` 是收件人自己的 socket id，客户端据此判断哪些成员不是自己。
- `offer` 的 `initiator` 由服务端填入真实来源，客户端不应伪造。
- 成员快照是**瞬时**的。客户端需定时重新 `discover` 才能发现中途加入的成员。

## 客户端接入

### 1. 连接信令

```js
import { io } from 'socket.io-client';

const socket = io('https://rtc.example.com', {
    transports: ['websocket', 'polling']
});

socket.on('connect', () => {
    // 载荷必须是房间名字符串
    socket.emit('simple-signal[discover]', 'my-room');
});
```

### 2. 拉取 ICE 配置

在创建 RTCPeerConnection 之前获取，否则不会使用 TURN：

```js
const res = await fetch('https://rtc.example.com/rtc-config');
const { iceServers } = await res.json();

const pc = new RTCPeerConnection({ iceServers });
```

### 3. 交换信令

收到成员列表后与每个成员建立连接：

```js
socket.on('simple-signal[discover]', ({ id, discoveryData }) => {
    for (const peerId of discoveryData.peers) {
        // 按 id 字典序裁定发起方，避免双方同时发 offer
        if (String(id) < String(peerId)) {
            startConnection(peerId);
        }
    }
});
```

### 4. 媒体收发

用 `addTransceiver` 预声明方向，再用 `replaceTrack` 装配轨道 —— 避免重协商（移动端 WebView 重协商失败率较高）：

```js
// 发起方：先声明收发方向
pc.addTransceiver('audio', { direction: 'sendrecv' });
pc.addTransceiver('video', { direction: 'sendrecv' });

// 应答方：transceiver 由对方 offer 创建，默认 recvonly，
// 必须在 createAnswer 之前提升方向，否则只收不发
for (const t of pc.getTransceivers()) {
    if (t.direction === 'recvonly') t.direction = 'sendrecv';
}
```

## 配置项

全部通过 `.env` 配置。

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `TURN_PUBLIC_IP` | 是 | - | 服务器公网 IP |
| `TURN_DOMAIN` | 是 | - | 下发给客户端的 TURN 域名 |
| `TURN_SECRET` | 是 | - | TURN 长期密钥，须与 coturn 一致 |
| `TURN_PORT` | 否 | 34780 | STUN / TURN 端口 |
| `TURN_TLS_PORT` | 否 | 53490 | TURN over TLS 端口 |
| `TURN_RELAY_MIN` | 否 | 49152 | 中继端口段起始 |
| `TURN_RELAY_MAX` | 否 | 65535 | 中继端口段结束 |
| `ALLOW_ORIGIN` | 否 | `*` | CORS 放行来源 |

信令服务端口在 `docker-compose.yml` 的 `PORT` 中配置（默认 17300）。

改动端口不需要修改客户端 —— ICE 配置由服务端运行时签发。

### 中继端口容量

一个 TURN allocation 占 1 个端口；一条走中继的连接需两端各一个，共 2 个。mesh 房间 N 人总占用 `N×(N-1)`。

| 端口数 | 支持人数（全中继） |
| --- | --- |
| 100 | 约 10 |
| 1024 | 约 32 |
| 16384 | 上百 |

只有打洞失败的连接才走中继。同一局域网或打洞成功的走 host/srflx，不占 TURN 端口。

**实际瓶颈通常是带宽**，而非端口数。TURN 双向转发，服务端每个流收一次发一次：

| 场景 | 中继流数 | 服务端带宽 |
| --- | --- | --- |
| 2 人 | 2 | 约 2.4 Mbps |
| 3 人 | 6 | 约 7 Mbps |
| 5 人 | 20 | 约 24 Mbps |

轻量服务器通常 3-5 Mbps 峰值，3 人即到上限。

## 排查

### 客户端未收集到中继候选

TURN 未生效。依次检查：

```bash
curl https://rtc.example.com/rtc-config      # 是否下发了 turn 地址
docker compose logs coturn | head -30        # coturn 是否在跑
nc -vuz rtc.example.com 34780                # 端口是否可达
```

常见原因：`TURN_PUBLIC_IP` 填了内网 IP，或安全组未放行端口。

### ICE 连通失败

候选已交换但无法互通。常见原因：

- `TURN_PUBLIC_IP` 与实际公网 IP 不一致（云主机 1:NAT 场景）
- 中继端口段被防火墙拦截（UDP 49152-65535）
- `TURN_SECRET` 两端不一致，coturn 校验 HMAC 失败，中继请求被拒

### 信令连不上

```bash
curl https://rtc.example.com/health
docker compose ps
```

若使用 Nginx，确认 `proxy_set_header Upgrade/Connection` 两行存在，否则 WebSocket 升级失败，只能退回长轮询。

### 对照客户端候选统计

客户端应记录 ICE 候选类型：

```
ICE 收集完成 host=3 srflx=2 relay=2
```

| 情况 | 含义 |
| --- | --- |
| 只有 `host` | STUN 不可达，或 ICE 配置未拉取 |
| 有 `srflx` 无 `relay` | 缺 TURN，跨网络必失败 |
| 有 `relay` 但仍失败 | TURN 地址不可达或密钥不匹配 |

## 架构

```
客户端 A ──┐
           ├─→ 反向代理 → 信令服务 :17300
客户端 B ──┘                  · 交换 offer/answer/ICE 候选
                              · /rtc-config 下发 TURN 凭据
           ←── turn:域名:34780（打洞失败时中转媒体）──→
```

### TURN 凭据机制

使用 coturn 的 `use-auth-secret` 模式，签发临时凭据：

```
username   = "<过期时间戳>:<标识>"
credential = base64(HMAC-SHA1(secret, username))
```

coturn 用同一密钥重算并校验，同时检查时间戳。

相比在客户端写死静态账号：

- 凭据可轮换，不必重新发版
- 密钥不进客户端，避免中继带宽被滥用
- 部分运行环境读不到构建期变量，运行时下发是唯一可行方式

### 为什么 coturn 用 host 网络

TURN 需要一整段 UDP 端口做中继。Docker 的端口范围映射会为**每个端口**逐条生成 iptables 规则 —— 范围小时尚可，一旦开到 16384 个，容器启动会卡顿甚至失败。

host 模式下容器直接绑定宿主网卡，无映射开销，可开满整个范围；且 coturn 对外公布的 relay 地址与真实地址天然一致 —— bridge 模式下容器内 IP 与宿主公网 IP 不同，这是自建 TURN「能启动但连不通」的常见原因。

注意：host 模式仅在 Linux 上有效，Docker Desktop for Windows/Mac 不支持。

信令服务保持 bridge + 端口映射，它只有一个端口，无上述问题。

## 运维

```bash
docker compose logs -f signaling
docker compose logs -f coturn
docker compose restart
docker compose up -d --build    # 更新
docker compose down
```

信令服务无状态，可随意重启。客户端定时重新 discover 即可恢复。

## 目录结构

```
.
├── docker-compose.yml            # 命令行部署（配合 .env 与 deploy.sh）
├── docker-compose.panel.yml      # 面板部署（变量内联，直接粘贴）
├── .env.example                  # 环境变量模板
├── init-env.sh                   # 生成 .env，自动生成密钥
├── deploy.sh                     # 构建 / 启动 / 验证 / 更新
├── signaling/                    # 信令服务
│   ├── server.js
│   ├── package.json
│   ├── package-lock.json         # 锁定依赖版本，加速构建
│   └── Dockerfile
└── coturn/                       # TURN 中继
    ├── turnserver.conf.tpl       # 配置模板
    ├── entrypoint.sh             # 启动时注入密钥
    └── Dockerfile
```

两个 compose 文件的服务定义一致，按部署方式二选一，不要同时使用。


'use strict';

/**
 * WebRTC 信令服务
 *
 * 两件事：
 *   1. 转发 WebRTC 信令（simple-signal 协议，socket.io v4）
 *   2. 下发 ICE 配置（含 TURN 临时凭据）
 *
 * 通用实现：不依赖任何特定客户端，任何实现了 simple-signal 协议的前端
 * 均可接入。房间仅以字符串标识，不涉及业务语义。
 *
 * 无状态、无数据库。重启只丢失内存里的房间表，客户端定时 rediscover
 * 会自行重建。
 *
 * ---------------------------------------------------------------------------
 * 部署拓扑（示例域名，按实际替换）
 *
 *   https://rtc.example.com          → 反向代理 → 本服务 :17300
 *   turn:rtc.example.com:34780       → 直连 coturn（原生 UDP/TCP，不经反代）
 *   turns:rtc.example.com:53490      → 直连 coturn（TURN over TLS，可选）
 *
 * TURN 不能走 HTTP 反向代理 —— 它是原生 UDP 协议。域名在这里只起
 * DNS 解析作用，34780 端口需在安全组直接放行。
 *
 * 端口均避开惯例值（3000 / 3478 / 5349），减少公网扫描器探测噪音。
 * 改动端口不需要动客户端 —— ICE 配置由本服务运行时签发。
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 17300);

/* ---------------- TURN 配置 ---------------- */

/** 与 coturn 共享的长期密钥，用于签发临时凭据。两端必须完全一致。 */
const TURN_SECRET = process.env.TURN_SECRET || '';

/**
 * 下发给客户端的 TURN 域名。
 *
 * 用域名而非 IP：服务器换 IP 时只需改 DNS，客户端不必重新发版。
 * 也便于将来把 coturn 迁到独立机器。
 */
const TURN_DOMAIN = process.env.TURN_DOMAIN || '';

/**
 * coturn 监听端口。
 *
 * 刻意避开 3478/5349 —— 这两个是 TURN 的惯例端口，公网上有大量扫描器
 * 盯着它们（探测开放中继）。换成不常见端口能显著减少这类噪音流量。
 *
 * 注意：改这里不需要动客户端 —— ICE 配置由本服务运行时签发，
 * 客户端拿到的就是新端口。这也是不做构建期注入的原因之一。
 */
const TURN_PORT = String(process.env.TURN_PORT || '34780');
const TURN_TLS_PORT = String(process.env.TURN_TLS_PORT || '53490');

/**
 * 是否下发 turns:（TURN over TLS）条目。
 *
 * 默认关闭。TLS 端口需要单独配置证书，未配时不可达 ——
 * 客户端虽然会忽略不可达的 ICE server，但日志里会打出一串
 * 「ICE 候选收集失败」，徒增排查干扰。
 *
 * 确有需要（极端受限网络）时置 true，并给 coturn 配好证书。
 */
const TURN_TLS_ENABLE = process.env.TURN_TLS_ENABLE === 'true';

/** 凭据有效期（秒）。默认 12 小时，与 coturn 的会话上限对齐。 */
const TURN_TTL = Number(process.env.TURN_TTL || 43200);

/** 跨域放行来源。浏览器端上线后建议收窄为前端域名。 */
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

/* ---------------- 房间状态 ---------------- */

/**
 * 房间名 -> socket id 集合。
 *
 * 只维护内存态：信令是瞬时的，最后一人离开后房间即可丢弃。
 */
const rooms = new Map();

/** 一个 socket 当前所属的房间名（用于断开时精确清理）。 */
const socketRoom = new Map();

function addToRoom(room, id) {
    let set = rooms.get(room);
    if (!set) {
        set = new Set();
        rooms.set(room, set);
    }
    set.add(id);
}

function removeFromRoom(room, id) {
    const set = rooms.get(room);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) rooms.delete(room);
}

/** 取房间内除 `exceptId` 外的所有成员。 */
function peersOf(room, exceptId) {
    const set = rooms.get(room);
    if (!set) return [];
    const out = [];
    for (const id of set) {
        if (id !== exceptId) out.push(id);
    }
    return out;
}

/* ---------------- TURN 凭据签发 ---------------- */

/**
 * 按 coturn 的 `use-auth-secret` 约定生成临时凭据。
 *
 *   username   = `<过期时间戳>:<标识>`
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * coturn 收到后会用同一密钥重算并校验，同时检查时间戳是否过期。
 *
 * 相比在 App 里写死静态账号：
 *   · 凭据可轮换，不必重新发版
 *   · 密钥不进包，避免中继带宽被白嫖
 *   · renderjs 段读不到构建期变量，运行时下发是唯一可行方式
 */
function issueTurnCredentials(idSuffix) {
    const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
    const username = `${expiry}:${idSuffix}`;
    const credential = crypto
        .createHmac('sha1', TURN_SECRET)
        .update(username)
        .digest('base64');
    return { username, credential };
}

/** 组装客户端可直接使用的 ICE 服务器列表。 */
function buildIceServers(idSuffix) {
    /*
     * STUN 与 TURN 并列给出。
     *
     * STUN 负责发现公网地址（同一网络/简单 NAT 下够用，省中继带宽）；
     * TURN 是打洞失败时的兜底 —— 国内移动网络多为对称型 NAT / CGNAT，
     * 没有 TURN 就只能同 WiFi 互通。
     */
    const host = TURN_DOMAIN || 'localhost';

    const iceServers = [
        {
            urls: [
                `stun:${host}:${TURN_PORT}`,
                'stun:stun.l.google.com:19302',
                'stun:stun.miwifi.com:3478'
            ]
        }
    ];

    if (TURN_SECRET && TURN_DOMAIN) {
        const { username, credential } = issueTurnCredentials(idSuffix);

        const urls = [
            // udp 优先（延迟低），tcp 兜底（部分网络封 UDP）
            `turn:${host}:${TURN_PORT}?transport=udp`,
            `turn:${host}:${TURN_PORT}?transport=tcp`
        ];
        // TLS 变体：仅在 coturn 配好证书时下发，否则会徒增失败日志
        if (TURN_TLS_ENABLE) {
            urls.push(`turns:${host}:${TURN_TLS_PORT}?transport=tcp`);
        }

        iceServers.push({ urls, username, credential });
    }

    return iceServers;
}

/* ---------------- HTTP 接口 ---------------- */

function sendJson(res, code, body) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': ALLOW_ORIGIN
    });
    res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': ALLOW_ORIGIN,
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,X-Client-Id'
        });
        res.end();
        return;
    }

    /*
     * 客户端启动时拉取 ICE 配置。
     *
     * 走 HTTP 而不是构建期注入：renderjs 段不能 import，拿不到环境变量；
     * 且 TURN 凭据需要轮换，写死在包里就必须重新发版。
     */
    if (url === '/rtc-config') {
        const suffix = String(req.headers['x-client-id'] || 'guest').slice(0, 32);
        sendJson(res, 200, {
            iceServers: buildIceServers(suffix),
            ttl: TURN_TTL
        });
        return;
    }

    // 探活：供容器健康检查与反向代理使用
    if (url === '/health') {
        let members = 0;
        for (const set of rooms.values()) members += set.size;
        sendJson(res, 200, {
            ok: true,
            rooms: rooms.size,
            members,
            turn: !!(TURN_SECRET && TURN_DOMAIN)
        });
        return;
    }

    // 与原 lobby 服务保持一致的根路径响应，便于人工确认服务活着
    if (url === '/') {
        let members = 0;
        for (const set of rooms.values()) members += set.size;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`Lobby server<br/>rooms: ${rooms.size}<br/>members: ${members}`);
        return;
    }

    sendJson(res, 404, { error: 'not found' });
});

/* ---------------- Socket.IO 信令 ---------------- */

const io = new Server(server, {
    // 客户端 transports 为 ['websocket', 'polling']，两者都要支持
    cors: { origin: ALLOW_ORIGIN, methods: ['GET', 'POST'] },
    // 心跳放宽到 25s：移动网络切换（WiFi↔4G）时瞬时抖动不应直接判定断开
    pingInterval: 25000,
    pingTimeout: 20000,
    // SDP 体积不大，给足余量避免被截断
    maxHttpBufferSize: 1e6
});

/**
 * 事件名常量，与客户端约定，不可改动。
 */
const EV = {
    discover: 'simple-signal[discover]',
    offer: 'simple-signal[offer]',
    signal: 'simple-signal[signal]',
    reject: 'simple-signal[reject]'
};

/**
 * 向房间内每个成员各推一份成员快照。
 *
 * 必须逐个 emit（而非 io.to(room).emit）：载荷里的 id 是
 * 「收件人自己的 socket id」，客户端据此判断「哪些不是我」。
 * 广播同一个 id 会让所有人都以为只有那一个人是自己，配对全乱。
 */
function pushSnapshot(room) {
    const set = rooms.get(room);
    if (!set) return;
    for (const id of set) {
        io.to(id).emit(EV.discover, {
            id,
            discoveryData: { peers: peersOf(room, id) }
        });
    }
}

/** 离开旧房间（切换或断开时调用）。 */
function leaveCurrentRoom(socket) {
    const prev = socketRoom.get(socket.id);
    if (!prev) return;
    socketRoom.delete(socket.id);
    socket.leave(prev);
    removeFromRoom(prev, socket.id);
    pushSnapshot(prev);
}

io.on('connection', socket => {
    console.log(`[signal] 连接建立 ${socket.id}（当前 ${io.engine.clientsCount} 个）`);

    socket.on(EV.discover, roomName => {
        /*
         * 载荷必须是字符串。
         *
         * 客户端传的是房间名；若收到对象（旧实现踩过的坑），直接拒绝 ——
         * 否则 String({}) 得到 "[object Object]"，所有人被塞进同一个伪房间，
         * 跨房间串线且无从排查。
         */
        if (typeof roomName !== 'string') {
            console.warn(`[signal] ${socket.id} discover 载荷非字符串，已忽略`);
            return;
        }
        const room = roomName.trim();
        if (!room || room.length > 64) return;

        // 换了房间：先退旧的，避免同时挂在多个房间被重复配对
        const prev = socketRoom.get(socket.id);
        if (prev && prev !== room) leaveCurrentRoom(socket);

        socket.join(room);
        socketRoom.set(socket.id, room);
        addToRoom(room, socket.id);

        // 只回给发起 discover 的这个客户端
        socket.emit(EV.discover, {
            id: socket.id,
            discoveryData: { peers: peersOf(room, socket.id) }
        });

        // 让房间内其他人立刻看到新成员（客户端 3 秒轮询的加速补充）
        pushSnapshot(room);
    });

    socket.on(EV.offer, payload => {
        const { signal, metadata, sessionId, target } = payload || {};
        if (!target || !signal || !sessionId) return;

        // initiator 由服务端填入真实来源，客户端据此判定 glare 与应答对象
        io.to(target).emit(EV.offer, {
            initiator: socket.id,
            metadata: metadata || {},
            sessionId,
            signal
        });
    });

    socket.on(EV.signal, payload => {
        const { signal, metadata, sessionId, target } = payload || {};
        if (!target || !signal || !sessionId) return;

        // answer 与 ICE 候选共用这条通道，原样转发即可
        io.to(target).emit(EV.signal, {
            sessionId,
            signal,
            metadata: metadata || {}
        });
    });

    socket.on(EV.reject, payload => {
        const { metadata, sessionId, target } = payload || {};
        if (!target || !sessionId) return;

        io.to(target).emit(EV.reject, { sessionId, metadata: metadata || {} });
    });

    socket.on('disconnect', reason => {
        leaveCurrentRoom(socket);
        console.log(`[signal] 连接断开 ${socket.id}（${reason}）`);
    });
});

/* ---------------- 启动 ---------------- */

server.listen(PORT, () => {
    console.log(`[signal] 监听 :${PORT}`);
    console.log(
        `[signal] TURN ${TURN_SECRET && TURN_DOMAIN ? `已启用 → ${TURN_DOMAIN}:${TURN_PORT}` : '未配置（仅 STUN，跨网络可能连不通）'}`
    );
});

/*
 * 未捕获异常不能让进程静默死掉 —— 容器会自动重启，但重启前先留日志，
 * 否则「信令时好时坏」会完全无迹可循。
 */
process.on('uncaughtException', err => {
    console.error('[signal] 未捕获异常', err);
});
process.on('unhandledRejection', err => {
    console.error('[signal] 未处理的 Promise 拒绝', err);
});

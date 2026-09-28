// ============================================================
// tests/local/bridge.mjs —— 本机调试桥服务（零依赖 WebSocket 服务端）
//
// 角色：插件「设定/面板 → 调试 → 🔌 调试桥」开启后**主动拨出**连到这里。
//   为什么方向相反：WebView 页面无法监听端口，TauriTavern 也没有 http-server 类 Tauri 插件，
//   所以端口由本工具监听、插件拨出连接 —— 数据面等价。
//
// 跨宿主：插件侧只依赖浏览器 `WebSocket`，**酒馆原生（浏览器）与 TauriTavern 都能用**；
//   其中宿主日志类方法（`host.*`）依赖 TauriTavern 的 `api.dev`，非 TauriTavern 时插件会
//   返回 `available:false`（只降级，不报错）。
//
// 为什么自己实现 WebSocket：仓库「源码即发布物、无运行时依赖」，不引入 npm 包。
//   Node 自带 WebSocket **客户端**但没有服务端，故此处实现 RFC 6455 的握手与帧编解码，
//   只覆盖调试桥需要的能力（text / close / ping / pong；客户端帧带掩码）。
//
// 用法：
//   node tests/local/bridge.mjs                     # 监听 127.0.0.1:8791，进入交互
//   node tests/local/bridge.mjs --port 8792
//   node tests/local/bridge.mjs --host 0.0.0.0      # 监听局域网（**手机等其它设备可连**，见下方安全提示）
//   node tests/local/bridge.mjs --selftest          # 自检：内置假插件验证握手与调用
//   node tests/local/bridge.mjs --call sys.info     # 一次性调用（等插件连上来）
//   node tests/local/bridge.mjs --list              # 只打印用法
//
// ⚠ 安全：调试桥**只读但无鉴权**。默认只监听回环；一旦 `--host 0.0.0.0`，同一局域网内任何
//   设备都能读到你这些只读数据（记忆条数/取样、调试日志统计、宿主 LLM 请求留档等）。
//   仅在可信网络下临时使用，用完即停。
//
// 交互命令：
//   ls                          列出插件登记的白名单方法
//   hello                       重印插件与宿主信息
//   call <method> [json]        调用（例：call ftt.memoryShape）
//   quit / exit                 退出
// ============================================================
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
    const eq = args.find((a) => a.startsWith('--' + name + '='));
    if (eq) return eq.slice(eq.indexOf('=') + 1);
    const i = args.indexOf('--' + name);
    if (i < 0) return dflt;
    const next = args[i + 1];
    return (next === undefined || next.startsWith('--')) ? true : next;
};
const PORT = Number(arg('port', 8791));
/** 监听地址：默认只监听回环（最安全）。`--host 0.0.0.0` 可让**手机等其它设备**连过来。 */
const HOST = String(arg('host', '127.0.0.1'));
const ONESHOT = arg('call', null);
/**
 * 一次性调用的参数：优先 `--params-file <json文件>`（**推荐**：免去 shell 引号地狱），
 * 其次 `--params '<json>'`。
 */
const PARAMS = (() => {
    const file = arg('params-file', null);
    if (typeof file === 'string' && file.trim()) {
        try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('[bridge] --params-file 读取/解析失败：' + String((e && e.message) || e)); process.exit(2); }
    }
    const p = arg('params', null);
    if (typeof p !== 'string' || !p.trim()) return {};
    try { return JSON.parse(p); } catch (e) { console.error('[bridge] --params 不是合法 JSON：' + String((e && e.message) || e)); process.exit(2); }
})();
const LISTONLY = !!arg('list', false);
const SELFTEST = !!arg('selftest', false);
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

const log = (...a) => console.log(...a);
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

// ------------------------------------------------------------
// 极简 WebSocket 服务端（RFC 6455 子集）
// ------------------------------------------------------------
function acceptKey(key) {
    return createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** 服务端 → 客户端 text 帧（不掩码） */
function encodeText(str) {
    const payload = Buffer.from(String(str), 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
}

function encodeClose(code = 1000) {
    return Buffer.from([0x88, 0x02, (code >> 8) & 0xff, code & 0xff]);
}

/** 从累积缓冲解一帧；不足一帧返回 null */
function decodeFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < off + 2) return null; len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) {
        if (buf.length < off + 8) return null;
        const big = buf.readBigUInt64BE(off); off += 8;
        if (big > BigInt(16 * 1024 * 1024)) throw new Error('帧过大（>16MB），拒绝');
        len = Number(big);
    }
    let mask = null;
    if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) return null;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    return { frame: { fin, opcode, payload }, rest: buf.subarray(off + len) };
}

const clients = new Set();
let helloInfo = null;
const pending = new Map();
let seq = 0;

const server = createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('本端口是调试桥的 WebSocket 端点，请用 WebSocket 连接（插件里开启「🔌 调试桥」后会自动连过来）。\n');
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
    socket.write([
        'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Accept: ' + acceptKey(key), '', '',
    ].join('\r\n'));

    const client = { socket, buf: Buffer.alloc(0) };
    clients.add(client);
    log('[bridge] 插件已连入 · ' + stamp());

    socket.on('data', (chunk) => {
        client.buf = Buffer.concat([client.buf, chunk]);
        try {
            for (;;) {
                const out = decodeFrame(client.buf);
                if (!out) break;
                client.buf = out.rest;
                const { opcode, payload } = out.frame;
                if (opcode === 0x8) { closeClient(client); return; }
                if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
                if (opcode === 0xa) continue;
                if (opcode === 0x1 || opcode === 0x0) {
                    let msg = null;
                    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { log('[bridge] 收到非 JSON 帧，已忽略'); continue; }
                    handleIncoming(msg);
                }
            }
        } catch (e) {
            log('[bridge] 帧解析失败：' + String((e && e.message) || e));
            closeClient(client);
        }
    });
    socket.on('error', () => closeClient(client));
    socket.on('close', () => { clients.delete(client); log('[bridge] 插件连接已断开 · ' + stamp()); });
});

function closeClient(client) {
    try { client.socket.write(encodeClose(1000)); } catch (e) { /* 忽略 */ }
    try { client.socket.destroy(); } catch (e) { /* 忽略 */ }
    clients.delete(client);
}

function handleIncoming(msg) {
    if (msg && msg.type === 'hello') {
        helloInfo = msg;
        log('\n[bridge] 握手成功');
        log('  插件  ：' + (msg.plugin ? (msg.plugin.name + ' v' + msg.plugin.version + '（' + msg.plugin.moduleName + '）') : '?'));
        const h = msg.host || {};
        log('  宿主  ：' + (h.kind === 'tauritavern'
            ? ('TauriTavern（ABI v' + h.abiVersion + '，api.dev ' + (h.devApi ? '可用' : '不可用') + '）')
            : '酒馆原生（浏览器）'));
        log('  协议  ：v' + msg.protocol + ' · 只读方法 ' + ((msg.methods || []).length) + ' 个');
        if (h.kind !== 'tauritavern') log('  提示  ：非 TauriTavern —— host.* 类方法会返回 available:false（插件侧不报错）');
        printMethods(msg.methods || []);
        return;
    }
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
        return;
    }
    log('[bridge] 未知帧：' + JSON.stringify(msg).slice(0, 200));
}

function printMethods(methods) {
    log('  方法  ：' + (methods.length ? methods.join(' · ') : '（无可调用方法）'));
}

/** 向插件发一次调用；无客户端/超时都返回结构化错误（不抛） */
function call(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve) => {
        const client = [...clients][0];
        if (!client) { resolve({ ok: false, error: { code: 'E_NOCLIENT', message: '插件尚未连入（先在插件「调试 → 🔌 调试桥」点开启）' } }); return; }
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: { code: 'E_TIMEOUT', message: '调用超时 ' + timeoutMs + 'ms' } }); }, timeoutMs);
        pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
        try { client.socket.write(encodeText(JSON.stringify({ id, method, params }))); } catch (e) {
            clearTimeout(timer); pending.delete(id);
            resolve({ ok: false, error: { code: 'E_SEND', message: String((e && e.message) || e) } });
        }
    });
}

async function waitForClient(ms = 60000) {
    if (clients.size) return true;
    log('[bridge] 等待插件连入 ' + HOST + ':' + PORT + ' …（插件「调试 → 🔌 调试桥」点「▶ 开启调试桥」'
        + (IS_LOOPBACK ? '' : '，且目标主机需填本机局域网地址') + '）');
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        await new Promise((r) => setTimeout(r, 300));
        if (clients.size) return true;
    }
    return false;
}

// ------------------------------------------------------------
// 自检：内置假插件（Node 自带 WebSocket 客户端）验证握手与调用
// ------------------------------------------------------------
async function selftest() {
    const port = Number(arg('port', 8799));
    const clientHost = IS_LOOPBACK ? HOST : '127.0.0.1';   // 监听 0.0.0.0 时自检仍走回环
    log('===== 调试桥自检（无需真实宿主）=====');
    const srv = server.listen(port, HOST, async () => {
        let ws = null;
        try {
            ws = new WebSocket('ws://' + clientHost + ':' + port);
            await new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('客户端连接失败')), { once: true });
            });
            ws.send(JSON.stringify({
                type: 'hello', protocol: 1,
                plugin: { name: 'FTT记忆组件 V2', moduleName: 'ftt_memory_v2', version: 'selftest' },
                host: { kind: 'vanilla', tauriTavern: false, abiVersion: null, devApi: false },
                methods: ['sys.info', 'ftt.memoryShape'],
            }));
            const impl = {
                'sys.info': () => ({ protocol: 1, host: { kind: 'vanilla' }, note: 'selftest' }),
                'ftt.memoryShape': () => ({ atoms: 8, states: 4 }),
            };
            ws.addEventListener('message', (ev) => {
                const msg = JSON.parse(String(ev.data));
                const fn = impl[msg.method];
                ws.send(JSON.stringify(fn
                    ? { id: msg.id, ok: true, result: fn() }
                    : { id: msg.id, ok: false, error: { code: 'E_METHOD', message: '未登记：' + msg.method } }));
            });
            await new Promise((r) => setTimeout(r, 300));

            const r1 = await call('sys.info');
            const r2 = await call('ftt.memoryShape');
            const r3 = await call('nope.notRegistered');
            const pass = r1.ok === true && r1.result && r1.result.note === 'selftest'
                && r2.ok === true && r2.result.atoms === 8 && r2.result.states === 4
                && r3.ok === false && r3.error.code === 'E_METHOD'
                && helloInfo && helloInfo.plugin.version === 'selftest';
            log('\n  ① 握手 hello 收到：' + (helloInfo ? '✅' : '❌'));
            log('  ② 调用回传（sys.info）：' + (r1.ok ? '✅' : '❌') + ' ' + JSON.stringify(r1.result));
            log('  ③ 调用回传（ftt.memoryShape）：' + (r2.ok ? '✅' : '❌') + ' ' + JSON.stringify(r2.result));
            log('  ④ 未登记方法被拒：' + (r3.ok === false && r3.error.code === 'E_METHOD' ? '✅' : '❌'));
            log('\n' + (pass ? '✅ 自检通过（握手 / 帧编解码 / 调用回传 / 拒绝 全部正常）' : '❌ 自检失败'));
            try { ws.close(); } catch (e) { /* 忽略 */ }
            srv.close(() => process.exit(pass ? 0 : 1));
        } catch (e) {
            log('❌ 自检异常：' + String((e && e.message) || e));
            try { if (ws) ws.close(); } catch (e2) { /* 忽略 */ }
            srv.close(() => process.exit(1));
        }
    });
    return;
}

if (SELFTEST) {
    selftest();
} else {
    server.listen(PORT, HOST, async () => {
        log('===== FTT记忆组件 V2 · 本地调试桥 =====');
        log('  监听：ws://' + HOST + ':' + PORT);
        log('  说明：插件开启「🔌 调试桥」后会主动连过来（页面无法监听端口，故方向相反）。');
        if (!IS_LOOPBACK) {
            log('');
            log('  ⚠ 已监听非回环地址：同一局域网内任何设备都能连上并读取这些**只读**数据');
            log('    （记忆条数/取样、调试日志统计、宿主日志与 LLM 请求留档）。本服务无鉴权，');
            log('    请在可信网络下临时使用，用完即停。插件侧「目标主机」填本机局域网地址。');
        }

        if (LISTONLY) { log('\n  命令：ls · hello · call <method> [json] · quit'); return; }

        if (ONESHOT) {
            const ok = await waitForClient(60000);
            if (!ok) { log('\n[bridge] ❌ 超时：没有插件连入。'); process.exit(2); }
            await new Promise((r) => setTimeout(r, 300));
            const res = await call(String(ONESHOT), PARAMS);
            log('\n' + JSON.stringify(res, null, 2));
            process.exit(res && res.ok ? 0 : 1);
        }

        log('\n  命令：ls · hello · call <method> [json] · quit');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.setPrompt('bridge> ');
        rl.prompt();
        rl.on('line', async (raw) => {
            const line = String(raw || '').trim();
            if (!line) { rl.prompt(); return; }
            const sp = line.indexOf(' ');
            const cmd = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
            const rest = (sp < 0 ? '' : line.slice(sp + 1)).trim();
            if (cmd === 'quit' || cmd === 'exit') { rl.close(); return; }
            if (cmd === 'ls') { printMethods(helloInfo ? (helloInfo.methods || []) : []); rl.prompt(); return; }
            if (cmd === 'hello') { log(helloInfo ? JSON.stringify(helloInfo, null, 2) : '（插件尚未连入）'); rl.prompt(); return; }
            if (cmd === 'call') {
                const s2 = rest.indexOf(' ');
                const method = (s2 < 0 ? rest : rest.slice(0, s2)).trim();
                const pj = (s2 < 0 ? '' : rest.slice(s2 + 1)).trim();
                if (!method) { log('用法：call <method> [json]'); rl.prompt(); return; }
                let params = {};
                if (pj) { try { params = JSON.parse(pj); } catch (e) { log('参数不是合法 JSON：' + String(e.message)); rl.prompt(); return; } }
                log(JSON.stringify(await call(method, params), null, 2));
                rl.prompt();
                return;
            }
            log('未知命令：' + cmd + '（可用：ls · hello · call · quit）');
            rl.prompt();
        });
        rl.on('close', () => { log('\n[bridge] 退出。'); process.exit(0); });
    });
}

process.on('SIGINT', () => { log('\n[bridge] 收到中断，退出。'); process.exit(0); });

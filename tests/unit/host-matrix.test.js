// ============================================================
// 单元测试 · 宿主能力矩阵桩化回归（`docs/D21` §3.3 / §8 技-16 · `docs/D22` W5）
//
// 背景（技-16）：`tests/local/` 里的**真机专属**项不进 `npm run gate`（该边界**保持不变**）；
//   但「宿主能力矩阵」本身可以在 Node 里用**桩宿主**覆盖，于是本文件把三条链路钉成自动回归：
//     ① `host/st-api.js#probeCapabilities()` 的能力分类（必需 / 可选缺失清单精确到项）；
//     ② `adapters/file-transport.js` 的**三后端路由**（宿主原生存储 / 酒馆用户目录文件 / 降级回退）；
//     ③ 「探针 → 回读 → 删」两个可在 Node 驱动的实现：
//        · `adapters/browser-fs.js#browserFsProbe`（伪 OPFS：`installGlobalOpfs`）；
//        · `adapters/local-file.js#localFileProbeDir`（宿主原生存储：`api.extension.store` 桩）。
//
// 口径（`docs/D21` §5 R7）：**新增用例必须能失败** —— 每条断言都咬在真实行为上
//   （写入次数 / 读回逐字相等 / 删除确实发生 / 路由确实选了哪条后端 / 失败带可读原因），
//   而不是「跑完没抛错就算过」。反向探针（故意改坏一条断言的前提 → 必须见到 ❌）已在落地时实测。
//
// 可达性说明：本文件**不改任何生产代码**；真机专属项仍留在 `tests/local/`。
// 运行：node tests/unit/host-matrix.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import {
    makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalOpfs, installGlobalFetch, makeOpfs,
} from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { probeCapabilities } from '../../host/st-api.js';
import { ttResetSession, ttNativeOn, ttNativeActive, ttKeyOf } from '../../adapters/tt-store.js';
import {
    fileTransportBackend, fileTransportReadAuto, fileTransportReadBytes, fileTransportUploadText,
    fileTransportDelete, fileTransportStatus, resetFileTransportSession, stFilesAllowed, tauriModeEnabled,
} from '../../adapters/file-transport.js';
import {
    localFileProbeDir, localFileNs, localFileName, localFileStatsGet, localFileStatsReset,
} from '../../adapters/local-file.js';
import {
    localDiskProbeDir, localDiskExists, localDiskReset, localDiskReprobe,
} from '../../adapters/local-disk.js';
import {
    browserFsProbe, browserFsAvailable, browserFsNote, browserFsReset, browserFsWrite,
} from '../../adapters/browser-fs.js';

const R = makeReporter('host-matrix 宿主能力矩阵桩化回归（D21 技-16）');
/** 同步断言 */
const S = (n, c, e) => R.assert(n, c === true, e);
/** 集合比较（顺序无关） */
const sorted = (a) => (Array.isArray(a) ? a.slice().sort() : []);
const eq = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** 全局宿主（提供 `globalThis.window`，`file-transport` 的 TauriTavern 探测要用它） */
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const unHostFile = installGlobalHost(makeHost({}), doc);
/** 直接换 `globalThis.SillyTavern`（A 组要逐格切换宿主；`makeHost` 每次给全新 ctx） */
const useStHost = (host) => {
    if (host) globalThis.SillyTavern = { getContext: () => host.ctx };
    else { try { delete globalThis.SillyTavern; } catch (e) { /* 忽略 */ } }
};

// ============================================================
// A 组：`probeCapabilities()` 分类矩阵
// ============================================================
const HAS_FETCH = typeof globalThis.fetch === 'function';
/** 必需能力（口径来自 `host/st-api.js#probeCapabilities` 的 `REQUIRED` 常量；A0 会与原文件逐字比对） */
const REQUIRED = ['context', 'eventSource', 'eventTypes', 'setExtensionPrompt', 'extensionSettings', 'saveSettingsDebounced', 'generateRaw', 'chat'];
/** 可选能力（= `need` 里除 REQUIRED 之外的键；A0b 用真实探针核对并集） */
const OPTIONAL = [
    'extensionPrompts', 'generateQuietPrompt', 'ConnectionManagerRequestService', 'chatMetadata', 'saveMetadata',
    'accountStorage', 'characters', 'characterId', 'deleteMessage', 'saveChat', 'saveChatConditional', 'clearChat',
    'printMessages', 'reloadCurrentChat', 'loadWorldInfo', 'saveWorldInfo', 'getWorldInfoNames',
    'renderExtensionTemplateAsync', 'callGenericPopup', 'addLocaleData', 'SlashCommandParser', 'macros',
    'variables', 'substituteParams', 'getExtensionManifest', 'fetch',
];
/** 期望的可选缺失清单（本机无 `fetch` 时把 `fetch` 一并算作缺失，避免环境差异造成假红） */
const opt = (list) => (HAS_FETCH ? list.slice() : list.concat(['fetch']));

console.log('\n[A] host/st-api.js#probeCapabilities() —— 宿主能力矩阵分类');

{
    // A0：先把「必需清单」钉在源码上 —— 本文件不得硬编码一份与 st-api.js 不一致的清单
    const src = readFileSync(new URL('../../host/st-api.js', import.meta.url), 'utf8');
    const m = /const REQUIRED = \[([\s\S]*?)\]/.exec(src);
    const srcRequired = m ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
    S('A0 本文件硬编码的 REQUIRED 与 host/st-api.js 源码逐字一致（口径漂移即失败）',
        srcRequired.length === REQUIRED.length && eq(srcRequired, REQUIRED), { src: srcRequired, local: REQUIRED });
}

/** 能力矩阵的每一格：宿主能力子集 → 期望分类 */
const CELLS = [
    {
        id: 'A1', title: '无宿主（globalThis.SillyTavern 缺失）', host: null,
        ok: false, req: REQUIRED, opt: opt(OPTIONAL.filter((k) => k !== 'fetch')),
    },
    {
        id: 'A2', title: 'makeHost({}) 完整宿主', host: {}, ok: true, req: [], opt: opt([]),
    },
    {
        id: 'A3', title: 'makeHost({noEventSource}) 缺事件源', host: { noEventSource: true },
        ok: false, req: ['eventSource', 'eventTypes'], opt: opt([]),
    },
    {
        id: 'A4', title: 'makeHost({noInject}) 缺注入接口（必需缺 1 / 可选缺 1）', host: { noInject: true },
        ok: false, req: ['setExtensionPrompt'], opt: opt(['extensionPrompts']),
    },
    {
        id: 'A5', title: 'makeHost({noDeleteMessage,noBulk,noSlash,noMacros,noTemplate}) 只缺可选能力',
        host: { noDeleteMessage: true, noBulk: true, noSlash: true, noMacros: true, noTemplate: true },
        ok: true, req: [],
        opt: opt(['deleteMessage', 'saveChat', 'saveChatConditional', 'clearChat', 'printMessages', 'reloadCurrentChat',
            'renderExtensionTemplateAsync', 'SlashCommandParser', 'macros']),
    },
];
{
    const seen = {};
    for (const c of CELLS) {
        useStHost(c.host ? makeHost(c.host) : null);
        const p = probeCapabilities();
        S(c.id + ' ok 精确（' + c.title + '）', p.ok === c.ok, { got: p.ok, want: c.ok, missReq: p.missingRequired });
        S(c.id + ' missingRequired 精确', eq(p.missingRequired, c.req), { got: p.missingRequired, want: c.req });
        S(c.id + ' missingOptional 精确', eq(p.missingOptional, c.opt), { got: p.missingOptional, want: c.opt });
        S(c.id + ' missing = 必需缺失 + 可选缺失（无重复、无遗漏）',
            p.missing.length === p.missingRequired.length + p.missingOptional.length,
            { missing: p.missing.length, req: p.missingRequired.length, opt: p.missingOptional.length });
        S(c.id + ' 必需缺失清单是 REQUIRED 的子集（分类不越界）',
            p.missingRequired.every((k) => REQUIRED.indexOf(k) >= 0), { missReq: p.missingRequired });
        // 每格都精确校验 need 的可判据（避免"清单对了但取值来源错了"）
        seen[c.id] = p.need;
    }
    // A0b：真实探针的 need 键集合 = REQUIRED ∪ OPTIONAL（本文件的两个常量不得漏项/多项）
    const needKeys = Object.keys(seen.A2);
    S('A0b REQUIRED ∪ OPTIONAL === 探针 need 的全部键（无漏项、无重复）',
        eq(needKeys, REQUIRED.concat(OPTIONAL)) && eq(needKeys, Array.from(new Set(needKeys))),
        { need: needKeys.length, sum: REQUIRED.length + OPTIONAL.length });
    // 逐格的 need 取值来源（抽查：分类必须来自"有无 / 类型"，不是别的东西）
    S('A1 need.context=false 且 need.eventSource=false（无宿主时不是"全部缺失"的假象）',
        seen.A1.context === false && seen.A1.eventSource === false && seen.A1.setExtensionPrompt === false);
    S('A3 need.eventSource/eventTypes 为假而其余必需仍为真（只差事件源这一格）',
        seen.A3.eventSource === false && seen.A3.eventTypes === false
        && seen.A3.setExtensionPrompt === true && seen.A3.extensionSettings === true && seen.A3.generateRaw === true);
    S('A4 need.setExtensionPrompt/extensionPrompts 为假（注入缺口被如实列出）',
        seen.A4.setExtensionPrompt === false && seen.A4.extensionPrompts === false && seen.A4.chat === true);
    S('A5 必需全真、可选缺口正是删楼与批量截断相关方法（含 reloadCurrentChat / renderExtensionTemplateAsync）',
        seen.A5.generateRaw === true && seen.A5.chat === true
        && seen.A5.deleteMessage === false && seen.A5.reloadCurrentChat === false
        && seen.A5.renderExtensionTemplateAsync === false && seen.A5.getWorldInfoNames === true);
}
useStHost(null);

// ============================================================
// B 组：`adapters/file-transport.js` 三后端路由
// ============================================================
/** 酒馆用户目录文件桩（内存：upload / GET / delete 三种端点，与 `adapters/user-file.js` 同口径） */
const files = new Map();
const calls = [];
async function memFetch(url, opts) {
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: String(url), method: method });
    if (String(url).indexOf('/api/files/upload') === 0) {
        let body = null;
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        files.set(String(body.name), Buffer.from(String(body.data || ''), 'base64').toString('utf8'));
        return { status: 200, text: 'ok' };
    }
    if (String(url).indexOf('/api/files/delete') === 0) {
        let body = null;
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        const name = String((body && body.path) || '').replace('/user/files/', '');
        return files.delete(name) ? { status: 200, text: 'ok' } : { status: 404, text: 'not found' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const name = decodeURIComponent(m[1]);
        if (!files.has(name)) return { status: 404, text: 'not found' };
        return { status: 200, text: files.get(name) };
    }
    return { status: 404, text: '' };
}
let unFetch = installGlobalFetch(memFetch);
const urls = () => calls.map((c) => c.url);

/**
 * 宿主原生存储桩（官方 `api.extension.store` 契约；`noStore:true` 时连 store 一起抽掉 →
 * 模拟「宿主已识别（`__TAURITAVERN__` 在位）但原生 API 尚未就位」）。
 */
function makeTtHost(opts) {
    const o = opts || {};
    const kv = new Map();
    const blobs = new Map();
    const tc = { set: 0, tryGet: 0, get: 0, del: 0, setBlob: 0, getBlob: 0, delBlob: 0, listBlobKeys: 0 };
    const k = (a) => String(a.namespace) + '/' + String(a.table || 'main') + '/' + String(a.key);
    const store = {
        async setJson(a) { tc.set++; if (o.setError) throw new Error(o.setError); kv.set(k(a), a.value); },
        async tryGetJson(a) { tc.tryGet++; return kv.has(k(a)) ? { found: true, value: kv.get(k(a)) } : { found: false }; },
        async getJson(a) { tc.get++; if (!kv.has(k(a))) throw new Error('Not found: Extension store JSON entry not found'); return kv.get(k(a)); },
        async deleteJson(a) { tc.del++; kv.delete(k(a)); },
        async listKeys(a) { const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(kv.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
        async setBlob(a) { tc.setBlob++; if (o.blobSetError) throw new Error(o.blobSetError); const d = a.data; blobs.set(k(a), (d instanceof Uint8Array) ? d : new Uint8Array(d || [])); },
        async getBlob(a) { tc.getBlob++; if (!blobs.has(k(a))) throw new Error('Not found: Extension store blob entry not found'); return new Blob([blobs.get(k(a))]); },
        async deleteBlob(a) { tc.delBlob++; blobs.delete(k(a)); },
        async listBlobKeys(a) { tc.listBlobKeys++; const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(blobs.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
    };
    const abi = o.noStore
        ? { abiVersion: 1, ready: Promise.resolve(true), api: { extension: {} } }
        : { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store: store } } };
    return { abi: abi, store: store, kv: kv, blobs: blobs, calls: tc };
}
/** 复位环境（可选装宿主 ABI；cfg 回默认；清两边桩） */
function boot(ttAbi) {
    unFetch();
    unFetch = installGlobalFetch(memFetch);
    resetFileTransportSession();
    ttResetSession();
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    if (ttAbi) globalThis.window.__TAURITAVERN__ = ttAbi;
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setKernelState(emptyState());
    setScopeKey('char:host-matrix');
    files.clear();
    calls.length = 0;
    resetFileTransportSession();
    ttResetSession();
}

(async function main() {
    console.log('\n[B1] 三后端路由 · ① 宿主原生存储可用（tt-native）');
    {
        const h = makeTtHost();
        boot(h.abi);
        S('B1 后端解析为宿主原生存储（且自动模式开启）',
            fileTransportBackend() === 'tt-native' && tauriModeEnabled() === true);
        const body = '{"v":1,"route":"native"}';
        const w = await fileTransportUploadText('ftt2-matrix-a.json', body);
        const raw = h.kv.get('ftt2-files/main/ftt2-matrix-a.json');
        S('B1 写：落原生 KV（namespace/table/key 正确，base64 内容可还原）',
            w.ok === true && w.backend === 'tt-native' && w.channel === 'kv'
            && !!raw && raw.k === 'b64'
            && Buffer.from(String(raw.v), 'base64').toString('utf8') === body, { w: w });
        S('B1 写不触网（文件通道零请求）', calls.length === 0, { urls: urls() });
        const r = await fileTransportReadAuto('ftt2-matrix-a.json');
        S('B1 读：原生命中（不触网，文本逐字一致）',
            r.ok === true && r.backend === 'tt-native' && r.text === body && calls.length === 0, { r: r });
        const d = await fileTransportDelete('ftt2-matrix-a.json');
        S('B1 删：原生删除生效（key 消失；文件通道未参与）',
            d.ok === true && d.native === true && d.files === false && !h.kv.has('ftt2-files/main/ftt2-matrix-a.json'), { d: d });
    }

    console.log('\n[B2] 三后端路由 · ② 原生不可用（未检测到宿主）→ 酒馆用户目录文件，行为与旧通道一致');
    {
        boot(null);
        S('B2 后端解析为酒馆文件通道', fileTransportBackend() === 'st-files' && tauriModeEnabled() === true);
        calls.length = 0;
        const body = '{"v":1,"route":"files"}';
        const w = await fileTransportUploadText('ftt2-matrix-b.json', body);
        S('B2 写：单次 POST /api/files/upload（返回形状与旧通道一致：无 backend 字段）',
            w.ok === true && w.backend === undefined && calls.length === 1
            && calls[0].url === '/api/files/upload' && calls[0].method === 'POST'
            && files.get('ftt2-matrix-b.json') === body, { w: w, urls: urls() });
        calls.length = 0;
        const r = await fileTransportReadAuto('ftt2-matrix-b.json');
        S('B2 读：单次 GET /user/files/<name>（零额外请求 / 零额外微任务层这一格不产生额外后端探测）',
            r.ok === true && r.backend === undefined && r.text === body
            && calls.length === 1 && calls[0].url === '/user/files/ftt2-matrix-b.json', { r: r, urls: urls() });
        calls.length = 0;
        const d = await fileTransportDelete('ftt2-matrix-b.json');
        S('B2 删：单次 POST /api/files/delete 且文件真的没了',
            d.ok === true && calls.filter((c) => c.url === '/api/files/delete').length === 1
            && !files.has('ftt2-matrix-b.json'), { d: d, urls: urls() });
    }

    console.log('\n[B3] 三后端路由 · ②b 宿主已识别但原生 API 未就位 → 回退文件通道（nativeError=not-ready）');
    {
        const h = makeTtHost({ noStore: true });
        boot(h.abi);
        S('B3 前提：ttNativeOn=true / ttNativeActive=false → 后端解析仍为文件通道',
            ttNativeOn() === true && ttNativeActive() === false && fileTransportBackend() === 'st-files');
        const body = '{"v":1,"route":"fallback"}';
        const w = await fileTransportUploadText('ftt2-matrix-c.json', body);
        S('B3 写：降级到文件通道并**如实**报 nativeError=not-ready（绝不丢数据）',
            w.ok === true && w.backend === 'st-files' && String(w.nativeError) === 'not-ready'
            && files.get('ftt2-matrix-c.json') === body, { w: w });
        const rb = await fileTransportReadBytes('ftt2-matrix-c.json');
        S('B3 原始字节读：同样回退文件通道（这条路径不做就绪等待）',
            rb.ok === true && rb.backend === 'st-files' && rb.bytes.length === body.length, { rb: null });
        // 文本读会先走一次「启动早期就绪等待」（v3.0.11，上限 TT_READY_WAIT_MS）→ 本会话只等一次
        const r = await fileTransportReadAuto('ftt2-matrix-c.json');
        S('B3 文本读：就绪等待到点后回退读文件（把「还没就位」与「原生没有数据」区分开）',
            r.ok === true && r.backend === 'st-files' && r.text === body, { r: r });
        const t0 = Date.now();
        const r2 = await fileTransportReadAuto('ftt2-matrix-c.json');
        S('B3 就绪等待只发生一次：同会话再读即时返回（装配时序不受影响）',
            r2.ok === true && (Date.now() - t0) < 300, { ms: Date.now() - t0 });
        const d = await fileTransportDelete('ftt2-matrix-c.json');
        S('B3 删：原生未就位 → 文件通道删除生效（native=false / files=true）',
            d.ok === true && d.native === false && d.files === true && !files.has('ftt2-matrix-c.json'), { d: d });
    }

    console.log('\n[B4] 三后端路由 · ③ 原生命中为空 → 回退酒馆文件通道（并按 key 记住命中后端）');
    {
        const h = makeTtHost();
        boot(h.abi);
        files.set('ftt2-matrix-d.json', '{"v":1,"route":"files-legacy"}');
        calls.length = 0;
        const r = await fileTransportReadAuto('ftt2-matrix-d.json');
        S('B4 原生未命中 → 回退文件通道（backend=st-files；原生确实被探测过、文件通道确实被请求）',
            r.ok === true && r.backend === 'st-files' && r.text === '{"v":1,"route":"files-legacy"}'
            && h.calls.tryGet >= 1 && urls().indexOf('/user/files/ftt2-matrix-d.json') >= 0, { r: r, urls: urls() });
        const before = h.calls.tryGet;
        const r2 = await fileTransportReadAuto('ftt2-matrix-d.json');
        S('B4 v3.0.11：文件通道路由**不钉死** —— 原生可用时同键再读会复核原生（force 绕开未命中抑制）',
            r2.ok === true && r2.backend === 'st-files' && h.calls.tryGet === before + 1,
            { tryGet: h.calls.tryGet, before: before });
        // 原生已接管 + 文件通道也 404 → 本会话停用回退（不再无谓探测）
        calls.length = 0;
        const miss = await fileTransportReadAuto('ftt2-matrix-e.json');
        S('B4 两侧都没有 → 如实失败（ok:false）且文件通道被判 404 后停用回退',
            miss.ok === false && stFilesAllowed() === false && fileTransportStatus().stFilesReason === 'read-404', { miss: miss });
        const n = calls.length;
        const miss2 = await fileTransportReadAuto('ftt2-matrix-e2.json');
        S('B4 停用后不再无谓探测（零新增文件通道请求）',
            miss2.ok === false && calls.length === n, { urls: urls() });
    }

    // ============================================================
    // C 组：「探针 → 回读 → 删」
    // ============================================================
    console.log('\n[C1] 探针链 · browser-fs（伪 OPFS）：写 → 回读逐字相等 → 删掉自己的探针文件');
    /** 给 `makeOpfs()` 装观测层：记录写入 / 读回 / 删除；`tamperRead` 可让回读内容被篡改 */
    const instrumentOpfs = (opfs, opts) => {
        const o = opts || {};
        const log = { writes: [], reads: [], removes: [], dirs: [] };
        const wrapDir = (h) => ({
            kind: 'directory', name: h.name,
            getDirectoryHandle: async (n, op) => { log.dirs.push(String(n)); return wrapDir(await h.getDirectoryHandle(n, op)); },
            getFileHandle: async (n, op) => {
                const fh = await h.getFileHandle(n, op);
                return {
                    kind: 'file', name: fh.name,
                    createWritable: async () => {
                        const ws = await fh.createWritable();
                        return { write: async (t) => { log.writes.push(String(t)); return ws.write(t); }, close: () => ws.close() };
                    },
                    getFile: async () => {
                        const f = await fh.getFile();
                        const text = o.tamperRead === undefined ? await f.text() : String(o.tamperRead);
                        log.reads.push(text);
                        return { size: text.length, text: async () => text };
                    },
                };
            },
            removeEntry: async (n) => { log.removes.push(String(n)); return h.removeEntry(n); },
            entries: h.entries ? h.entries.bind(h) : undefined,
        });
        const orig = opfs.storage.getDirectory;
        opfs.storage.getDirectory = async () => wrapDir(await orig());
        return log;
    };
    {
        const opfs = makeOpfs();
        const log = instrumentOpfs(opfs);
        const unOpfs = installGlobalOpfs(opfs);
        browserFsReset();
        S('C1 前提：OPFS 可用（navigator.storage.getDirectory 在位）',
            browserFsAvailable() === true && String(browserFsNote()).indexOf('OPFS') > 0);
        const pr = await browserFsProbe('probe-dir');
        S('C1 探针通过：ok + 逐字路径 + 机制 browser-opfs',
            pr.ok === true && String(pr.path) === 'probe-dir/ftt2-local-probe.json' && pr.mechanism === 'browser-opfs', pr);
        S('C1 探针文件**真的写了**（恰好一次，载荷就是探针体）',
            log.writes.length === 1 && /"probe":1/.test(log.writes[0]) && /"backend":"browser-opfs"/.test(log.writes[0]),
            { writes: log.writes.length });
        S('C1 **回读逐字节一致**（读回文本 === 写入文本；这是"能写"的判据，不是走过场）',
            log.reads.length === 1 && log.reads[0] === log.writes[0], { reads: log.reads.length });
        S('C1 **删掉自己的探针文件**（删除调用命中该文件名，且目录树里不再有它）',
            log.removes.indexOf('ftt2-local-probe.json') >= 0
            && opfs.files().indexOf('probe-dir/ftt2-local-probe.json') < 0
            && opfs.files().length === 0, { removes: log.removes, files: opfs.files() });
        unOpfs();
        browserFsReset();
    }

    console.log('\n[C2] 探针链 · browser-fs：OPFS 不可用时**降级失败并给可读原因**（绝不静默成功）');
    {
        const unOpfs = installGlobalOpfs(null);      // navigator 在位、storage 缺失
        browserFsReset();
        S('C2 前提：OPFS 不可用',
            browserFsAvailable() === false && String(browserFsNote()).indexOf('不支持内置目录') > 0, { note: browserFsNote() });
        const w = await browserFsWrite('probe-dir/x.json', 'x');
        S('C2 写入如实失败（error=no-opfs）', w.ok === false && w.error === 'no-opfs', { w: w });
        const pr = await browserFsProbe('probe-dir');
        S('C2 探针返回 ok:false + 可读原因（error=no-opfs，且仍标注机制便于诊断）',
            pr.ok === false && String(pr.error) === 'no-opfs' && pr.mechanism === 'browser-opfs'
            && String(pr.path) === 'probe-dir/ftt2-local-probe.json', pr);
        unOpfs();
        browserFsReset();
    }

    console.log('\n[C3] 探针链 · browser-fs：回读被篡改 → verify-failed（证明回读真的逐字比对）');
    {
        const opfs = makeOpfs();
        const log = instrumentOpfs(opfs, { tamperRead: '{"probe":0,"tampered":true}' });
        const unOpfs = installGlobalOpfs(opfs);
        browserFsReset();
        const pr = await browserFsProbe('probe-dir');
        S('C3 写入成功但回读不一致 → 探针如实失败为 verify-failed（不谎报可写）',
            pr.ok === false && pr.error === 'verify-failed'
            && log.writes.length === 1 && log.reads.length === 1 && log.reads[0] !== log.writes[0], pr);
        S('C3 校验不过时**不删**（保留现场，不假装清理过）',
            log.removes.length === 0 && opfs.files().indexOf('probe-dir/ftt2-local-probe.json') >= 0,
            { removes: log.removes, files: opfs.files() });
        unOpfs();
        browserFsReset();
    }

    console.log('\n[C4] 探针链 · local-file（宿主原生存储）：写 → 回读逐字相等 → 删掉自己的探针文件');
    {
        // 记录型原生存储桩：把「写了什么 / 读回了什么 / 删了哪个 key」全部留证
        const kv = new Map();
        const blobs = new Map();
        const log = { writes: [], reads: [], deletes: [] };
        const kk = (a) => String(a.namespace) + '/' + String(a.table || 'main') + '/' + String(a.key);
        const dec = (v) => Buffer.from(String((v && v.v) || ''), 'base64').toString('utf8');
        const store = {
            async setJson(a) { kv.set(kk(a), a.value); log.writes.push({ key: kk(a), text: dec(a.value) }); },
            async tryGetJson(a) { const key = kk(a); if (!kv.has(key)) return { found: false }; log.reads.push({ key: key, text: dec(kv.get(key)) }); return { found: true, value: kv.get(key) }; },
            async getJson(a) { const key = kk(a); if (!kv.has(key)) throw new Error('Not found: ' + key); return kv.get(key); },
            async deleteJson(a) { log.deletes.push(kk(a)); kv.delete(kk(a)); },
            async listKeys(a) { const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(kv.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
            async setBlob(a) { const d = a.data; blobs.set(kk(a), (d instanceof Uint8Array) ? d : new Uint8Array(d || [])); },
            async getBlob(a) { const key = kk(a); if (!blobs.has(key)) throw new Error('Not found: ' + key); return new Blob([blobs.get(key)]); },
            async deleteBlob(a) { log.deletes.push(kk(a)); blobs.delete(kk(a)); },
            async listBlobKeys(a) { const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(blobs.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
        };
        boot({ abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store: store } } });
        localFileStatsReset();
        const dir = '校验目录';
        const ns = localFileNs(dir);
        const probeName = localFileName('probe', dir);
        const storeKey = ns + '/local/' + ttKeyOf(probeName);
        const pr = await localFileProbeDir(dir);
        S('C4 探针通过：ok + 归一目录 + 命名空间合法（宿主契约字符集）+ 探针名与写读同一来源',
            pr.ok === true && pr.path === dir && pr.ns === ns && /^[A-Za-z0-9_.-]+$/.test(ns)
            && pr.name === probeName && pr.backend === 'tt-native', pr);
        S('C4 探针文件**真的写了**（恰好一次，载荷含 probe:1 与目录名，key 为宿主归一后的键）',
            log.writes.length === 1 && log.writes[0].key === storeKey
            && /"probe":1/.test(log.writes[0].text) && log.writes[0].text.indexOf('"dir":"' + dir + '"') > 0,
            { writes: log.writes.map((x) => x.key) });
        S('C4 **回读逐字节一致**（读回文本 === 写入文本）',
            log.reads.length >= 1 && log.reads[0].key === storeKey && log.reads[0].text === log.writes[0].text,
            { reads: log.reads.length });
        S('C4 **删掉自己的探针文件**（删除命中同一 key，kv / blobs 里都不再留它）',
            log.deletes.indexOf(storeKey) >= 0 && !kv.has(storeKey) && !blobs.has(storeKey),
            { deletes: log.deletes });
        S('C4 目录里没有残留探针文件（"探测过就留一个文件"是不允许的）',
            Array.from(kv.keys()).concat(Array.from(blobs.keys())).filter((x) => x.indexOf('probe') >= 0).length === 0,
            { left: Array.from(kv.keys()) });
        S('C4 统计如实：probes +1、后端 = tt-native',
            Number(localFileStatsGet().probes) >= 1 && localFileStatsGet().backend === 'tt-native', { st: localFileStatsGet().probes });
    }

    console.log('\n[C5] 探针链 · local-file：写入失败 → 降级失败并给可读原因（不留残骸、不谎报）');
    {
        boot(null);
        unFetch();
        unFetch = installGlobalFetch(async () => ({ status: 500, text: 'boom' }));
        const pr = await localFileProbeDir('写不进去');
        S('C5 探针降级失败：ok:false + 可读原因（write-failed）',
            pr.ok === false && typeof pr.error === 'string' && pr.error.length > 0 && pr.error === 'write-failed', pr);
        S('C5 失败时没有留下任何探针文件（写入根本没成功）',
            files.size === 0 && Array.from(files.keys()).filter((x) => x.indexOf('probe') >= 0).length === 0, { files: Array.from(files.keys()) });
    }

    console.log('\n[C6] 可达性 · `adapters/local-disk.js#localDiskProbeDir` 的「删」在 api.dev 机制下**不可达**（缺陷证据）');
    {
        // 这一格**不是**「Node 桩不出来」：写与回读都能桩，探针本身也真的通过（对照 `tests/unit/local-disk.test.js` A4）。
        // 不可达的是探针末尾的**清理步骤** —— `localDiskExists` / `diskRemove` 只有三格路由
        //   （浏览器内置目录 / 会话文件夹句柄 / Tauri 原始桥 `plugin:fs|*`），**没有 `api.dev` 一格**，
        //   而 `diskWriteText` / `diskReadText` / `localDiskList` 都有。于是 api.dev 形态的宿主上：
        //   探针写进去了、回读也校验通过，但探针文件**留在用户的目录里**（`ftt2-local-probe.json`）。
        // 本断言是**行为证据**（不是硬编码文案）：盘上确实有探针文件、而 `localDiskExists()` 恒为 false。
        // ⚠️ 缺陷修复后本断言会失败 —— 那正是它的价值：届时应改为断言「探针已被清理」。
        const devDisk = new Map();
        globalThis.window.__TAURITAVERN__ = {
            abiVersion: 1, ready: Promise.resolve(true),
            api: {
                dev: {
                    files: {
                        async writeTextFile(a) { devDisk.set(String(a.path), String(a.text != null ? a.text : a.content)); return { ok: true }; },
                        async readTextFile(a) { const k = String(a.path); if (!devDisk.has(k)) throw new Error('ENOENT: ' + k); return { text: devDisk.get(k) }; },
                    },
                },
                extension: { store: {} },
            },
        };
        localDiskReset();
        localDiskReprobe();
        cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: 'D:\\matrix-store' });
        const pr = await localDiskProbeDir('D:\\matrix-store');
        const probePath = 'D:\\matrix-store\\ftt2-local-probe.json';
        const existsSeen = await localDiskExists(probePath);
        S('C6 api.dev 机制下探针本身成立：写 → 回读校验通过（ok:true / mechanism=dev-api）',
            pr.ok === true && pr.mechanism === 'dev-api' && String(pr.path) === probePath, { pr: pr });
        S('C6 【缺陷证据】探针文件仍在盘上（devDisk 里有它），但 localDiskExists() 恒为 false → 清理分支不可达',
            devDisk.has(probePath) === true && existsSeen === false,
            { onDisk: Array.from(devDisk.keys()), exists: existsSeen });
        try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
        localDiskReset();
    }

    // 收尾：还原全局桩
    unFetch();
    browserFsReset();
    useStHost(null);
    unHostFile();
    R.done();
})().catch((e) => { console.error('❌ host-matrix.test.js 异常中断:', e); process.exit(1); });

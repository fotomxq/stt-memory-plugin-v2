// ============================================================
// 单元测试 · v2.77.0 文件通道后端路由（宿主原生存储 / 酒馆用户目录文件）
//
// 语义来源（V1 v1.150/v1.156 行为口径，逐条对齐）：
//   · 未检测到宿主 → 保持酒馆用户目录文件通道，**行为与旧实现完全一致**（不多一次请求、返回值同形）；
//   · 检测到 TauriTavern（`window.__TAURITAVERN__`）→ 记忆文件 / 备份 / 快照 / 清单 / 日志镜像
//     自动改走宿主原生存储；读取**原生优先、未命中回退**酒馆文件（旧数据迁移）；原生命中时不触网；
//   · `cfg.storage.tauriNative` = auto（默认）/ on（强制）/ off（始终用文件通道）；
//   · `cfg.storage.tauriMirror` = 原生模式下额外镜像写一份酒馆文件；
//   · 原生写失败 → **自动回退**文件通道（绝不丢数据）；写/读按 key 记住命中后端（避免反复探测）。
// 运行：node tests/unit/file-transport.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { TT_KV_MAX_BYTES, ttResetSession, ttTextBytes, ttGetBytes } from '../../adapters/tt-store.js';
import {
    fileTransportBackend, fileTransportReadAuto, fileTransportReadBytes, fileTransportUploadText,
    fileTransportUploadGz, fileTransportDelete, fileTransportStatus, fileTransportListKeys,
    fileTransportKey, resetFileTransportSession, stFilesAllowed, tauriModeEnabled,
} from '../../adapters/file-transport.js';
import { readStateFileAuto } from '../../adapters/user-file.js';
import { storagePageHtml } from '../../ui/sync.js';
import { SETTINGS_CONTROLS } from '../../ui/settings-pages.js';

const R = makeReporter('file-transport v2.77.0 文件通道后端路由');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };

// ---------- 酒馆用户目录文件（内存桩） ----------
const files = new Map();
const calls = [];
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const unHost = installGlobalHost(makeHost({}), doc);
async function memFetch(url, opts) {
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: String(url), method });
    if (String(url).indexOf('/api/files/upload') === 0) {
        let body = null;
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        let text = '';
        try { text = Buffer.from(String(body.data || ''), 'base64').toString('utf8'); } catch (e) { text = ''; }
        files.set(String(body.name), text);
        return { status: 200, text: 'ok' };
    }
    if (String(url).indexOf('/api/files/delete') === 0) {
        let body = null;
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        const name = String((body && body.path) || '').replace('/user/files/', '');
        const had = files.delete(name);
        return { status: had ? 200 : 404, text: had ? 'ok' : 'not found' };
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

// ---------- 宿主原生存储桩（官方契约；记录调用） ----------
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
    return { abi: { ready: Promise.resolve(true), api: { extension: { store } } }, store, kv, blobs, calls: tc };
}

/** 重置环境（可选装宿主；cfg 复位到默认） */
function boot(host) {
    unFetch();                                   // 恢复酒馆文件通道桩（前一段可能装了 noNet）
    unFetch = installGlobalFetch(memFetch);
    resetFileTransportSession();
    ttResetSession();
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    if (host) globalThis.window.__TAURITAVERN__ = host.abi;
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setKernelState(emptyState());
    setScopeKey('char:tt-route');
    files.clear();
    calls.length = 0;
    resetFileTransportSession();
    ttResetSession();
    return host || null;
}
const noNet = () => { globalThis.fetch = async () => { throw new Error('不应发起网络请求'); }; };
const urls = () => calls.map((c) => c.url);

(async function main() {
    console.log('\n[A1] 未检测到宿主：行为与旧实现完全一致（零额外请求）');
    {
        boot(null);
        await A('A1 后端解析为酒馆用户目录文件', () => fileTransportBackend() === 'st-files' && tauriModeEnabled() === true);
        await A('A1 读取 = 单次 GET /user/files/<name>（与旧通道同形同序，零额外字段/层次）', async () => {
            files.set('ftt2-state-a.json', '{"v":1,"from":"files"}');
            calls.length = 0;
            const r = await fileTransportReadAuto('ftt2-state-a.json');
            return r.ok === true && r.gz === false && r.text.indexOf('"from":"files"') > 0
                && r.backend === undefined && fileTransportBackend() === 'st-files'
                && urls().length === 1 && urls()[0] === '/user/files/ftt2-state-a.json';
        });
        await A('A1 写入 = 单次 POST /api/files/upload（name + base64 data，解码后与原文一致）', async () => {
            calls.length = 0;
            const r = await fileTransportUploadText('ftt2-state-b.json', '{"v":1,"hello":"酒馆"}');
            const up = calls.filter((c) => c.url === '/api/files/upload');
            return r.ok === true && r.backend === undefined && up.length === 1 && up[0].method === 'POST'
                && files.get('ftt2-state-b.json') === '{"v":1,"hello":"酒馆"}';
        });
        await A('A1 缺失文件 → ok:false（与旧通道同形：404 不抛错）', async () => {
            const r = await fileTransportReadAuto('ftt2-state-none.json');
            return r.ok === false && r.status === 404 && r.backend === undefined;
        });
        await A('A1 零额外微任务层：无宿主读取的「落定微任务步数」与直接调用旧通道逐拍一致（装配时序不受影响）', async () => {
            files.set('ftt2-state-tick.json', '{"v":1,"tick":true}');
            const count = (p) => new Promise((res) => {
                let n = 0;
                const spin = () => { n += 1; if (n > 40) return res(-1); Promise.resolve().then(spin); };
                Promise.resolve(p).then(() => res(n), () => res(-1));
                spin();
            });
            const direct = await count(readStateFileAuto('ftt2-state-tick.json'));
            resetFileTransportSession();
            const via = await count(fileTransportReadAuto('ftt2-state-tick.json'));
            return direct > 0 && via === direct;
        });
        await A('A1 删除 = 单次 POST /api/files/delete', async () => {
            calls.length = 0;
            const r = await fileTransportDelete('ftt2-state-b.json');
            const del = calls.filter((c) => c.url === '/api/files/delete');
            return r.ok === true && r.backend === undefined && del.length === 1 && !files.has('ftt2-state-b.json');
        });
    }

    console.log('\n[B1] 检测到宿主：自动切换到原生存储（写读均不触网）');
    {
        const h = boot(makeTtHost());
        noNet();
        await A('B1 后端解析为宿主原生存储', () => fileTransportBackend() === 'tt-native' && fileTransportStatus().channel.native === true);
        await A('B1 写入落原生存储（namespace/table/key 正确；小载荷走 KV）', async () => {
            const r = await fileTransportUploadText('ftt2-meta-a.json', '{"v":1,"meta":true}');
            const v = h.kv.get('ftt2-files/main/ftt2-meta-a.json');
            return r.ok === true && r.backend === 'tt-native' && r.channel === 'kv' && !!v && v.k === 'b64'
                && Buffer.from(String(v.v), 'base64').toString('utf8') === '{"v":1,"meta":true}';
        });
        await A('B1 大载荷写入走 Blob 通道（官方推荐：大文件用 Blob）', async () => {
            const big = 'x'.repeat(TT_KV_MAX_BYTES + 100);
            const r = await fileTransportUploadText('ftt2-state-big.json', big);
            return r.ok === true && r.channel === 'blob' && h.blobs.get('ftt2-files/main/ftt2-state-big.json').length === big.length;
        });
        await A('B1 读取原生命中（不触网，明文回读正确）', async () => {
            calls.length = 0;
            const r = await fileTransportReadAuto('ftt2-meta-a.json');
            return r.ok === true && r.backend === 'tt-native' && r.text === '{"v":1,"meta":true}' && urls().length === 0;
        });
        await A('B1 大载荷回读（Blob → 文本）', async () => {
            const r = await fileTransportReadAuto('ftt2-state-big.json');
            return r.ok === true && r.backend === 'tt-native' && r.text.length === TT_KV_MAX_BYTES + 100;
        });
        await A('B1 原始字节读取（V1 导入器路径）走原生', async () => {
            const r = await fileTransportReadBytes('ftt2-state-big.json');
            return r.ok === true && r.backend === 'tt-native' && r.bytes.length === TT_KV_MAX_BYTES + 100;
        });
        await A('B1 原生删除生效（无需文件通道）', async () => {
            const r = await fileTransportDelete('ftt2-meta-a.json');
            return r.ok === true && r.native === true && !h.kv.has('ftt2-files/main/ftt2-meta-a.json');
        });
    }

    console.log('\n[B2] 原生未命中 → 回退酒馆文件通道（旧数据迁移），并按 key 记住命中后端');
    {
        const h = boot(makeTtHost());
        await A('B2 原生命中为空 → 回退 GET /user/files（V1 B3 语义）', async () => {
            files.set('ftt2-state-legacy.json', '{"v":1,"from":"files"}');
            calls.length = 0;
            const r = await fileTransportReadAuto('ftt2-state-legacy.json');
            return r.ok === true && r.backend === 'st-files' && urls().indexOf('/user/files/ftt2-state-legacy.json') >= 0;
        });
        await A('B2 命中过文件通道后，同键再读优先文件通道（原生探测次数不增）', async () => {
            const before = h.calls.tryGet;
            calls.length = 0;
            const r = await fileTransportReadAuto('ftt2-state-legacy.json');
            return r.ok === true && r.backend === 'st-files' && h.calls.tryGet === before && urls().length === 1;
        });
        await A('B2 原生已接管且文件通道 404 → 本会话停用回退（不再无谓探测）', async () => {
            const r1 = await fileTransportReadAuto('ftt2-state-ghost.json');
            const before = calls.length;
            const r2 = await fileTransportReadAuto('ftt2-state-ghost2.json');
            return r1.ok === false && r2.ok === false && stFilesAllowed() === false && calls.length === before;
        });
        await A('B2 停用状态在通道诊断中如实呈现', () => {
            const s = fileTransportStatus();
            return s.stFilesAllowed === false && s.stFilesReason === 'read-404' && s.channel.native === true;
        });
        resetFileTransportSession();
    }

    console.log('\n[B3] 强制语义：off 用文件通道 / on（无宿主）不激活并回退');
    {
        const h = boot(makeTtHost());
        cfg.storage.tauriNative = 'off';
        await A('B3 off：即便检测到宿主也走酒馆文件通道（原生无新增写入）', async () => {
            const before = h.calls.set + h.calls.setBlob;
            const w = await fileTransportUploadText('ftt2-state-off.json', '{"v":1}');
            return w.ok === true && w.backend === undefined && fileTransportBackend() === 'st-files'
                && (h.calls.set + h.calls.setBlob) === before && files.get('ftt2-state-off.json') === '{"v":1}';
        });
        await A('B3 off：读取也不探测原生存储', async () => {
            const before = h.calls.tryGet;
            const r = await fileTransportReadAuto('ftt2-state-off.json');
            return r.ok === true && r.backend === undefined && h.calls.tryGet === before;
        });
        boot(null);
        cfg.storage.tauriNative = 'on';
        await A('B3 on（无宿主）：后端仍为文件通道且写入不丢数据', async () => {
            const w = await fileTransportUploadText('ftt2-state-on.json', '{"v":1}');
            const r = await fileTransportReadAuto('ftt2-state-on.json');
            // 意图原生但 API 不在位 → 走路由内的回退分支（该分支带 backend 标记），结果仍落到文件通道
            return fileTransportBackend() === 'st-files' && w.ok === true && w.backend === 'st-files'
                && String(w.nativeError || '') === 'not-ready' && r.ok === true && r.text === '{"v":1}';
        });
    }

    console.log('\n[B4] 镜像与失败回退');
    {
        const h = boot(makeTtHost());
        cfg.storage.tauriMirror = true;
        await A('B4 镜像开启：原生写入后额外写一份酒馆文件（双份都在）', async () => {
            const w = await fileTransportUploadText('ftt2-state-mir.json', '{"v":1,"mirror":true}');
            return w.ok === true && w.backend === 'tt-native' && w.mirror === true
                && !!h.kv.get('ftt2-files/main/ftt2-state-mir.json') && files.get('ftt2-state-mir.json') === '{"v":1,"mirror":true}';
        });
        await A('B4 镜像关闭时不写文件通道', async () => {
            cfg.storage.tauriMirror = false;
            calls.length = 0;
            const w = await fileTransportUploadText('ftt2-state-nomir.json', '{"v":1}');
            return w.ok === true && w.mirror === false && files.has('ftt2-state-nomir.json') === false;
        });
        const h2 = boot(makeTtHost({ setError: 'host store read-only' }));
        await A('B4 KV 写失败但 Blob 可用 → 仍在原生存储内降级（不越界回退文件通道）', async () => {
            const w = await fileTransportUploadText('ftt2-state-kvfb.json', '{"v":1,"kvFail":true}');
            return w.ok === true && w.backend === 'tt-native' && w.channel === 'blob'
                && !!h2.blobs.get('ftt2-files/main/ftt2-state-kvfb.json') && files.has('ftt2-state-kvfb.json') === false;
        });
        const h3 = boot(makeTtHost({ setError: 'host store read-only', blobSetError: 'host blob read-only' }));
        await A('B4 原生两条通道都写不进 → 自动回退酒馆文件通道（不丢数据）', async () => {
            const w = await fileTransportUploadText('ftt2-state-fb.json', '{"v":1,"fallback":true}');
            return w.ok === true && w.backend === 'st-files' && String(w.nativeError || '').indexOf('read-only') >= 0
                && files.get('ftt2-state-fb.json') === '{"v":1,"fallback":true}' && h3.kv.size === 0 && h3.blobs.size === 0;
        });
    }

    console.log('\n[B5] 删除双端 / gzip 写入 / 键清单 / 页面接线');
    {
        const h = boot(makeTtHost());
        await A('B5 删除：原生与酒馆文件两侧都清（避免被另一侧唤醒）', async () => {
            await fileTransportUploadText('ftt2-state-both.json', '{"v":1}');
            files.set('ftt2-state-both.json', '{"v":1}');                 // 模拟历史镜像遗留
            calls.length = 0;
            const r = await fileTransportDelete('ftt2-state-both.json');
            return r.ok === true && r.native === true && r.files === true
                && !h.kv.has('ftt2-files/main/ftt2-state-both.json') && !files.has('ftt2-state-both.json')
                && urls().indexOf('/api/files/delete') >= 0;
        });
        await A('B5 gzip 写入：原生通道保存 gzip 字节（魔数 1f 8b），回读按魔数解压', async () => {
            const body = JSON.stringify({ v: 1, gz: true, pad: 'y'.repeat(TT_KV_MAX_BYTES + 200) });
            const w = await fileTransportUploadGz('ftt2-state-gz.json.gz', body);
            const raw = await ttGetBytes('ftt2-state-gz.json.gz');
            const r = await fileTransportReadAuto('ftt2-state-gz.json.gz');
            return w.ok === true && w.gz === true && raw.found === true && raw.bytes[0] === 0x1f && raw.bytes[1] === 0x8b
                && r.ok === true && r.gz === true && r.text === body;
        });
        await A('B5 键清单（诊断/数据管理）列出 KV 与 Blob 键', async () => {
            const l = await fileTransportListKeys();
            return l.ok === true && l.kv.indexOf('ftt2-state-gz.json.gz') >= 0;
        });
        await A('B5 key 归一与通道诊断字段齐备', () => {
            const s = fileTransportStatus();
            return fileTransportKey('ftt2-snap-x.json.gz') === 'ftt2-snap-x.json.gz'
                && !!s.channel && s.channel.ns === 'ftt2-files' && s.channel.table === 'main'
                && typeof s.routes === 'number' && !!s.lastWrite;
        });
        await A('B5 存储页含通道状态行与两个通道开关（此前被整段隐去）', () => {
            const html = storagePageHtml(SETTINGS_CONTROLS.storage);
            return html.indexOf('data-ftt-tt-channel') > 0 && html.indexOf('存储通道') > 0
                && html.indexOf('storage.tauriNative') > 0 && html.indexOf('storage.tauriMirror') > 0;
        });
    }

    // 收尾：恢复真实 fetch（其余测试文件独立进程，这里只保证本文件内后续调用可用）
    unFetch();
    unHost();
    R.done();
})().catch((e) => { console.error('❌ file-transport.test.js 异常中断:', e); process.exit(1); });

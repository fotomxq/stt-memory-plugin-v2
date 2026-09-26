// ============================================================
// 单元测试 · v2.77.0 宿主原生存储（TauriTavern 官方契约）
//
// 事实源（官方文档，2026-09 核对）：
//   · `docs/API/Extension.md`：`window.__TAURITAVERN__.api.extension.store`
//     —— KV JSON（getJson / tryGetJson / setJson / updateJson / renameKey / deleteJson / listKeys /
//        listTables / deleteTable）+ Blob（getBlob / setBlob / deleteBlob / listBlobKeys）；
//     `tryGetJson` 缺失时返回 `{found:false}`，**其他错误仍抛出**；`setBlob` 接受
//     Blob / ArrayBuffer / Uint8Array / base64 字符串；命名规则 `[A-Za-z0-9_.-]`、非空、不以 `.` 开头。
//   · `docs/API/README.md`：调用前 `await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__)`。
//   · 官方同步数据集 `extensions.store` = 目录 `_tauritavern/extension-store`（默认同步范围内）。
//
// 覆盖：
//   A 契约常量与宿主探测（含 API 未就绪阶段）
//   B KV JSON 通道（写入形状 / 未命中不再追问 getJson / 负缓存 / 幂等删除 / 形状兼容）
//   C Blob 通道（大载荷选型 / listBlobKeys 判存在不触发宿主报错 / 无 Blob 能力自动退回 / 写失败退回）
//   D 就绪等待 / 诊断 / 旧命名空间只读 / 双通道删除 / gzip 魔数解码
// 运行：node tests/unit/tt-store.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { gzipToBytes } from '../../adapters/gzip.js';
import {
    TT_NS, TT_LEGACY_NS, TT_TABLE, TT_KV_MAX_BYTES, TT_MISS_TTL_MS, TT_LIST_TTL_MS, TT_KEY_RE,
    ttKeyOf, ttDetected, ttNativeOn, ttNativeActive, ttStoreApi, ttBlobApi, ttFeatureSeen,
    ttKvPut, ttKvTryGet, ttKvDel, ttBlobPut, ttBlobHas, ttBlobGet, ttChannelFor, ttPutBytes, ttGetBytes,
    ttDelete, ttListKeys, ttListBlobKeys, ttStoreOverview, ttGetLegacyBytes, ttBytesToTextAuto,
    ttTextBytes, ttMissStats, ttChannelInfo, ttChannelStatusHtml, ttChannelDetailHtml,
    ttEnsureReady, ttIsNotFound, ttAnnounceSwitch, ttAnnounced, ttResetSession, ttDropCaches,
} from '../../adapters/tt-store.js';

const R = makeReporter('tt-store v2.77.0 宿主原生存储（官方契约）');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };

// ---------- 官方宿主桩（按 extension-store.js 桥接行为） ----------
function makeTtHost(opts) {
    const o = opts || {};
    const kv = new Map();
    const blobs = new Map();
    const calls = { set: 0, tryGet: 0, get: 0, del: 0, listKeys: 0, setBlob: 0, getBlob: 0, delBlob: 0, listBlobKeys: 0 };
    const k = (a) => String(a.namespace) + '/' + String(a.table || 'main') + '/' + String(a.key);
    const notFoundJson = (a) => new Error('Failed to get extension store json ' + String(a.namespace) + ':' + String(a.key)
        + ': Not found: Extension store JSON entry not found: /root/_tauritavern/extension-store/' + String(a.namespace) + '/kv/' + String(a.table || 'main') + '/' + String(a.key) + '.json');
    const store = {
        async setJson(a) { calls.set++; if (o.setError) throw new Error(o.setError); kv.set(k(a), a.value); },
        async tryGetJson(a) { calls.tryGet++; if (o.tryError) throw new Error(o.tryError); return kv.has(k(a)) ? { found: true, value: kv.get(k(a)) } : { found: false }; },
        async getJson(a) { calls.get++; if (o.getError) throw new Error(o.getError); if (!kv.has(k(a))) throw notFoundJson(a); return kv.get(k(a)); },
        async deleteJson(a) {
            calls.del++;
            if (!kv.has(k(a))) throw new Error('Not found: Extension store JSON entry not found: ' + k(a));
            kv.delete(k(a));
        },
        async listKeys(a) {
            calls.listKeys++;
            const p = String(a.namespace) + '/' + String(a.table || 'main') + '/';
            return Array.from(kv.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length));
        },
        async setBlob(a) {
            calls.setBlob++;
            if (o.blobSetError) throw new Error(o.blobSetError);
            const d = a.data;
            const u8 = (d instanceof Uint8Array) ? d : new Uint8Array(d || []);
            blobs.set(k(a), u8);
        },
        async getBlob(a) {
            calls.getBlob++;
            if (!blobs.has(k(a))) throw new Error('Not found: Extension store blob entry not found: ' + k(a));
            return new Blob([blobs.get(k(a))]);
        },
        async deleteBlob(a) { calls.delBlob++; blobs.delete(k(a)); },
        async listBlobKeys(a) {
            calls.listBlobKeys++;
            const p = String(a.namespace) + '/' + String(a.table || 'main') + '/';
            return Array.from(blobs.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length));
        },
    };
    if (o.noTryGet) delete store.tryGetJson;
    if (o.noBlob) { delete store.setBlob; delete store.getBlob; delete store.deleteBlob; delete store.listBlobKeys; }
    const abi = { abiVersion: 1, ready: o.ready || Promise.resolve(true), api: { extension: { store } } };
    return { abi, store, kv, blobs, calls };
}

const doc = makeDocument([]);
const unHost = installGlobalHost(makeHost({}), doc);

/** 重置宿主与模块会话状态 */
function useHost(host) {
    ttResetSession();
    try { delete globalThis.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.__TAURITAVERN_MAIN_READY__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.__TAURI_INTERNALS__; } catch (e) { /* 忽略 */ }
    if (globalThis.window) {
        try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
        try { delete globalThis.window.__TAURITAVERN_MAIN_READY__; } catch (e) { /* 忽略 */ }
        try { delete globalThis.window.__TAURI_INTERNALS__; } catch (e) { /* 忽略 */ }
    }
    if (host) { try { globalThis.window.__TAURITAVERN__ = host.abi; } catch (e) { /* 忽略 */ } }
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    ttResetSession();
    return host || null;
}

(async function main() {
    console.log('\n[A1] 契约常量与 key 归一');
    {
        await A('A1 命名空间/表/阈值常量（官方命名规则内）', () => TT_NS === 'ftt2-files' && TT_LEGACY_NS === 'ftt-files' && TT_TABLE === 'main'
            && TT_KV_MAX_BYTES === 96 * 1024 && TT_MISS_TTL_MS === 30000 && TT_LIST_TTL_MS === 3000);
        await A('A1 插件真实文件名符合官方 key 规则（含 .json.gz）', () => ['ftt2-state-n1a2b3.json', 'ftt2-state-n1a2b3.json.gz', 'ftt2-bak-x.json', 'ftt2-snap-y.json.gz', 'ftt2-meta-z.json', 'ftt2-log-w.json']
            .every((n) => TT_KEY_RE.test(ttKeyOf(n)) && ttKeyOf(n) === n));
        await A('A1 非法字符/前导点/空值被归一', () => ttKeyOf('a b/c?.json') === 'a_b_c_.json' && ttKeyOf('.hidden') === 'hidden' && ttKeyOf('') === 'unnamed' && ttKeyOf(null) === 'unnamed');
        await A('A1 Not found 分类器（getJson 缺失键文案）',
            () => ttIsNotFound(new Error('Not found: Extension store JSON entry not found: /x.json')) === true
                && ttIsNotFound(new Error('未找到')) === true && ttIsNotFound(new Error('boom')) === false);
    }

    console.log('\n[A2] 宿主探测（含 API 未就绪阶段）');
    {
        useHost(null);
        await A('A2 无宿主 → 未检测 / 不启用 / 无 API', () => ttDetected() === false && ttNativeOn() === false && ttNativeActive() === false && ttStoreApi() === null);
        const h = makeTtHost();
        useHost(h);
        await A('A2 __TAURITAVERN__ → 检测并自动启用', () => ttDetected() === true && ttNativeOn() === true && ttNativeActive() === true);
        useHost(null);
        globalThis.window.__TAURITAVERN_MAIN_READY__ = Promise.resolve(true);
        await A('A2 只有就绪特征（无 API）→ 检测到但未就绪（不误判为可用）', () => ttFeatureSeen() === true && ttDetected() === true && ttNativeActive() === false);
        useHost(null);
        globalThis.window.__TAURI_INTERNALS__ = {};
        await A('A2 __TAURI_INTERNALS__ 也算宿主特征', () => ttFeatureSeen() === true && ttDetected() === true && ttNativeActive() === false);
        useHost(h);
        cfg.storage.tauriNative = 'off';
        await A('A2 off：检测到宿主也不启用（强制用文件通道）', () => ttDetected() === true && ttNativeOn() === false && ttNativeActive() === false);
        useHost(null);
        cfg.storage.tauriNative = 'on';
        await A('A2 on（无宿主）：意图原生但 API 不在位 → 不激活', () => ttNativeOn() === true && ttNativeActive() === false);
        useHost(h);
    }

    console.log('\n[B1] KV JSON 写入形状与读写往返');
    {
        const h = useHost(makeTtHost());
        await A('B1 写入落到官方参数形状（namespace/table/key + {k,v,ts}）', async () => {
            const r = await ttKvPut('ftt2-meta-a.json', 'eyJ2IjoxfQ==');
            const v = h.kv.get('ftt2-files/main/ftt2-meta-a.json');
            return r.ok === true && r.channel === 'kv' && !!v && v.k === 'b64' && v.v === 'eyJ2IjoxfQ==' && typeof v.ts === 'number';
        });
        await A('B1 写入后立即可读（负缓存被撤销）', async () => {
            const r = await ttKvTryGet('ftt2-meta-a.json');
            return r.found === true && r.b64 === 'eyJ2IjoxfQ==';
        });
        await A('B1 三种历史形状都能读（{k,v} / {v} / 裸 base64 字符串）', async () => {
            h.kv.set('ftt2-files/main/s1.json', 'QUJD');
            h.kv.set('ftt2-files/main/s2.json', { v: 'QUJD' });
            const a = await ttKvTryGet('s1.json');
            const b = await ttKvTryGet('s2.json');
            return a.found && a.b64 === 'QUJD' && b.found && b.b64 === 'QUJD';
        });
        await A('B1 写/读计数进入通道状态', () => { const c = ttChannelInfo(); return c.native === true && c.kvWrites >= 1 && c.reads >= 1; });
    }

    console.log('\n[B2] 未命中：有 tryGetJson 时绝不追问 getJson（宿主不报错）');
    {
        const h = useHost(makeTtHost());
        await A('B2 缺失键 → found:false 且 getJson 调用 0 次', async () => {
            const r = await ttKvTryGet('ftt2-meta-missing.json');
            return r.found === false && h.calls.get === 0 && h.calls.tryGet === 1;
        });
        await A('B2 判定未命中后计数与负缓存 +1', () => { const s = ttMissStats(); return s.count === 1 && s.cached === 1 && s.ttlMs === TT_MISS_TTL_MS; });
        await A('B2 同键 30s 内不再探测（tryGetJson 调用不增）', async () => {
            const before = h.calls.tryGet;
            await ttKvTryGet('ftt2-meta-missing.json');
            await ttKvTryGet('ftt2-meta-missing.json');
            return h.calls.tryGet === before;
        });
        await A('B2 force 可绕开负缓存（取真值路径）', async () => {
            const before = h.calls.tryGet;
            await ttKvTryGet('ftt2-meta-missing.json', { force: true });
            return h.calls.tryGet === before + 1;
        });
        await A('B2 写入后负缓存撤销，可立即读到', async () => {
            await ttKvPut('ftt2-meta-missing.json', 'QUJD');
            const r = await ttKvTryGet('ftt2-meta-missing.json');
            return r.found === true;
        });
        await A('B2 通道状态行含未命中计数（诊断可见）', () => ttChannelStatusHtml().indexOf('未命中') > 0);
    }

    console.log('\n[B3] 宿主只提供 getJson（无 tryGetJson）时的未命中与错误语义');
    {
        const h = useHost(makeTtHost({ noTryGet: true }));
        await A('B3 Not found 视为正常未命中（不记为通道错误，只探测一次）', async () => {
            const r = await ttKvTryGet('ftt2-meta-x.json');
            const c = ttChannelInfo();
            return r.found === false && h.calls.get === 1 && !c.err;
        });
        await A('B3 删除缺失键 → 幂等成功', async () => {
            const r = await ttKvDel('ftt2-meta-x.json');
            return r.ok === true && r.idempotent === true;
        });
        const e = useHost(makeTtHost({ noTryGet: true, getError: 'backend exploded' }));
        await A('B3 真实错误仍如实上报（不吞）', async () => {
            const r = await ttKvTryGet('ftt2-meta-y.json', { force: true });
            return r.found === false && String(r.error || '').indexOf('backend exploded') >= 0;
        });
        e.store.setJson = async () => { throw new Error('disk full'); };
        await A('B3 写入失败如实返回 error', async () => {
            const r = await ttKvPut('ftt2-meta-z.json', 'QUJD');
            return r.ok === false && String(r.error || '').indexOf('disk full') >= 0;
        });
        useHost(makeTtHost());
    }

    console.log('\n[C1] Blob 通道：大载荷走官方 Blob，小载荷走 KV');
    {
        const h = useHost(makeTtHost());
        const big = ttTextBytes('x'.repeat(TT_KV_MAX_BYTES + 10));
        await A('C1 通道选型：≥阈值且宿主具备 Blob → blob；小载荷 → kv', () => ttChannelFor(big.length) === 'blob' && ttChannelFor(400) === 'kv' && !!ttBlobApi());
        await A('C1 大载荷写入 → setBlob（KV 不写）且字节一致', async () => {
            const r = await ttPutBytes('ftt2-state-big.json', big);
            const stored = h.blobs.get('ftt2-files/main/ftt2-state-big.json');
            return r.ok === true && r.channel === 'blob' && h.calls.setBlob === 1 && h.calls.set === 0
                && !!stored && stored.length === big.length && stored[0] === big[0];
        });
        await A('C1 大载荷回读 → 字节一致且走 blob', async () => {
            const r = await ttGetBytes('ftt2-state-big.json');
            return r.found === true && r.channel === 'blob' && r.bytes.length === big.length && r.bytes[big.length - 1] === big[big.length - 1];
        });
        await A('C1 小载荷写入 → setJson（Blob 不写）', async () => {
            const small = ttTextBytes('{"v":1}');
            const r = await ttPutBytes('ftt2-meta-small.json', small);
            return r.ok === true && r.channel === 'kv' && h.calls.setBlob === 1;
        });
        await A('C1 小载荷回读 → 文本正确', async () => {
            const r = await ttGetBytes('ftt2-meta-small.json');
            const dec = await ttBytesToTextAuto(r.bytes);
            return r.found === true && dec.ok === true && dec.text === '{"v":1}';
        });
    }

    console.log('\n[C2] 缺失的 Blob key：用 listBlobKeys 判存在，不触发宿主 getBlob 报错');
    {
        const h = useHost(makeTtHost());
        await A('C2 未命中 → 连直接 ttBlobGet 也不会调宿主 getBlob（存在性先拦下）', async () => {
            const r = await ttBlobGet('ftt2-state-none.json');
            const has = await ttBlobHas('ftt2-state-none.json');
            return r.ok === false && r.miss === true && has === false && h.calls.getBlob === 0 && h.calls.listBlobKeys >= 1;
        });
        await A('C2 ttGetBytes 对缺失大键也不调 getBlob（抑制宿主报错）', async () => {
            const before = h.calls.getBlob;
            const r = await ttGetBytes('ftt2-state-none.json');
            return r.found === false && h.calls.getBlob === before;
        });
        await A('C2 列表缓存命中（短 TTL 内不重复列表）', async () => {
            const before = h.calls.listBlobKeys;
            await ttBlobHas('ftt2-state-none.json');
            return h.calls.listBlobKeys === before;
        });
        await A('C2 写入后列表缓存失效（新键立即可见）', async () => {
            const u8 = ttTextBytes('y'.repeat(TT_KV_MAX_BYTES + 5));
            await ttPutBytes('ftt2-state-new.json', u8);
            const has = await ttBlobHas('ftt2-state-new.json');
            return has === true;
        });
    }

    console.log('\n[C3] Blob 能力缺失 / 写入失败 → 自动退回 KV（绝不丢数据）');
    {
        const h = useHost(makeTtHost({ noBlob: true }));
        await A('C3 无 Blob 方法 → 能力探测为假且选型退回 kv', () => ttBlobApi() === null && ttChannelFor(TT_KV_MAX_BYTES * 4) === 'kv');
        await A('C3 大载荷写入 → 落 KV（base64 承载）且可回读', async () => {
            const big = ttTextBytes('z'.repeat(TT_KV_MAX_BYTES + 3));
            const w = await ttPutBytes('ftt2-state-big2.json', big);
            const r = await ttGetBytes('ftt2-state-big2.json');
            return w.ok === true && w.channel === 'kv' && h.calls.set === 1 && r.found === true && r.channel === 'kv' && r.bytes.length === big.length;
        });
        const h2 = useHost(makeTtHost({ blobSetError: 'blob channel down' }));
        await A('C3 Blob 写失败 → 退回 KV 且记录原因', async () => {
            const big = ttTextBytes('q'.repeat(TT_KV_MAX_BYTES + 7));
            const w = await ttPutBytes('ftt2-state-big3.json', big);
            const r = await ttGetBytes('ftt2-state-big3.json');
            return w.ok === true && w.channel === 'kv' && String(w.afterBlobError || '').indexOf('blob channel down') >= 0
                && h2.calls.set === 1 && r.found === true && r.bytes.length === big.length;
        });
    }

    console.log('\n[D1] 删除：两个通道都删（避免另一通道唤醒）与 KV/Blob 列表');
    {
        const h = useHost(makeTtHost());
        await A('D1 同名键同时存在于 KV 与 Blob → ttDelete 清掉两处', async () => {
            await ttKvPut('ftt2-log-d.json', 'QUJD');
            const big = ttTextBytes('b'.repeat(TT_KV_MAX_BYTES + 2));
            await ttBlobPut('ftt2-log-d.json', big);
            const r = await ttDelete('ftt2-log-d.json');
            return r.ok === true && r.kv === true && r.blob === true
                && !h.kv.has('ftt2-files/main/ftt2-log-d.json') && !h.blobs.has('ftt2-files/main/ftt2-log-d.json');
        });
        await A('D1 listKeys / listBlobKeys / 概览按官方参数读取', async () => {
            await ttKvPut('k1.json', 'QQ=='); await ttKvPut('k2.json', 'QQ==');
            await ttBlobPut('b1.json', ttTextBytes('c'.repeat(10)));
            const kv = await ttListKeys();
            const bl = await ttListBlobKeys();
            const ov = await ttStoreOverview();
            return kv.indexOf('k1.json') >= 0 && kv.indexOf('k2.json') >= 0 && bl.indexOf('b1.json') >= 0
                && ov.available === true && ov.ns === 'ftt2-files' && ov.table === 'main' && ov.kvCount >= 2 && ov.blobCount >= 1;
        });
    }

    console.log('\n[D2] 就绪等待 / 旧命名空间只读 / gzip 魔数解码 / 切换提示一次');
    {
        const slow = makeTtHost({ ready: new Promise(() => { }) });
        useHost(slow);
        await A('D2 ready 一直不 resolve → 超时按未就绪处理（不抛错）', async () => {
            const ok = await ttEnsureReady(30);
            return ok === false && ttNativeActive() === true;
        });
        const h = useHost(makeTtHost());
        await A('D2 正常宿主 ready → true', async () => { ttResetSession(); return (await ttEnsureReady(50)) === true; });
        h.kv.set('ftt-files/main/ftt-tt-legacy.json', { k: 'b64', v: 'eyJ2IjoxfQ==', ts: Date.now() });
        await A('D2 旧命名空间（V1 落点）可只读命中', async () => {
            const r = await ttGetLegacyBytes('ftt-tt-legacy.json');
            const dec = await ttBytesToTextAuto(r.bytes);
            return r.found === true && r.ns === 'ftt-files' && dec.text === '{"v":1}';
        });
        await A('D2 gzip 载荷按魔数解码', async () => {
            const gz = await gzipToBytes('{"gz":true}');
            const dec = await ttBytesToTextAuto(gz);
            return dec.ok === true && dec.gz === true && dec.text === '{"gz":true}';
        });
        await A('D2 切换提示每次会话最多一次', () => { const a = ttAnnounceSwitch(); const b = ttAnnounceSwitch(); return a === true && b === false && ttAnnounced() === true; });
        await A('D2 通道详情含命名空间/写入分布/未命中抑制', () => {
            const d = ttChannelDetailHtml();
            return d.indexOf('ftt2-files') > 0 && d.indexOf('大文件') > 0 && d.indexOf('未命中抑制') > 0;
        });
        await A('D2 未检测到宿主时状态行为「⚪」且文案为酒馆用户目录文件', async () => {
            useHost(null);
            const html = ttChannelStatusHtml();
            return html.indexOf('⚪') === 0 && html.indexOf('酒馆用户目录文件') > 0;
        });
        await A('D2 缓存清理可调用（立即同步取真值路径）', () => { ttDropCaches(); return ttMissStats().cached === 0; });
    }

    unHost();
    R.done();
})().catch((e) => { console.error('❌ tt-store.test.js 异常中断:', e); process.exit(1); });

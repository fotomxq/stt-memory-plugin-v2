// ============================================================
// adapters/import-v1.js —— V1 → V2 数据导入器（P2 次批）
// 用户要求（V2 设计 docs/13 §7 迁移与回退）：**不丢数据、可回退、绝不删除源数据**。
// 本模块只做三件事：① 发现 V1 数据源；② 产出**干跑差异报告**；③ 显式 apply 时才合并进 V2 当前容器。
//
// V1 数据源（全部只读；导入后**一个都不删**）：
//   ① 服务端记忆文件  ftt-state-<slug>-<scope8>.json[.gz]（唯一权威；同目录另有 -bak 备份）
//   ② 旧 settings 存档 SPreset_FTTMemory_char:<hash>（v1.127 之前的本机信封）
//   ③ 本机命名缓存    SPreset_FTTMemory_FileSlug_/FileNames_/ArchiveName_<scope8>（用于反推 V1 作用域与文件名）
//
// ⚠️ 作用域不对齐的事实（黄金样本 9 实测）：V1 的 scope = `char:<hashText(TH getCurrentCharacterId())>`，
//   而 V2 用「角色稳定键（avatar → name2）」——同一角色两边可能不同哈希。故导入器**枚举候选作用域**
//   （当前 V2 作用域 + 角色名/头像派生 + 本机缓存反推），逐一构造文件名去试，绝不假设两边相等。
// ============================================================
import { hashText } from '../core/util.js';
import { DIMENSIONS } from '../core/constants.js';
import { scopeId, emptyState } from '../core/state.js';
import { migrateState } from '../core/migrate.js';
import { readStateFileBytes } from './user-file.js';
import { getCtx } from '../host/st-api.js';

export const V1_NAMES = Object.freeze({
    FILE_PREFIX: 'ftt-state-',
    BAK_SUFFIX: '-bak',
    SNAP_PREFIX: 'ftt-snap-',
    GZ: '.json.gz',
    JSON: '.json',
    KEY_SLUG: 'SPreset_FTTMemory_FileSlug_',
    KEY_FILES: 'SPreset_FTTMemory_FileNames_',
    KEY_ARCHIVE: 'SPreset_FTTMemory_ArchiveName_',
    KEY_CONFIG: 'SPreset_FTTMemoryConfig',
    STATE_KEY_PREFIX: 'SPreset_FTTMemory_char:',
    LEGACY_PREFIX: 'SPreset_FTTMemory_',
});

/** V1 作用域哈希前 8 位：hashText(scope) + hashText('ftt-scope:' + scope) 拼接后取 8（黄金样本 9 实测） */
export function v1ScopeHash8(scope) {
    try {
        const s = String(scope || '');
        return (String(hashText(s)) + String(hashText('ftt-scope:' + s))).slice(0, 8);
    } catch (e) { return '00000000'; }
}

/** V1 从存档名派生 slug（只留 [A-Za-z0-9_-]，最多 24；全非 ASCII 时退化为 'n'+哈希前 6） */
export function v1SlugFromName(name) {
    try {
        const nm = String(name || '');
        if (!nm) return '';
        const s = nm.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
        return s || ('n' + String(hashText(nm)).slice(0, 6));
    } catch (e) { return ''; }
}

/** V1 名称未就绪时的确定性兜底 slug：'n' + hashText(scope).slice(0,6) */
export function v1SlugFallback(scope) {
    try { return 'n' + String(hashText(String(scope || ''))).slice(0, 6); } catch (e) { return 'n000000'; }
}

/** V1 读取候选名（先 .json.gz 再 .json；同一 slug 展开主文件与 -bak） */
export function v1FileNames(scope, slug) {
    const s8 = v1ScopeHash8(scope);
    const base = V1_NAMES.FILE_PREFIX + String(slug || '') + '-' + s8;
    const state = [base + V1_NAMES.GZ, base + V1_NAMES.JSON];
    const bak = [base + V1_NAMES.BAK_SUFFIX + V1_NAMES.GZ, base + V1_NAMES.BAK_SUFFIX + V1_NAMES.JSON];
    return { scope8: s8, base, state, bak, all: state.concat(bak) };
}

/** 已知 V1 作用域哈希（来自本机缓存键名）时的文件名候选 —— 不再反算 scope8 */
export function v1NamesForScope8(scope8, slug) {
    const s8 = String(scope8 || '');
    const base = V1_NAMES.FILE_PREFIX + String(slug || '') + '-' + s8;
    const state = [base + V1_NAMES.GZ, base + V1_NAMES.JSON];
    const bak = [base + V1_NAMES.BAK_SUFFIX + V1_NAMES.GZ, base + V1_NAMES.BAK_SUFFIX + V1_NAMES.JSON];
    return { scope8: s8, base, state, bak, all: state.concat(bak) };
}

/** 收集 V1 兼容的身份候选（角色名/头像/TH 的 getCurrentCharacterId/V1 存档名缓存） */
export function collectV1Identity(extra) {
    const out = Object.assign({}, extra || {});
    try {
        const ctx = getCtx();
        if (ctx) {
            if (out.name2 === undefined && ctx.name2) out.name2 = String(ctx.name2);
            if (out.name === undefined && ctx.name) out.name = String(ctx.name);
            if (out.avatar === undefined && ctx.characters && ctx.characters[ctx.characterId]) out.avatar = String(ctx.characters[ctx.characterId].avatar || '');
            if (out.characterId === undefined && ctx.characterId !== undefined && ctx.characterId !== null) out.characterId = String(ctx.characterId);
        }
    } catch (e) { /* 忽略 */ }
    // TH（V1 生产环境的作用域来源）：全局 getCurrentCharacterId()
    try {
        if (out.getCurrentCharacterId === undefined && typeof globalThis.getCurrentCharacterId === 'function') {
            out.getCurrentCharacterId = String(globalThis.getCurrentCharacterId() || '');
        }
    } catch (e) { /* 忽略 */ }
    try {
        if (!out.archiveName && globalThis.localStorage) {
            const ls = globalThis.localStorage;
            for (let i = 0; typeof ls.key === 'function' && i < Number(ls.length || 0); i++) {
                const k = String(ls.key(i) || '');
                if (k.indexOf(V1_NAMES.KEY_ARCHIVE) === 0) { const v = ls.getItem(k); if (v) { out.archiveName = String(v); break; } }
            }
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 作用域候选（V1 与 V2 的作用域定义可能不同 → 全部列出逐一尝试） */
export function v1ScopeCandidates(identity) {
    const out = [];
    const push = (v) => { const s = String(v || '').trim(); if (s && out.indexOf(s) < 0) out.push(s); };
    const id = identity || {};
    // ① V1 生产环境的作用域定义来源（TH getCurrentCharacterId）优先 —— 最可能命中 V1 真实文件
    if (id.getCurrentCharacterId) push('char:' + String(hashText(String(id.getCurrentCharacterId))));
    try { push(scopeId()); } catch (e) { /* 忽略 */ }   // ② V2 当前作用域
    ['name2', 'name', 'avatar', 'characterId'].forEach((k) => {
        const v = id[k];
        if (v === undefined || v === null || v === '') return;
        push('char:' + String(hashText(String(v))));
    });
    (Array.isArray(id.cachedScopes) ? id.cachedScopes : []).forEach(push);
    return out;
}

/** 解析 V1 信封 / 裸 state：信封校验哈希，裸对象直接当 state（旧存档变量形态） */
export function decodeV1Envelope(obj) {
    try {
        if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not-object' };
        if (obj.payload && typeof obj.payload === 'object') {
            const data = obj.payload.data;
            if (!data || typeof data !== 'object') return { ok: false, reason: 'no-data' };
            if (obj.hash) {
                const h = v1EnvelopeHash(obj.payload);
                if (h !== obj.hash) return { ok: false, reason: 'hash-mismatch' };
            }
            return { ok: true, shaped: 'envelope', scope: String(obj.scope || obj.payload.scope || ''), updatedAt: Number(obj.payload.updatedAt) || 0, data };
        }
        return { ok: true, shaped: 'raw', scope: String(obj.scope || ''), updatedAt: 0, data: obj };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

/** V1 信封哈希（双轮 FNV-1a，与 core/envelope.js 同算法；此处独立实现以便校验外来数据） */
export function v1EnvelopeHash(payload) {
    try {
        const s = JSON.stringify(payload);
        let h1 = 0x811c9dc5, h2 = 0x01000193;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ (c ^ 0x5f), 0x85ebca6b) >>> 0;
        }
        return h1.toString(36) + '_' + h2.toString(36);
    } catch (e) { return ''; }
}

/** 是否 gzip 魔数（1f 8b） */
export function isGzipBytes(bytes) {
    try { return !!bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; } catch (e) { return false; }
}

/** gzip 字节 → 文本（DecompressionStream；Node 18+/现代浏览器可用；缺失则明确失败） */
export async function gunzipToText(bytes) {
    try {
        if (typeof DecompressionStream === 'undefined') return { ok: false, error: 'no-decompression-stream' };
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const text = await new Response(stream).text();
        return { ok: true, text };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 内存字节 → 文本（明文文件用） */
export function bytesToText(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return ''; }
}

/** 扫描 V1 本机痕迹（键名 → 作用域 / slug / 历史文件名 / 旧信封 / 配置） */
export function scanV1LocalStorage(keys, getItem) {
    const out = { scopes: {}, legacyStates: [], config: null, configKey: '', keys: [] };
    const byScope = (s8) => {
        if (!out.scopes[s8]) out.scopes[s8] = { scope8: s8, slug: '', files: [], archiveName: '' };
        return out.scopes[s8];
    };
    const list = Array.isArray(keys) ? keys : [];
    list.forEach((key) => {
        const k = String(key || '');
        if (!k) return;
        try {
            if (k.indexOf(V1_NAMES.KEY_SLUG) === 0) { byScope(k.slice(V1_NAMES.KEY_SLUG.length)).slug = String(getItem(k) || ''); out.keys.push(k); return; }
            if (k.indexOf(V1_NAMES.KEY_ARCHIVE) === 0) { byScope(k.slice(V1_NAMES.KEY_ARCHIVE.length)).archiveName = String(getItem(k) || ''); out.keys.push(k); return; }
            if (k.indexOf(V1_NAMES.KEY_FILES) === 0) {
                const s8 = k.slice(V1_NAMES.KEY_FILES.length);
                let arr = [];
                try { arr = JSON.parse(String(getItem(k) || '[]')) || []; } catch (e) { arr = []; }
                const slot = byScope(s8);
                (Array.isArray(arr) ? arr : []).forEach((n) => { const s = String(n || ''); if (s && slot.files.indexOf(s) < 0) slot.files.push(s); });
                out.keys.push(k);
                return;
            }
            if (k === V1_NAMES.KEY_CONFIG) { out.config = String(getItem(k) || ''); out.configKey = k; out.keys.push(k); return; }
            if (k.indexOf(V1_NAMES.STATE_KEY_PREFIX) === 0) {
                const raw = String(getItem(k) || '');
                if (!raw) return;
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
                const dec = decodeV1Envelope(parsed);
                out.legacyStates.push({ key: k, scope: k.slice(V1_NAMES.LEGACY_PREFIX.length), bytes: raw.length, ok: !!dec.ok, reason: dec.reason || '', data: dec.ok ? dec.data : null });
                out.keys.push(k);
            }
        } catch (e) { /* 单键失败不影响其余 */ }
    });
    return out;
}

// ---------------- 差异报告与合并 ----------------

const dimKinds = () => DIMENSIONS.map((d) => ({ kind: d.kind, label: d.label }));

const arrOf = (st, kind) => (st && Array.isArray(st[kind]) ? st[kind] : []);
const idOf = (e) => { try { return e && e.id !== undefined && e.id !== null ? String(e.id) : ''; } catch (x) { return ''; } };

/**
 * 干跑差异报告：逐维度统计「V1 有 / 当前有 / 将新增 / 已存在（按 id）」。
 * @returns {object} 报告（不做任何写入）
 */
export function buildImportReport(v1State, currentState) {
    const rows = [];
    let add = 0, exist = 0, conflict = 0, v1Total = 0;
    dimKinds().forEach(({ kind, label }) => {
        const v1 = arrOf(v1State, kind);
        const cur = arrOf(currentState, kind);
        const curIds = {};
        cur.forEach((e) => { const id = idOf(e); if (id) curIds[id] = e; });
        let rAdd = 0, rExist = 0, rConflict = 0;
        v1.forEach((e) => {
            const id = idOf(e);
            if (!id) { rAdd++; return; }
            if (!curIds[id]) { rAdd++; return; }
            rExist++;
            try { if (JSON.stringify(curIds[id]) !== JSON.stringify(e)) rConflict++; } catch (x) { rConflict++; }
        });
        v1Total += v1.length; add += rAdd; exist += rExist; conflict += rConflict;
        if (v1.length || cur.length) rows.push({ kind, label, v1: v1.length, current: cur.length, add: rAdd, exist: rExist, conflict: rConflict });
    });
    const v1Tomb = (v1State && v1State.deleted && typeof v1State.deleted === 'object') ? Object.keys(v1State.deleted).length : 0;
    const v1TombH = (v1State && v1State.deletedH && typeof v1State.deletedH === 'object') ? Object.keys(v1State.deletedH).length : 0;
    return {
        rows, totals: { v1Entries: v1Total, add, exist, conflict, tombstoneDims: v1Tomb, tombstoneHashes: v1TombH },
        scope: { v1: String((v1State && v1State.scope) || ''), current: safeScope() },
        empty: v1Total === 0 && v1Tomb === 0 && v1TombH === 0,
    };
}

function safeScope() { try { return String(scopeId()); } catch (e) { return ''; } }

/**
 * 合并（append-only）：按 id 并集 —— 当前容器为基准，V1 独有条目追加，**同 id 以当前为准**（不覆盖用户现有数据）；
 * 墓碑（deleted / deletedH）取并集（V1 的删除记录同样生效，避免「导入把删掉的东西唤醒」）。
 * @returns {{merged:object, summary:object}}
 */
export function mergeV1IntoCurrent(currentState, v1State) {
    // 深拷贝：migrateState 会就地补容器键，若只做浅拷贝会把**源对象**改掉（导入器必须对 V1 数据只读）
    const deep = (v) => { try { return JSON.parse(JSON.stringify(v || {})); } catch (e) { return {}; } };
    const cur = migrateState(Object.assign(emptyState(), deep(currentState)));
    const v1 = migrateState(Object.assign(emptyState(), deep(v1State)));
    const summary = { added: {}, kept: {}, tombstones: { deleted: 0, deletedH: 0 } };
    dimKinds().forEach(({ kind }) => {
        const have = arrOf(cur, kind).slice();
        const seen = {};
        have.forEach((e) => { const id = idOf(e); if (id) seen[id] = true; });
        let n = 0;
        arrOf(v1, kind).forEach((e) => {
            const id = idOf(e);
            if (id && seen[id]) return;
            if (id) seen[id] = true;
            have.push(e);
            n++;
        });
        cur[kind] = have;
        if (n) summary.added[kind] = n;
    });
    // 墓碑并集
    ['deleted', 'deletedH'].forEach((k) => {
        const src = (v1[k] && typeof v1[k] === 'object') ? v1[k] : {};
        const dst = (cur[k] && typeof cur[k] === 'object') ? cur[k] : {};
        Object.keys(src).forEach((dim) => {
            const s = (src[dim] && typeof src[dim] === 'object') ? src[dim] : {};
            const d = (dst[dim] && typeof dst[dim] === 'object') ? dst[dim] : (dst[dim] = {});
            Object.keys(s).forEach((id) => {
                if (d[id] === undefined) { d[id] = s[id]; summary.tombstones[k]++; }
            });
        });
        cur[k] = dst;
    });
    // 单值容器：当前为空才采用 V1 值（不覆盖用户现有状态）
    const stKeys = ['time', 'date', 'location'];
    cur.state = Object.assign({}, v1.state || {}, cur.state || {});
    stKeys.forEach((k) => { if (!cur.state[k] && v1.state && v1.state[k]) cur.state[k] = v1.state[k]; });
    // 作用域归位到 V2 当前作用域（数据搬进本机作用域，源文件保持不动）
    cur.scope = safeScope();
    return { merged: cur, summary };
}

// ---------------- 宿主编排 ----------------

function lsKeys() {
    try {
        const ls = globalThis.localStorage;
        if (!ls) return [];
        if (typeof ls.length === 'number' && typeof ls.key === 'function') {
            const out = [];
            for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k) out.push(k); }
            return out;
        }
        return Object.keys(ls);
    } catch (e) { return []; }
}

function lsGet(key) { try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null; } catch (e) { return null; } }

/**
 * 发现并读取全部 V1 数据源（只读）。
 * @param {object} [opts] identity（角色身份候选）/ maxFiles
 * @returns {Promise<object>} { sources:[{name, kind, from, ok, shaped, scope, bytes, state, error}], local, scopes }
 */
export async function discoverV1Sources(opts) {
    const o = opts || {};
    const local = scanV1LocalStorage(lsKeys(), lsGet);
    // 旧信封的键名本身就带完整 V1 作用域（`char:<hash>`）→ 最可信的作用域候选
    const legacyScopes = (local.legacyStates || []).map((x) => String(x.scope || '')).filter((x) => x);
    const identity = collectV1Identity(o.identity || {});
    const scopes = v1ScopeCandidates(Object.assign({}, identity, { cachedScopes: legacyScopes.concat((o.identity && o.identity.cachedScopes) || []) }));
    const names = [];
    const pushName = (n, from) => { const s = String(n || ''); if (s && !names.some((x) => x.name === s)) names.push({ name: s, from }); };
    // ① 本机历史文件名（最可靠：V1 实际写过的名字）
    Object.keys(local.scopes).forEach((s8) => {
        const slot = local.scopes[s8];
        slot.files.forEach((n) => pushName(n, 'v1-history:' + s8));
        if (slot.slug) v1NamesForScope8(s8, slot.slug).all.forEach((n) => pushName(n, 'v1-slug-cache:' + s8));
    });
    // ② 候选作用域 × 候选 slug 构造（同一 scope8 只展开一次：不同候选可能算出同一个哈希）
    const seenScope8 = {};
    scopes.forEach((sc) => {
        const sc8 = v1ScopeHash8(sc);
        if (seenScope8[sc8]) return;
        seenScope8[sc8] = true;
        const slugs = [];
        try { if (identity.archiveName) { const s = v1SlugFromName(identity.archiveName); if (s) slugs.push(s); } } catch (e) { /* 忽略 */ }
        const s8 = v1ScopeHash8(sc);
        if (local.scopes[s8] && local.scopes[s8].slug) slugs.push(local.scopes[s8].slug);
        slugs.push(v1SlugFallback(sc));
        ['name2', 'name', 'avatar', 'getCurrentCharacterId'].forEach((k) => { const v = identity[k]; if (v) { const s = v1SlugFromName(v); if (s) slugs.push(s); } });
        slugs.forEach((slug) => v1FileNames(sc, slug).all.forEach((n) => pushName(n, 'derived:' + sc)));
    });
    const max = Number(o.maxFiles) > 0 ? Number(o.maxFiles) : 16;
    const sources = [];
    for (const item of names.slice(0, max)) {
        const got = await readStateFileBytes(item.name);
        if (!got.ok) { sources.push({ name: item.name, from: item.from, ok: false, error: got.error || ('status:' + got.status) }); continue; }
        let text = '';
        if (isGzipBytes(got.bytes)) {
            const un = await gunzipToText(got.bytes);
            if (!un.ok) { sources.push({ name: item.name, from: item.from, ok: false, error: un.error, gz: true }); continue; }
            text = un.text;
        } else {
            text = bytesToText(got.bytes);
        }
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        const dec = decodeV1Envelope(parsed);
        sources.push({
            name: item.name, from: item.from, ok: !!dec.ok, gz: isGzipBytes(got.bytes), bytes: got.bytes.length,
            shaped: dec.shaped || '', scope: dec.scope || '', updatedAt: dec.updatedAt || 0,
            state: dec.ok ? dec.data : null, reason: dec.reason || '',
            kind: /-bak\.json(\.gz)?$/.test(item.name) ? 'bak' : 'state',
        });
    }
    return { sources, local, scopes, identity, names: names.map((x) => x.name) };
}

/**
 * 选最佳 V1 源：服务端主文件（非 bak、按 updatedAt 新→旧）→ 旧 settings 信封（字节数大者）。
 */
export function pickBestV1Source(found) {
    const ok = (found.sources || []).filter((s) => s.ok && s.state && s.kind !== 'bak');
    ok.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.bytes || 0) - (a.bytes || 0));
    if (ok.length) return { via: 'server-file', name: ok[0].name, state: ok[0].state, source: ok[0] };
    const leg = (found.local.legacyStates || []).filter((s) => s.ok && s.data);
    leg.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    if (leg.length) return { via: 'legacy-settings', name: leg[0].key, state: leg[0].data, source: leg[0] };
    return { via: '', name: '', state: null, source: null };
}

/**
 * 导入 V1 数据（默认**干跑**）。
 * @param {object} opts dryRun（默认 true）/ identity / current（当前容器）/ apply（async (merged, report) => void）
 * @returns {Promise<object>} { dryRun, via, name, report, summary, merged, sources, notes }
 */
export async function importV1Data(opts) {
    const o = opts || {};
    const dryRun = o.dryRun !== false;
    const notes = [];
    let found = { sources: [], local: { scopes: {}, legacyStates: [], config: null, keys: [] }, scopes: [], names: [] };
    try { found = await discoverV1Sources(o); } catch (e) { notes.push('发现失败：' + String((e && e.message) || e)); }
    const current = o.current || (() => { try { return emptyState(); } catch (e) { return {}; } })();
    const best = pickBestV1Source(found);
    if (!best.state) {
        notes.push('未发现可用的 V1 数据（服务端文件 / 旧存档变量均为空或不可读）');
        return { dryRun, via: '', name: '', report: buildImportReport(null, current), summary: null, merged: null, sources: found.sources, discovered: found.names, notes };
    }
    const report = buildImportReport(best.state, current);
    if (report.scope.v1 && report.scope.v1 !== report.scope.current) {
        notes.push('V1 作用域(' + report.scope.v1 + ') 与当前 V2 作用域(' + report.scope.current + ') 不同 —— 按「并入当前角色」处理，源数据保持不变');
    }
    if (dryRun) return { dryRun: true, via: best.via, name: best.name, report, summary: null, merged: null, sources: found.sources, discovered: found.names, notes };
    const { merged, summary } = mergeV1IntoCurrent(current, best.state);
    if (typeof o.apply === 'function') { await o.apply(merged, report); notes.push('已写入 V2 容器（apply 回调完成）'); }
    else { notes.push('未提供 apply 回调 → 仅返回合并结果，未落盘'); }
    notes.push('V1 源数据未被删除（本导入器不调用任何删除接口）');
    return { dryRun: false, via: best.via, name: best.name, report, summary, merged, sources: found.sources, discovered: found.names, notes, configRaw: found.local.config || '' };
}

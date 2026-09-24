// ============================================================
// 单元测试 · P2 次批（V1 → V2 数据导入器）
// 黄金样本：tests/fixtures/v1-golden-importer.json（oracle = 真实 V1 插件 v1.206 的 scopeId/scopeHash8/storageSlug/stateFileName）
// 口径：命名派生必须**逐字符**等于 V1；导入必须 append-only（同 id 以当前为准）、墓碑并集、源数据不删。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { makeReporter, installGlobalFetch } from '../harness/st-mock.js';
import { setScopeKey } from '../../core/model/runtime.js';
import { emptyState, scopeId } from '../../core/state.js';
import {
    v1ScopeHash8, v1SlugFromName, v1SlugFallback, v1FileNames, v1ScopeCandidates,
    decodeV1Envelope, isGzipBytes, gunzipToText, scanV1LocalStorage,
    buildImportReport, mergeV1IntoCurrent, discoverV1Sources, pickBestV1Source, importV1Data,
} from '../../adapters/import-v1.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-importer.json'), 'utf8'));
const R = makeReporter('v1-importer V1 数据导入（P2 次批）');
const J = (v) => JSON.stringify(v);

// 固定身份：V1 oracle 的 scope = 'char:1157z2a'（哈希来自 TH getCurrentCharacterId 'char_abc'）
const V1_SCOPE = G.scope;
const V1_SLUG = G.storageSlug;

const mkEntry = (id, extra) => Object.assign({ id }, extra || {});
const v1State = {
    version: 'v1.206', scope: V1_SCOPE,
    state: { time: '1919-11-29 夜', date: '1919-11-29', location: '码头', sceneFocus: null },
    atoms: [mkEntry('a1', { title: '甲' }), mkEntry('a2', { title: '乙' })],
    memories: [mkEntry('m1', { content: '旧记忆' }), mkEntry('m2', { content: 'V1 独有' })],
    items: [], plans: [], suspense: [], scenes: [], currentStates: [], snapshots: [], concepts: [],
    parallels: [], links: [], plotSegments: [], rumors: [], currencies: [], npcs: [],
    deleted: { atoms: { a9: 111 } }, deletedH: { atoms: { deadbeef: 111 } },
};

// ---------- I1–I3：命名与作用域派生（对齐 V1 oracle） ----------
R.assert('I1 V1 作用域哈希：scopeHash8(scope) 逐字符等于 V1 实测值 ' + G.scopeHash8, (() => {
    return v1ScopeHash8(V1_SCOPE) === G.scopeHash8
        && v1ScopeHash8(V1_SCOPE).length === 8 && v1ScopeHash8('').length === 8;
})(), { got: v1ScopeHash8(V1_SCOPE), want: G.scopeHash8 });

R.assert('I2 slug 派生：兜底与「名称派生」都等于 V1 实测（' + V1_SLUG + '）', (() => {
    return v1SlugFallback(V1_SCOPE) === 'nzxg18s'                       // 'n' + hashText(scope).slice(0,6)
        && v1SlugFromName('角色甲') === V1_SLUG                          // 全非 ASCII → 'n' + hashText(name).slice(0,6)
        && v1SlugFromName('Sample-Char_01') === 'Sample-Char_01'
        && v1SlugFromName('Sample Char/01') === 'SampleChar01';           // 非法字符剔除
})(), { fallback: v1SlugFallback(V1_SCOPE), fromName: v1SlugFromName('角色甲') });

R.assert('I3 文件名候选：主文件/备份文件与 V1 实测名逐字符一致（默认先 .json.gz 再 .json）', (() => {
    const f = v1FileNames(V1_SCOPE, V1_SLUG);
    return f.state[0] === G.stateFileName && f.state[1] === G.stateFileName.replace(/\.gz$/, '')
        && f.bak[0] === G.stateBakFileName && f.scope8 === G.scopeHash8
        && f.all.length === 4 && f.base === 'ftt-state-' + V1_SLUG + '-' + G.scopeHash8;
})(), { state: v1FileNames(V1_SCOPE, V1_SLUG).state, want: G.stateFileName });

R.assert('I4 作用域候选：包含当前 V2 作用域与按身份哈希派生的 V1 作用域（两边定义不同也不假设相等）', (() => {
    setScopeKey('角色甲');
    const cur = scopeId();
    const list = v1ScopeCandidates({ getCurrentCharacterId: 'char_abc', name2: '角色甲', avatar: '角色甲.png', cachedScopes: [V1_SCOPE] });
    return list[0] === V1_SCOPE                                   // ① TH 身份（V1 的作用域定义来源）优先
        && list.indexOf(cur) === 1                                // ② 紧随 V2 当前作用域
        && list.indexOf(V1_SCOPE) >= 0
        && list.length === new Set(list).size                     // 去重
        && v1ScopeCandidates({}).indexOf(cur) === 0;
})(), { cur: scopeId() });

// ---------- I5：信封解析与完整性 ----------
R.assert('I5 信封解析：合法信封（哈希校验通过）/ 篡改拒绝 / 裸 state 兼容 / 垃圾输入不抛', (() => {
    const payload = { scope: V1_SCOPE, updatedAt: 1700000000000, data: v1State };
    const env = { v: 1, scope: V1_SCOPE, payload, hash: hashOf(payload), ts: 1700000000001 };
    const ok = decodeV1Envelope(env);
    const tampered = decodeV1Envelope(Object.assign({}, env, { payload: Object.assign({}, payload, { data: { atoms: [] } }) }));
    const raw = decodeV1Envelope(v1State);
    const junk = decodeV1Envelope(null);
    return ok.ok && ok.shaped === 'envelope' && ok.scope === V1_SCOPE && ok.updatedAt === 1700000000000
        && J(ok.data.atoms) === J(v1State.atoms)
        && !tampered.ok && tampered.reason === 'hash-mismatch'
        && raw.ok && raw.shaped === 'raw' && raw.data.scope === V1_SCOPE
        && !junk.ok && junk.reason === 'not-object';
})(), {});

function hashOf(payload) {
    // 与 adapters/import-v1.js 同算法的独立实现（双轮 FNV-1a），避免用被测函数自证
    const s = J(payload);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ (c ^ 0x5f), 0x85ebca6b) >>> 0;
    }
    return h1.toString(36) + '_' + h2.toString(36);
}

// ---------- I6：gzip 读取（V1 主文件就是 .json.gz） ----------
await (async () => {
    const text = J({ v: 1, scope: V1_SCOPE, payload: { scope: V1_SCOPE, updatedAt: 1, data: v1State }, hash: 'x', ts: 2 });
    const gz = new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
    const un = await gunzipToText(gz);
    const plain = new Uint8Array(Buffer.from(text, 'utf8'));
    R.assert('I6 gzip 支持：魔数识别 + 解压回原文（明文不误判）', (() => {
        return isGzipBytes(gz) && !isGzipBytes(plain) && !isGzipBytes(new Uint8Array([0x1f]))
            && un.ok && un.text === text && J(JSON.parse(un.text).payload.data.atoms) === J(v1State.atoms);
    })(), { gzOk: un.ok, len: (un.text || '').length });
})();

// ---------- I7：本机痕迹扫描 ----------
R.assert('I7 本机痕迹扫描：slug 缓存 / 历史文件名 / 存档名 / 旧信封 / 配置 全部识别并归到作用域', (() => {
    const s8 = G.scopeHash8;
    const store = {
        ['SPreset_FTTMemory_FileSlug_' + s8]: V1_SLUG,
        ['SPreset_FTTMemory_FileNames_' + s8]: J([G.stateFileName, G.stateBakFileName, 'ftt-snap-x.json']),
        ['SPreset_FTTMemory_ArchiveName_' + s8]: '角色甲',
        ['SPreset_FTTMemory_char:1157z2a']: J({ v: 1, scope: V1_SCOPE, payload: { scope: V1_SCOPE, updatedAt: 7, data: v1State }, hash: hashOf({ scope: V1_SCOPE, updatedAt: 7, data: v1State }) }),
        SPreset_FTTMemoryConfig: '{"VERSION":"v1.206"}',
        SomeOtherKey: 'x',
    };
    const got = scanV1LocalStorage(Object.keys(store), (k) => store[k]);
    const slot = got.scopes[s8];
    return !!slot && slot.slug === V1_SLUG && slot.archiveName === '角色甲'
        && slot.files.length === 3 && slot.files[0] === G.stateFileName
        && got.legacyStates.length === 1 && got.legacyStates[0].ok === true && got.legacyStates[0].data.atoms.length === 2
        && got.config === '{"VERSION":"v1.206"}' && got.configKey === 'SPreset_FTTMemoryConfig'
        && JSON.parse(got.config).VERSION === 'v1.206';
})(), {});

// ---------- I8：干跑差异报告 ----------
R.assert('I8 差异报告：新增 / 已存在 / 冲突 / 墓碑 逐维度计数正确且不做写入', (() => {
    setScopeKey('角色甲');
    const cur = Object.assign(emptyState(), { atoms: [mkEntry('a2', { title: '乙' }), mkEntry('a3', { title: '丙' })] });
    const before = J(cur);
    const rep = buildImportReport(v1State, cur);
    const atoms = rep.rows.filter((r) => r.kind === 'atoms')[0];
    const mems = rep.rows.filter((r) => r.kind === 'memories')[0];
    return atoms.v1 === 2 && atoms.current === 2 && atoms.add === 1 && atoms.exist === 1 && atoms.conflict === 0
        && mems.add === 2 && mems.exist === 0
        && rep.totals.v1Entries === 4 && rep.totals.add === 3 && rep.totals.exist === 1
        && rep.totals.tombstoneDims === 1 && rep.totals.tombstoneHashes === 1
        && rep.scope.v1 === V1_SCOPE && rep.scope.current === scopeId()
        && J(cur) === before;                       // 干跑不写入
})(), {});

R.assert('I8b 内容不同 → 计为冲突（同 id 但正文变了，提示用户人工确认）', (() => {
    const cur = Object.assign(emptyState(), { atoms: [mkEntry('a1', { title: '甲改' }), mkEntry('a2', { title: '乙' })] });
    const rep = buildImportReport(v1State, cur);
    const atoms = rep.rows.filter((r) => r.kind === 'atoms')[0];
    return atoms.conflict === 1 && atoms.exist === 2 && atoms.add === 0 && rep.totals.conflict === 1;
})(), {});

// ---------- I9：合并语义（append-only + 墓碑并集） ----------
R.assert('I9 合并：同 id 以当前为准（不覆盖用户数据）、V1 独有追加、墓碑并集、作用域归位当前、源不被改动', (() => {
    setScopeKey('角色甲');
    const cur = Object.assign(emptyState(), {
        atoms: [mkEntry('a2', { title: '乙-当前版' })],
        deleted: { memories: { m9: 55 } },
    });
    const v1Copy = J(v1State);
    const { merged, summary } = mergeV1IntoCurrent(cur, v1State);
    const ids = merged.atoms.map((x) => x.id);
    const a2 = merged.atoms.filter((x) => x.id === 'a2')[0];
    return ids.indexOf('a1') >= 0 && ids.indexOf('a2') >= 0 && ids.length === 2
        && a2.title === '乙-当前版'                                                   // 当前优先
        && merged.memories.length === 2 && merged.memories.map((x) => x.id).indexOf('m2') >= 0
        && summary.added.atoms === 1 && summary.added.memories === 2
        && merged.deleted.atoms.a9 === 111 && merged.deleted.memories.m9 === 55        // 两边墓碑并集
        && summary.tombstones.deleted === 1 && merged.deletedH.atoms.deadbeef === 111
        && merged.scope === scopeId()                                                  // 归位当前作用域
        && merged.state.location === '码头'                                            // 当前为空 → 采用 V1 单值
        && J(v1State) === v1Copy;                                                      // 源状态零改动
})(), {});

R.assert('I9b 合并幂等：同一 V1 数据再合并一次不再新增（除首次），且当前数据不丢', (() => {
    setScopeKey('角色甲');
    const cur = Object.assign(emptyState(), { atoms: [mkEntry('a1', { title: '甲' })] });
    const one = mergeV1IntoCurrent(cur, v1State).merged;
    const two = mergeV1IntoCurrent(one, v1State);
    return J(two.merged.atoms.map((x) => x.id)) === J(one.atoms.map((x) => x.id))
        && Object.keys(two.summary.added).length === 0 && two.summary.tombstones.deleted === 0;
})(), {});

// ---------- I10：发现 + 读取（宿主 fetch：gz 主文件优先于 bak 旧文件） ----------
await (async () => {
    setScopeKey('角色甲');
    const mainPayload = { scope: V1_SCOPE, updatedAt: 5000, data: v1State };
    const envText = J({ v: 1, scope: V1_SCOPE, payload: mainPayload, hash: hashOf(mainPayload), ts: 1 });
    const gzState = new Uint8Array(gzipSync(Buffer.from(envText, 'utf8')));
    const bakText = J({ v: 1, scope: V1_SCOPE, payload: { scope: V1_SCOPE, updatedAt: 1, data: { atoms: [mkEntry('old')] } }, hash: 'H', ts: 1 });
    const calls = [];
    const restore = installGlobalFetch((url) => {
        calls.push(url);
        const name = decodeURIComponent(url.replace('/user/files/', ''));
        if (name === G.stateFileName) return { status: 200, bytes: gzState };
        if (name === G.stateBakFileName) return { status: 200, text: bakText };
        return { status: 404, text: '' };
    });
    try {
        const found = await discoverV1Sources({ identity: { name2: '角色甲', archiveName: '角色甲', getCurrentCharacterId: 'char_abc' }, maxFiles: 24 });
        const main = found.sources.filter((s) => s.name === G.stateFileName)[0];
        const best = pickBestV1Source(found);
        const applied = [];
        const res = await importV1Data({
            dryRun: false, current: emptyState(), identity: { name2: '角色甲', archiveName: '角色甲', getCurrentCharacterId: 'char_abc' },
            apply: (merged) => { applied.push(merged.atoms.length); },
        });
        const dry = await importV1Data({ dryRun: true, current: emptyState(), identity: { name2: '角色甲', archiveName: '角色甲', getCurrentCharacterId: 'char_abc' } });
        R.assert('I10 发现与读取：gz 主文件解压成功、bak 单独标注、最佳源=主文件、apply 写入且干跑不写', (() => {
            return !!main && main.ok === true && main.gz === true && main.kind === 'state'
                && main.state && main.state.atoms.length === 2
                && found.sources.some((s) => s.name === G.stateBakFileName && s.kind === 'bak')
                && best.via === 'server-file' && best.name === G.stateFileName
                && res.dryRun === false && applied.length === 1 && applied[0] === 2
                && res.summary.added.atoms === 2 && res.notes.some((n) => n.indexOf('未被删除') >= 0)
                && dry.dryRun === true && dry.merged === null && dry.report.totals.add === 4
                && calls.every((u) => (u === '/user/files/' + G.stateFileName) || u.indexOf('/user/files/') === 0);
        })(), { got: found.sources.map((s) => s.name + ':' + (s.ok ? 'ok' : s.error)), best: best.via });
    } finally { restore(); }
})();

// ---------- I11：无源数据时的降级 ----------
await (async () => {
    const restore = installGlobalFetch(() => ({ status: 404, text: '' }));
    try {
        const res = await importV1Data({ dryRun: true, current: emptyState(), identity: { name2: '无人' } });
        R.assert('I11 无源数据：不抛、返回空报告并给出说明（导入器绝不因此损坏当前容器）', (() => {
            return res.via === '' && res.merged === null && res.report.totals.v1Entries === 0
                && res.notes.some((n) => n.indexOf('未发现可用的 V1 数据') >= 0)
                && Array.isArray(res.sources) && Array.isArray(res.discovered);
        })(), { via: res.via, notes: res.notes });
    } finally { restore(); }
})();

R.done();

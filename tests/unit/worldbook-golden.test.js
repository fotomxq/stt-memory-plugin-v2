// ============================================================
// 单元测试 · B8-7 世界书单向镜像（内核 + 宿主通道）
//   （与**真实 V1 插件**逐项比对 + V2 通道/接线自查）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 直接调用 V1 的
//   `storageProviders.worldbook` / `buildWorldbookKeys` / `refreshWorldbookNames` / `scheduleWorldbookSync`）：
//   tests/fixtures/v1-golden-worldbook.json —— 由 /tmp/wb-oracle.cjs 生成（连跑两次逐字节一致）。
// 覆盖：
//   W 组（V1 对齐）：buildWorldbookEntries 三模式 + 自定义字段 + 数值怪癖（类目常驻 H1/constant、
//     原子 H2/正文、keys 纯标签 2-12/去重/上限 10、短标题 ≤40、正文 2000/类目 4000 截断、
//     position/role/depth/probability/sticky/cooldown/delay/scan_depth/prevent_recursion 映射、
//     概率钳制与 depth=null→0 怪癖、空数据/缺 payload/null 三种退化）；
//     isFttEntry（FTT· 前缀 / extra.ftt 两态）与 legacyEntryName/isOurs（v1.27 快照词条第三态）；
//     buildWorldbookKeys（长度 2-12 过滤、隐藏原子不参与、上下限）；write/read/remove/test 全分支
//     （updateWorldbookWith 主路径、create / delete+create 退化、体积上限、缺名、无接口）；
//     refreshWorldbookNames；scheduleWorldbookSync（闸门 / 8s 防抖 / updatedAt 去重 / 失败重试）；
//     storageMeta.worldbook 元数据与非写镜像身份。
//   F 组（V2 通道与接线）：未开启世界书存储时零行为、保存流水线挂钩、宿主函数解析链
//     （TavernHelper → ctx，V1 getFn 口径）、观测/复位出口、身份视图注入、导入无副作用。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import {
    cfg, state, setKernelState, setScopeKey, setPersistHooks, setNotifyHooks, setIdentityView, setTimerHooks,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    WORLDBOOK_META, buildWorldbookEntries, buildWorldbookKeys, worldbookIsFttEntry, worldbookIsOurs,
    worldbookLegacyEntryName, worldbookFormatBytes, worldbookTotalBytes,
} from '../../core/worldbook.js';
import { worldbookProvider, refreshWorldbookNames, worldbookNames } from '../../host/worldbook.js';
import {
    WORLDBOOK_SYNC_DELAY, scheduleWorldbookSync, worldbookSyncNow, worldbookSyncState,
    worldbookSyncEnabled, worldbookResetSync,
} from '../../adapters/worldbook.js';
import { worldbookApi } from '../../host/st-api.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-worldbook.json'), 'utf8'));
const R = makeReporter('worldbook-golden B8-7 世界书单向镜像（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- 运行环境 ----------
let warns = [];
let timers = [];
/** 断言包装（防呆：fn 必须是同步返回布尔或 Promise<布尔>；异常即失败） */
const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.stack) || e); }
    R.assert(name, cond === true, extra);
};

/** oracle 同款基础存储配置（每次写入前铺底，避免用例间串味） */
function setCfg(patch) {
    Object.assign(cfg.storage, {
        worldbook: true, worldbookName: '测试书', worldbookMode: 'selective', worldbookScanDepth: 6,
        worldbookPosition: 'at_depth', worldbookRole: 'system', worldbookDepth: 9999,
        worldbookPreventRecursion: true, worldbookProbability: 100,
        worldbookSticky: null, worldbookCooldown: null, worldbookDelay: null, worldbookMaxBytes: 262144,
    }, patch || {});
    return cfg.storage;
}

function boot(patch) {
    Object.assign(cfg, clone(defaultCfg));
    if (patch) Object.assign(cfg, clone(patch));
    setScopeKey(G.inputs.charId);
    setIdentityView({ characterName: G.inputs.charName });
    setKernelState(Object.assign(emptyState(), clone(G.inputs.scenario)));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: (m) => warns.push(String(m)) });
    setNotifyHooks({ toast: () => undefined });
    setTimerHooks({
        set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clear: (id) => { timers = timers.filter((t, i) => i + 1 !== id); },
    });
    warns = [];
    timers = [];
    delete globalThis.TavernHelper;
    worldbookResetSync();
    setCfg({});
    return state;
}

/** 写入用信封（oracle 同款：固定 ts/scope → 逐字节可比） */
const envOf = (data) => ({
    v: 1, scope: G.inputs.scope, ts: G.inputs.fixedTs,
    payload: { scope: G.inputs.scope, updatedAt: G.inputs.fixedTs, data: data === undefined ? clone(G.inputs.scenario) : data },
    hash: 'fixed-hash',
});

const LEGACY_NAME = G.inputs.legacyName;
/** 世界书桩（oracle 同款初始四态：普通 / FTT· 前缀 / v1.27 快照 / extra.ftt 无前缀） */
function makeStub(opts) {
    const o = opts || {};
    const store = {};
    const calls = [];
    store['测试书'] = [
        { name: '普通词条', content: '与插件无关的词条。' },
        { name: 'FTT·旧原子', content: 'v1.37-38 前缀词条。', extra: { ftt: { kind: '情节' } } },
        { name: LEGACY_NAME, comment: LEGACY_NAME, content: J(G.read.legacy) },
        { name: '无前缀标记词条', content: 'v1.39 extra 标记词条。', extra: { ftt: { kind: '记忆' } } },
    ];
    store['空书'] = [];
    store['坏快照书'] = [{ name: LEGACY_NAME, content: '不是 JSON' }];
    const api = {
        getWorldbookNames: async () => Object.keys(store),
        getWorldbook: async (n) => clone(store[n] || []),
        updateWorldbookWith: async (n, updater) => {
            const prev = clone(store[n] || []);
            const next = updater(prev);
            calls.push({ api: 'updateWorldbookWith', name: String(n), before: prev.map((e) => e.name), after: next.map((e) => e.name) });
            store[n] = next;
        },
        deleteWorldbookEntries: async (n, pred) => {
            const prev = clone(store[n] || []);
            const next = prev.filter((e) => !pred(e));
            calls.push({ api: 'deleteWorldbookEntries', name: String(n), before: prev.map((e) => e.name), after: next.map((e) => e.name) });
            store[n] = next;
        },
        createWorldbookEntries: async (n, entries) => {
            calls.push({ api: 'createWorldbookEntries', name: String(n), created: entries.map((e) => e.name) });
            store[n] = (store[n] || []).concat(entries);
        },
    };
    if (o.noUpdate) delete api.updateWorldbookWith;
    if (o.noDelete) delete api.deleteWorldbookEntries;
    if (o.noCreate) delete api.createWorldbookEntries;
    if (o.noNames) delete api.getWorldbookNames;
    return { api, store, calls };
}

// ============================================================
// W 组：与 V1 逐项比对
// ============================================================
const MODES = {
    selective: {},
    constant: { worldbookMode: 'constant' },
    vectorized: { worldbookMode: 'vectorized' },
    custom: {
        worldbookPosition: 'after_character_definition', worldbookRole: 'assistant', worldbookDepth: 4,
        worldbookScanDepth: 0, worldbookProbability: 150, worldbookSticky: 3, worldbookCooldown: 2,
        worldbookDelay: 1, worldbookPreventRecursion: false, worldbookMode: 'constant',
    },
    quirks: { worldbookProbability: -5, worldbookScanDepth: 8, worldbookDepth: null, worldbookSticky: 0, worldbookCooldown: 0, worldbookDelay: 0 },
};

await A('W1 buildWorldbookEntries(selective)：类目常驻 H1 词条（constant + `# 类目` 清单）与原子词条（H2 标题+正文、keys 纯标签）逐条逐字段与 V1 一致', () => {
    boot(); setCfg(MODES.selective);
    const got = buildWorldbookEntries(envOf());
    const cat0 = got[0], atom1 = got[1];
    return J(got) === J(G.entrySets.selective) && got.length === G.entrySets.selective.length
        && cat0.strategy.type === 'constant' && J(cat0.strategy.keys) === J([])
        && cat0.content.indexOf('# 情节\n\n- ') === 0 && cat0.extra.ftt.cat === true && cat0.extra.ftt.scope === G.inputs.scope
        && atom1.strategy.type === 'selective' && J(atom1.strategy.keys) === J(['码头', '交接', '货物'])
        && atom1.content.indexOf('## 码头交接货物\n\n') === 0 && atom1.extra.ftt.title === '码头交接货物'
        && atom1.extra.ftt.ts === G.inputs.fixedTs;
}, () => J(buildWorldbookEntries(envOf())).slice(0, 300));

await A('W2 worldbookMode 三模式差异：仅原子词条 strategy.type 变化（constant/selective/vectorized），类目词条恒为 constant 且 keys 为空', () => {
    const out = {};
    for (const m of ['selective', 'constant', 'vectorized']) { boot(); setCfg(MODES[m]); out[m] = buildWorldbookEntries(envOf()); }
    const atomTypes = (arr) => arr.filter((e) => e.extra.ftt.cat !== true).map((e) => e.strategy.type);
    return J(out.selective) === J(G.entrySets.selective) && J(out.constant) === J(G.entrySets.constant)
        && J(out.vectorized) === J(G.entrySets.vectorized)
        && out.selective.every((e) => e.extra.ftt.cat === true ? true : e.strategy.type === 'selective')
        && out.constant.every((e) => e.extra.ftt.cat === true ? true : e.strategy.type === 'constant')
        && out.vectorized.every((e) => e.extra.ftt.cat === true ? true : e.strategy.type === 'vectorized')
        && atomTypes(out.constant).length === 14 && out.constant[1].strategy.keys.length === 3
        && out.constant[0].strategy.type === 'constant';
}, '');

await A('W3 字段映射（custom）：position.type/role/depth/order + probability + recursion 双向 + effect sticky/cooldown/delay + strategy.scan_depth 全部取 cfg.storage.worldbook*', () => {
    boot(); setCfg(MODES.custom);
    const got = buildWorldbookEntries(envOf());
    const e = got[1];
    return J(got) === J(G.entrySets.custom)
        && e.position.type === 'after_character_definition' && e.position.role === 'assistant'
        && e.position.depth === 4 && e.position.order === 100
        && e.recursion.prevent_incoming === false && e.recursion.prevent_outgoing === false && e.recursion.delay_until === null
        && e.effect.sticky === 3 && e.effect.cooldown === 2 && e.effect.delay === 1
        && e.probability === 100 && e.strategy.scan_depth === 1                     // 150 → 钳制 100；scanDepth 0 → 下限 1
        && e.enabled === true;
}, '');

await A('W4 V1 数值怪癖原样保留：probability -5 → 0；scanDepth 8 → 8；depth null → 0（非 9999）；sticky/cooldown/delay 为 0（非 null）', () => {
    boot(); setCfg(MODES.quirks);
    const e = buildWorldbookEntries(envOf())[1];
    return J(buildWorldbookEntries(envOf())) === J(G.entrySets.quirks)
        && e.probability === 0 && e.strategy.scan_depth === 8 && e.position.depth === 0
        && e.effect.sticky === 0 && e.effect.cooldown === 0 && e.effect.delay === 0;
}, '');

await A('W5 截断口径：词条名短标题 ≤40（超出加省略号）、atomContent 内标题 ≤48、正文 2000 截断、类目 content ≤4000、正文 >80 字时「短标题 + 完整正文」；关联摘要行 4 处', () => {
    boot(); setCfg(MODES.selective);
    const got = buildWorldbookEntries(envOf());
    const longAtom = got.find((e) => e.name === '长文情节');
    const longTitleEntry = got.find((e) => e.name.startsWith('这是一个长度超过四十个字符'));
    const longLineEntry = got.find((e) => e.name.startsWith('这这这'));
    const cat = got.find((e) => e.name === '记忆');
    const relCount = got.filter((e) => e.content.indexOf('关联：') >= 0).length;
    const titleLine = longTitleEntry.content.split('\n\n')[0];
    return J(got) === J(G.entrySets.selective)
        && longTitleEntry.name.length === 40 && longTitleEntry.name.endsWith('…')     // 词条名 shortTitle(max=40)
        && titleLine === '## 这是一个长度超过四十个字符以验证短标题截断行为的情节标题甲乙丙丁戊己庚辛壬癸子丑寅卯'   // 42 ≤ 48 不截断
        && titleLine.length === 45
        && longLineEntry.name.length === 40 && longLineEntry.name.endsWith('…')       // atomContent 超长行 → 40
        && longLineEntry.content.split('\n\n')[0].length === 43
        && longAtom.content.split('\n\n')[1].length === 2000
        && cat.content.length <= 4000 && cat.content.indexOf('# 记忆\n\n- 秘密交易') === 0
        && relCount === 4;
}, '');

await A('W6 三种退化：空 payload.data / 缺 payload / env 为 null → 一律空数组（不抛错）', () => {
    boot();
    return J(buildWorldbookEntries(envOf({}))) === J(G.entrySets.empty)
        && J(buildWorldbookEntries({ ts: G.inputs.fixedTs })) === J(G.entrySets.noPayload)
        && J(buildWorldbookEntries(null)) === J(G.entrySets.nullEnv)
        && buildWorldbookEntries(envOf({})).length === 0;
}, '');

await A('W7 识别三态：isFttEntry（FTT· 前缀 / extra.ftt 两态；FTT-38· 与普通词条不命中）+ legacyEntryName + isOurs（第三态 v1.27 快照词条按 name/comment 命中）与 V1 一致', () => {
    boot();
    const isFttOk = G.isFtt.every(([e, want]) => worldbookIsFttEntry(e) === want && worldbookProvider.isFttEntry(e) === want);
    const oursOk = G.isOurs.every(([e, want]) => worldbookIsOurs(e) === want && worldbookProvider.isOurs(e) === want);
    return isFttOk && oursOk && worldbookLegacyEntryName() === G.legacyName
        && worldbookProvider.legacyEntryName() === LEGACY_NAME
        && worldbookIsFttEntry({ name: 'FTT·' }) === true
        && worldbookIsFttEntry({ name: 'FTT-38·无中点' }) === false
        && worldbookIsFttEntry({ name: '普通词条', extra: {} }) === false
        && worldbookIsOurs(null) === false;
}, '');

await A('W8 buildWorldbookKeys：只取长度 2-12 的真实标签、去重、按频次降序取前 n（默认 8 / 下限 3）；已总结隐藏的情节不参与（activeAtoms 口径）', () => {
    boot();
    setKernelState(Object.assign(emptyState(), clone(G.inputs.keysState)));
    const k8 = buildWorldbookKeys(8), k3 = buildWorldbookKeys(3), k20 = buildWorldbookKeys(20), kd = buildWorldbookKeys();
    return J(k8) === J(G.keys.max8) && J(k3) === J(G.keys.max3) && J(k20) === J(G.keys.max20) && J(kd) === J(G.keys.undef)
        && k3.length === 3 && k20.indexOf('隐藏') < 0            // a4 已总结隐藏 → 标签不计入
        && k20.indexOf('丙') < 0 && k20.indexOf('这是一个超过十二个字的标签名称') < 0   // 长度过滤
        && k8.indexOf('标题') === 0;                             // 频次 2 排第一
}, () => G.keys.max8);

await A('W9 write 主路径（updateWorldbookWith）：先清掉三态旧词条（FTT·/快照/extra）再全量写入，保留无关词条；调用轨迹与结果与 V1 一致', async () => {
    boot();
    const stub = makeStub(); globalThis.TavernHelper = stub.api;
    try {
        setCfg({});
        const ok = await worldbookProvider.write(envOf());
        return ok === true && ok === G.write.ok
            && J(stub.calls) === J(G.write.calls)
            && J(stub.store['测试书'].map((e) => e.name)) === J(G.write.store)
            && J(warns) === J(G.write.warns) && warns.length === 0
            && stub.store['测试书'][0].name === '普通词条';
    } finally { delete globalThis.TavernHelper; }
}, () => warns);

await A('W10 write 体积上限（worldbookMaxBytes）：超限即跳过（不写、返回 false）并告警「词条总量 X 超过上限，已跳过…」（formatBytes 口径）', async () => {
    boot();
    const stub = makeStub(); globalThis.TavernHelper = stub.api;
    try {
        setCfg({ worldbookMaxBytes: 100 });
        const ok = await worldbookProvider.write(envOf());
        const over = G.write.overLimit;
        return ok === false && over.ok === false && stub.calls.length === 0 && over.calls === 0
            && J(warns) === J(over.warns)
            && worldbookFormatBytes(worldbookTotalBytes(buildWorldbookEntries(envOf()))) === '2.8 KB'
            && warns[0] === '存储[世界书]词条总量 2.8 KB 超过上限，已跳过（请改用浏览器/文件夹存储）';
    } finally { delete globalThis.TavernHelper; }
}, () => warns);

await A('W11 write 退化分支：未选择世界书 / 接口不支持 → 返回 false 且告警文案与 V1 逐字一致（不触发任何写入调用）', async () => {
    boot();
    try {
        setCfg({ worldbookName: '' });
        const noName = await worldbookProvider.write(envOf());
        const w1 = warns.slice(); warns = [];
        const stub2 = makeStub({ noUpdate: true, noCreate: true, noDelete: true });
        globalThis.TavernHelper = stub2.api;
        setCfg({});
        const noApi = await worldbookProvider.write(envOf());
        const w2 = warns.slice(); warns = [];
        return noName === false && J(w1) === J(G.write.noName.warns) && G.write.noName.ok === false
            && noApi === false && J(w2) === J(G.write.noApi.warns) && stub2.calls.length === 0;
    } finally { delete globalThis.TavernHelper; }
}, () => warns);

await A('W12 write 退化通道：仅 create → 直接追加；del+create → 先按谓词删本插件词条再写；两接口全无 → false；轨迹与 V1 一致', async () => {
    boot();
    try {
        const onlyCreate = makeStub({ noUpdate: true, noDelete: true });
        globalThis.TavernHelper = onlyCreate.api;
        setCfg({});
        const ok1 = await worldbookProvider.write(envOf());
        const createOnlyCalls = clone(onlyCreate.calls);
        const delCreate = makeStub({ noUpdate: true });
        globalThis.TavernHelper = delCreate.api;
        const ok2 = await worldbookProvider.write(envOf());
        const delCreateCalls = clone(delCreate.calls);
        const delCreateStore = delCreate.store['测试书'].map((e) => e.name);
        const none = makeStub({ noUpdate: true, noCreate: true, noDelete: true });
        globalThis.TavernHelper = none.api;
        const ok3 = await worldbookProvider.write(envOf());
        return ok1 === G.write.createOnly.ok && J(createOnlyCalls) === J(G.write.createOnly.calls)
            && ok2 === G.write.delCreate.ok && J(delCreateCalls) === J(G.write.delCreate.calls)
            && J(delCreateStore) === J(G.write.delCreate.store)
            && ok3 === false;
    } finally { delete globalThis.TavernHelper; }
}, '');

await A('W13 read：仅兼容 v1.27 旧快照词条（content=完整信封 JSON）→ 返回该信封；坏 JSON / 未命中 / 未选书 → null', async () => {
    boot();
    const stub = makeStub(); globalThis.TavernHelper = stub.api;
    try {
        setCfg({});
        const hit = await worldbookProvider.read();
        setCfg({ worldbookName: '坏快照书' });
        const bad = await worldbookProvider.read();
        setCfg({ worldbookName: '空书' });
        const miss = await worldbookProvider.read();
        setCfg({ worldbookName: '' });
        const noName = await worldbookProvider.read();
        return J(hit) === J(G.read.legacy) && bad === G.read.badJson && miss === G.read.miss && noName === G.read.noName
            && hit && hit.payload && hit.payload.data && Array.isArray(hit.payload.data.atoms);
    } finally { delete globalThis.TavernHelper; }
}, '');

await A('W14 test：有 getWorldbookNames 且返回数组 → true；无 API → false；返回非数组 → false', async () => {
    boot();
    const stub = makeStub(); globalThis.TavernHelper = stub.api;
    try {
        const ok = await worldbookProvider.test();
        const noNames = makeStub({ noNames: true });
        globalThis.TavernHelper = noNames.api;
        const noApi = await worldbookProvider.test();
        const saved = stub.api.getWorldbookNames;
        stub.api.getWorldbookNames = async () => '不是数组';
        globalThis.TavernHelper = stub.api;
        const nonArray = await worldbookProvider.test();
        stub.api.getWorldbookNames = saved;
        return ok === G.test.ok && noApi === G.test.noApi && nonArray === G.test.nonArray && ok === true;
    } finally { delete globalThis.TavernHelper; }
}, '');

await A('W15 remove：优先 updateWorldbookWith 过滤；无 upd 时走 deleteWorldbookEntries(pred)；均无 → false；未选书 → false', async () => {
    boot();
    try {
        const stub = makeStub(); globalThis.TavernHelper = stub.api;
        setCfg({});
        const ok = await worldbookProvider.remove();
        const updCalls = clone(stub.calls);
        const updStore = stub.store['测试书'].map((e) => e.name);
        const del = makeStub({ noUpdate: true });
        globalThis.TavernHelper = del.api;
        const okDel = await worldbookProvider.remove();
        const delCalls = clone(del.calls);
        const none = makeStub({ noUpdate: true, noDelete: true });
        globalThis.TavernHelper = none.api;
        const okNone = await worldbookProvider.remove();
        setCfg({ worldbookName: '' });
        const okNoName = await worldbookProvider.remove();
        return ok === G.remove.ok && J(updCalls) === J(G.remove.calls) && J(updStore) === J(G.remove.store)
            && okDel === G.remove.delPath.ok && J(delCalls) === J(G.remove.delPath.calls)
            && okNone === G.remove.noApi && okNoName === G.remove.noName;
    } finally { delete globalThis.TavernHelper; }
}, '');

await A('W16 scheduleWorldbookSync：未开启 → 不排（零行为）；开启 → 单次 8000ms 防抖；失败告警且不记 updatedAt（下次重试）；成功后相同 updatedAt 跳过', async () => {
    boot();
    setCfg({ worldbook: false });
    const enabledOff = scheduleWorldbookSync();
    const offTimers = timers.length;
    setCfg({});
    const enabledOn = scheduleWorldbookSync();
    const onTimers = timers.map((t) => t.ms);
    scheduleWorldbookSync();
    const afterDebounce = timers.length;
    const timer = timers[timers.length - 1];
    const origWrite = worldbookProvider.write;
    const origNow = Date.now;
    const writes = [];
    Date.now = () => G.inputs.fixedNow;
    try {
        worldbookProvider.write = async (env) => { writes.push({ scope: env.scope, ts: env.ts, updatedAt: env.payload.updatedAt }); return false; };
        warns = [];
        await timer.fn();
        const failWarns = warns.slice();
        worldbookProvider.write = async (env) => { writes.push({ scope: env.scope, ts: env.ts, updatedAt: env.payload.updatedAt }); return true; };
        await timer.fn();
        const afterOk = writes.length;
        await timer.fn();
        const afterDedupe = writes.length;
        return enabledOff === false && G.schedule.gateOffTimers === 0 && offTimers === 0
            && enabledOn === true && J(onTimers) === J(G.schedule.gateOnDelays) && J(onTimers) === J([WORLDBOOK_SYNC_DELAY])
            && afterDebounce === G.schedule.afterDebounce && J(failWarns) === J(G.schedule.failWarns)
            && J(writes) === J(G.schedule.writes) && afterOk === G.schedule.afterOk && afterDedupe === G.schedule.afterDedupe;
    } finally {
        worldbookProvider.write = origWrite;
        Date.now = origNow;
    }
}, () => ({ timers: timers.map((t) => t.ms), warns, writes }));

await A('W17 存储元数据：WORLDBOOK_META 与 V1 storageMeta.worldbook 逐字段一致；世界书**不参与常规写镜像**（V1 storageIsWriteMirror(\"worldbook\")===false）', () => {
    boot();
    return J(WORLDBOOK_META) === J(G.storageMetaWorldbook) && G.storageIsWriteMirrorWorldbook === false
        && worldbookProvider.label === G.storageMetaWorldbook.label
        && WORLDBOOK_META.label === '世界书存储' && WORLDBOOK_META.short === '世界书'
        && WORLDBOOK_META.group === 'cross' && WORLDBOOK_META.crossDevice === true;
}, '');

await A('W18 refreshWorldbookNames：取 TH 世界书名 → 更新缓存并返回字符串数组（两次调用一致）；无 API → 空数组不抛错', async () => {
    boot();
    const stub = makeStub(); globalThis.TavernHelper = stub.api;
    try {
        const names = await refreshWorldbookNames();
        const again = await refreshWorldbookNames();
        const cacheOk = J(worldbookNames()) === J(G.refreshNames[1]) && J(names) === J(G.refreshNames[0]) && J(again) === J(G.refreshNames[1]);
        delete globalThis.TavernHelper;
        const none = await refreshWorldbookNames();
        return cacheOk && J(none) === J([]) && worldbookNames().length === 0 && worldbookNames().isArray !== true;
    } finally { delete globalThis.TavernHelper; }
}, '');

// ============================================================
// F 组：V2 通道与接线自查
// ============================================================
await A('F1 未开启世界书存储时零行为：schedule 返回 false 且不排任何定时器；worldbookSyncNow 直接 skipped=disabled；不触宿主 API', async () => {
    boot();
    setCfg({ worldbook: false });
    const s = scheduleWorldbookSync();
    const now = await worldbookSyncNow();
    const st = worldbookSyncState();
    return s === false && timers.length === 0 && now.skipped === 'disabled'
        && st.enabled === false && st.pending === false && st.lastSyncedAt === 0
        && st.delayMs === WORLDBOOK_SYNC_DELAY && WORLDBOOK_SYNC_DELAY === 8000 && worldbookSyncEnabled() === false;
}, '');

await A('F2 保存流水线接线：adapters/store.js#saveStateNow 在开启世界书存储后挂钩 8s 世界书同步（关闭时不挂钩）', async () => {
    boot();
    const { saveStateNow } = await import('../../adapters/store.js');
    setCfg({ worldbook: false, syncOnSave: false });
    await saveStateNow({ skipFile: true });
    const offCount = timers.filter((t) => t.ms === WORLDBOOK_SYNC_DELAY).length;
    boot();
    setCfg({ worldbook: true, syncOnSave: false });
    await saveStateNow({ skipFile: true });
    const onCount = timers.filter((t) => t.ms === WORLDBOOK_SYNC_DELAY).length;
    return offCount === 0 && onCount === 1 && worldbookSyncState().pending === true;
}, () => ({ timers: timers.map((t) => t.ms) }));

await A('F3 观测/复位出口：worldbookSyncState 报告 pending/name/延迟；worldbookResetSync 清空在途态（不改写入语义）', async () => {
    boot();
    setCfg({});
    scheduleWorldbookSync();
    const before = worldbookSyncState();
    worldbookResetSync();
    const after = worldbookSyncState();
    return before.pending === true && before.name === '测试书' && before.delayMs === 8000
        && after.pending === false && after.lastSyncedAt === 0 && after.last.ok === false
        && after.name === '测试书' && worldbookSyncEnabled() === true && timers.length === 0;
}, '');

await A('F4 宿主函数解析链（V1 getFn 口径）：无 TavernHelper 时世界书读接口为空；仅 ctx 提供 getWorldbook/getWorldbookNames 时 read/test 仍可用；TavernHelper 优先', async () => {
    boot();
    const empty = worldbookApi();
    const emptyOk = empty.names === null && empty.get === null && empty.update === null && empty.del === null && empty.create === null;
    const stubCtx = { getWorldbookNames: async () => ['ctx书'], getWorldbook: async () => [{ name: 'ctx词条', content: 'x' }] };
    const prevST = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => stubCtx };
    try {
        const api = worldbookApi();
        const test = await worldbookProvider.test();
        const read = await worldbookProvider.read();
        globalThis.TavernHelper = { getWorldbookNames: async () => ['th书'] };
        const viaTavern = worldbookApi();
        const thNames = await viaTavern.names();
        delete globalThis.TavernHelper;
        return emptyOk && !!api.names && !!api.get && api.update === null && api.del === null && api.create === null
            && test === true && read === null && typeof viaTavern.names === 'function' && J(thNames) === J(['th书']);
    } finally {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        delete globalThis.TavernHelper;
    }
}, '');

await A('F5 身份视图注入：legacyEntryName 用注入的角色名（前 20 字截断）；未注入时退化为「FTT记忆快照·」', () => {
    boot();
    const LONG_NAME = '这是一个长度超过二十个字符的角色名字甲乙丙丁戊己庚辛壬癸';
    setIdentityView({ characterName: '角色甲' });
    const a = worldbookLegacyEntryName();
    setIdentityView({ characterName: LONG_NAME });
    const b = worldbookLegacyEntryName();
    setIdentityView({ characterName: '' });
    const c = worldbookLegacyEntryName();
    setIdentityView({ characterName: G.inputs.charName });
    return a === LEGACY_NAME && LONG_NAME.length > 20
        && b === 'FTT记忆快照·' + LONG_NAME.slice(0, 20) && b.length === 'FTT记忆快照·'.length + 20
        && c === 'FTT记忆快照·' && worldbookLegacyEntryName() === LEGACY_NAME;
}, '');

await A('F6 导入无副作用：仅导入（boot 后未调用任何入口）不排定时器、不触宿主；世界书内核可离线构建（纯 cfg/state 视图）', () => {
    boot();
    const idle = timers.length === 0 && worldbookSyncState().pending === false;
    const entries = buildWorldbookEntries(envOf());
    const shared = entries.length === G.entrySets.selective.length && entries[0].strategy.type === 'constant';
    setKernelState(null);
    const emptyNoState = buildWorldbookEntries(envOf({}));
    setKernelState(Object.assign(emptyState(), clone(G.inputs.scenario)));
    return idle && J(entries) === J(G.entrySets.selective) && shared && J(emptyNoState) === J([]) && timers.length === 0;
}, '');

R.done();

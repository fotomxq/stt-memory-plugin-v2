// ============================================================
// 单元测试 · 功能清单基线锁（**防止功能被静默移除**）
//
// 由来（v3.48.1，用户报告）：「例如修改角色旁批量补全履历功能，发版后消失了，需修复。
//   其他类似被错误移除的功能也需核对，如是被误操作移除的也需恢复。」
//
// 背景：本仓近期出现过多会话并行开发（v3.47.x 期间远端与本地各发一版），
//   合并 / 重编号 / 体量压缩时**最容易发生的就是「顺手删掉别人刚加的东西」**，
//   而现有门禁（体量 / 静态 / 单测）**不会**因为「少了一个按钮 / 少了一个设定项 / 少了一个配置键」而变红 ——
//   除非刚好有测试覆盖到它。本文件补上这道**面向用户可见入口**的兜底：
//
//   ① 基线文件 `scripts/feature-inventory.json` 记录**用户可见入口**的全量清单：
//      · `actions`  —— 界面上出现过的动作锚点（`data-ftt-action="…"`，= 用户能点的东西）
//      · `controls` —— 设定页的配置控件键（= 用户能调的参数）
//      · `cfgKeys`  —— 内核配置键（= 功能的存在本身）
//      · `tabs`     —— 面板分页
//      · `dims`     —— 数据维度
//      · `bridge`   —— 调试桥只读方法
//      · `i18n`     —— 词条键
//   ② **只对「消失」判红**：基线里有、现状没有 → 失败并逐条列出（附「确为有意移除时怎么改」的指引）；
//      现状新增 → **不失败**，只提示跑 `--write` 刷新基线（新功能不该被这道锁挡住）。
//   ③ `--write` 重建基线（有意移除时**必须**先在本目录对应的 `docs/D22` 行登记，再刷新基线）。
//
// 反向探针：删掉任意一个 `data-ftt-action` / 控件 / 配置键 → 本文件立即变红（见 F 组自检）。
//
// 运行：`node tests/unit/feature-inventory.test.js`（校验）· `… --write`（重建基线）
// ============================================================
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_PATH = join(ROOT, 'scripts', 'feature-inventory.json');
const R = makeReporter('feature-inventory v3.48.1 功能清单基线锁（防静默移除）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const WRITE = process.argv.indexOf('--write') >= 0;

// ---------- 采集现状 ----------
/** 递归列出某目录下的文件（按扩展名过滤） */
function walk(dir, ext, acc) {
    const out = acc || [];
    let list = [];
    try { list = readdirSync(dir); } catch (e) { return out; }
    for (const name of list) {
        const p = join(dir, name);
        let st = null;
        try { st = statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) walk(p, ext, out);
        else if (ext.test(name)) out.push(p);
    }
    return out;
}
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch (e) { return ''; } };

/** 界面动作锚点（用户能点的东西） */
function collectActions() {
    const set = new Set();
    for (const f of walk(join(ROOT, 'ui'), /\.js$/).concat([join(ROOT, 'index.js')])) {
        const src = read(f);
        for (const m of src.matchAll(/data-ftt-action="([A-Za-z0-9_-]+)"/g)) set.add(m[1]);
    }
    return [...set].sort();
}
/** 设定页控件键（用户能调的参数） */
async function collectControls() {
    const SP = await import('../../ui/settings-pages.js');
    const out = [];
    for (const [page, list] of Object.entries(SP.SETTINGS_CONTROLS)) {
        for (const c of (Array.isArray(list) ? list : [])) out.push(page + ':' + String(c && c.key != null ? c.key : c));
    }
    return out.sort();
}
/** 内核配置键（功能的存在本身） */
async function collectCfgKeys() {
    const C = await import('../../core/config.js');
    return Object.keys(C.defaultCfg).sort();
}
async function collectTabs() {
    const P = await import('../../ui/panel.js');
    return P.PANEL_TABS.map((t) => String(t[0])).sort();
}
async function collectDims() {
    const C = await import('../../core/constants.js');
    return C.DIMENSIONS.map((d) => String(d.kind)).sort();
}
async function collectBridge() {
    const D = await import('../../ui/debug.js');
    let n = 0;
    try { n = Object.keys(D.buildBridgeMethods()).length; } catch (e) { n = 0; }
    return ['count:' + n];
}
function collectI18n() {
    const j = read(join(ROOT, 'i18n', 'zh-cn.json'));
    try { return Object.keys(JSON.parse(j)).sort(); } catch (e) { return []; }
}

const NOW = {
    actions: collectActions(),
    controls: await collectControls(),
    cfgKeys: await collectCfgKeys(),
    tabs: await collectTabs(),
    dims: await collectDims(),
    bridge: await collectBridge(),
    i18n: collectI18n(),
};

// ---------- 基线 ----------
let BASE = null;
try { BASE = JSON.parse(read(BASE_PATH)); } catch (e) { BASE = null; }

if (WRITE) {
    const out = {
        note: '功能清单基线（防静默移除，见 tests/unit/feature-inventory.test.js 头部）。'
            + '**只对「基线有、现状没有」判红**；新增项请跑 `node tests/unit/feature-inventory.test.js --write` 刷新。'
            + '有意移除时必须先在 docs/D22 对应批次行登记，再刷新此处。',
        generatedBy: 'tests/unit/feature-inventory.test.js --write',
        actions: NOW.actions, controls: NOW.controls, cfgKeys: NOW.cfgKeys,
        tabs: NOW.tabs, dims: NOW.dims, bridge: NOW.bridge, i18n: NOW.i18n,
    };
    writeFileSync(BASE_PATH, JSON.stringify(out, null, 2) + '\n');
    console.log('已重建功能清单基线：' + BASE_PATH);
    console.log('  actions ' + NOW.actions.length + ' · controls ' + NOW.controls.length + ' · cfgKeys ' + NOW.cfgKeys.length
        + ' · tabs ' + NOW.tabs.length + ' · dims ' + NOW.dims.length + ' · bridge ' + NOW.bridge.join(',') + ' · i18n ' + NOW.i18n.length);
}

A('A1 基线文件存在且可解析（`scripts/feature-inventory.json`）', (() => {
    return !!BASE && Array.isArray(BASE.actions) && Array.isArray(BASE.controls) && Array.isArray(BASE.cfgKeys)
        && Array.isArray(BASE.tabs) && Array.isArray(BASE.dims) && Array.isArray(BASE.i18n);
})(), J(BASE ? Object.keys(BASE) : null));
A('A2 基线覆盖规模合理（防「基线被清空 → 门禁静默全绿」）', (() => {
    if (!BASE) return false;
    return BASE.actions.length >= 170 && BASE.controls.length >= 170 && BASE.cfgKeys.length >= 230
        && BASE.tabs.length >= 13 && BASE.dims.length >= 14 && BASE.i18n.length >= 40;
})(), J(BASE ? { actions: BASE.actions.length, controls: BASE.controls.length, cfgKeys: BASE.cfgKeys.length } : null));

/** 逐类比对：返回消失项（基线有、现状没有） */
const missingOf = (key) => {
    if (!BASE || !Array.isArray(BASE[key])) return [];
    const nowSet = new Set(NOW[key] || []);
    return BASE[key].filter((x) => !nowSet.has(x));
};
const addedOf = (key) => {
    if (!BASE || !Array.isArray(BASE[key])) return [];
    const baseSet = new Set(BASE[key]);
    return (NOW[key] || []).filter((x) => !baseSet.has(x));
};
/** 统一断言：消失即红（附指引），新增只提示 */
function lock(key, label) {
    const gone = missingOf(key);
    const added = addedOf(key);
    const ok = gone.length === 0;
    A('B' + (lock.n = (lock.n || 0) + 1) + ' ' + label + '：**无静默移除**（基线 ' + (BASE ? BASE[key].length : 0)
        + ' 项 / 现状 ' + (NOW[key] || []).length + ' 项' + (added.length ? (' · 新增 ' + added.length + ' 项') : '') + '）',
    ok, gone.length ? ('消失：' + gone.join(' | ') + '  ← 若确为有意移除，先在 docs/D22 登记再跑 --write 刷新基线') : (added.length ? ('新增（不判红，请择机 --write）：' + added.join(' | ')) : ''));
    return ok;
}

lock('actions', 'C·用户能点的动作锚点');
lock('controls', 'C·设定页配置控件');
lock('cfgKeys', 'C·内核配置键');
lock('tabs', 'C·面板分页');
lock('dims', 'C·数据维度');
lock('bridge', 'C·调试桥方法数');
lock('i18n', 'C·词条键');

// ---------- D 组：本次修复的功能必须在位 ----------
A('D1 用户报告的那一条**在位**：角色页「📜 批量完善履历」入口与动作（不因「暂无候选」而消失）', (() => {
    const src = read(join(ROOT, 'ui', 'resume-batch.js'));
    return NOW.actions.indexOf('resumeBatchOpen') >= 0 && NOW.actions.indexOf('resumeBatchRun') >= 0
        && NOW.actions.indexOf('resumeBatchApply') >= 0 && NOW.actions.indexOf('resumeBatchToggle') >= 0
        && NOW.actions.indexOf('resumeBatchClose') >= 0
        && NOW.actions.indexOf('resumeRepair') >= 0
        && src.indexOf('📜 批量完善履历') >= 0
        && src.indexOf("if (!cands.length) return '';") < 0;         // 入口**不再**按候选数隐藏（v3.48.1 起恒显）
    
})(), 'n/a');
A('D2 其配置四键与设定控件都在位（功能「存在」的三层证据：动作 / 控件 / 配置键）', (() => {
    const keys = ['resumeBatchEnabled', 'resumeBatchDays', 'resumeBatchMaxRoles', 'resumeBatchMemoryPerRole'];
    return keys.every((k) => NOW.cfgKeys.indexOf(k) >= 0)
        && keys.every((k) => NOW.controls.indexOf('feed:' + k) >= 0);
})(), J({ cfg: NOW.cfgKeys.filter((k) => k.indexOf('resumeBatch') === 0), ctl: NOW.controls.filter((c) => c.indexOf('resumeBatch') >= 0) }));

// ---------- E 组：基线文件自身可维护 ----------
A('E1 基线文件由本测试生成/维护（`--write` 已在头部写明），且带说明字段', (() => {
    return !!BASE && typeof BASE.note === 'string' && BASE.note.indexOf('feature-inventory.test.js') >= 0
        && BASE.generatedBy === 'tests/unit/feature-inventory.test.js --write';
})(), J(BASE && BASE.generatedBy));

// ---------- F 组：反向探针（证明这道锁真的会红） ----------
A('F1 反向探针：把「删除」动作从现状里假设移除 → 判据变红（模拟「功能被静默移除」）', (() => {
    const probe = 'delete';                        // 一个真实存在、且几乎不可能被删的动作
    const nowSet = new Set(NOW.actions.filter((x) => x !== probe));   // ← 假设它被删掉了
    const gone = (BASE ? BASE.actions : []).filter((x) => !nowSet.has(x));
    return NOW.actions.indexOf(probe) >= 0 && gone.length === 1 && gone[0] === probe;
})(), 'n/a');
A('F2 反向探针：把某个设定控件从现状里假设移除 → 也判红（覆盖「设定项被删」这一类）', (() => {
    const probe = 'feed:resumeBatchEnabled';
    const nowSet = new Set(NOW.controls.filter((x) => x !== probe));
    const gone = (BASE ? BASE.controls : []).filter((x) => !nowSet.has(x));
    return NOW.controls.indexOf(probe) >= 0 && gone.length === 1 && gone[0] === probe;
})(), 'n/a');
A('F3 新增项**不判红**（否则新功能会被这道锁挡住）', (() => {
    const fakeNow = (NOW.actions || []).concat(['brandNewActionForProbe']);
    const fakeBase = BASE ? BASE.actions : [];
    const gone = fakeBase.filter((x) => fakeNow.indexOf(x) < 0);
    const added = fakeNow.filter((x) => fakeBase.indexOf(x) < 0);
    return gone.length === 0 && added.length === 1;
})(), 'n/a');

R.done();

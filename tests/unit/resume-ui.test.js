// ============================================================
// 单元测试 · v3.45.5（`docs/D22` W4 数据维度「履历」`应-19`）——**界面与个体按钮**
//
// 覆盖（设计稿 `docs/D26` §3.5「展示口径」）：
//   R 组 角色行的「📜 履历」区块：开关 / 锚点 / 条数读数 / **剧情时间倒序** / 原作条目可区分 / 默认收起；
//   S 组 设定页「📜 履历」6 项控件齐备（键 / 类型 / 默认值 / 在「投喂范围」页可见）；
//   F 组 角色编辑器字段表新增「原作 / 史实人物」（`canon`）并归入 `identity`。
//
// 口径（本文件只做「界面 vs 内核」的一致性断言，不重算算法）：
//   · 逐条顺序与单行文本都直接调 `core/resume.js#resumeSort` / `#resumeEntryLine` 取期望值 ——
//     断言的是「界面确实用了内核那一份」，而不是界面自己排的序；
//   · 「动作路由」不在本文件断言：`ui/panel.js` 的 `resumeRepair` 由维护者实现，本文件只锁**锚点**。
// 运行：node tests/unit/resume-ui.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { listRowMainHtml } from '../../ui/list-rows.js';
import { kindFields, deconstructEntry, flattenSnapshot } from '../../ui/fields.js';
import { SETTINGS_CONTROLS, settingsControlHtml, settingsPageHtml } from '../../ui/settings-pages.js';
import { panelBodyHtml, setPanelHooks2, openPanel } from '../../ui/panel.js';
import { resumeSort, resumeEntryLine } from '../../core/resume.js';
import { escHtml } from '../../core/util.js';

const R = makeReporter('resume-ui v3.45.5 履历界面与个体按钮（应-19）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const esc = (v) => escHtml(String(v == null ? '' : v));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

/** 六项新键（设定页控件 + 默认值） */
const RESUME_KEYS = ['snapshotResumeEnabled', 'snapshotResumeMax', 'snapshotResumeTriggerRatio',
    'snapshotResumeImmune', 'snapshotResumeSummaryMax', 'snapshotResumeCanonFill'];

/** 3 条履历（**乱序**输入：中间一条是「原作」来源且年份最早） */
const ENTRIES = [
    { date: '1919-11-01', summary: '乙在码头与甲立约', importance: 0.5, source: 'story' },
    { date: '1800-05-05', summary: '乙年少时师从剑客', importance: 0.9, source: 'canon' },
    { date: '1919-11-20', summary: '乙发现铜箱来路', importance: 0.8, source: 'story' },
];

const SNAP = (extra) => Object.assign({
    id: 's1', name: '乙', tags: [], identity: { canon: true }, uses: 0,
}, extra || {});

/** 每例都从默认配置与一条干净档案起（避免用例互相污染） */
function boot(snap) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:resume-ui');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), { snapshots: [snap || SNAP({ resume: clone(ENTRIES) })] }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
    return state.snapshots[0];
}
/** 单行渲染（与列表页同一渲染函数；`ctx=null` = 不传渲染期索引，走原实现） */
const rowHtml = (snap) => { boot(snap); return String(listRowMainHtml('snapshots', state.snapshots[0], null) || ''); };

// ---------- R 组：角色行的「📜 履历」区块 ----------
A('R1 开关开启 + 3 条履历（乱序输入）→ 区块渲染：行锚点 / 条数「3 / 30」/ `resumeSort` 倒序 / 原作条目可区分 / 逐条默认收起', (() => {
    const html = rowHtml(SNAP({ resume: clone(ENTRIES) }));
    const sorted = resumeSort(clone(ENTRIES));
    const at = sorted.map((e) => html.indexOf(esc(e.summary)));
    const canonLine = resumeEntryLine(sorted[2]);              // 1800-05-05 = 最早 = 排最后 = canon 那条
    return html.indexOf('data-ftt-resume="s1"') >= 0
        && html.indexOf('📜 履历 3 / 30') >= 0
        // 倒序：位置递增（1919-11-20 → 1919-11-01 → 1800-05-05）
        && at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]))
        // 单行文本出自内核（`resumeEntryLine`），界面不另写一份
        && canonLine.indexOf('原作') >= 0 && html.indexOf(esc(canonLine)) >= 0
        // 原作人物标记（identity.canon === true）
        && html.indexOf('原作人物') >= 0
        // 逐条清单默认收起
        && html.indexOf('<details class="ftt-details ftt-hint-details">') >= 0
        && html.indexOf('履历 3 条') >= 0;
})(), J({ at: resumeSort(clone(ENTRIES)).map((e) => e.summary), canon: resumeEntryLine(resumeSort(clone(ENTRIES))[2]) }));

A('R2 总开关关闭（`snapshotResumeEnabled = false`）→ **整块不渲染**（锚点 / 按钮 / 履历正文都不出现）', (() => {
    boot(SNAP({ resume: clone(ENTRIES) }));
    cfg.snapshotResumeEnabled = false;
    const html = String(listRowMainHtml('snapshots', state.snapshots[0], null) || '');
    return html.indexOf('data-ftt-resume') < 0 && html.indexOf('resumeRepair') < 0
        && html.indexOf('📜 履历') < 0 && html.indexOf('乙年少时师从剑客') < 0;
})(), '见断言');

A('R3 履历为空（N === 0）→ 空态一行（`ftt-muted`）+ 「📜 补全 / 修复履历」按钮仍在；不渲染空的折叠块', (() => {
    const html = rowHtml(SNAP({ resume: [] }));
    return html.indexOf('data-ftt-resume="s1"') >= 0
        && html.indexOf('📜 履历 0 / 30') >= 0
        && html.indexOf('（暂无履历；点「📜 补全 / 修复履历」生成）') >= 0
        && html.indexOf('data-ftt-action="resumeRepair"') >= 0
        && html.indexOf('ftt-hint-details') < 0;
})(), '见断言');

A('R4 个体按钮锚点：`data-ftt-action="resumeRepair"` 与 `data-ftt-id="<档案 id>"` 在**同一个按钮**上；title 如实写明「只修这一名角色」', (() => {
    const html = rowHtml(SNAP({ resume: clone(ENTRIES) }));
    return /<button[^>]*data-ftt-action="resumeRepair"[^>]*data-ftt-id="s1"[^>]*>/.test(html)
        && html.indexOf('📜 补全 / 修复履历') >= 0
        && html.indexOf('只修这一名角色的履历') >= 0;
})(), '见断言');

await (async () => {
    boot(SNAP({ resume: clone(ENTRIES) }));
    openPanel('snapshots');
    const html = String(panelBodyHtml('snapshots') || '');
    A('R5 真实列表页（`ui/panel.js` 的快照分页）同样带履历区块与按钮锚点（不是只有直接调用才有）',
        html.indexOf('data-ftt-resume="s1"') >= 0 && html.indexOf('data-ftt-action="resumeRepair"') >= 0
        && html.indexOf('📜 履历 3 / 30') >= 0,
        J({ anchor: html.indexOf('data-ftt-resume="s1"'), btn: html.indexOf('data-ftt-action="resumeRepair"') }));
})();

// ---------- S 组：设定页 6 项控件 ----------
A('S1 设定页「📜 履历」6 项控件齐备：键都在控件表里、都在「投喂范围」页渲染出 `data-ftt-cfg`、类型 = 两个勾选框 + 四个数字', (() => {
    boot();
    const feed = Array.isArray(SETTINGS_CONTROLS.feed) ? SETTINGS_CONTROLS.feed : [];
    const ctlOf = (k) => feed.filter((c) => String(c.key) === k)[0] || null;
    const missing = RESUME_KEYS.filter((k) => !ctlOf(k));
    const types = RESUME_KEYS.map((k) => (ctlOf(k) || {}).type);
    const renderOk = RESUME_KEYS.every((k) => {
        const c = ctlOf(k);
        return !!c && settingsControlHtml(c).indexOf('data-ftt-cfg="' + k + '"') >= 0;
    });
    const page = String(settingsPageHtml('feed') || '');
    const pageOk = RESUME_KEYS.every((k) => page.indexOf('data-ftt-cfg="' + k + '"') >= 0);
    return missing.length === 0 && renderOk && pageOk
        && J(types) === J(['checkbox', 'number', 'number', 'number', 'number', 'checkbox'])
        && settingsControlHtml(ctlOf('snapshotResumeEnabled')).indexOf('<input type="checkbox"') >= 0
        && settingsControlHtml(ctlOf('snapshotResumeMax')).indexOf('<input type="number"') >= 0;
})(), (() => {
    const feed = Array.isArray(SETTINGS_CONTROLS.feed) ? SETTINGS_CONTROLS.feed : [];
    return J({ types: RESUME_KEYS.map((k) => ((feed.filter((c) => String(c.key) === k)[0]) || {}).type) });
})());

A('S2 6 项键的默认值与内核一致（30 / 0.8 / 0.7 / 60 / 开 / 开）——控件写的是同一份配置', (() => {
    return defaultCfg.snapshotResumeEnabled === true && Number(defaultCfg.snapshotResumeMax) === 30
        && Number(defaultCfg.snapshotResumeTriggerRatio) === 0.8 && Number(defaultCfg.snapshotResumeImmune) === 0.7
        && Number(defaultCfg.snapshotResumeSummaryMax) === 60 && defaultCfg.snapshotResumeCanonFill === true;
})(), J(RESUME_KEYS.map((k) => defaultCfg[k])));

// ---------- F 组：编辑器字段表 ----------
A('F1 角色编辑器字段表含「原作 / 史实人物」勾选框（紧跟「长生者」，带 label）；`deconstructEntry` 把它归入 `identity`（三态可存）', (() => {
    const fields = kindFields('snapshots');
    const iImm = fields.findIndex((f) => f.key === 'immortal');
    const iCanon = fields.findIndex((f) => f.key === 'canon');
    const on = deconstructEntry('snapshots', { id: 's9', name: '丙', canon: true, history: '旧档' });
    const off = deconstructEntry('snapshots', { id: 's9', name: '丙', canon: false });
    return iCanon >= 0 && iCanon === iImm + 1
        && fields[iCanon].type === 'checkbox' && String(fields[iCanon].label || '').trim().length > 0
        && !!(on.identity && on.identity.canon === true) && on.canon === undefined
        && !!(off.identity && off.identity.canon === false)
        && flattenSnapshot({ id: 's9', name: '丙', identity: { canon: true } }).canon === true;
})(), J(kindFields('snapshots').map((f) => f.key)));

un();
R.done();

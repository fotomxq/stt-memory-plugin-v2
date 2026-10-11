// ============================================================
// 单元测试 · v3.43.0 `docs/D22` `应-7` —— **设定页控件可定位**（`docs/D19` §3.1）
//
// 缺陷（`D19` §2 K3）：列表页早有搜索/筛选，**设定页没有** —— 15 个子页 / 159 个控件只能一页页翻。
//   `D19` §3.1 的验收是「**任一控件名可在 3 次操作内定位**」（打开设定 → 输入关键词 → 点结果）。
//
// 本文件把该验收**机械化**：不是抽查几个，而是**逐个遍历全部控件**，断言：
//   ① 每个控件的**显示名**都能被检索到，且结果指向**它自己那一页的那一个键**；
//   ② 每个控件的**配置键**同样可检索（用户/文档常直接写键名）；
//   ③ 排序口径（label 前缀 > label 包含 > key 包含 > hint 包含）；
//   ④ 跳转动作 `cfgGoto`：换到目标子页 + 清空检索词 + 给目标控件加 `.ftt-cfg-flash`；
//   ⑤ 手动换子页会清掉高亮（不留残影）。
//
// 运行：node tests/unit/settings-locator.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SETTINGS_CONTROLS, SETTINGS_TABS, findSettingsControls, settingsPagesInfo, cfgFlashKeyNow, setCfgFlashKey } from '../../ui/settings-pages.js';
import { panelAction, panelBodyHtml, panelState, setPanelHooks2, openPanel } from '../../ui/panel.js';

const R = makeReporter('settings-locator v3.43.0 设定页控件可定位（D22 应-7）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(0);
    setKernelState(emptyState());
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    setCfgFlashKey('');
    try { setLoadPhase('ready'); } catch (e) { /* 忽略 */ }
    openPanel('settings');
}

/** 全站控件清单（子页 → 控件） */
const ALL = [];
for (const t of SETTINGS_TABS) for (const c of (SETTINGS_CONTROLS[t.id] || [])) if (c && c.key) ALL.push({ page: t.id, pageLabel: t.label, key: String(c.key), label: String(c.label || c.key) });

A('L1 空查询不返回全量（避免被当成"浏览模式"）：`findSettingsControls(\'\')` / `findSettingsControls(\'   \')` 均为空数组', (() => {
    return findSettingsControls('').length === 0 && findSettingsControls('   ').length === 0 && findSettingsControls(null).length === 0;
})(), J({ empty: findSettingsControls('').length }));

A('L2 **逐控件可定位（按显示名）**：全部控件的 `label` 都能检索到，且结果里存在"它自己那一页的那一个键"',
    (() => {
        const miss = [];
        for (const c of ALL) {
            const hits = findSettingsControls(c.label, 50);
            const ok = hits.some((h) => h.key === c.key && h.page === c.page);
            if (!ok) miss.push(c.page + '/' + c.key);
        }
        return ALL.length >= 150 && miss.length === 0;
    })(), (() => {
        const miss = [];
        for (const c of ALL) {
            const hits = findSettingsControls(c.label, 50);
            if (!hits.some((h) => h.key === c.key && h.page === c.page)) miss.push(c.page + '/' + c.key);
        }
        return J({ controls: ALL.length, miss: miss.slice(0, 10) });
    })());

A('L3 **逐控件可定位（按配置键）**：全部控件的 `key` 同样能检索到（用户/文档常直接写键名）',
    (() => {
        const miss = [];
        for (const c of ALL) {
            const hits = findSettingsControls(c.key, 50);
            if (!hits.some((h) => h.key === c.key && h.page === c.page)) miss.push(c.page + '/' + c.key);
        }
        return miss.length === 0;
    })(), (() => {
        const miss = [];
        for (const c of ALL) if (!findSettingsControls(c.key, 50).some((h) => h.key === c.key)) miss.push(c.key);
        return J({ miss: miss.slice(0, 10) });
    })());

A('L4 排序口径：label 前缀命中排在最前；`limit` 生效（默认 12 / 上限 50）',
    (() => {
        const prefix = findSettingsControls('重要度', 5);
        const wide = findSettingsControls('度', 5);
        const many = findSettingsControls('e', 50);
        return prefix.length >= 1 && prefix[0].rank === 0 && String(prefix[0].label).indexOf('重要度') === 0
            && wide.length === 5 && many.length <= 50 && findSettingsControls('度', 1).length === 1;
    })(), J({ prefixTop: (findSettingsControls('重要度', 3) || []).map((x) => [x.rank, x.page, x.key]) }));

A('L5 检索结果带子页归属（`page` / `pageLabel`）与命中字段（`hint` 可检索）',
    (() => {
        const hits = findSettingsControls('存储', 12);
        const withPage = hits.every((h) => !!h.page && !!h.pageLabel && SETTINGS_TABS.some((t) => t.id === h.page));
        // `hint` 命中：取任一有 hint 的控件，用其 hint 的一个片段检索
        const sample = ALL.map((c) => c).length ? (() => {
            for (const t of SETTINGS_TABS) for (const c of (SETTINGS_CONTROLS[t.id] || [])) {
                const h = String((c && c.hint) || '').trim();
                if (h.length >= 6) return { page: t.id, key: String(c.key), frag: h.slice(0, 5) };
            }
            return null;
        })() : null;
        const hintOk = sample ? findSettingsControls(sample.frag, 50).some((x) => x.key === sample.key) : false;
        return withPage && hits.length > 0 && hintOk;
    })(), J({ store: (findSettingsControls('存储', 3) || []).map((x) => [x.page, x.key]) }));

// ============================================================
// G 组：跳转动作（换子页 + 高亮 + 清检索词）
// ============================================================
await (async () => {
    boot();
    const target = ALL.filter((c) => c.page === 'forget' && c.key === 'memoryForgetCutoff')[0] || ALL[0];
    const r = await panelAction('cfgGoto', { page: target.page, cfgGoto: target.key });
    const st = panelState();
    const html = String(panelBodyHtml('settings') || '');
    const hitIdx = html.indexOf('data-ftt-cfg="' + target.key + '"');
    const flashBefore = html.lastIndexOf('ftt-cfg-flash', hitIdx);
    const near = hitIdx >= 0 && flashBefore >= 0 && (hitIdx - flashBefore) < 220;   // 高亮类挂在同一个 .ftt-field 上
    A('G1 `cfgGoto` 跳到目标子页、清空检索词、并把 `.ftt-cfg-flash` 加在**目标控件**的包装上',
        r.ok === true && st.settingsSub === target.page && st.cfgFind === '' && cfgFlashKeyNow() === target.key && near,
        J({ ret: { page: r.page, key: r.cfgKey }, sub: st.settingsSub, find: st.cfgFind, flash: cfgFlashKeyNow(), near: near }));
    const htmlQuery = String(panelAction('cfgFind', { q: '重要度' }) && '');
    await panelAction('cfgFind', { q: '重要度' });
    const st2 = panelState();
    const hitsHtml = String(panelBodyHtml('settings') || '');
    A('G2 `cfgFind` 写入检索词并渲染结果项（`data-ftt-action="cfgGoto"` + 页 / 键标记）；`cfgFindClear` 清空',
        st2.cfgFind === '重要度' && hitsHtml.indexOf('data-ftt-action="cfgGoto"') > 0
        && hitsHtml.indexOf('data-ftt-cfg-goto=') > 0 && hitsHtml.indexOf('data-ftt-page=') > 0,
        J({ find: st2.cfgFind, queryUnused: htmlQuery }));
    await panelAction('cfgFindClear', {});
    const st3 = panelState();
    A('G3 `cfgFindClear` 清检索词与高亮（不留残影）', st3.cfgFind === '' && cfgFlashKeyNow() === '', J({ find: st3.cfgFind, flash: cfgFlashKeyNow() }));
    await panelAction('settingsSub', { sub: 'base' });
    A('G4 手动换子页清掉定位高亮（避免让人误以为"就是这一项"）', cfgFlashKeyNow() === '' && panelState().settingsSub === 'base', J({ flash: cfgFlashKeyNow(), sub: panelState().settingsSub }));
})();

A('L6 控件总数与定位器口径同源（`settingsPagesInfo()` 统计 = 本文件遍历口径；159 个控件）',
    (() => {
        const info = settingsPagesInfo();
        return info.totalControls === ALL.length && info.pages.length === 15 && info.totalControls >= 150;
    })(), J(settingsPagesInfo()));

R.done();

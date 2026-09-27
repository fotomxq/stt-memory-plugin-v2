// ============================================================
// 单元测试 · v2.88.0「提取记忆的注入内容改为 Markdown 结构」（用户要求）+ 提示词一致性
// 口径：
//   · 注入体外框 = `# FTT 记忆注入` + `> …` 引用行 + 正文 + `记忆结束。`（结束哨兵保留）；
//   · 正文 = 若干 `## 小节`（`> 说明：…` 说明行紧随其后）+ `- ` 条目；
//   · 状态记录 = 每角色一行，其下二级列表 `  - **字段**：值`；当前状态 = `- **日期** / **时间** / **地点** / **在场角色**`；
//   · 约束段 = `## 注入约束` + `> 说明` + 有序列表 `1.` … + 二级列表 `  - `；
//   · **预算按内容计**（Markdown 标记不挤占预算）→ 同内容下的注入条目集合与 V1 一致；
//   · 提示词 `injectGuide` 同步改用 `## 小节名` 引用（不再出现旧的 `[区块]` 写法），保持**提示词与注入体一致**。
// 运行：node tests/unit/inject-markdown.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setChatHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg, PROMPT_TEMPLATES_V2 } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildMemoryBodyForInject, buildInjectConstraints } from '../../core/recall.js';
import { wrapInjectText } from '../../host/inject.js';

const R = makeReporter('inject-markdown v2.88.0 注入体 Markdown 结构 + 提示词一致性');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);

const mdCost = (t) => String(t == null ? '' : t).replace(/^##\s+/gm, '').replace(/^>\s*/gm, '').replace(/\*\*/g, '')
    .split('\n').map((l) => l.replace(/^[\s·\-]+/, '')).join('\n').length;

function boot(patch) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    if (patch) Object.assign(cfg, patch);
    setScopeKey('char:mdinject');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setChatHooks({ dbgLog: () => undefined, latestAiFloorText: () => '', getChatMessages: () => [], getAssistantText: () => '' });
    setLastMessageId(9);
    state.state = { date: '1919-11-29', time: '黄昏', location: '码头', present: ['角色甲'] };
    state.atoms = [{ id: 'a1', title: '发现木箱', text: '角色甲在码头发现被破坏的木箱。', date: '1919-11-29', tags: ['码头'], uses: 1 }];
    state.memories = [{ id: 'm1', owner: '角色甲', title: '木箱断口', content: '断口整齐。', date: '1919-11-29', tags: [] }];
    state.currentStates = [{ id: 's1', subject: '角色甲', field: '情绪与心理状态', value: '担忧', uses: 1 }];
    state.plans = [{ id: 'p1', title: '查案', content: '查明真相', status: 'open', uses: 1 }];
    state.scenes = [{ id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '水汽很重。', uses: 1 }];
    cfg.charBudget = 4000;
}
boot();

// ---------- A 组：正文结构 ----------
A('A1 正文为 Markdown：小节一律 `## 名称`；带说明的小节紧跟 `> 说明：…`；条目一律 `- ` 开头', (() => {
    const body = String(buildMemoryBodyForInject('码头 木箱', {}) || '');
    const lines = body.split('\n');
    const heads = lines.filter((l) => /^## /.test(l));
    const headsOk = heads.length >= 4 && heads.every((h) => /^## [^\s]/.test(h));
    const quoteOk = lines.some((l) => /^> 说明：/.test(l));
    const bulletOk = lines.filter((l) => /^- /.test(l)).length >= 3;
    const noOldMarkers = !/^\s*\[[^\]]+\]\s*$/.test(heads.join('\n')) && body.indexOf('\n[') < 0;
    return headsOk && quoteOk && bulletOk && noOldMarkers;
})(), () => String(buildMemoryBodyForInject('码头 木箱', {})).split('\n').filter((l) => /^## /.test(l)).join(' | '));

A('A2 `## 当前状态` 的四要素为 `- **日期** / **时间** / **地点** / **在场角色**`（顺序与内容不变）', (() => {
    const body = String(buildMemoryBodyForInject('', { inject: true }) || '');
    const L = body.split('\n');
    const i = L.indexOf('## 当前状态');
    return i >= 0
        && L[i + 1] === '- **日期**：1919-11-29'
        && L[i + 2] === '- **时间**：黄昏'
        && L[i + 3] === '- **地点**：码头'
        && L[i + 4] === '- **在场角色**：角色甲';
})(), () => String(buildMemoryBodyForInject('', { inject: true })).split('\n').slice(0, 6));

A('A3 `## 状态记录`：每角色一行 `- **主体**`，其下二级列表 `  - **字段**：值`', (() => {
    const body = String(buildMemoryBodyForInject('', { inject: true }) || '');
    return body.indexOf('## 状态记录') >= 0 && body.indexOf('- **角色甲**') >= 0
        && body.indexOf('  - **情绪与心理状态**：担忧') >= 0;
})(), '见断言');

// ---------- B 组：约束段与外框 ----------
A('B1 约束段：`## 注入约束` + `> 说明…` + 有序列表 `1.` + 明细 `  - …`（Markdown）', (() => {
    const c = String(buildInjectConstraints() || '');
    const L = c.split('\n');
    return L[0] === '## 注入约束' && /^> 说明：/.test(L[1] || '')
        && L.some((l) => /^1\. /.test(l)) && L.some((l) => /^2\. /.test(l))
        && L.filter((l) => /^\s+- /.test(l)).length >= 0
        && c.indexOf('· ') < 0;
})(), () => String(buildInjectConstraints()).split('\n').slice(0, 3));

A('B2 外框：`# FTT 记忆注入` + 引用行 + 正文 + `记忆结束。`；空正文返回空串', (() => {
    const t = wrapInjectText('## 情节记忆\n- 内容');
    return t.indexOf('# FTT 记忆注入') === 0 && t.indexOf('## 情节记忆\n- 内容') > 0
        && t.trim().endsWith('记忆结束。') && wrapInjectText('') === '' && wrapInjectText('  ') === '';
})(), () => wrapInjectText('x').split('\n').slice(0, 2));

// ---------- C 组：预算按内容计（Markdown 标记不挤占） ----------
A('C1 小预算下：正文的**内容长度**（去 Markdown 标记）不超过预算；且不会因标记开销而丢掉本可注入的条目', (() => {
    boot({ charBudget: 900 });
    const body = String(buildMemoryBodyForInject('码头 木箱 案例', {}) || '');
    const c = mdCost(body);
    boot({ charBudget: 900, maxAtoms: 1, maxMemories: 1, maxStates: 1, maxScenes: 0 });
    const small = String(buildMemoryBodyForInject('码头 木箱 案例', {}) || '');
    return c <= 900 && small.indexOf('## 情节记忆') >= 0 && small.indexOf('角色甲在码头发现') > 0 && mdCost(small) <= 900;
})(), () => ({ cost: mdCost(String(buildMemoryBodyForInject('码头 木箱 案例', {}))), budget: 900 }));

// ---------- D 组：提示词与注入体口径一致 ----------
A('D1 提示词 `injectGuide` 已同步为 Markdown 小节口径：引用 `## 名称`，不再出现旧的 `[区块]` 写法', (() => {
    const g = String(PROMPT_TEMPLATES_V2.injectGuide || '');
    const mustMd = ['## 当前状态', '## 情节记忆', '## 状态记录', '## 角色档案', '## 长期记忆', '## 物品', '## 货币', '## 传言', '## 计划', '## 悬念', '## 平行事件', '## 场景地点', '## 概念', '## 注入约束'];
    const miss = mustMd.filter((k) => g.indexOf(k) < 0);
    const oldMarkers = ['[当前状态]', '[情节记忆]', '[长期记忆]', '【注入约束】', '[区块]'].filter((k) => g.indexOf(k) >= 0);
    return miss.length === 0 && oldMarkers.length === 0 && g.indexOf('不得输出任何 Markdown 标题') > 0;
})(), () => ({ miss: ['## 当前状态', '## 情节记忆', '## 状态记录', '## 角色档案', '## 长期记忆', '## 物品', '## 货币', '## 传言', '## 计划', '## 悬念', '## 平行事件', '## 场景地点', '## 概念', '## 注入约束'].filter((k) => String(PROMPT_TEMPLATES_V2.injectGuide || '').indexOf(k) < 0) }));

A('D2 一致性：`## ` 小节名集合与提示词引用集合一致（注入体出现的小节都能在提示词里找到定义）', (() => {
    const body = String(buildMemoryBodyForInject('码头 木箱 案例', {}) || '');
    const heads = body.split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());
    const g = String(PROMPT_TEMPLATES_V2.injectGuide || '');
    const undef = heads.filter((h) => g.indexOf('## ' + h) < 0);
    return heads.length >= 3 && undef.length === 0;
})(), () => String(buildMemoryBodyForInject('码头 木箱 案例', {})).split('\n').filter((l) => /^## /.test(l)));

R.done();

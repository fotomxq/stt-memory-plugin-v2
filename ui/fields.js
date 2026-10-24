// ============================================================
// ui/fields.js —— **逐字移植自 V1**（src/modules/11-UI-样式与按钮.js 的字段表与表单重组）
// 覆盖：`kindFields(kind)`（各维度编辑器的字段定义：key/label/type/options/hint）、
//   `flattenSnapshot(s)`（角色档案的分组字段展开为表单字段）、`deconstructEntry(kind, flat)`（表单 → 入库 raw）。
// 依据：用户要求「完全对齐 V1」——编辑器字段、顺序、标签文案与 V1 一致。
// ============================================================

import { state } from '../core/model/runtime.js';
import { normalizePlotSegmentLines, plotSegmentsToText } from '../core/model/segment.js';
import { snapshotAppearanceText } from '../core/model/snapshot.js';
import { splitListText } from '../core/util.js';
/** v3.51.2（W32 未落地修复）：货币下拉选项 —— **当前现存货币**（记账/标的物必须挂在其中一条上 */
function currencyPickOptions() {
    try {
        const list = Array.isArray(state.currencies) ? state.currencies : [];
        const opts = list.filter((c) => c && c.id).map((c) => ({ value: String(c.id), label: (String(c.owner || '') ? (String(c.owner) + '·') : '') + String(c.name || c.id) + '（' + String(c.amount == null ? '' : c.amount) + (c.unit ? (' ' + String(c.unit)) : '') + '）' }));
        return [{ value: '', label: opts.length ? '（请选择货币 —— 记账必须挂在一条现存货币上）' : '（当前没有货币，请先在「货币总览」新增）' }].concat(opts);
    } catch (e) { return [{ value: '', label: '（请选择货币）' }]; }
}
function kindFields(kind) {
    const F = (key, label, type, extra) => ({ key, label, type: type || 'text', ...(extra || {}) });
    switch (kind) {
        case 'atoms': return [
            F('title', '标题(可选，一句话概括)', 'text'), F('text', '内容', 'textarea'), F('type', '类型', 'text'), F('date', '日期(年-月-日)', 'text'), F('time', '时间', 'text'),
            F('importance', '重要度(0-1)', 'number'), F('entities', '涉及角色(逗号分隔)', 'text'), F('locations', '涉及地点(逗号分隔)', 'text'),
            F('tags', '标签(逗号分隔，如 战斗/对话/发现)', 'text'), F('keywords', '关键词(逗号分隔，保存时并入标签)', 'text'), F('validity', '有效性', 'select', { options: [{ value: 'active', label: '进行中' }, { value: 'inactive', label: '已失效' }, { value: 'uncertain', label: '不确定' }] }),
        ];
        case 'states': return [
            F('subject', '主体', 'text'), F('field', '字段', 'text'), F('value', '值', 'textarea'), F('importance', '重要度(0-1)', 'number'), F('status', '状态', 'select', { options: ['active', 'inactive'] }),
        ];
        case 'snapshots': return [
            F('name', '姓名', 'text'), F('gender', '性别', 'text'),
            // v1.162：年龄不再是可填字段 —— 由出生日期 + 当前剧情日期自动计算（编辑器内只读展示）
            F('birthDate', '出生日期(年-月-日；年龄自动计算)', 'text'),
            F('occupation', '职业', 'text'), F('title', '称号', 'text'), F('species', '种族', 'text'), F('family', '家族', 'text'),
            // v1.164：角色存亡开关（勾选 = 已去世；角色页显示 🪦，注入时随身份带出）
            F('deceased', '已去世（剧情已明确死亡/牺牲时勾选）', 'checkbox'),
            // v3.22.0（用户要求）：「长生者」开关（勾选 = 按剧情确认是超长寿命者；角色页显示 🧬；
            //   勾选后**不再被「🔧 修复角色」分析**；可随时取消 —— 误判纠正就靠取消勾选或 AI 研判）
            F('immortal', '长生者（剧情明确超长寿命/不死/精灵/神明等设定时勾选；勾选后不再被角色修复分析）', 'checkbox'),
            // v3.45.5（`docs/D22` W4 `数-21` / 设计稿 `docs/D26` §3.4 Q5）——**V2 新增、V1 无此字段**：
            //   本字段表其余行逐字移植自 V1，唯有 `immortal`（v3.22.0）与本行 `canon` 是**有意新增**
            //   （「原作 / 史实人物」三态：true / false / 未提及）。勾选后才允许补「当前剧情日期之前」的既有生平，
            //   上界护栏与来源强制标 `canon` 见 `core/resume.js#resumeCanonGuard`。
            F('canon', '原作 / 史实人物（勾选 = 该角色有独立于本剧情的既有生平；勾选后才允许补「剧情前」的履历）', 'checkbox'),
            // v1.162：外貌特征聚合为单字段（原 身高/体型/发色发型/瞳色/肤色/特征 六项合并）
            F('appearance', '外貌特征（身高/体型/发色/瞳色等，一句话）', 'textarea'),
            F('traits', '性格特质(逗号分隔)', 'text'), F('quirks', '小癖好(逗号分隔)', 'text'), F('values', '价值观(逗号分隔)', 'text'), F('speechStyle', '说话风格', 'text'),
            F('origin', '出身', 'text'), F('history', '背景经历', 'textarea'),
            F('relationToUser', '与主角关系', 'text'), F('attitudeToUser', '对主角态度', 'text'),
            F('todos', '待办(逗号分隔)', 'text'), F('commitments', '承诺(逗号分隔)', 'text'),
            // 角色（档案/快照）标签组 —— 列表「调用统计」上一行展示；编辑器可填（逗号分隔）
            F('tags', '标签(逗号分隔，如 关键角色/伙伴/敌对/组织)', 'text'),
        ];
        case 'memories': return [
            // 去掉「关键词」输入 —— 标签组即关键词（历史 keywords 仍会并入 tags 兼容）
            F('owner', '所属角色', 'text'), F('date', '日期(年-月-日)', 'text'), F('title', '标题', 'text'), F('content', '正文', 'textarea'),
            F('tags', '标签(逗号分隔，如 约定/秘密/见闻)', 'text'), F('category', '分类', 'text'), F('importance', '重要度(0-1)', 'number'),
            F('relLinks', '关联（谁知情 / 谁相关）', 'relTable'),   // v1.166
        ];
        case 'concepts': return [
            F('name', '概念名', 'text'), F('content', '内容（含义/理念/领悟）', 'textarea'), F('source', '来源（谁提出的/从哪发现的）', 'text'),
            F('date', '日期(年-月-日)', 'text'), F('tags', '标签(逗号分隔，如 信仰/力量/规则)', 'text'), F('keywords', '关键词(逗号分隔，保存时并入标签)', 'text'), F('importance', '重要度(0-1)', 'number'),
        ];
        case 'items': return [
            // 物品支持填写 标签组（触发关键词，与记忆一致）
            F('name', '名称', 'text'), F('qty', '数量', 'number'), F('desc', '说明', 'textarea'), F('location', '位置', 'text'), F('carried', '携带中', 'checkbox'), F('tags', '标签(逗号分隔，如 关键道具/钥匙/武器)', 'text'),
        ];
        case 'currencies': return [
            // v1.181：货币 —— 归属（默认主角；其他角色需明确指定）/ 币种 / 额度（数字）/ 单位 / 收支
            F('owner', '归属（默认主角；写其他角色名即记该角色的货币）', 'text'),
            F('name', '币种（如 银元 / 一两银子 / 贝壳 / 美元 / 信用点）', 'text'),
            F('amount', '当前额度（纯数字，不带单位与千分位）', 'number'),
            F('unit', '单位（可选，如 枚 / 两 / 元 / 串）', 'text'),
            F('note', '备注（存放处 / 来源，≤80 字）', 'textarea'),
            F('date', '日期(年-月-日)', 'text'),
            F('tags', '标签(逗号分隔，如 现金/盘缠/赏金/积蓄/债务)', 'text'),
        ];
        case 'plotSegments': return [
            // v1.182：情节分段总结（### 时间范围 + 段内逐条剧情线；只归档，不注入）
            F('header', '时间范围（`### ` 后的标题文本，如 1899-03-01 ~ 1899-05-12）', 'text'),
            F('linesText', '剧情线（每行一条：线路名: 概述）', 'textarea'),
        ];
        case 'rumors': return [
            // v1.192：传言（主体 / 当前说法 / 客观性 / 阶段与发酵度 / 传播者 / 载体 / 来源）
            F('subject', '主体（这条传言关于什么；同一裂变谱系只用一种写法）', 'text'),
            F('content', '当前说法（≤180 字，只写「在传什么」）', 'textarea'),
            F('objectivity', '客观性', 'select', { options: [{ value: '主观', label: '主观（揣测/无依据）' }, { value: '客观', label: '客观（有事实基础）' }] }),
            F('stage', '阶段', 'select', { options: ['萌芽', '扩散', '发酵', '异变', '消退', '沉寂'].map(v => ({ value: v, label: v })) }),
            F('ferment', '发酵度(0-100，机械演化自动维护)', 'number'),
            F('carriersText', '传播者（每行一条：角色名 或 角色名:源头/传播者/听闻者）', 'textarea'),
            F('mediaText', '载体（每行一条：类型|名称|日期|耐久度1-5，如 报刊|申报|1919-11-29|4）', 'textarea'),
            F('source', '来源（最初从谁 / 哪里出来）', 'text'),
            F('date', '日期(年-月-日，本次变化)', 'text'),
            F('tags', '标签(逗号分隔，如 谣言/名声/阴谋/恐慌/辟谣)', 'text'),
        ];
        case 'plans': return [
            // 计划补原子层字段 —— 标题/日期/时间/涉及角色/标签（注入与清单显式展示）
            F('content', '计划内容(描述：说清做什么+为何+目标)', 'textarea'), F('title', '标题(一句话，可选)', 'text'), F('date', '日期(年-月-日，剧情时间线)', 'text'), F('time', '时间(可选)', 'text'),
            F('characters', '涉及角色(逗号分隔)', 'text'), F('tags', '标签(逗号分隔，如 目标/调查/委托)', 'text'), F('targetTime', '目标时间', 'text'), F('status', '状态', 'select', { options: [{ value: 'open', label: '进行中' }, { value: 'closed', label: '已关闭' }] }),
            F('phase', '阶段(正常推进请留空)', 'select', { options: [{ value: '', label: '进行中（默认）' }, { value: 'blocked', label: '受阻' }, { value: 'abandoned', label: '已放弃（仍在计划库中）' }] }),
            F('statusNote', '状态备注(受阻/放弃的原因，≤30字)', 'text'),
            F('relLinks', '关联（谁策划 / 谁参与 / 谁知情）', 'relTable'),   // v1.166
        ];
        case 'suspense': return [
            // 悬念补原子层字段 —— 标题/日期/时间/涉及角色/标签
            F('content', '悬念内容(描述：疑点+客观事实+因果，勿只写一个问句)', 'textarea'), F('title', '标题(一句话，可选)', 'text'), F('date', '日期(年-月-日，剧情时间线)', 'text'), F('time', '时间(可选)', 'text'),
            F('characters', '涉及角色(逗号分隔)', 'text'), F('tags', '标签(逗号分隔，如 伏笔/秘密/调查)', 'text'), F('resolveTime', '揭晓时间', 'text'), F('status', '状态', 'select', { options: [{ value: 'open', label: '未解' }, { value: 'closed', label: '已揭晓' }] }),
            F('phase', '阶段(正常推进请留空)', 'select', { options: [{ value: '', label: '进行中（默认）' }, { value: 'blocked', label: '受阻' }, { value: 'abandoned', label: '已放弃（仍在计划库中）' }] }),
            F('statusNote', '状态备注(受阻/放弃的原因，≤30字)', 'text'),
            F('relLinks', '关联（谁当事人 / 谁在查 / 谁知情）', 'relTable'),   // v1.166
        ];
        case 'scenes': return [
            F('name', '地点名（当前层级）', 'text'), F('parent', '父级场景', 'sceneParent'), F('desc', '描述', 'textarea'),
        ];
        // 平行事件（正文之外 · 八卦推演）
        case 'parallels': return [
            F('title', '标题(≤30字)', 'text'),
            F('text', '当前事件描述（正文之外正在酝酿什么）', 'textarea'),
            F('type', '类型(暗线/心理线/势力动向/环境演变/未爆伏笔/前景推演)', 'text'),
            F('date', '日期(年-月-日)', 'text'), F('time', '时刻', 'text'),
            F('gua', '卦象(卦名+一句象断，≤40字)', 'text'),
            F('causalLine', '因果线(源起→中间推力→指向的果)', 'textarea'),
            F('characters', '涉及角色姓名(逗号分隔，无则留空)', 'text'),
            F('location', '发生地点', 'text'),
            F('goalOdds', '演化目标可能性 JSON，如 [{"目标":"…","可能性":60}]（或按行「目标…/可能性 NN」）', 'textarea'),
            F('importance', '重要度(0-1)', 'number'),
            F('tags', '标签(逗号分隔，含语境词与内容关键词)', 'text'),
            F('relLinks', '相关角色（相关 ≠ 知情：角色一律不知情）', 'relTable'),   // v1.166
        ];
        // v3.51.0（`docs/D53` W32 数-43 / 应-47）：**收支记录**（记账必须挂在一条现存货币上）
        case 'ledger': return [
            F('currencyId', '货币（必选：记账必须挂在一条现存货币上；不存在的货币会被拒绝，不会自动新建）', 'select', { options: currencyPickOptions() }),
            F('date', '剧情日期(年-月-日，必填)', 'text'),
            F('delta', '金额（必填，正数=收入 / 负数=支出，不得为 0）', 'number'),
            F('note', '说明(≤80字)', 'text'),
            F('source', '来源', 'select', { options: [
                { value: 'manual', label: '手动' }, { value: 'quick', label: '快速记账' },
                { value: 'ai', label: 'AI' }, { value: 'deal', label: '长期收支兑现' },
                { value: 'repair', label: '修复' }, { value: 'migrate', label: '迁移回填' },
            ] }),
            F('dealId', '来源标的物 ID（由触发器生成时自动填；手填可留空）', 'text'),
        ];
        // v3.51.0（`docs/D53` W32 数-44 / 应-47）：**长期收支**（标的物 + 前景预判三段）
        case 'deals': return [
            // v3.51.7（用户要求「优化编辑面板，多余提示没意义」）：标签只留**字段名**，解释放进字段下方 hint（按需）
            F('name', '标的物名称', 'text'),
            F('desc', '约定内容', 'textarea'),
            F('kind', '类型', 'select', { options: [
                { value: 'investment', label: '投资' }, { value: 'royalty', label: '创作长期收益' },
                { value: 'loan', label: '贷款长期支出' }, { value: 'other', label: '其它' },
            ] }),
            F('currencyId', '锚定货币', 'select', { options: currencyPickOptions() }),
            F('startDate', '最初确定日期', 'text'),
            F('endDate', '截止日期', 'text'),
            F('cycle', '周期', 'text', { placeholder: 'weekly / monthly / quarterly / yearly / custom:天数（留空=由节点推断）' }),
            F('status', '标的物现状', 'text'),
            F('outlookText', '前景说明', 'textarea'),
            // ② 已发生的变动节点：**结构性行编辑器**（日期 / 金额 / 说明 三列 + 增删），不再用「日期|金额|说明」文本
            F('nodes', '已发生节点', 'nodeTable'),
            F('forecastNextDate', '预测下一节点日期', 'text'),
            F('forecastDelta', '预测金额', 'number'),
            F('forecastDirection', '预测方向', 'select', { options: [
                { value: 'increase', label: '增加' }, { value: 'decrease', label: '减少' },
            ] }),
            F('forecastNote', '预测说明', 'text'),
            F('forecastSource', '预测来源', 'select', { options: [
                { value: 'ai', label: 'AI 建议' }, { value: 'manual', label: '手动' }, { value: 'auto', label: '自动推算' },
            ] }),
        ];
        default: return [];
    }
}

function deconstructEntry(kind, flat) {
    const raw = { ...flat };
    if (kind === 'atoms') {
        if (raw.entities) raw.entities = splitListText(raw.entities);
        if (raw.locations) raw.locations = splitListText(raw.locations);
        if (raw.tags) raw.tags = splitListText(raw.tags);
        if (raw.keywords) raw.keywords = splitListText(raw.keywords);
    } else if (kind === 'snapshots') {
        const identity = {}, personality = {}, background = {}, social = {}, future = {};
        const flatMap = {
            identity: ['gender', 'birthDate', 'deceased', 'immortal', 'canon', 'species', 'occupation', 'title', 'family'],
            personality: ['traits', 'quirks', 'values', 'speechStyle'],
            background: ['origin', 'history'],
            social: ['relationToUser', 'attitudeToUser'],
            future: ['todos', 'commitments'],
        };
        for (const [group, keys] of Object.entries(flatMap)) {
            const target = { identity, personality, background, social, future }[group];
            for (const k of keys) {
                if (raw[k] !== undefined) target[k] = raw[k];
                delete raw[k];
            }
            for (const k of Object.keys(target)) { if (target[k] === '' || target[k] === undefined) delete target[k]; }
        }
        if (personality.traits) personality.traits = splitListText(personality.traits);
        if (personality.quirks) personality.quirks = splitListText(personality.quirks);
        if (personality.values) personality.values = splitListText(personality.values);
        if (future.todos) future.todos = splitListText(future.todos);
        if (future.commitments) future.commitments = splitListText(future.commitments);
        const out = { id: raw.id, name: raw.name, identity, personality, background, social, future };
        // v1.162：外貌特征为单字段文本（清空 = ''，由全量保存语义真正清掉）
        if (raw.appearance !== undefined) out.appearance = String(raw.appearance == null ? '' : raw.appearance).trim();
        // 角色标签组（顶层字段；逗号分隔输入 → 数组；清空 = [])
        if (raw.tags !== undefined) out.tags = splitListText(raw.tags);
        return out;
    } else if (kind === 'memories') {
        if (raw.tags) raw.tags = splitListText(raw.tags);
        if (raw.keywords) raw.keywords = splitListText(raw.keywords);
    } else if (kind === 'items') {
        if (raw.carried === 'on') raw.carried = true;
        if (raw.carried === '') raw.carried = false;
        if (raw.qty === '') raw.qty = undefined;
        else if (raw.qty !== undefined) raw.qty = Number(raw.qty);
        if (raw.tags) raw.tags = splitListText(raw.tags);
    } else if (kind === 'npcs') {
        if (raw.follow === 'on') raw.follow = true;
        if (raw.follow === '') raw.follow = false;
    } else if (kind === 'scenes') {
        // 父级场景下拉 → 由父级路径 + 本节点名拼接完整层级路径
        const parentId = String(raw.parent || '').trim();
        delete raw.parent;
        const parent = (state.scenes || []).find(x => x.id === parentId);
        if (parent) {
            const base = Array.isArray(parent.pathArr) ? parent.pathArr.slice() : [];
            if (!base.length || base[base.length - 1] !== parent.name) base.push(parent.name);
            raw.pathArr = base.concat([raw.name]).filter(Boolean);
        } else {
            raw.pathArr = [raw.name].filter(Boolean);
        }
    } else if (kind === 'concepts') {
        if (raw.tags) raw.tags = splitListText(raw.tags);
        if (raw.keywords) raw.keywords = splitListText(raw.keywords);
    } else if (kind === 'plotSegments') {
        // v1.182：编辑器用「一行一条 线路名: 概述」的文本域 → 解析为 lines（标题行仍存 header）
        const arr = String(raw.linesText == null ? '' : raw.linesText).split('\n').map(x => x.trim()).filter(Boolean);
        delete raw.linesText;
        raw.lines = arr;
        raw.manual = true;                       // 手动编辑过 → 后续 AI 运行不覆盖该段落
        raw.raw = plotSegmentsToText([{ header: raw.header, lines: normalizePlotSegmentLines(arr, 12) }]);
    } else if (kind === 'ledger') {
        // v3.51.0（W32 数-43）：金额/日期来自输入框 → 交给 `normalizeLedgerEntry` 做最终校验（无主流水拒绝）
        if (raw.delta === '') raw.delta = undefined;
        else if (raw.delta !== undefined) raw.delta = Number(raw.delta);
    } else if (kind === 'deals') {
        // v3.51.0（W32 数-44）：扁平表单 → 三段 `outlook`（**预测与事实分字段**，不混写）
        // v3.51.7：**结构性节点行**优先（`node-<i>-date|delta|note`）；旧 `nodesText` 仅作兼容（程序化调用 / 旧测试）
        let nodes = [];
        const rowKeys = Object.keys(raw).filter((k) => /^node-\d+-(date|delta|note)$/.test(k));
        if (rowKeys.length) {
            const rows = new Map();
            for (const k of rowKeys) {
                const m = /^node-(\d+)-(date|delta|note)$/.exec(k);
                const i = Number(m[1]);
                if (!rows.has(i)) rows.set(i, {});
                rows.get(i)[m[2]] = raw[k];
                delete raw[k];
            }
            const bad = [];
            nodes = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => {
                const date = String(r.date == null ? '' : r.date).trim();
                if (!date) return null;
                const delta = r.delta === '' || r.delta === undefined ? 0 : Number(r.delta);
                if (!Number.isFinite(delta)) { bad.push(i + 1); return null; }
                return { date: date, delta: delta, note: String(r.note == null ? '' : r.note).trim().slice(0, 80) };
            }).filter(Boolean);
            if (bad.length) raw.__error = '已发生节点第 ' + bad.join(' / ') + ' 行的金额不是数字';
        }
        const nodesRaw = String(raw.nodesText == null ? '' : raw.nodesText).trim();
        if (!nodes.length && nodesRaw) {
            if (nodesRaw.charAt(0) === '[') {
                try {
                    const arr = JSON.parse(nodesRaw);
                    if (!Array.isArray(arr)) throw new Error('节点 JSON 必须是数组');
                    nodes = arr.map((x) => ({ date: String((x && x.date) || ''), delta: Number(x && x.delta) || 0, note: String((x && x.note) || '') }));
                } catch (e) { raw.__error = '变动节点 JSON 无法解析：' + String((e && e.message) || e); }
            } else {
                let badLine = 0;
                nodes = nodesRaw.split('\n').map((line, li) => {
            const t = String(line || '').trim();
            if (!t) return null;
                    const parts = t.split('|').map((x) => x.trim());
                    const date = parts[0] || '';
                    if (!date) return null;
                    const delta = parts[1] === undefined || parts[1] === '' ? 0 : Number(parts[1]);
                    if (!Number.isFinite(delta)) badLine = li + 1;
                    return { date: date, delta: Number.isFinite(delta) ? delta : 0, note: parts[2] || '' };
                }).filter(Boolean);
                if (badLine) raw.__error = '变动节点第 ' + badLine + ' 行的金额不是数字（格式：日期|金额|说明）';
            }
        }
        const forecast = {
            nextDate: String(raw.forecastNextDate == null ? '' : raw.forecastNextDate).trim(),
            delta: raw.forecastDelta === '' || raw.forecastDelta === undefined ? 0 : Number(raw.forecastDelta),
            direction: String(raw.forecastDirection || '').trim(),
            note: String(raw.forecastNote == null ? '' : raw.forecastNote).trim(),
            source: String(raw.forecastSource || 'manual').trim() || 'manual',
        };
        raw.outlook = { text: String(raw.outlookText == null ? '' : raw.outlookText).trim(), nodes: nodes, forecast: forecast };
        delete raw.outlookText; delete raw.nodesText; delete raw.forecastNextDate;
        delete raw.forecastDelta; delete raw.forecastDirection; delete raw.forecastNote; delete raw.forecastSource;
        if (raw.forecastDelta !== undefined) delete raw.forecastDelta;
    } else if (kind === 'parallels') {
        if (raw.characters) raw.characters = splitListText(raw.characters);
        if (raw.tags) raw.tags = splitListText(raw.tags);
        if (raw.goalOdds) {
            let odds = [];
            if (typeof raw.goalOdds === 'string') {
                const s = raw.goalOdds.trim();
                try { const j = JSON.parse(s); if (Array.isArray(j)) odds = j; } catch (e) { /* 忽略：归一化/刷新失败：下一轮会重新处理 */ }
                if (!odds.length) {
                    // 宽松解析：每行「目标 … / 可能性 NN% 或 NN」
                    String(raw.goalOdds).split(/[\n;；]/).forEach(line => {
                        const m = /目标[：:\s]*(.+?)(?:\s*(?:可能性|likelihood)[：:\s]*(\d{1,3})\s*%?)?$/.exec(String(line).trim());
                        if (m && m[1]) odds.push({ target: m[1].trim(), likelihood: m[2] ? Math.max(0, Math.min(100, Number(m[2]))) : 0 });
                    });
                }
            }
            raw.goalOdds = odds.slice(0, 8);
        }
    }
    return raw;
}

/** 节点行数上限（编辑态展示上限；超出只读） */
const NODE_TABLE_ROWS = 12;
/**
 * v3.51.7：**已发生节点的结构性编辑器**（用户要求：不要用分隔符设计）。
 *   每行三列 `日期 / 金额 / 说明` + 行级删除；末尾「＋ 加一行」。
 *   键名 `node-<行号>-date|delta|note`（`deconstructEntry` 负责收集；空日期行自动忽略）。
 * @param {object} f 字段定义（{key:'nodes', label}）
 * @param {Array} val 现有节点
 */
export function nodeTableHtml(f, val) {
    const rows = Array.isArray(val) ? val.slice(0, NODE_TABLE_ROWS) : [];
    const total = Array.isArray(val) ? val.length : 0;
    const cells = (i, n) => {
        const x = n || {};
        return '<div class="ftt-node-row" data-ftt-node-row="' + i + '">'
            + '<input type="text" data-ftt-ed="node-' + i + '-date" value="' + attr2(x.date) + '" placeholder="年-月-日" title="发生日期（年-月-日）">'
            + '<input type="number" data-ftt-ed="node-' + i + '-delta" value="' + attr2(Number(x.delta) || 0) + '" placeholder="金额" title="金额（正=收入 / 负=支出）">'
            + '<input type="text" data-ftt-ed="node-' + i + '-note" value="' + attr2(x.note) + '" placeholder="说明" title="说明（≤80 字）">'
            + '<button type="button" class="ftt-btn ftt-sm ftt-node-del" data-ftt-node-del="' + i + '" title="删除这一行">✕</button>'
            + '</div>';
    };
    const shown = Math.max(rows.length, 1);
    let html = '<div class="ftt-node-table" data-ftt-node-table="' + attr2(f && f.key) + '">'
        + '<div class="ftt-node-head"><span>日期</span><span>金额</span><span>说明</span><span></span></div>';
    for (let i = 0; i < shown; i++) html += cells(i, rows[i]);
    // 额外留 2 个空行便于直接添加（不预填）
    for (let i = shown; i < Math.min(NODE_TABLE_ROWS, shown + 2); i++) html += cells(i, null);
    html += '<div class="ftt-node-foot"><button type="button" class="ftt-btn ftt-sm" data-ftt-node-add="1">＋ 加一行</button>'
        + '<span class="ftt-hint">只记**已发生**的收支；预测请写在下方「预测」三项里' + (total > NODE_TABLE_ROWS ? ('（共 ' + total + ' 条，此处只显示前 ' + NODE_TABLE_ROWS + ' 条）') : '') + '</span></div></div>';
    return html;
}
function attr2(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export { kindFields, deconstructEntry };

/** 角色档案：分组字段展开为表单字段（**逐字移植自 V1** `flattenSnapshot`） */
function flattenSnapshot(s) {
    const o = { ...s };
    o.appearance = snapshotAppearanceText(s);
    Object.assign(o, s.identity || {}, s.personality || {}, s.background || {}, s.social || {}, s.future || {});
    if (Array.isArray(o.traits)) o.traits = o.traits.join('，');
    if (Array.isArray(o.quirks)) o.quirks = o.quirks.join('，');
    if (Array.isArray(o.values)) o.values = o.values.join('，');
    if (Array.isArray(o.todos)) o.todos = o.todos.join('，');
    if (Array.isArray(o.commitments)) o.commitments = o.commitments.join('，');
    return o;
}

export { flattenSnapshot };

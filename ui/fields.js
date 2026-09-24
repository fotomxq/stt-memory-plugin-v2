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
            identity: ['gender', 'birthDate', 'deceased', 'species', 'occupation', 'title', 'family'],
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
    } else if (kind === 'parallels') {
        if (raw.characters) raw.characters = splitListText(raw.characters);
        if (raw.tags) raw.tags = splitListText(raw.tags);
        if (raw.goalOdds) {
            let odds = [];
            if (typeof raw.goalOdds === 'string') {
                const s = raw.goalOdds.trim();
                try { const j = JSON.parse(s); if (Array.isArray(j)) odds = j; } catch (e) { }
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

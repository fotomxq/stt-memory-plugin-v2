// ============================================================
// core/character-repair.js —— **角色档案修复管道**（B8-6c-3，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
//
// 定位（V1 v1.139 角色修复提取策略重构 · v1.152 出生日期必给 · v1.161 剧情时间采样 ·
//   v1.162 schema 收敛 · v1.172 出生日期倒挂优先 · v1.176 AI 前全局机械处理 · v1.177 相关原子数据依据 +
//   关键词自动补充 · v1.205 已去世角色跳过）：
//   【用户反馈的 BUG：修复后没什么区别】根因：① 旧 dump 只把 4 项给 AI 看，AI 看不到现有档案内容；
//   ② 一次列出全部角色，注意力被稀释；③ 输出契约没有字段级 schema；④ 没有「必须产出」的硬约束。
//   【新策略（对应用户三条要求）】：
//     ① 提取按「该分类下的原子数据尺寸」：每条档案算**有效正文字数**（`snapshotAtomSize`）与字段填充数，
//        size < `cfg.repairCharacterMinSize` 者列入待修复名单，按 size 升序（最薄弱最前）；
//        **出生日期倒挂/异常者（`snapshotBirthAnomaly`）无视字数门限一律入列**并排最前；
//        **已去世角色整批跳过**（年龄锁定，档案不再补全）；
//     ② 每次只提取 `cfg.repairCharacterBatch` 条（默认 3）；
//     ③ 提示词 = 窄契约 + 可见现状 + 字段闭集 + 变化校验：只发本轮目标的**完整字段级现状**、缺失字段清单、
//        相关记忆原子数据（`characterEvidencePack`）与聚焦正文；要求按**中文点路径**回填；
//        JS 按路径精确写值（只填空、不改写）并逐字段比对，未产生真实变化即如实上报。
//   流程（`runCharacterRepair`）：① AI 前**全局机械处理**（`runCharacterMechanicalPass`：出生日期校正 +
//   标签补充 + 年龄刷新，零 AI，覆盖全部档案）→ ② `buildCharacterRepairQueue` 选目标 → ③ 窄契约 AI
//   （AI 空手而归时**自动加强重试一次**，同一批目标、同一次点击内完成）→ ④ `applyCharacterRepairResult`
//   按「姓名 + 中文点路径」精确应用 → ⑤ AI 之后再兜底（出生日期 + 标签）并对全部档案刷新年龄 → 落盘。
//
// 复用（不重复实现）：
//   · 剧情时间采样 / 年龄锚点 / 出生日期兜底 / 已去世锁定 / 倒挂判定 / 标签归一 → `core/model/snapshot.js`；
//   · 点路径写入用的 `mergeTags`/`clockDateTrim` → `core/model/scalars.js`；`normText`/`normalizeList`/`snapNameKey` → `core/util.js`；
//   · 状态记录联动清除（删角色）→ `core/entries.js#sweepStatesForRemovedSnapshots`；墓碑 → `core/merge.js#tombMany`；
//   · 正文投喂 → `core/ai-hooks.js#aiFeedText`（V1 `buildFeedFloorText` 的 V2 等价物）。
//
// 适配（与 V1 的差异，逐条见 docs/history/P8u-B8-6c-3物品与角色修复.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/notifyHooks/getStoryNow）；
//   ② AI 调用走注入钩子 `core/ai-hooks.js#aiCallText`（V1 `callChatCompletion` 不移植）；互斥走 `aiBusy()`；
//   ③ V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`abortQuiet`/`abortRequested`/`newTaskStart`/`renderPanel`
//      未移植（V2 无任务管线 UI，重绘由 UI 层负责）；
//   ④ `notify(kind, title, text)` 与 `core/repair.js` 既有写法逐字一致（经 `notifyHooks.toast`）；
//   ⑤ `runCharacterRepair(opts)` 增设可选 `opts.aiText` 注入点（与 `runRepair`/`runMemoryRepair` 同约定）。
// 一致性由 tests/unit/character-repair-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, warn, getStoryNow } from './model/runtime.js';
import { normText, normalizeList, snapNameKey, extractJsonObject } from './util.js';
import { mergeTags, clockDateTrim } from './model/scalars.js';
import {
    stampSnapshotTime, ageAnchorDate, snapshotAgeIsLocked, snapshotBirthAnomaly, snapshotBirthAnomalyLabel,
    snapshotFlag, parseBirthDateParts, calcAge, refreshAllSnapshotAges,
    ensureSnapshotBirthDate, birthDateInFuture, snapshotFutureOrigin, guessAgeFromCues,
    // v3.22.0（用户要求）：长生者开关 + 「不再处理」判据 + 超长年龄研判所需的年龄/年差
    snapshotImmortal, snapshotImmortalFlag, snapshotRepairSkip, snapshotLastSeenGapYears, snapshotAge,
    SNAP_AGE_EXTREME_YEARS,
} from './model/snapshot.js';
import { clockDateStr } from './clock.js';
import { tombMany, atomIsHidden } from './merge.js';
import { sweepStatesForRemovedSnapshots } from './entries.js';
import { repairReport } from './repair.js';
import { aiCallText, aiBusy, aiFeedText } from './ai-hooks.js';
import { defaultCfg, normalizeDeltaKeys } from './config.js';

/** 用户提示（经宿主钩子；与 core/repair.js / core/group-repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

// ==================== 角色档案字段闭集（V1 `SNAP_REPAIR_FIELDS`） ====================
// 中文点路径 ↔ 对象路径 ↔ 取值类型（与 normalizeSnapshot 一一对应）。
//   t：str=字符串（normText 限长）；arr=字符串数组（normalizeList）；tags=标签数组（3-5）；
//      rel=关系列表（结构复杂，本管道不改写）；bool=开关标记
//   optional：不参与「缺失字段清单 / 原子尺寸」统计（开关类字段本就允许留空，若计入缺失会诱导 AI 逐条乱填）
const SNAP_REPAIR_FIELDS = [
    { p: '身份.性别', g: ['identity', 'gender'], t: 'str' },
    { p: '身份.出生日期', g: ['identity', 'birthDate'], t: 'str' },
    { p: '身份.种族', g: ['identity', 'species'], t: 'str' },
    { p: '身份.职业', g: ['identity', 'occupation'], t: 'str' },
    { p: '身份.称号', g: ['identity', 'title'], t: 'str' },
    { p: '身份.家族', g: ['identity', 'family'], t: 'str' },
    // v1.164：已去世开关 —— 只做「标记为已去世」（正文明确死亡时），从不回退为在世；不计入缺失清单
    { p: '身份.已去世', g: ['identity', 'deceased'], t: 'bool', optional: true },
    // v3.22.0（用户要求）：「长生者」开关（**根据剧情标记是否为长生者，该开关可以被编辑**）——
    //   与「已去世」同构的 bool、同样不计入缺失清单；差别：它**可双向写**（勾上/取消都允许，误判要能纠正），
    //   且被标记的角色此后**不再被角色修复分析**（见 `buildCharacterRepairQueue` / `snapshotRepairSkip`）。
    { p: '身份.长生者', g: ['identity', 'immortal'], t: 'bool', optional: true },
    // v1.162：外貌特征聚合为**单字段**（身高/体型/发色发型/瞳色/肤色/显著特征 → 一句话）
    { p: '外貌', g: ['appearance'], t: 'str' },
    { p: '性格.性格特质', g: ['personality', 'traits'], t: 'arr' },
    { p: '性格.小癖好', g: ['personality', 'quirks'], t: 'arr' },
    { p: '性格.价值观', g: ['personality', 'values'], t: 'arr' },
    { p: '性格.说话风格', g: ['personality', 'speechStyle'], t: 'str' },
    { p: '背景资料.出身', g: ['background', 'origin'], t: 'str' },
    { p: '背景资料.经历', g: ['background', 'history'], t: 'str' },
    { p: '关系列表', g: ['relationships'], t: 'rel' },
    // v1.162：删除「内心（情绪/当前目标/担忧）」与「位置（城市/区域/建筑/室内）」两组高动态字段
    { p: '社交.与主角关系', g: ['social', 'relationToUser'], t: 'str' },
    { p: '社交.对主角态度', g: ['social', 'attitudeToUser'], t: 'str' },
    { p: '未来.待办', g: ['future', 'todos'], t: 'arr' },
    { p: '未来.承诺', g: ['future', 'commitments'], t: 'arr' },
    { p: '标签', g: ['tags'], t: 'tags' },
];
const SNAP_REPAIR_FIELD_MAP = (function () { const m = {}; for (const f of SNAP_REPAIR_FIELDS) m[f.p] = f; return m; })();
/** 单字段入库限长（与 normalizeSnapshot 的 normText 上限保持一致，避免修复把字段写超） */
const SNAP_REPAIR_FIELD_LIMIT = {
    '身份.性别': 10, '身份.出生日期': 12, '身份.种族': 20, '身份.职业': 40, '身份.称号': 40, '身份.家族': 60,
    '外貌': 120,
    '性格.说话风格': 60, '背景资料.出身': 60, '背景资料.经历': 200,
    '社交.与主角关系': 60, '社交.对主角态度': 60,
};
/** 空话占位（AI 在无依据时最容易写的词）——整值全等才判定，避免误伤正常表述 */
const SNAP_REPAIR_EMPTY_RE = /^(未知|不详|不明|待定|待补|待填|暂无|无|空|没有|未提及|未出现|未说明|n\/a|na|none|null|-+|—+|\.+)$/i;

/** 取字段值（对象路径，V1 `snapGetByPath`） */
function snapGetByPath(s, g) {
    try {
        let cur = s;
        for (const k of g) { if (cur === undefined || cur === null) return ''; cur = cur[k]; }
        return cur;
    } catch (e) { return ''; }
}
/** 字段值 → 可读文本（数组用「、」连接；关系列表取 名字/关系/态度，V1 `snapValueText`） */
function snapValueText(v) {
    try {
        if (v === undefined || v === null) return '';
        if (Array.isArray(v)) {
            return v.map(x => (x && typeof x === 'object')
                ? [x.name, x.relation, x.attitude].filter(Boolean).join('/')
                : String(x == null ? '' : x)).join('、').trim();
        }
        return String(v).trim();
    } catch (e) { return ''; }
}

// ==================== v1.177：角色「关键词（标签）」自动补充（零 AI） ====================
// 用户要求：「角色修复功能，除了补全信息，关键词也应该自动补充。」
// 口径：标签 = 「以后可能用来检索这个角色」的词；只从**角色自身数据 + 相关原子数据**里取
//   （职业 / 称号 / 种族 / 家族 / 出身 / 性格特质 / 关系对象 / 与主角关系 / 相关情节与记忆的高频标签），
//   不臆造、不写姓名本身、不写空话；已有 ≥3 个标签则不再动（尊重 AI / 用户已填写的内容）。
const SNAP_TAG_STOP = ['角色', '人物', '一般', '其他', '其它', '未知', '不详', '待定', '暂无', '事件', '信息', '内容', '相关', '主要', '次要'];
/** 自由文本（家族 / 出身 / 称号…）→ 候选短词：按分隔符切成 2-8 字的片段（V1 `snapTagSplit`） */
function snapTagSplit(text, max) {
    const out = [];
    for (const seg of String(text == null ? '' : text).split(/[，,、;；/|·:：\s（）()【】\[\]「」]+/)) {
        const t = seg.replace(/^#/, '').trim();
        if (t.length >= 2 && t.length <= 8 && out.indexOf(t) < 0) out.push(t);
        if (max && out.length >= max) break;
    }
    return out;
}
/** 派生标签（V1 `deriveSnapshotTags`）：① 档案身份词前 3 → ② 相关原子数据高频标签前 3 → ③ 其余补齐到 max */
function deriveSnapshotTags(s, opts) {
    const o = opts || {};
    const max = Math.max(1, Math.min(8, Number(o.max) || 6));
    const identity = [], atomTags = [];
    try {
        if (!s || typeof s !== 'object') return [];
        const name = String(s.name || '').trim();
        const push = (bucket) => (v) => {
            const t = String(v == null ? '' : v).replace(/^#/, '').replace(/\s+/g, '').trim();
            if (!t || t.length < 2 || t.length > 8) return;
            if (t === name || identity.indexOf(t) >= 0 || atomTags.indexOf(t) >= 0 || SNAP_TAG_STOP.indexOf(t) >= 0) return;
            bucket.push(t);
        };
        const pushId = push(identity), pushAtom = push(atomTags);
        const id = s.identity || {}, pf = s.personality || {}, bg = s.background || {}, so = s.social || {};
        pushId(id.occupation); pushId(id.title); pushId(id.species);
        snapTagSplit(id.family, 2).forEach(pushId);
        snapTagSplit(bg.origin, 2).forEach(pushId);
        (Array.isArray(pf.traits) ? pf.traits : []).forEach(pushId);
        (Array.isArray(s.relationships) ? s.relationships : []).slice(0, 3).forEach(r => pushId(r && r.name));
        snapTagSplit(so.relationToUser, 1).forEach(pushId);
        // 相关原子数据的高频关键词
        try {
            const freq = new Map();
            const bump = (v) => {
                const t = String(v == null ? '' : v).replace(/^#/, '').trim();
                if (!t || t.length < 2 || t.length > 8 || t === name || SNAP_TAG_STOP.indexOf(t) >= 0) return;
                freq.set(t, (freq.get(t) || 0) + 1);
            };
            for (const a of (state.atoms || [])) {
                if (!a || atomIsHidden(a)) continue;   // v1.203：已总结隐藏的不参与标签归纳
                const inEnt = (Array.isArray(a.entities) ? a.entities : []).some(x => String(x) === name);
                const hitTxt = String(a.text || '').indexOf(name) >= 0 || String(a.title || '').indexOf(name) >= 0;
                if (inEnt || hitTxt) (Array.isArray(a.tags) ? a.tags : []).forEach(bump);
            }
            for (const m of (state.memories || [])) {
                if (!m) continue;
                if (String(m.owner || '') === name) (Array.isArray(m.tags) ? m.tags : []).forEach(bump);
            }
            Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).forEach(e => pushAtom(e[0]));
        } catch (e) { }
    } catch (e) { }
    // ① 身份词前 3 + ② 原子高频标签前 3 → ③ 其余补齐
    const out = identity.slice(0, 3).concat(atomTags.slice(0, 3));
    for (const t of identity.slice(3).concat(atomTags.slice(3))) {
        if (out.length >= max) break;
        if (out.indexOf(t) < 0) out.push(t);
    }
    return out.slice(0, max);
}
/** 兜底关键词（V1 `snapshotFallbackTags`）：年龄线索 → 性别 → 「角色」，保证每个角色都有可检索关键词 */
function snapshotFallbackTags(s) {
    const out = [];
    try {
        const id = (s && s.identity) || {};
        try {
            const a = guessAgeFromCues(s);
            const cue = a <= 10 ? '孩童' : (a <= 17 ? '少年' : (a <= 30 ? '青年' : (a <= 55 ? '中年' : '长者')));
            if (cue) out.push(cue);
        } catch (e) { }
        const g = String(id.gender || '').trim();
        if (g && out.indexOf(g) < 0) out.push(g);
    } catch (e) { }
    if (!out.length) out.push('角色');
    return out;
}
/** 单个角色：标签不足 3 个时自动补充（已有 ≥3 个 → 不动；V1 `ensureSnapshotTags`） */
function ensureSnapshotTags(s) {
    const out = { changed: false, before: 0, after: 0, added: 0, tags: [] };
    try {
        if (!s || typeof s !== 'object') return out;
        const cur = (Array.isArray(s.tags) ? s.tags : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
        out.before = cur.length;
        out.tags = cur;
        out.after = cur.length;
        if (cur.length >= 3) return out;
        const derived = deriveSnapshotTags(s, { max: 6 });
        let next = mergeTags(cur, derived);
        if (next.length < 3) next = mergeTags(next, snapshotFallbackTags(s));
        out.after = next.length;
        if (next.join('|') === cur.join('|')) return out;
        s.tags = next;
        out.changed = true; out.added = next.length - cur.length; out.tags = next;
    } catch (e) { }
    return out;
}
/** 全局：为全部角色档案补充标签（零 AI，幂等；供修复角色的 AI 前机械阶段使用，V1 `ensureAllSnapshotTags`） */
function ensureAllSnapshotTags() {
    const st = { total: 0, filled: 0, added: 0, already: 0, items: [] };
    try {
        for (const s of ((state && state.snapshots) || [])) {
            if (!s || typeof s !== 'object') continue;
            st.total++;
            const r = ensureSnapshotTags(s);
            if (r.changed) { st.filled++; st.added += r.added; st.items.push({ name: String(s.name || ''), tags: (s.tags || []).slice(0, 6) }); }
            else st.already++;
        }
    } catch (e) { }
    return st;
}

// ==================== v1.177：角色「相关记忆原子数据」参考包（AI 补全的首选依据） ====================
// 用户要求：「交给 AI 补全，也可以提取涉及到的关键词原子数据作为 AI 的参考依据，而不是依赖于正文去补全。」
//   按姓名从各维度捞出与该角色相关的条目（含关联层的「知情方式」），按时间从新到旧排序，压成紧凑文本行；
//   只读、零 AI、有上限（默认 12 条 · 单条 ≤160 字），供角色修复提示词使用。
function characterEvidencePack(name, opts) {
    const o = opts || {};
    const max = Math.max(3, Math.min(30, Number(o.max) || 12));
    const out = { name: String(name == null ? '' : name).trim(), lines: [], total: 0, chars: 0 };
    try {
        const nm = out.name;
        if (!nm || typeof state === 'undefined' || !state) return out;
        const hitText = (t) => String(t == null ? '' : t).indexOf(nm) >= 0;
        const items = [];
        const add = (sort, kind, text) => {
            const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
            if (t) items.push({ sort: String(sort || ''), text: `[${kind}] ${t}` });
        };
        for (const a of (state.atoms || [])) {
            if (!a || atomIsHidden(a)) continue;   // v1.203：已总结隐藏的不进上下文
            if (hitText(a.text) || hitText(a.title) || (Array.isArray(a.entities) ? a.entities : []).some(x => String(x) === nm)) {
                add(a.date, '情节', `${a.date ? a.date + ' ' : ''}${a.title ? a.title + '：' : ''}${a.text || ''}`);
            }
        }
        for (const m of (state.memories || [])) {
            if (!m) continue;
            if (String(m.owner || '') === nm || hitText(m.content) || hitText(m.title)) {
                add(m.date, '记忆', `${m.date ? m.date + ' ' : ''}${m.owner ? '（' + m.owner + '）' : ''}${m.title ? m.title + '：' : ''}${m.content || ''}`);
            }
        }
        for (const s of (state.currentStates || [])) {
            if (s && String(s.subject || '') === nm) add(s.updatedAt, '状态', `${s.field}：${s.value}`);
        }
        for (const it of (state.items || [])) {
            if (!it) continue;
            if (String(it.owner || '') === nm || hitText(it.name) || hitText(it.desc)) add(it.seenDate || it.date, '物品', `${it.name || ''}${it.desc ? '：' + it.desc : ''}`);
        }
        for (const c of (state.concepts || [])) {
            if (c && (hitText(c.name) || hitText(c.content))) add(c.date, '概念', `${c.name || ''}${c.content ? '：' + c.content : ''}`);
        }
        for (const p of (state.plans || [])) {
            if (p && (hitText(p.content) || (Array.isArray(p.tags) ? p.tags : []).some(x => String(x) === nm))) add(p.date, '计划', p.content || '');
        }
        for (const s of (state.suspense || [])) {
            if (s && (hitText(s.content) || (Array.isArray(s.tags) ? s.tags : []).some(x => String(x) === nm))) add(s.date, '悬念', s.content || '');
        }
        for (const p of (state.parallels || [])) {
            if (p && (hitText(p.text) || hitText(p.title) || (Array.isArray(p.characters) ? p.characters : []).some(x => String(x) === nm))) {
                add(p.date, '平行事件', `${p.title ? p.title + '：' : ''}${p.text || ''}`);
            }
        }
        // 关联层：谁与该条目关联（含知情方式），给出对应条目原文（用户要求「涉及到的关键词原子数据」）
        try {
            const DIMARR = { atoms: 'atoms', memories: 'memories', plans: 'plans', suspense: 'suspense', parallels: 'parallels', concepts: 'concepts' };
            const seen = new Set();
            for (const l of (state.links || [])) {
                if (!l || String(l.who || '') !== nm) continue;
                const arr = state[DIMARR[l.dim]] || [];
                const e = arr.find(x => x && String(x.id) === String(l.refId));
                if (!e) continue;
                const key = String(l.dim) + ':' + String(l.refId);
                if (seen.has(key)) continue;
                seen.add(key);
                const txt = String(e.title || e.name || e.content || e.text || '').slice(0, 80);
                if (!txt) continue;
                add(l.at || e.date, `关联·${l.how || 'knows'}`, txt);
            }
        } catch (e) { }
        items.sort((a, b) => String(b.sort).localeCompare(String(a.sort)));
        out.total = items.length;
        for (const it of items.slice(0, max)) {
            const line = it.text.slice(0, 160);
            out.lines.push(line);
            out.chars += line.length;
        }
    } catch (e) { }
    return out;
}

/** 角色档案「原子数据尺寸」（V1 `snapshotAtomSize`）：有效正文字数（去空白）+ 字段填充数 + 缺失字段清单。
 *  v1.164：optional 字段（如「身份.已去世」开关）不参与统计 —— 既不计入 total/filled，也不进缺失清单 */
function snapshotAtomSize(s) {
    const counted = SNAP_REPAIR_FIELDS.filter(f => !f.optional);
    const out = { size: 0, filled: 0, total: counted.length, missing: [] };
    try {
        for (const f of counted) {
            const txt = snapValueText(snapGetByPath(s, f.g)).replace(/\s+/g, '');
            if (txt) { out.filled++; out.size += txt.length; }
            else out.missing.push(f.p);
        }
    } catch (e) { }
    return out;
}

// ==================== v3.18.0：已去世研判（机械，零 AI） ====================
// 用户要求（原话）：「角色修复功能，针对已明显去世的角色进行标记已去世，避免反复调取处理。
//   注意个别可能存在超长寿命的角色，需结合剧情研判，实在无法确认的不做标记。」
// 口径（保守优先，**默认不标记**）：
//   ① 证据 = 该角色的**档案自身字段** + `characterEvidencePack()` 收集的**相关原子数据**（情节 / 记忆 / 状态 /
//      物品 / 概念 / 计划 / 悬念 / 平行 / 关联行）；
//   ② 只有「**本人**在句中被明确判定死亡」才算证据 —— 名字必须出现在死亡词**之前 16 字内**，
//      且这中间不得出现亲属 / 同伴一类第三方主语（「甲目睹其父去世」不算），也不得是否定 / 幸存 / 假死表述；
//   ③ **长寿命语境**（长生 / 不死 / 精灵 / 妖族 / 修真 / 神明 / 转世 … 出现在本人档案或相关数据里）→
//      必须出现**终局**措辞（形神俱灭 / 魂飞魄散 / 彻底死亡 …）才标记，否则判「待确认」；
//   ④ 判不出（无名字邻接证据 / 只有他人死亡 / 被否定）→ **不标记**，如实回报计数。
/** 死亡措辞（本人明确死亡的证据；均为多字词，避免「死战」「死士」一类误伤） */
const DEATH_WORDS = Object.freeze([
    '已死', '死了', '死去', '死亡', '身亡', '阵亡', '战死', '牺牲', '殒命', '丧命', '命丧', '遇害', '被杀', '被杀害',
    '惨死', '横死', '暴毙', '病逝', '逝去', '去世', '逝世', '已故', '亡故', '故去', '绝命', '气绝', '香消玉殒', '玉殒',
    '殉难', '殉职', '就义', '殉情', '长眠', '入土', '遗体', '尸首', '墓前', '坟前', '葬礼', '下葬', '忌日', '薨', '崩逝',
    '夭折', '早逝', '死于', '死在', '殒身', '命殒',
]);
/** 终局措辞（对长寿命 / 特殊生命体也成立：不再有复活与轮回余地） */
const DEATH_TERMINAL = Object.freeze(['形神俱灭', '神形俱灭', '魂飞魄散', '灰飞烟灭', '挫骨扬灰', '彻底陨落', '彻底死亡', '真正死去', '彻底死去', '再无生机', '道消身殒']);
/** 长寿命 / 特殊生命体语境（需更强证据，且结合剧情研判） */
const LONG_LIFE_WORDS = Object.freeze([
    '长生', '不死', '永生', '不灭', '不死之身', '精灵', '妖族', '半妖', '仙人', '真仙', '仙尊', '修真', '修仙', '修士',
    '渡劫', '元婴', '化神', '寿元', '千年', '百岁', '神族', '神明', '神祇', '魔神', '龙族', '鬼修', '巫妖', '复活', '转世', '轮回',
]);
/** 否定 / 幸存 / 假死（命中即不标记） */
const DEATH_NEGATE = Object.freeze(['未死', '没死', '没有死', '不会死', '死不了', '死里逃生', '九死一生', '幸免', '假死', '诈死', '未亡', '尚未', '并未', '未曾', '差点', '险些']);
/** 第三方主语（名字与死亡词之间出现 → 不是本人） */
const DEATH_THIRD_PARTY = Object.freeze([
    '父', '母', '爹', '娘', '兄', '弟', '姐', '妹', '妻', '夫', '子', '女', '祖父', '祖母', '外公', '外婆', '师父', '师傅',
    '朋友', '友人', '同伴', '队友', '属下', '下属', '主人', '家人', '族人', '亲族', '邻居', '路人', '某人',
]);
/** 句读切分（逗号**保留在句内** —— 名字与死亡词的邻接判定需要同一句内） */
function deathSplitSentences(text) {
    return String(text == null ? '' : text).split(/[。！？!?；;\n\r]+/).map((x) => x.trim()).filter(Boolean);
}
/** 该句是否「本人在场 + 死亡措辞」；返回 `{word, own, why}` */
function deathSentenceJudge(sent, name, longLife) {
    const s = String(sent || '');
    const nm = String(name || '');
    if (!s || !nm) return null;
    // v3.18.0：**终局措辞也算死亡词**（「形神俱灭 / 魂飞魄散」这类对长生角色成立的终局描写）
    let word = '', at = -1;
    for (const w of DEATH_WORDS.concat(DEATH_TERMINAL)) { const i = s.indexOf(w); if (i >= 0 && (at < 0 || i < at)) { word = w; at = i; } }
    if (!word) return null;
    const ni = s.indexOf(nm);
    if (ni < 0) return { word: word, own: false, why: 'name-absent' };
    if (ni > at) return { word: word, own: false, why: 'name-after' };
    const between = s.slice(ni + nm.length, at);
    if (between.length > 16) return { word: word, own: false, why: 'too-far' };
    if (DEATH_THIRD_PARTY.some((w) => between.indexOf(w) >= 0)) return { word: word, own: false, why: 'third-party' };
    const around = s.slice(Math.max(0, ni), Math.min(s.length, at + word.length + 8));
    if (DEATH_NEGATE.some((w) => around.indexOf(w) >= 0)) return { word: word, own: false, why: 'negated' };
    if (/(未|没|不会|并未|尚未|差点|险些)$/.test(s.slice(0, at))) return { word: word, own: false, why: 'negated' };
    const terminal = DEATH_TERMINAL.some((w) => around.indexOf(w) >= 0 || s.indexOf(w) >= 0);
    if (longLife && !terminal) return { word: word, own: false, why: 'long-life-unconfirmed' };
    return { word: word, own: true, why: terminal ? 'terminal' : '', terminal: terminal };
}

/** 该角色的死亡证据文本集合（自身档案字段 + 相关原子数据；只读） */
function snapshotDeathEvidence(s, opts) {
    const o = opts || {};
    const name = String((s && s.name) || '').trim();
    const own = [];
    const related = [];
    try {
        for (const f of SNAP_REPAIR_FIELDS) {
            if (f.t === 'bool') continue;
            const v = snapValueText(snapGetByPath(s, f.g));
            if (v) own.push(v);
        }
        for (const r of (Array.isArray(s.relationships) ? s.relationships : [])) {
            const t = [r && r.name, r && r.relation, r && r.attitude].filter(Boolean).join(' ');
            if (t) own.push(t);
        }
    } catch (e) { /* 忽略 */ }
    try {
        const ev = characterEvidencePack(name, { max: Math.max(3, Math.min(30, Number(o.max) || 24)) });
        for (const line of ev.lines) related.push(String(line).replace(/^\[[^\]]*\]\s*/, ''));
    } catch (e) { /* 忽略 */ }
    return { name: name, own: own, related: related };
}

/**
 * **单条档案的已去世研判**（机械、只读、零 AI）。
 * @param {object} s 角色档案（条目对象）
 * @param {object} [opts] `max`（相关原子数据取样条数）
 * @returns {{verdict:'dead'|'uncertain'|'none', reason:string, evidence:string, hits:number, longLife:boolean, scanned:number}}
 */
function snapshotDeathVerdict(s, opts) {
    const out = { verdict: 'none', reason: 'no-evidence', evidence: '', hits: 0, longLife: false, scanned: 0 };
    try {
        if (!s || typeof s !== 'object' || !s.name) { out.reason = 'no-name'; return out; }
        // 已标记 → 无需再判（「避免反复调取处理」）
        if (snapshotAgeIsLocked(s)) { out.reason = 'already-marked'; return out; }
        const ev = snapshotDeathEvidence(s, opts);
        const ownBlob = ev.own.join(' ');
        const allBlob = ownBlob + ' ' + ev.related.join(' ');
        // v3.22.0：**已标记「长生者」= 长寿命语境**（用户/AI 已按剧情确认）→ 与内容层长寿信号同一档：
        //   必须出现「形神俱灭 / 魂飞魄散」一类**终局**措辞才可标记已去世（长生者也会死，但门槛更高）。
        const longLife = LONG_LIFE_WORDS.some((w) => allBlob.indexOf(w) >= 0) || snapshotImmortal(s);
        out.longLife = longLife;
        const sents = [];
        for (const t of ev.own.concat(ev.related)) for (const x of deathSplitSentences(t)) sents.push(x);
        out.scanned = sents.length;
        let deadHit = '';
        let uncertain = '';
        let otherHits = 0;
        let anyDeath = '';
        for (const sent of sents) {
            const j = deathSentenceJudge(sent, ev.name, longLife);
            if (!j) continue;
            if (!anyDeath) anyDeath = sent.slice(0, 120);
            if (j.own) { out.hits++; if (!deadHit) deadHit = sent.slice(0, 120); }
            else if (j.why === 'long-life-unconfirmed') { if (!uncertain) uncertain = sent.slice(0, 120); }
            else if (j.why === 'third-party' || j.why === 'name-absent') otherHits++;
        }
        if (out.hits > 0) {
            out.verdict = 'dead';
            out.reason = longLife ? 'explicit-terminal' : 'explicit-death';
            out.evidence = deadHit;
        } else if (uncertain || (longLife && anyDeath)) {
            // 长寿命语境 + 有死亡措辞但**无法确认是本人** → 只报「待确认」，绝不标记（用户口径：无法确认不做标记）
            out.verdict = 'uncertain';
            out.reason = 'long-life-unconfirmed';
            out.evidence = uncertain || anyDeath;
        } else if (otherHits > 0) {
            out.reason = 'others-only';
        }
    } catch (e) { out.reason = 'error'; }
    return out;
}

/**
 * **批量已去世研判与标记**（机械、零 AI）：把「明显已去世」的角色标记 `身份.已去世 = true`，
 *   此后由既有固定规则接管 —— 修复名单跳过（`buildCharacterRepairQueue`）、年龄锁定、状态记录清除（`state-repair`）。
 *   纪律：**只标记、从不取消**（取消请到编辑器取消勾选）；判不出的一律不动。
 * @param {object} [opts] `max` / `silent`（不写调试日志）
 * @returns {{scanned:number, marked:number, uncertain:number, skipped:number, markedNames:Array, uncertainDetail:Array, items:Array}}
 */
function markDeceasedByEvidence(opts) {
    const o = opts || {};
    const stat = { scanned: 0, marked: 0, uncertain: 0, skipped: 0, markedNames: [], uncertainDetail: [], items: [] };
    try {
        for (const s of ((state && state.snapshots) || [])) {
            if (!s || typeof s !== 'object' || !s.name) continue;
            stat.scanned++;
            if (snapshotAgeIsLocked(s)) { stat.skipped++; continue; }              // 已标记 → 不再判（避免反复调取）
            const v = snapshotDeathVerdict(s, o);
            if (v.verdict === 'dead') {
                s.identity = s.identity || {};
                s.identity.deceased = true;
                stat.marked++;
                stat.markedNames.push(String(s.name));
                stat.items.push({ name: String(s.name), verdict: 'dead', reason: v.reason, evidence: v.evidence });
            } else if (v.verdict === 'uncertain') {
                stat.uncertain++;
                stat.uncertainDetail.push({ name: String(s.name), reason: v.reason, evidence: v.evidence });
            }
        }
        if (stat.marked) { try { saveState(); } catch (e) { /* 忽略 */ } }
        if ((stat.marked || stat.uncertain) && o.silent !== true) {
            try {
                dbgLog('修复', {
                    action: '已去世研判（机械，v3.18.0）', scanned: stat.scanned, marked: stat.marked,
                    markedNames: stat.markedNames.slice(0, 8), uncertain: stat.uncertain,
                    uncertainDetail: stat.uncertainDetail.slice(0, 5), skippedAliveOrMarked: stat.skipped,
                });
            } catch (e) { /* 忽略 */ }
        }
    } catch (e) { /* 忽略 */ }
    return stat;
}

/** 一行摘要（通知 / 报告用） */
function deceasedMarkText(stat) {
    const st = stat || { marked: 0, uncertain: 0 };
    if (!st.marked && !st.uncertain) return '';
    const parts = [];
    if (st.marked) parts.push(`新标记已去世 ${st.marked} 名（${st.markedNames.slice(0, 6).join('、')}${st.markedNames.length > 6 ? '…' : ''}）`);
    if (st.uncertain) parts.push(`待确认 ${st.uncertain} 名（超长寿命 / 证据不足，未标记：${st.uncertainDetail.slice(0, 4).map((x) => x.name).join('、')}${st.uncertainDetail.length > 4 ? '…' : ''}）`);
    return parts.join(' · ');
}

/** v3.18.0：最近一次机械「已去世研判」结果（供通知书/日志读取；**不进** `runCharacterMechanicalPass` 的返回结构，
 *  以免改变 V1 逐字黄金样本的字段集） */
let lastDeathMark = null;
/** 最近一次已去世研判结果（只读；未跑过为 `null`） */
function lastDeceasedMark() { return lastDeathMark; }

/**
 * v3.22.0（用户要求「新增对超长年龄人员的分析」）：**只读干跑** —— 逐角色给出「超长年龄」研判所需的读数：
 *   姓名 / 出生日期 / 按剧情锚点算出的年龄 / 是否超长（`extreme`）/ 异常码与文案 / 是否已标记长生者 /
 *   跳过原因（deceased / immortal）/ 「最后见面」距今多少年（判「长期未出场」用）。
 *   **不写任何标记**：真正落笔只有两条路 —— ① 角色修复里 AI 按剧情判定（写 `身份.长生者` / `身份.已去世`）；
 *   ② 用户在编辑器里勾选。与 v3.18.0 的 `FTT.deceasedScan()` 同款只读口径。
 * @returns {Array<object>} 按年龄从大到小
 */
function characterAgeScan() {
    const out = [];
    try {
        for (const s of ((state && state.snapshots) || [])) {
            if (!s || typeof s !== 'object' || !s.name) continue;
            const age = (() => { try { const a = Number(snapshotAge(s)); return Number.isFinite(a) ? a : null; } catch (e) { return null; } })();
            const anomaly = (() => { try { return snapshotBirthAnomaly(s) || ''; } catch (e) { return ''; } })();
            const gap = (() => { try { const g = snapshotLastSeenGapYears(s); return Number.isFinite(g) ? Math.round(g * 10) / 10 : null; } catch (e) { return null; } })();
            out.push({
                name: String(s.name),
                birthDate: String((s.identity && s.identity.birthDate) || ''),
                age: age,
                extreme: anomaly === 'age-extreme',
                immortal: snapshotImmortal(s),
                skip: snapshotRepairSkip(s).reason,
                anomaly: anomaly,
                anomalyLabel: anomaly ? snapshotBirthAnomalyLabel(anomaly) : '',
                staleYears: gap,
                lastSeenDate: String(s.lastSeenDate || s.lastUpdateDate || ''),
                threshold: SNAP_AGE_EXTREME_YEARS,
            });
        }
    } catch (e) { /* 忽略 */ }
    out.sort((a, b) => (Number(b.age) || 0) - (Number(a.age) || 0));
    return out;
}

/**
 * 待修复名单（V1 `buildCharacterRepairQueue`）：分两档 ——
 *   ① **优先档**：出生日期倒挂 / 异常（`snapshotBirthAnomaly` 非空）的角色，**无视字数门限一律入列**，
 *      按异常严重度（future > after-record > overage > bad-format）排在**最前**；
 *   ② 常规档：有效字数 < `cfg.repairCharacterMinSize` 者，按 size 升序（同尺寸时字段更少者优先）。
 *   v1.205：**已去世角色整批跳过**（用户要求「修复角色功能跳过已去世角色」）—— 年龄已锁定、档案不再补全。
 *   v3.22.0：**已标记「长生者」的角色同样整批跳过**（用户要求「如果是标记了长生者，则无需在修复角色中被分析」）
 *     —— 年龄本就不可信，反复分析只会互相打架；两类跳过分别计数，供通知如实说明。
 * @returns {{list:Array, all:Array, total:number, minSize:number, anomalies:number, anomalyList:Array, deceasedCount:number, deceasedList:Array, immortalCount:number, immortalList:Array}}
 */
function buildCharacterRepairQueue() {
    const all = [];
    const deceased = [];
    const immortal = [];
    const minSize = Math.max(0, Number((cfg && cfg.repairCharacterMinSize) != null ? cfg.repairCharacterMinSize : 0) || 0);
    try {
        (state.snapshots || []).forEach(s => {
            if (!s || !s.name) return;
            // v3.22.0：统一跳过判据（已去世 → 年龄锁定；长生者 → 年龄不可信）
            const skip = snapshotRepairSkip(s);
            if (skip.skip) { (skip.reason === 'immortal' ? immortal : deceased).push(String(s.name)); return; }
            const m = snapshotAtomSize(s);
            // v1.172：出生日期异常（倒挂）与档案厚薄无关 —— 数据自相矛盾必须优先处置
            let anomaly = '';
            try { anomaly = snapshotBirthAnomaly(s) || ''; } catch (e) { }
            // v3.22.0：「超长年龄」研判依据（年龄 + 最后见面距今）—— 只读，供提示词与通知说明「长期未出场」
            const ageNum = (() => { try { const a = Number(snapshotAge(s)); return Number.isFinite(a) ? a : NaN; } catch (e) { return NaN; } })();
            const gap = (() => { try { return snapshotLastSeenGapYears(s); } catch (e) { return NaN; } })();
            all.push({
                snap: s, id: s.id, name: String(s.name), size: m.size, filled: m.filled, total: m.total, missing: m.missing,
                anomaly: anomaly,
                anomalyLabel: anomaly ? snapshotBirthAnomalyLabel(anomaly) : '',
                birthDate: String((s.identity && s.identity.birthDate) || '').trim(),
                age: Number.isFinite(ageNum) ? ageNum : null,
                staleYears: Number.isFinite(gap) ? Math.round(gap * 10) / 10 : null,
            });
        });
    } catch (e) { }
    // v3.22.0：`age-extreme`（超长年龄待研判）排在其后 —— 它不是「数据自相矛盾」，而是「疑似长期未出场/误判长生」
    const anomalyRank = { future: 0, 'after-record': 1, overage: 2, 'age-extreme': 3, 'bad-format': 4 };
    const rankOf = (x) => (x && x.anomaly && anomalyRank[x.anomaly] !== undefined) ? anomalyRank[x.anomaly] : 9;
    const thin = minSize > 0 ? all.filter(x => x.size < minSize) : all.slice();
    const anomalyList = all.filter(x => x.anomaly);
    const merged = thin.slice();
    for (const x of anomalyList) if (merged.indexOf(x) < 0) merged.push(x);   // 优先档无视字数门限
    merged.sort((a, b) => (rankOf(a) - rankOf(b))
        || (a.size - b.size) || (a.filled - b.filled) || String(a.name).localeCompare(String(b.name)));
    return {
        list: merged, all: all, total: all.length, minSize: minSize, anomalies: anomalyList.length, anomalyList: anomalyList,
        deceasedCount: deceased.length, deceasedList: deceased,     // v1.205：被跳过的已去世角色（供通知如实说明）
        immortalCount: immortal.length, immortalList: immortal,     // v3.22.0：被跳过的长生者（同上）
    };
}

// v1.162：路径别名 —— AI 返回的「补全」会先经 normalizeDeltaKeys（中文键 → 英文），
//   而本管道的路径表是中文（如 外貌 / 标签）→ 若只按中文查表，`{"外貌": …}` 会被误判为非法路径。
//   这里登记「英文字段名 / 组名 → 中文路径」，读写都先过别名表（幂等，中文路径原样命中）。
const SNAP_REPAIR_FIELD_ALIAS = {
    appearance: '外貌', tags: '标签', relationships: '关系列表',
    identity: '身份', personality: '性格', background: '背景资料', social: '社交', future: '未来',
    gender: '身份.性别', birthDate: '身份.出生日期', species: '身份.种族', occupation: '身份.职业',
    title: '身份.称号', family: '身份.家族',
    deceased: '身份.已去世', '已去世': '身份.已去世', '是否死亡': '身份.已去世',   // v1.164
    // v3.22.0：长生者开关（AI 输出 / 编辑器字段名都宽容）
    immortal: '身份.长生者', '长生者': '身份.长生者', '长生': '身份.长生者', '是否长生': '身份.长生者',
    longLived: '身份.长生者', 'isImmortal': '身份.长生者',
    traits: '性格.性格特质', quirks: '性格.小癖好', values: '性格.价值观', speechStyle: '性格.说话风格',
    origin: '背景资料.出身', history: '背景资料.经历',
    relationToUser: '社交.与主角关系', attitudeToUser: '社交.对主角态度',
    todos: '未来.待办', commitments: '未来.承诺',
};

/**
 * v3.22.0：按字段选「开关解析器」—— 已去世用死亡语义词表（`snapshotFlag`，V1 原样），
 *   长生者用长生语义词表（`snapshotImmortalFlag`）。两套词表**不可混用**：
 *   若拿死亡词表去解析「长生者」，`"长生"` 会命中「是」→ 语义完全反了（同一处代码维护两套，故显式分派）。
 */
function snapshotFlagForField(path, val) {
    const p = String(path || '');
    if (p === '身份.长生者') return (val === true || val === false) ? val : snapshotImmortalFlag(val);
    return (val === true || val === false) ? val : snapshotFlag(String(val == null ? '' : val).trim());
}

/** 按中文点路径（或英文字段别名）写值；返回 `{ ok, changed }`。ok=false → 路径非法/值无效；
 *  changed=false → 仅填空不覆盖，故无变化（V1 `setSnapshotByPath`）。
 *  v1.172：`opts.allowOverwrite=true` 时，**仅**「身份.出生日期」允许改写（用于修正被标记为倒挂 / 异常的出生日期）。 */
function setSnapshotByPath(s, path, val, opts) {
    const o = opts || {};
    try {
        let key = String(path == null ? '' : path).trim();
        let f = SNAP_REPAIR_FIELD_MAP[key];
        if (!f) { const alias = SNAP_REPAIR_FIELD_ALIAS[key]; if (alias) { key = alias; f = SNAP_REPAIR_FIELD_MAP[key]; } }
        if (!f || !s) return { ok: false, changed: false };
        if (f.t === 'rel') return { ok: false, changed: false };
        // v1.164：开关字段（已去世）—— 只做「标记为已去世」，从不回退（撤回标记请到编辑器取消勾选）
        if (f.t === 'bool') {
            const flag = snapshotFlagForField(f.p, val);
            if (flag === undefined) return { ok: false, changed: false };
            // v3.22.0：「身份.长生者」**可双向写**（勾上/取消都允许 —— 误判纠正必须能取消）
            if (f.p === '身份.长生者') {
                if (snapshotImmortal(s) === flag) return { ok: true, changed: false };
                s.identity = s.identity || {};
                s.identity.immortal = flag;
                return { ok: true, changed: true };
            }
            if (flag !== true) return { ok: true, changed: false };
            if (snapGetByPath(s, f.g) === true) return { ok: true, changed: false };
            s.identity = s.identity || {};
            s.identity.deceased = true;
            return { ok: true, changed: true };
        }
        if (f.t === 'tags') {
            const raw = Array.isArray(val) ? val : String(val == null ? '' : val).split(/[，,、|；;]/);
            const arr = raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
            if (!arr.length) return { ok: false, changed: false };
            const oldTags = Array.isArray(s.tags) ? s.tags : [];
            // v1.177：标签按**并集**合并（自动补的关键词与 AI 补的关键词都保留，不互相覆盖）
            const next = mergeTags(oldTags, arr);
            if (!next.length) return { ok: false, changed: false };
            if (oldTags.join('|') === next.join('|')) return { ok: true, changed: false };
            s.tags = next;
            return { ok: true, changed: true };
        }
        if (f.t === 'arr') {
            const raw = Array.isArray(val) ? val : String(val == null ? '' : val).split(/[，,、|；;]/);
            const arr = raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
            if (!arr.length) return { ok: false, changed: false };
            const cur = snapGetByPath(s, f.g);
            if (Array.isArray(cur) && cur.length) return { ok: true, changed: false };
            const clean = normalizeList(arr).slice(0, 8);
            if (!clean.length) return { ok: false, changed: false };
            if (f.g.length === 1) s[f.g[0]] = clean;
            else { s[f.g[0]] = s[f.g[0]] || {}; s[f.g[0]][f.g[1]] = clean; }
            return { ok: true, changed: true };
        }
        const raw = String(val == null ? '' : val).trim();
        if (!raw || SNAP_REPAIR_EMPTY_RE.test(raw)) return { ok: false, changed: false };
        // v1.193：出生日期先按「可解析日期」规范化（支持 公元前221年1月2日 / -221-01-02 等写法）
        const v = (key === '身份.出生日期')
            ? (() => { const bp = parseBirthDateParts(raw); return bp ? clockDateStr(bp.y, bp.m, bp.d) : normText(raw, SNAP_REPAIR_FIELD_LIMIT[key] || 60); })()
            : normText(raw, SNAP_REPAIR_FIELD_LIMIT[key] || 60);
        if (!v) return { ok: false, changed: false };
        const cur = String(snapGetByPath(s, f.g) || '').trim();
        // v1.172：倒挂 / 异常的出生日期允许改写（唯一例外）—— 其余已填字段仍「只填空、不改写」
        const allowOverwrite = !!(o.allowOverwrite && f.p === '身份.出生日期');
        if (allowOverwrite && !/^-?\d{1,4}-\d{2}-\d{2}$/.test(v)) return { ok: false, changed: false, reason: 'badFormatBirth' };   // v1.193：负年份（公元前）合法
        if (cur && !allowOverwrite) return { ok: true, changed: false };
        // v1.164：出生日期不得晚于当前剧情日期（未来人 / 穿越者除外）—— 命中即拒写，
        //   交由 applyCharacterRepairResult 之后的 ensureSnapshotBirthDate 按剧情日期重新推算
        if (f.p === '身份.出生日期' && birthDateInFuture(v) && !snapshotFutureOrigin(s)) return { ok: false, changed: false, reason: 'futureBirth' };
        if (cur && cur === v) return { ok: true, changed: false };
        if (f.g.length === 1) s[f.g[0]] = v;
        else { s[f.g[0]] = s[f.g[0]] || {}; s[f.g[0]][f.g[1]] = v; }
        // v1.172：改写出生日期时同步标注来源与依据（可追溯原值）
        if (allowOverwrite && cur) {
            try {
                if (!s.identity) s.identity = {};
                s.identity.birthSource = 'text';
                s.identity.birthNote = `修复：依据正文修正为 ${v}（原值 ${cur}，曾判定为出生日期异常）`;
            } catch (e) { }
        }
        return { ok: true, changed: true };
    } catch (e) { return { ok: false, changed: false }; }
}

/** 近期正文聚焦（V1 `characterRepairContext`）：只保留提到目标角色的行（提高信噪比、降低 token）；命中过少时退回整段 */
function characterRepairContext(names) {
    let full = '';
    try { full = String(aiFeedText(Math.max(1, Number(cfg.repairFloors) || Number(cfg.feedFloors) || 10)) || ''); } catch (e) { full = ''; }
    if (!full) return '';
    try {
        const set = (names || []).filter(Boolean);
        if (set.length) {
            const lines = String(full).split('\n');
            const hit = lines.filter(ln => set.some(n => ln.indexOf(n) >= 0)).join('\n').trim();
            if (hit.length >= 200) return hit.slice(-10000);
        }
    } catch (e) { }
    return String(full).slice(-10000);
}

/**
 * 角色修复提示词（V1 `buildCharacterRepairPrompt`）：窄契约 —— 只含本轮目标的**完整字段级现状** +
 *   缺失清单 + 相关记忆原子数据 + 聚焦正文；`opts.strict` = 加强轮（上一轮零落库时追加「必须逐字段给出值」）。
 *   `targetsIn` 缺省时自行取 `buildCharacterRepairQueue().list.slice(0, cfg.repairCharacterBatch)`。
 */
function buildCharacterRepairPrompt(targetsIn, opts) {
    try {
        const o = opts || {};
        const strict = !!o.strict;
        const batch = Math.max(1, Math.min(10, Number(cfg && cfg.repairCharacterBatch) || 3));
        let targets = Array.isArray(targetsIn) ? targetsIn : null;
        if (!targets) targets = buildCharacterRepairQueue().list.slice(0, batch);
        const tpl = String((cfg.promptTemplates && cfg.promptTemplates.characterRepair) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.characterRepair) || '').trim() || '补全角色档案的缺失字段；输出「角色档案」的更新。';
        const ctxText = characterRepairContext(targets.map(t => t.name));
        // v1.171：把**当前剧情日期**明确写给 AI —— 此前只说「按剧情日期推测」却不给日期，
        //   模型只能拿正文里最后出现的日期（≈最后一次见面的场景日期）当基准，出生日期因此被写偏。
        const storyNowTxt = clockDateTrim(getStoryNow());
        const refNowTxt = ageAnchorDate();
        const clockLine = /^\d{4}/.test(storyNowTxt)
            ? `【当前剧情日期】${storyNowTxt}（「年龄」由插件按此日期与出生日期自动计算；出生日期不得晚于此日）`
            : (/^\d{4}/.test(refNowTxt)
                ? `【当前剧情日期】尚未明确；已知的**最晚剧情记录日期**为 ${refNowTxt} —— 出生日期请以此为依据合理推算，**不要用现实时间（今天）当基准**`
                : '【当前剧情日期】未知（正文与记忆里都没有明确的剧情日期）——出生日期请以正文中**最晚出现的明确日期**为依据，并在依据里写明该日期；**不要用现实时间（今天）当基准**');
        const anomCount = targets.filter(t => t && t.anomaly).length;
        // v3.22.0：异常分两类（出生日期异常 / 超长年龄待研判）—— 计数文案分开写，
        //   且**在没有超长年龄目标时逐字保持 V1 原文**（V1 黄金样本逐字符比对不受影响）。
        const ageAnoms = targets.filter(t => t && t.anomaly === 'age-extreme').length;
        const birthAnoms = Math.max(0, anomCount - ageAnoms);
        const anomHead = (birthAnoms ? `，其中 ⚠️ 出生日期异常 ${birthAnoms} 条已优先` : '')
            + (ageAnoms ? (o.immortalGuide ? `，其中 ⚠️ 超长年龄 ${ageAnoms} 条待研判` : `，其中 ⚠️ 年龄异常 ${ageAnoms} 条已优先`) : '');
        const anomTail = (ageAnoms && !birthAnoms)
            ? (o.immortalGuide ? '超长年龄待研判者优先' : '年龄异常者优先')
            : '出生日期异常者优先';
        const blocks = targets.map((t, i) => {
            const s = (t && t.snap) || {};
            const out = [];
            out.push(`#${i + 1} 姓名「${t.name}」（现有 ${t.size} 字 · ${t.total} 个字段中已填 ${t.filled} 个）`);
            // v1.172：出生日期倒挂 / 异常 —— 明确点名（含现值与原因），并允许改写该字段
            // v3.22.0（用户要求「新增对超长年龄人员的分析」）：`age-extreme` 是**另一类**异常 ——
            //   它**不要求**改写出生日期（改日期会把「长期未出场」误改成别的数据），而是要 AI 结合剧情研判
            //   这个年龄是否成立：成立 → 标记「长生者」；不成立且正文显示早已离场/去世 → 标记「已去世」。
            if (t.anomaly === 'age-extreme') {
                const gapTxt = (t.staleYears !== null && t.staleYears !== undefined)
                    ? `（档案记录最后见面 ${s.lastSeenDate || '—'} / 最后更新 ${s.lastUpdateDate || '—'}，距今约 ${t.staleYears} 年）`
                    : '（档案没有「最后见面 / 最后更新」日期）';
                const ageTxtNum = (t.age !== null && t.age !== undefined) ? t.age : '?';
                // 未开启长生者守则时只做**中性点名**（不说「长生者」三个字）：这样默认提示词与 V1 逐字黄金样本保持一致；
                //   开启守则（`runCharacterRepair` 的真实路径）时才给出 ① ② ③ 完整研判口径。
                out.push(o.immortalGuide
                    ? (`  ⚠️ 超长年龄（${t.anomalyLabel || t.anomaly}）：按当前剧情日期算出的年龄约 **${ageTxtNum} 岁**`
                        + `（出生日期「${t.birthDate || '（空）'}」）${gapTxt}`
                        + ` —— 请**结合剧情研判**：① 若相关原子数据 / 正文明确支持该角色是长生、不死、精灵、神明、修真等**超长寿命设定**`
                        + `（含明确的时间旅行 / 转世），输出 {"身份.长生者":"是"}；② 若**没有**任何长寿依据，则**不要**标记长生，`
                        + `并按「长期未出场」处理：正文或相关数据能看出该角色早已死亡 / 失踪 / 离场（例如几十上百年未再出场、`
                        + `其亲属或势力已更替、明确提及他的死亡或身后事）→ 输出 {"身份.已去世":"是"}；③ 两者都不成立 → `
                        + `两个字段都**不要输出**（宁可留着待下轮研判）。**年龄超长本身不是长寿依据。**`)
                    : (`  ⚠️ 年龄异常（${t.anomalyLabel || t.anomaly}）：按当前剧情日期算出的年龄约 ${ageTxtNum} 岁`
                        + `（出生日期「${t.birthDate || '（空）'}」）${gapTxt} —— 请结合剧情研判该年龄是否成立，`
                        + `**年龄超长本身不构成依据**；不要据此改写出生日期。`));
            } else if (t.anomaly) {
                out.push(`  ⚠️ 出生日期异常（${t.anomalyLabel || t.anomaly}）：现值「${t.birthDate || '（空）'}」`
                    + `${(s.lastSeenDate || s.lastUpdateDate) ? `（档案记录：最后见面 ${s.lastSeenDate || '—'} / 最后更新 ${s.lastUpdateDate || '—'}）` : ''}`
                    + ' —— **必须修正「身份.出生日期」**：以正文 / 档案依据重新给出合理出生年月日，须早于上述记录日期且不晚于当前剧情日期（若正文明确该角色来自未来 / 穿越，则保持原值不动）。');
            }
            out.push('  现有字段（未列出的字段 = 当前为空，绝不要改动已列出的值）：');
            let shown = 0;
            for (const f of SNAP_REPAIR_FIELDS) {
                // v1.164：开关字段只在「已标记为已去世」时列出（false/未填一律不列，避免噪声）
                if (f.optional) {
                    if (snapGetByPath(s, f.g) !== true) continue;
                    shown++;
                    out.push(`    ${f.p} = 是`);
                    continue;
                }
                const v = snapValueText(snapGetByPath(s, f.g));
                if (!v) continue;
                shown++;
                out.push(`    ${f.p} = ${v.slice(0, 120)}`);
            }
            if (!shown) out.push('    （全部为空）');
            out.push(`  缺失字段清单（**每一项都要在本次给出值**；路径逐字照抄）：${t.missing.join('、') || '（无）'}`);
            // v1.177：相关记忆原子数据（AI 补全的**首选依据** —— 不再只依赖近期正文）
            try {
                const ev = characterEvidencePack(t.name);
                if (ev.lines.length) {
                    out.push(`  相关记忆原子数据（补全首选依据 · 命中 ${ev.total} 条，按时间从新到旧展示前 ${ev.lines.length} 条）：`);
                    for (const ln of ev.lines) out.push(`    ${ln}`);
                } else {
                    out.push('  相关记忆原子数据：（无命中）—— 依据退回到「近期正文 + 档案已有字段」保守推断。');
                }
            } catch (e) { }
            return out.join('\n');
        });
        // v3.18.0（用户要求「针对已明显去世的角色进行标记已去世……实在无法确认的不做标记」）：
        //   仅在 `opts.deathGuide` 为真时追加一条**保守判定守则**（默认不追加 → V1 逐字黄金样本不变）。
        const deathLine = o.deathGuide
            ? '【已去世判定（保守）】只有当相关原子数据或正文**明确写出该角色本人**已死亡 / 牺牲 / 被杀害 / 阵亡时，才输出 {"身份.已去世":"是"}；'
                + '**别人（父母 / 同伴 / 属下）的死不算**；**长生 / 不死 / 精灵 / 妖族 / 修真 / 神明等可能超长寿命的角色**，'
                + '须出现「形神俱灭 / 魂飞魄散 / 彻底死亡」一类**终局**描写才可填；假死 / 复活 / 转世 / 沉睡 / 封印一律不填；'
                + '**无法确认就不要输出该字段**（该字段只由本插件标记、不会自动取消）。\n\n'
            : '';
        const strictLine = strict
            ? '【加强轮】上一轮**没有产生任何可落库的字段**（模型空手而归）。本轮请严格按依据优先级逐角色、逐字段补全 —— 哪怕只有相关原子数据里的间接线索，也要给出保守值；每个角色都必须给出「标签」（3-5 个）；再次空手返回视为任务失败。\n\n'
            : '';
        // v3.22.0（用户要求）：「长生者」判定守则 —— 仅在 `opts.immortalGuide` 为真时追加（默认不追加 → V1 逐字黄金样本不变）。
        //   用户原话：「新增对超长年龄人员的分析，明显不合理的可能是长期没出现的人物，但被误判会长生。」
        const immortalLine = o.immortalGuide
            ? '【长生者判定（保守）】只有当相关原子数据或正文**明确支持**该角色为超长寿命者（长生 / 不死 / 永生 / 精灵 / 妖族 / 神明 / 修真 / 渡劫 / 转世 / 明确的时间旅行设定）时，才输出 {"身份.长生者":"是"}；'
                + '**年龄超长本身不是依据** —— 一个人物「几百年没出场、年龄随剧情推进越算越大」恰恰更可能是**长期未出场**（人早已离场或去世），此时**不要**标记长生。'
                + '若该角色**已经**标着「长生者」但本轮依据显示那是误判（没有任何长寿依据、且正文/相关数据表明其早已死亡或消失）→ 同时输出 {"身份.长生者":"否","身份.已去世":"是"}（误判纠正 + 标记去世）；'
                + '只想纠正长生标记、死亡尚无依据时，**只**输出 {"身份.长生者":"否"}。'
                + '标了「长生者」的角色不会再进入后续修复名单，所以**宁可少标不可错标**。\n\n'
            : '';
        // v3.22.0：输出契约里追加「超长年龄」那一条 —— **仅在长生者守则开启时**，
        //   这样默认调用（V1 逐字黄金样本 / deathGuide-only 调用）的提示词一字不变。
        const ageClause = o.immortalGuide
            ? '；**标了 ⚠️ 超长年龄 的角色：不要改出生日期，按上方①②③研判「身份.长生者」/「身份.已去世」**'
            : '';
        return [
            { role: 'system', content: `${tpl}\n只输出 JSON，不要解释文字。` },
            { role: 'user', content: `${strictLine}${deathLine}${immortalLine}${clockLine}\n\n【待修复角色（本轮共 ${targets.length} 条${anomHead}：${anomTail}，其余按现有字数由少到多）】\n${blocks.join('\n')}\n\n【近期正文（补充依据之一）】\n${ctxText || '（无正文）'}\n\n输出：{"角色档案":{"更新":[{"姓名":"…","补全":{"字段路径":"值"}}],"推断":["…"],"无依据":[],"删除":[]}}。**清单里每个角色都要出现在「更新」中，且每个缺失字段都要给出值**（首选依据 = 上方「相关记忆原子数据」，其次是近期正文与档案已有字段）；依据不足时给出**保守推断**并把姓名写进「推断」，「无依据」只在连推断都无法进行时才用。**每个角色必须给出「标签」（3-5 个）**；**「身份.出生日期」必须给出**（没写就按年龄/年代/身份与剧情日期合理推测），**且不得晚于当前剧情日期**（未来人 / 穿越者除外）；**标了 ⚠️ 出生日期异常 的角色：允许并需要改写「身份.出生日期」**（这是唯一允许改写的已填字段，格式必须是 年-月-日）${ageClause}；相关原子数据或正文明确写出死亡 / 牺牲 / 被杀害时可输出 {"身份.已去世":"是"}（没写就不要输出该字段）；不要输出「年龄」「年龄备注」与任何空话（未知 / 不详 / 待定 / 暂无）。` },
        ];
    } catch (e) { return [{ role: 'system', content: '补全角色档案的缺失字段，输出「角色档案」的更新。' }, { role: 'user', content: '请输出角色档案补全结果（JSON）。' }]; }
}

/** 按「姓名 + 中文点路径」精确应用（V1 `applyCharacterRepairResult`）；只填空不改写；
 *  逐字段比对统计「真实变化」。返回 `{changed, rolesChanged, rolesNoBasis, removed, invalid, unknownRole, fields,
 *  rolesInferred, birthInferred?, birthFixed?, birthFixedNames?}`。 */
function applyCharacterRepairResult(delta, targets) {
    const out = { changed: 0, rolesChanged: 0, rolesNoBasis: 0, removed: 0, invalid: 0, unknownRole: 0, fields: [] };
    try {
        const ops = delta && delta.snapshots;
        const list = Array.isArray(targets) ? targets : [];
        const byName = {};
        for (const t of list) { const k = snapNameKey(t && t.name); if (k) byName[k] = t; }
        const findSnap = (nm) => {
            const k = snapNameKey(nm);
            if (!k) return null;
            const hit = byName[k];
            if (hit && hit.snap) return hit.snap;
            return (state.snapshots || []).find(x => snapNameKey(x && x.name) === k) || null;
        };
        const updates = Array.isArray(ops && ops.update) ? ops.update : (Array.isArray(ops && ops.add) ? ops.add : []);
        for (const u of updates) {
            if (!u || typeof u !== 'object') continue;
            const nm = String(u['姓名'] !== undefined ? u['姓名'] : (u.name || '')).trim();
            const s = findSnap(nm);
            if (!s) { out.unknownRole++; continue; }
            const fill = u['补全'] || u.fill || null;
            if (!fill || typeof fill !== 'object') { out.invalid++; continue; }
            // v1.172：本轮目标若被判定为「出生日期倒挂 / 异常」，允许 AI **改写**该字段（唯一例外）
            const tgt = byName[snapNameKey(nm)] || null;
            const allowBirthRewrite = !!(tgt && tgt.anomaly);
            const birthBefore = String((s.identity && s.identity.birthDate) || '').trim();
            // v3.22.0：「长生者」标记的前后对比（用于「误判纠正」如实上报）
            const immortalBefore = snapshotImmortal(s);
            const deceasedBefore = snapshotAgeIsLocked(s);
            let roleChanged = 0;
            for (const path of Object.keys(fill)) {
                const p = String(path).trim();
                const canon = SNAP_REPAIR_FIELD_MAP[p] ? p : (SNAP_REPAIR_FIELD_ALIAS[p] || p);   // v1.162：英文别名还原为中文路径
                const r = setSnapshotByPath(s, p, fill[path], { allowOverwrite: allowBirthRewrite });
                if (!r.ok) { out.invalid++; continue; }
                if (r.changed) { roleChanged++; out.fields.push(`${s.name}·${canon}`); }
            }
            // v3.22.0（用户要求）：「被分析发现为误判角色 → 可根据剧情标记为去世」的落地计数 ——
            //   · AI 把「长生者」从「是」改成「否」（误判纠正）→ `immortalCleared`
            //   · AI 本轮把角色标成「长生者」 → `immortalSet`
            //   · AI 本轮把角色标成「已去世」 → `deceasedMarked`
            try {
                const immortalAfter = snapshotImmortal(s);
                if (immortalBefore !== immortalAfter) {
                    if (immortalAfter) { out.immortalSet = (out.immortalSet || 0) + 1; out.immortalNames = (out.immortalNames || []).concat([s.name]); }
                    else { out.immortalCleared = (out.immortalCleared || 0) + 1; out.immortalClearedNames = (out.immortalClearedNames || []).concat([s.name]); }
                }
                if (!deceasedBefore && snapshotAgeIsLocked(s)) { out.deceasedMarked = (out.deceasedMarked || 0) + 1; out.deceasedMarkedNames = (out.deceasedMarkedNames || []).concat([s.name]); }
            } catch (e) { /* 忽略 */ }
            // v1.172：倒挂修正计数（出生日期真的被改写 → 单独上报，便于确认「优先处置」生效）
            if (allowBirthRewrite) {
                const birthAfter = String((s.identity && s.identity.birthDate) || '').trim();
                if (birthAfter && birthAfter !== birthBefore) {
                    out.birthFixed = (out.birthFixed || 0) + 1;
                    out.birthFixedNames = (out.birthFixedNames || []).concat([s.name]);
                }
            }
            // v1.152：无论 AI 是否给出出生日期，都**确保不为空**（合理推测 + 注明依据）
            try {
                const eb = ensureSnapshotBirthDate(s);
                if (eb.changed) { roleChanged++; out.changed++; out.fields.push(s.name + '·身份.出生日期（推测）'); out.birthInferred = (out.birthInferred || 0) + 1; }
            } catch (e) { }
            if (roleChanged > 0) {
                try { stampSnapshotTime(s, 'update'); } catch (e) { }   // v1.161：档案被补全 → 记「最后一次更新」时刻
                // 出生日期变更 → 按 normalizeSnapshot 同口径重算年龄（v1.171：锚点 = 剧情日期 → 最近记录日期）
                try {
                    const bd = String((s.identity && s.identity.birthDate) || '');
                    if (bd) { const a = calcAge(bd, ageAnchorDate()); if (a) s.identity.age = a; }
                } catch (e) { }
                out.changed += roleChanged; out.rolesChanged++;
            }
        }
        const nb = Array.isArray(ops && ops['无依据']) ? ops['无依据'] : (Array.isArray(ops && ops.noBasis) ? ops.noBasis : []);
        out.rolesNoBasis = nb.length;
        // v1.177：「推断」数组 = 依据不足但按保守推断补全的角色（如实上报，便于用户复核）
        const inf = Array.isArray(ops && ops['推断']) ? ops['推断'] : (Array.isArray(ops && ops.inferred) ? ops.inferred : []);
        out.rolesInferred = inf.length;
        const dels = Array.isArray(ops && ops.remove) ? ops.remove : [];
        if (dels.length) {
            const delSet = new Set(dels.map(x => String(x).trim()).filter(Boolean));
            const removedNames = (state.snapshots || []).filter(x => delSet.has(String(x.id)) || delSet.has(String(x.name))).map(x => x.name);
            if (removedNames.length) {
                state.snapshots = (state.snapshots || []).filter(x => !delSet.has(String(x.id)) && !delSet.has(String(x.name)));
                try { tombMany('snapshots', dels); } catch (e) { }
                try { sweepStatesForRemovedSnapshots(removedNames); } catch (e) { }
                out.removed = removedNames.length;
            }
        }
    } catch (e) { }
    return out;
}

/** 全局机械处理（AI 前，零 AI，V1 `correctSnapshotBirthDates`）：出生日期校正 ——
 *  缺失（跳过，交 AI 不臆造）/ 占位（`birthSource='fallback'`）/ 未来出生（非未来来客）/ 格式非法 → 按线索重推；
 *  v1.205：已去世角色出生日期与年龄**一律不动**（年龄锁定在死亡那一刻）。
 *  v3.22.0：**已标记「长生者」的角色同样不动**（用户要求「标记了长生者则无需被分析」）——
 *    他们的年龄本就不可信（长寿/穿越设定），机械重推只会把设定改坏；分别计数以便如实说明。 */
function correctSnapshotBirthDates(opts) {
    const stat = { total: 0, already: 0, corrected: 0, skippedEmpty: 0, skippedDeceased: 0, skippedImmortal: 0, items: [] };
    try {
        for (const s of ((state && state.snapshots) || [])) {
            if (!s || typeof s !== 'object') continue;
            stat.total++;
            // v1.205：已去世 → 出生日期与年龄**一律不动**（年龄锁定在死亡那一刻）
            // v3.22.0：长生者 → 同样不动（年龄不可信，机械重推会把设定改坏）
            const skip = snapshotRepairSkip(s);
            if (skip.skip) { (skip.reason === 'immortal' ? (stat.skippedImmortal++) : (stat.skippedDeceased++)); continue; }
            const cur = String((s.identity && s.identity.birthDate) || '').trim();
            if (!cur) { stat.skippedEmpty++; continue; }                          // 缺失 → 交 AI（机械阶段不臆造）
            const parsed = parseBirthDateParts(cur);
            const placeholder = String((s.identity && s.identity.birthSource) || '') === 'fallback';
            const future = !!parsed && birthDateInFuture(cur) && !snapshotFutureOrigin(s);
            if (parsed && !placeholder && !future) { stat.already++; continue; }   // 已就绪（含低精度）→ 不动
            const r = ensureSnapshotBirthDate(s, opts);
            if (r.changed) { stat.corrected++; stat.items.push({ name: s.name, date: r.date, source: r.source }); }
        }
    } catch (e) { }
    return stat;
}
/** 机械处理总入口（V1 `runCharacterMechanicalPass`）：出生日期校正 + 标签补充 + 年龄刷新（全部零 AI） */
function runCharacterMechanicalPass(opts) {
    const out = { total: 0, birth: null, ages: null, tags: null, anomalies: 0, changed: false, deceased: 0, immortal: 0 };
    try {
        const list = (state && state.snapshots) || [];
        out.total = list.length;
        if (!list.length) return out;
        // v3.18.0（用户要求）：**先做已去世研判**（机械零 AI）—— 标记后本轮的出生日期校正 / 标签 / 年龄与
        //   AI 待修复名单都会自动跳过这些角色（「避免反复调取处理」）。
        try { lastDeathMark = markDeceasedByEvidence(opts); } catch (e) { lastDeathMark = null; }
        try { out.birth = correctSnapshotBirthDates(opts); } catch (e) { }
        // v1.177：关键词（标签）自动补充 —— 用户要求「除了补全信息，关键词也应该自动补充」
        try { out.tags = ensureAllSnapshotTags(); } catch (e) { }
        try { out.ages = refreshAllSnapshotAges(); } catch (e) { }
        // v1.205：已去世角色被跳过的数量（出生日期与年龄都不动）—— 供通知与调试如实说明
        try { out.deceased = (out.birth && out.birth.skippedDeceased) || 0; } catch (e) { out.deceased = 0; }
        // v3.22.0：被跳过的「长生者」数量（用户要求「标记了长生者则无需被分析」）
        try { out.immortal = (out.birth && out.birth.skippedImmortal) || 0; } catch (e) { out.immortal = 0; }
        out.changed = !!((lastDeathMark && lastDeathMark.marked) || (out.birth && out.birth.corrected) || (out.tags && out.tags.filled)
            || (out.ages && (out.ages.fixed || out.ages.cleared)));
        if (out.changed) { try { saveState(); } catch (e) { } }
        try { out.anomalies = list.filter(s => snapshotBirthAnomaly(s)).length; } catch (e) { }
        if (out.changed || out.deceased || out.immortal) {
            try {
                dbgLog('摘要', {
                    action: '角色机械处理（AI 前全局）', total: out.total,
                    birthCorrected: out.birth ? out.birth.corrected : 0,
                    birthSkippedEmpty: out.birth ? out.birth.skippedEmpty : 0,
                    birthSkippedDeceased: out.deceased || 0,
                    birthSkippedImmortal: out.immortal || 0,
                    tagsFilled: out.tags ? out.tags.filled : 0,
                    tagsAdded: out.tags ? out.tags.added : 0,
                    ageFixed: out.ages ? out.ages.fixed : 0,
                    ageCleared: out.ages ? out.ages.cleared : 0,
                    ageLocked: out.ages ? (out.ages.locked || 0) : 0,
                    anomalies: out.anomalies,
                    deathMarked: lastDeathMark ? lastDeathMark.marked : 0,
                    deathUncertain: lastDeathMark ? lastDeathMark.uncertain : 0,
                });
            } catch (e) { }
        }
    } catch (e) { }
    return out;
}

/**
 * 角色档案修复全链路（V1 `runCharacterRepair`）：
 *   ① `runCharacterMechanicalPass`（零 AI，覆盖全部档案）→ ② `buildCharacterRepairQueue` 选目标
 *   → ③ 窄契约 AI（`buildCharacterRepairPrompt`；AI 空手 → strict 加强重试一次，最多 2 轮）
 *   → ④ `applyCharacterRepairResult` 按「姓名 + 中文点路径」精确应用
 *   → ⑤ AI 后再兜底（`ensureSnapshotBirthDate` + `ensureSnapshotTags`）并 `refreshAllSnapshotAges` → 落盘。
 * 早退：空库 → `{made:0, skipped:true}`；`aiBusy()` → `{made:0, blocked:true}`；
 *   队列为空 → `{made:0, skipped:true, total, queue:0, deceased, mech}`；
 *   AI 两轮零落库且兜底也无变化 → `{made:0, noChange:true, …}`（warning 提示）。
 * V2 适配：互斥走 `aiBusy()`；AI 走 `aiCallText`；`opts.aiText` 为 V2 注入点（测试用）；
 *   V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortQuiet`/`abortRequested`/`newTaskStart`/`renderPanel` 未移植。
 * @param {object} [opts] aiText（V2 注入）
 * @returns {Promise<object>} V1 同形返回结构
 */
async function runCharacterRepair(opts) {
    const o = opts || {};
    try {
        const snaps = state.snapshots || [];
        if (!snaps.length) { notify('info', '角色修复：暂无角色', '请先通过「AI 摘要」生成角色档案或手动添加后再修复。'); return { made: 0, skipped: true }; }
        // V1：`busy.repair` 与 `busy.summary || busy.compact || weaveBusy || advanceBusy || syncOcc()` 都返回 blocked；
        //   V2 由宿主 `aiBusy()` 钩子统一表达（与 `core/repair.js#runRepair` 同一写法）。
        if (aiBusy()) { notify('warning', '修复进行中', '已有修复任务在运行，请稍候（本操作会排队等待）。'); return { made: 0, blocked: true }; }
        // v1.176：**AI 之前先做全局机械处理**（零 AI，覆盖全部角色档案）——
        //   出生日期兜底 + 年龄固定规则刷新；机械阶段能解决的（占位校正 / 年龄落盘错误）不再消耗 AI 额度，
        //   且抽取名单基于"机械处理之后"的档案计算（尺寸与字段缺失清单都是最新的）。
        const mech = runCharacterMechanicalPass();
        // v1.205：已去世角色**跳过修复**（年龄锁定，档案不再改写）—— 在结果文案里如实说明
        const deadText = mech.deceased ? `已去世 ${mech.deceased} 名跳过（年龄锁定）；` : '';
        // v3.22.0（用户要求）：「如果是标记了长生者，则无需在修复角色中被分析」—— 同样在文案里如实说明
        const immText = mech.immortal ? `长生者 ${mech.immortal} 名跳过（年龄不可信，标记后不再分析）；` : '';
        // v3.22.0：AI 本轮的长生/去世结论（标记长生 X · 误判纠正 Y · 标记去世 Z）
        const immortalOutcomeText = (r) => {
            try {
                const bits = [];
                if (r.immortalSet) bits.push(`标记长生者 ${r.immortalSet} 名（${(r.immortalNames || []).slice(0, 4).join('、')}${(r.immortalNames || []).length > 4 ? '…' : ''}）`);
                if (r.immortalCleared) bits.push(`纠正误判长生 ${r.immortalCleared} 名（${(r.immortalClearedNames || []).slice(0, 4).join('、')}${(r.immortalClearedNames || []).length > 4 ? '…' : ''}）`);
                if (r.deceasedMarked) bits.push(`标记已去世 ${r.deceasedMarked} 名（${(r.deceasedMarkedNames || []).slice(0, 4).join('、')}${(r.deceasedMarkedNames || []).length > 4 ? '…' : ''}）`);
                return bits.length ? (' · ' + bits.join(' · ')) : '';
            } catch (e) { return ''; }
        };
        // v3.18.0：机械已去世研判结果（新标记 / 待确认）—— 进通知与文案
        const deathStat = lastDeceasedMark();
        const deathText = (deathStat && (deathStat.marked || deathStat.uncertain)) ? (deceasedMarkText(deathStat) + '；') : '';
        const mechText = (mech.changed
            ? `全局机械处理 ${mech.total} 名：出生日期校正 ${mech.birth ? mech.birth.corrected : 0} 名 · 标签补充 ${mech.tags ? mech.tags.filled : 0} 名 · 年龄刷新 ${mech.ages ? mech.ages.fixed : 0} 名${mech.ages && mech.ages.cleared ? `（清无效值 ${mech.ages.cleared}）` : ''}`
            : `全局机械处理 ${mech.total} 名：无需改动（出生日期 / 标签 / 年龄均已就绪）`) + `；${deathText}${deadText}${immText}`;
        const q = buildCharacterRepairQueue();
        if (!q.list.length) {
            notify('success', '角色修复：无需修复', `${mechText}可修复的 ${q.total} 名角色档案有效字数都已达到门限（≥ ${q.minSize} 字）${q.deceasedCount ? ` · 另有 ${q.deceasedCount} 名已去世角色按固定规则跳过（年龄锁定）` : ''}${q.immortalCount ? ` · 另有 ${q.immortalCount} 名长生者跳过（已按剧情标记，不再分析）` : ''}。如需重查更完整的档案，可在 设定 → 自动修复 调低「角色修复字数门限」。`);
            return { made: 0, skipped: true, total: q.total, queue: 0, deceased: q.deceasedCount || 0, mech: mech };
        }
        const batch = Math.max(1, Math.min(10, Number(cfg.repairCharacterBatch) || 3));
        const targets = q.list.slice(0, batch);
        const beforeCount = snaps.length;
        const floors = Math.max(1, Number(cfg.repairFloors) || Number(cfg.feedFloors) || 10);
        // V1 `notify('repair', …)` → TOAST_KINDS.repair.type === 'warning'（V2 notifyHooks 只认 info/success/warning/error）
        notify('warning', '开始修复角色档案…', `${mechText}待修复 ${q.list.length} 名（可修复 ${q.total} 名，门限 ${q.minSize} 字${q.anomalies ? ` · ⚠️ 出生日期异常 ${q.anomalies} 名已入优先档` : ''}${q.deceasedCount ? ` · 已去世 ${q.deceasedCount} 名跳过` : ''}${q.immortalCount ? ` · 长生者 ${q.immortalCount} 名跳过` : ''}）· 本轮处理 ${targets.length} 名：${targets.map(t => t.name + (t.anomaly ? '⚠️' : '')).join('、')}`);
        // v1.177：AI 空手而归时**自动加强重试一次**（用户要求「确保能一次性补全信息，而不是反复不提供」）——
        //   第 2 轮用加强版说明（strict：逐字段必给 + 标签必给 + 依据优先级重申），同一批目标、同一次点击内完成。
        let attempts = 0, r = null;
        const maxAttempts = 2;
        while (attempts < maxAttempts) {
            attempts++;
            const prompt = buildCharacterRepairPrompt(targets, { strict: attempts > 1, deathGuide: true, immortalGuide: true });   // v3.18.0：已去世守则；v3.22.0：长生者守则
            const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '角色修复'));
            r = applyCharacterRepairResult(normalizeDeltaKeys(extractJsonObject(resp) || {}), targets);
            if (r.changed || r.removed) break;
        }
        // v1.152：AI 之后仍可能留空 → 对本轮目标逐条兜底（用户要求：出生年月绝对不能留空）
        let birthFix = 0;
        try {
            for (const t of targets) {
                const sn = (t && t.snap) || null;
                if (!sn) continue;
                const eb = ensureSnapshotBirthDate(sn);
                if (eb.changed) { birthFix++; r.changed++; r.fields.push(sn.name + '·身份.出生日期（推测）'); }
            }
        } catch (e) { }
        // v1.177：AI 之后标签仍不足 3 个 → 自动补充（零 AI 兜底；不改变「AI 是否给出补全」的判定口径）
        let tagFix = 0;
        try {
            for (const t of targets) {
                const sn = (t && t.snap) || null;
                if (!sn) continue;
                if (ensureSnapshotTags(sn).changed) { tagFix++; r.fields.push(sn.name + '·标签（自动补充）'); }
            }
        } catch (e) { }
        // v1.176：AI 之后再跑一次**全局年龄固定规则**（含本轮目标之外的档案 —— 剧情日期可能已推进）
        let ageSync = { fixed: 0, cleared: 0, items: [] };
        try { ageSync = refreshAllSnapshotAges(); } catch (e) { }
        if (ageSync.fixed || ageSync.cleared) { try { saveState(); } catch (e) { } }
        const ageSyncText = (ageSync.fixed || ageSync.cleared)
            ? ` · 全局年龄刷新 ${ageSync.fixed} 名${ageSync.cleared ? `（清无效值 ${ageSync.cleared}）` : ''}`
            : '';
        const after = (state.snapshots || []).length;
        if (!r.changed && !r.removed) {
            notify('warning', '角色修复：本轮未产生实际变化', `${mechText}${ageSyncText ? `AI 之后${ageSyncText.replace(' · ', '：')}；` : ''}本轮目标 ${targets.length} 名；AI ${attempts > 1 ? '连续两轮（含加强重试）' : '本轮'}均未给出可落库的补全（推断 ${r.rolesInferred || 0} · 无依据 ${r.rolesNoBasis} · 无效字段 ${r.invalid}${r.unknownRole ? ` · 姓名不匹配 ${r.unknownRole}` : ''}）。最常见原因：相关原子数据与最近 ${floors} 楼正文里确实没有这几名角色的信息 —— 可在 设定 调大「修复使用最近楼层数」后重试。`);
            try { dbgLog('摘要', { action: '角色修复无变化', targets: targets.map(t => t.name), attempts: attempts, inferred: r.rolesInferred || 0, noBasis: r.rolesNoBasis, invalid: r.invalid, unknownRole: r.unknownRole, ageSync: { fixed: ageSync.fixed, cleared: ageSync.cleared } }); } catch (e) { }
            return { made: 0, noChange: true, targets: targets.length, attempts: attempts, noBasis: r.rolesNoBasis, inferred: r.rolesInferred || 0, invalid: r.invalid, unknownRole: r.unknownRole, queueLeft: Math.max(0, q.list.length - targets.length), mech: mech, ageSync: ageSync };
        }
        saveState();
        const rest = Math.max(0, q.list.length - targets.length);
        notify('success', '角色修复完成', `${repairReport({ before: targets.length, after: targets.length, checked: targets.length, submittedNames: targets.map(t => t.name), rolesChanged: r.rolesChanged, changed: r.changed, deleted: r.removed, queueLeft: rest })}；本轮目标 ${targets.length} 名${attempts > 1 ? `（AI 加强重试 ${attempts} 轮）` : ''} · 实际补全 ${r.rolesChanged} 名 / ${r.changed} 个字段${r.removed ? ` · 删除明显错误 ${r.removed} 条` : ''}${r.rolesInferred ? ` · 保守推断 ${r.rolesInferred} 名` : ''}${r.rolesNoBasis ? ` · 无依据 ${r.rolesNoBasis} 名` : ''}${r.invalid ? ` · 无效字段 ${r.invalid} 个` : ''}${(birthFix || r.birthInferred) ? ` · 推测出生日期 ${birthFix || r.birthInferred} 名` : ''}${tagFix ? ` · 标签自动补充 ${tagFix} 名` : ''}${r.birthFixed ? ` · 修正倒挂出生日期 ${r.birthFixed} 名` : ''}${immortalOutcomeText(r)}${ageSyncText}；角色 ${beforeCount} → ${after}；${rest ? `待修复名单剩余 ${rest} 名，可再次点击继续` : '待修复名单已清空'}。`);
        if (r.birthFixed) { try { dbgLog('摘要', { action: '倒挂出生日期修正', names: r.birthFixedNames || [], count: r.birthFixed }); } catch (e) { } }
        try { dbgLog('摘要', { action: '角色修复完成', targets: targets.map(t => t.name), attempts: attempts, fields: r.fields, changed: r.changed, rolesChanged: r.rolesChanged, inferred: r.rolesInferred || 0, removed: r.removed, noBasis: r.rolesNoBasis, invalid: r.invalid, queueLeft: rest, ageSync: { fixed: ageSync.fixed, cleared: ageSync.cleared },
            // v3.22.0：长生者判定与误判纠正的落地计数（可事后核对「谁被标成长生 / 谁被纠正为去世」）
            immortalSet: r.immortalSet || 0, immortalNames: (r.immortalNames || []).slice(0, 8),
            immortalCleared: r.immortalCleared || 0, immortalClearedNames: (r.immortalClearedNames || []).slice(0, 8),
            deceasedMarked: r.deceasedMarked || 0, deceasedMarkedNames: (r.deceasedMarkedNames || []).slice(0, 8),
        }); } catch (e) { }
        return { made: 1, targets: targets.length, attempts: attempts, changed: r.changed, rolesChanged: r.rolesChanged, inferred: r.rolesInferred || 0, removed: r.removed, noBasis: r.rolesNoBasis, invalid: r.invalid, queueLeft: rest, mech: mech, ageSync: ageSync };
    } catch (e) {
        warn('角色修复失败', e);
        notify('error', '角色修复失败', String((e && e.message) || e).slice(0, 100));
        return { made: 0, error: String((e && e.message) || e) };
    }
}

export {
    SNAP_REPAIR_FIELDS, SNAP_REPAIR_FIELD_MAP, SNAP_REPAIR_FIELD_LIMIT, SNAP_REPAIR_EMPTY_RE, SNAP_REPAIR_FIELD_ALIAS,
    snapGetByPath, snapValueText, SNAP_TAG_STOP, snapTagSplit, deriveSnapshotTags, snapshotFallbackTags,
    ensureSnapshotTags, ensureAllSnapshotTags, characterEvidencePack,
    snapshotAtomSize, buildCharacterRepairQueue, setSnapshotByPath, characterRepairContext,
    buildCharacterRepairPrompt, applyCharacterRepairResult, correctSnapshotBirthDates, runCharacterMechanicalPass,
    runCharacterRepair,
    // v3.18.0：已去世研判（机械，零 AI）
    DEATH_WORDS, DEATH_TERMINAL, LONG_LIFE_WORDS, DEATH_NEGATE, DEATH_THIRD_PARTY,
    deathSplitSentences, deathSentenceJudge, snapshotDeathEvidence, snapshotDeathVerdict,
    markDeceasedByEvidence, deceasedMarkText, lastDeceasedMark,
    // v3.22.0：长生者（跳过修复）+ 超长年龄研判
    characterAgeScan,
};

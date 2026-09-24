// ============================================================
// core/model/scalars.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js + 01/09（常数与工具））
// 移植口径：算法与字段名保持与 V1 完全一致（保证 V1 数据可导入、跨端哈希一致）；
//   仅做两处适配：① 去掉 IIFE/全局依赖，改为 ESM 显式导入；② `cfg.dimCharLimits` 改为可注入的维度上限表。
// 一致性由 tests/unit/model-golden.test.js 使用 V1 源码切片产出的黄金样本强制校验。
// ============================================================
import { normText, normalizeList, clamp, hashText, splitListText } from '../util.js';
import { DIM_CHAR_LIMITS } from '../constants.js';
import { cfg } from './runtime.js';
import { clockYearStr, dateStrCmp } from '../clock.js';

// 维度字数硬上限（默认逐字取自 V1 `defaultCfg.dimCharLimits`）
const defaultCfg = { dimCharLimits: DIM_CHAR_LIMITS };
/** 当前维度上限表（只读快照） */
export function dimCharLimits() { return Object.assign({}, cfg.dimCharLimits); }
/** V1 原版：按维度上限截断（`cfg.dimCharLimits[dim] || defaultCfg.dimCharLimits[dim] || 300`） */
function dimCap(dim, text) {
    const limit = Number((cfg && cfg.dimCharLimits && cfg.dimCharLimits[dim]) || defaultCfg.dimCharLimits[dim] || 300);
    const s = String(text || '');
    return s.length > limit ? s.slice(0, limit) : s;
}

function mergeTags(tagsArr, kwArr) {
    const out = normalizeList(tagsArr);
    normalizeList(kwArr).forEach(k => { if (!out.includes(k)) out.push(k); });
    return out;
}

function makeExtra(fields) {
    const out = [];
    for (const [name, value] of Object.entries(fields || {})) {
        if (value === undefined || value === null || value === '') continue;
        out.push({ name, type: detectValueType(value), value });
    }
    return out;
}

function extraGet(extra, name) {
    const slot = (extra || []).find(s => s && s.name === name);
    return slot ? slot.value : undefined;
}

// [] 中文兜底映射：状态字段 / 记忆分类（AI 偶尔输出英文时自动转中文）

function detectValueType(v) {
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'float';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
    return 'string';
}

function toChineseField(field) {
    const f = String(field || '').trim();
    if (!f) return f;
    if (/[\u4e00-\u9fff]/.test(f)) return f;          // 已是中文
    return STATE_FIELD_CN[f.toLowerCase()] || f;        // 英文 → 中文兜底
}

function toChineseCategory(cat) {
    const c = String(cat || '').trim();
    if (!c) return '一般';
    if (/[\u4e00-\u9fff]/.test(c)) return c;
    return MEMORY_CATEGORY_CN[c.toLowerCase()] || c;
}

// ==================== 归一化 ====================
// 各大类单条正文硬截断 —— 依据设定 dimCharLimits（提取记忆 → 字数上限）对主正文字段限长；
//        仅在入库（normalize）时对超限正文截断，历史数据不回溯；缺省用默认上限。

function atomTitle(a) {
    const t = normText(a?.title || '', 40);
    const txt = String(a?.text || '').trim();
    if (t && txt && !txt.startsWith(t)) return t;
    if (!txt) return '';
    const first = txt.split(/\n/)[0].trim().replace(/[。！？!?；;，,、：:\s]+$/, '');
    return first || txt;
}

const STATE_FIELD_CN = {
    emotion: '情绪', health: '身体状况', mental: '心理状态', identity: '身份',
    relationship: '关系', situation: '处境', injury: '伤势', status: '状态', mood: '心情',
};

const MEMORY_CATEGORY_CN = {
    event: '事件', secret: '秘密', agreement: '约定', promise: '约定', sighting: '见闻',
    memory: '记忆', plan: '计划', lesson: '教训', gossip: '传闻',
};

function normStrList(v, max, len) {
    const out = [];
    for (const raw of (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[，,、;；\n]/))) {
        const x = normText(typeof raw === 'string' ? raw : (raw && (raw.text || raw.content || raw['内容'])) || '', len || 40);
        if (!x || out.indexOf(x) >= 0) continue;
        out.push(x);
        if (out.length >= max) break;
    }
    return out;
}
// ==================== v1.166：计划 / 悬念「阶段」轻量状态机（docs/11 Q15-A 的补充扩展） ====================
// 设计口径：**不改 status 语义**（open/closed 原样保留、旧数据零迁移零抖动、可整层回退）——
//   仅新增可选字段 phase（'' = 进行中 / blocked = 受阻 / abandoned = 已放弃）+ statusNote（一句话备注）。
//   空值不参与任何判定；未填写的旧条目与 v1.165 行为逐字节等价。

function normSteps(v, max) {
    const out = [];
    const list = Array.isArray(v) ? v : [];
    for (const raw of list) {
        const o = (raw && typeof raw === 'object') ? raw : { text: raw };
        const text = normText(o.text || o.content || o['内容'] || '', 60);
        if (!text) continue;
        out.push({ text, done: o.done === true || o['完成'] === true });
        if (out.length >= max) break;
    }
    return out;
}

function normHistory(v, max) {
    const out = [];
    const list = Array.isArray(v) ? v : [];
    for (const raw of list) {
        const o = (raw && typeof raw === 'object') ? raw : { text: raw };
        const text = normText(o.text || o.content || o['内容'] || '', 60);
        if (!text) continue;
        const at = /^\d{4}-\d{2}-\d{2}$/.test(String(o.at || o.date || o['日期'] || '').trim()) ? String(o.at || o.date || o['日期']).trim() : '';
        out.push({ text, at, result: normText(o.result || o['结果'] || '', 10), atomRef: normText(o.atomRef || o['依据'] || '', 60) });
        if (out.length >= max) break;
    }
    out.sort((a, b) => dateStrCmp(a && a.at, b && b.at));   // v1.193：负年份安全
    return out;
}

function normIdList(v, max) {
    const out = [];
    for (const raw of (Array.isArray(v) ? v : [])) {
        const id = String((raw && typeof raw === 'object') ? (raw.id || raw.refId || raw['标题'] || '') : (raw == null ? '' : raw)).trim().slice(0, 60);
        if (!id || out.indexOf(id) >= 0) continue;
        out.push(id);
        if (out.length >= max) break;
    }
    return out;
}

function normPhase(v) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    if (Object.prototype.hasOwnProperty.call(PLAN_PHASE_CN, raw)) return PLAN_PHASE_CN[raw];
    const s = raw.toLowerCase();
    if (s === 'blocked' || s === 'abandoned') return s;
    return '';
}

const PLAN_PHASE_CN = { '进行中': '', '正常': '', '顺利': '', '受阻': 'blocked', '卡住': 'blocked', '停滞': 'blocked', '搁置': 'abandoned', '放弃': 'abandoned', '中止': 'abandoned', '终止': 'abandoned' };

function normClues(v, max) {
    const out = [];
    const list = Array.isArray(v) ? v : [];
    for (const raw of list) {
        const o = (raw && typeof raw === 'object') ? raw : { text: raw };
        const text = normText(o.text || o.content || o['内容'] || '', 60);
        if (!text) continue;
        out.push({
            text,
            by: normText(o.by || o.who || o['发现者'] || '', 40),
            at: /^\d{4}-\d{2}-\d{2}$/.test(String(o.at || o.date || o['发现日期'] || '').trim()) ? String(o.at || o.date || o['发现日期']).trim() : '',
            atomRef: normText(o.atomRef || '', 60),
        });
        if (out.length >= max) break;
    }
    return out;
}

function scenePathArr(e) {
    let raw = (e && (e.pathArr !== undefined ? e.pathArr : (e.path !== undefined ? e.path : e.pathStr))) ?? [];
    let arr = [];
    if (Array.isArray(raw)) arr = raw.map(x => String(x ?? '').trim()).filter(Boolean);
    else if (typeof raw === 'string') arr = String(raw).split(/>|›|»/).map(x => String(x).trim()).filter(Boolean);
    const name = e && typeof e.name === 'string' ? String(e.name).trim() : '';
    if (name && (!arr.length || arr[arr.length - 1] !== name)) arr.push(name);
    return arr;
}

function clockDateTrim(v) {
    try {
        const t = String(v == null ? '' : v).trim();
        // v1.193：兼容 `/` 与 `.` 分隔符（AI/历史数据常见混用），统一规范化为 `-`；负年份同样处理
        const m = t.match(/^(-?\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (!m) return '';
        return clockYearStr(Number(m[1])) + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    } catch (e) { return ''; }
}
// 取「月-日」部分（用于关联行等紧凑展示）：负年份同样正确

function storageHash(obj) {
    try {
        const s = JSON.stringify(obj);
        let h1 = 0x811c9dc5, h2 = 0x01000193;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ (c ^ 0x5f), 0x85ebca6b) >>> 0;
        }
        return h1.toString(36) + '_' + h2.toString(36);
    } catch (e) { return ''; }
}
// ==================== 服务端/CP 协同 + 删除墓碑 基础工具 ====================
// ① 与 Cocktail Plus 一致的稳定序列化（递归排序键；null/undefined→'null'）——用于 settings 哈希对齐

const SNAP_GROUP_MAP = {
    gender: 'identity', birthDate: 'identity', ageNote: 'identity', species: 'identity', occupation: 'identity', title: 'identity', family: 'identity',
    deceased: 'identity',   // v1.164：已去世开关归入身份组
    height: 'appearance', build: 'appearance', hair: 'appearance', eyes: 'appearance', skin: 'appearance', distinguishing: 'appearance',
    traits: 'personality', quirks: 'personality', values: 'personality', speechStyle: 'personality',
    origin: 'background', history: 'background',
    emotion: 'mind', currentGoal: 'mind', concern: 'mind',
    relationToUser: 'social', attitudeToUser: 'social',
    todos: 'future', commitments: 'future',
    city: 'location', area: 'location', building: 'location', interior: 'location',
};
function normalizeTrackedRoles(v) {
    try {
        // 只接受「数组」或「逗号/顿号分隔的字符串」；其它类型（数字/布尔/对象）一律视为无名单
        if (!Array.isArray(v) && typeof v !== 'string') return [];
        const arr = Array.isArray(v) ? v : String(v).split(/[,，、;；\n]/);
        const out = [];
        for (const x of arr) {
            const nm = String(x == null ? '' : x).trim().slice(0, 40);
            if (!nm) continue;
            if (out.indexOf(nm) >= 0) continue;
            out.push(nm);
            if (out.length >= 12) break;   // 上限 12 名（注入/提示词规模可控）
        }
        return out;
    } catch (e) { return []; }
}

export { dimCap };
export { normalizeTrackedRoles };
export { SNAP_GROUP_MAP, splitListText };
export { mergeTags, makeExtra, extraGet, detectValueType, toChineseField, toChineseCategory, atomTitle, STATE_FIELD_CN, MEMORY_CATEGORY_CN, normStrList, normSteps, normHistory, normIdList, normPhase, PLAN_PHASE_CN, normClues, scenePathArr, clockDateTrim, storageHash };

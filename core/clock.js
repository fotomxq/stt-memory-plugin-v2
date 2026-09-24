// ============================================================
// core/clock.js —— **逐字移植自 V1**（src/modules/09-AI摘要与楼层处理.js 的剧情时钟族）
// 覆盖：日期裁剪 / 解析 / 格式化 / 校验（异常阈值）/ 公元前归一（`clockNormBcText`）/ 中文数字 / 数值化时间戳。
// 适配：ESM 化 + 注入视图（cfg）。一致性由 tests/unit/clock-golden.test.js 的黄金样本强制校验。
// ============================================================
import { cfg } from './model/runtime.js';

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

function clockDateParts(s) {
    try {
        const t = String(s == null ? '' : s).trim().slice(0, 10 + 1);
        const m = t.match(/^(-?\d{1,4})-(\d{1,2})-(\d{1,2})$/);
        if (!m) return null;
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (!clockYearInRange(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const ms = storyDateMs(y, mo, d);
        if (!Number.isFinite(ms)) return null;
        const dt = new Date(ms);
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
        return { y, m: mo, d };
    } catch (e) { return null; }
}
// 换掉日期串的年份（保留月日；用于时间巡检的「年份校正」）

function clockDateStr(y, m, d) { return `${clockYearStr(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

function clockDateValid(s) {
    try {
        const t = String(s == null ? '' : s).trim();
        // v1.193：年份可负（公元前）—— `-0221-01-02` / `0221-01-02` / `221-01-02` 均接受
        if (!/^-?\d{1,4}-\d{2}-\d{2}$/.test(t)) return false;
        const p = clockDateParts(t);
        return !!p;
    } catch (e) { return false; }
}
// ==================== v1.184：日期异常判定 + 降级来源（最新情节 / 最新场景） ====================
// 用户要求：③ 若捕捉的日期异常 → **自动降级**采用「最新情节的日期与时间」+「最新的场景」；
//   ④ 设定新增「强制使用降级处理方案」开关（开启后**强制降级**，否则走默认自动提取）；
// 判定（`clockAnomalyJumpYears` 默认 100 年，0 = 关闭该判定）：
//   ① 格式非法（非 YYYY-MM-DD 或日期不存在）→ `invalid`；
//   ② 与锚点年份（当前时钟 / 最新情节 / 原子数据最新日期）相差超过阈值 → `jump`；
//   ③ 早于锚点 **超过阈值**（剧情时间大幅倒退，通常是脏数据）→ `backward`。

function clockNormBcText(text) {
    try {
        let s = String(text == null ? '' : text);
        if (!/公元前|西元前|纪元前|元前|\bBC\b|B\.C|BCE|-\s*\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]|(?:^|[^\u4e00-\u9fff])前\s*(?=\d|[一二三四五六七八九〇零两十])/i.test(s)) return s;
        // ③ 直接写的负数 ISO 日期：`-221-01-02` → `前-221年1月2日`（前面不能紧跟数字，避免半截误匹配）
        s = s.replace(/(^|[^\d])(-\d{1,4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/g, '$1前$2年$3月$4日');
        s = s.replace(CLOCK_BC_SUFFIX, (all, v) => {
            const arab = /^\d+$/.test(String(v)) ? Number(v) : clockCnInt(v);
            return Number.isInteger(arab) && arab > 0 ? `前-${arab}年` : all;
        });
        s = s.replace(CLOCK_BC_PREFIX_CN, (all, cn) => {
            const n = clockCnInt(cn);
            return Number.isInteger(n) && n > 0 ? `前-${n}` : all;
        });
        s = s.replace(CLOCK_BC_PREFIX, '前-');
        // v1.193：公元前写法里的中文月/日统一换算为阿拉伯数字（如「公元前一九年三月」→「前-19年3月」）
        s = s.replace(/(前-\d{1,4}\s*年)\s*([一二三四五六七八九〇零两十]{1,3})\s*月(?:\s*([一二三四五六七八九〇零两十]{1,3})\s*[日号]?)?/g,
            (all, head, moCn, dayCn) => {
                const mo = clockCnInt(moCn), dd = dayCn === undefined ? null : clockCnInt(dayCn);
                if (!Number.isInteger(mo)) return all;
                return head + mo + '月' + (dd === null ? '' : dd + '日');
            });
        // v1.193：裸写法「前221年」「前 九年」（前面不能紧跟汉字，避免误吃「之前 221 年」）
        s = s.replace(/(^|[^\u4e00-\u9fff])前\s*(?=\d|[一二三四五六七八九〇零两十])/g, '$1前-');
        return s;
    } catch (e) { return String(text == null ? '' : text); }
}
// v1.184：年份补零到 4 位（「公元9年」→ `0009-01-01`，保证 clockDateValid / 字符串排序口径一致）
//   v1.193：负数年份 → `-0221-01-02`（符号 + 4 位）

function clockYearStr(y) {
    const n = Number(y);
    if (!Number.isFinite(n)) return '';
    const v = Math.trunc(n);
    return v < 0 ? '-' + String(Math.abs(v)).padStart(4, '0') : String(v).padStart(4, '0');
}

function storyDateMs(y, m, d) {
    try {
        const yy = Number(y), mm = Number(m), dd = Number(d);
        // v1.193：年份可为负（公元前）；0 年不存在
        if (!Number.isInteger(yy) || yy === 0 || yy < CLOCK_YEAR_MIN || yy > CLOCK_YEAR_MAX) return NaN;
        if (!Number.isInteger(mm) || mm < 1 || mm > 12) return NaN;
        if (!Number.isInteger(dd) || dd < 1 || dd > 31) return NaN;
        const dt = new Date(Date.UTC(2000, 0, 1));
        dt.setUTCFullYear(yy, mm - 1, dd);
        if (dt.getUTCMonth() !== mm - 1) return NaN;        // 进位（如 2 月 30 日）→ 非法
        return dt.getTime();
    } catch (e) { return NaN; }
}

function storyDateMsFromStr(s) {
    try {
        const m = String(s || '').match(/^(-?\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})/);   // v1.193：支持负年份
        if (!m) return NaN;
        return storyDateMs(m[1], m[2], m[3]);
    } catch (e) { return NaN; }
}

function clockDateFromParts(ymd, prevYear) {
    try {
        let y = Number.isFinite(clockValYear(ymd[0])) && String(ymd[0]).trim() !== '' ? clockValYear(ymd[0]) : NaN;
        // v1.184：只给年份（如「公元9年」）→ 月/日按 1 月 1 日；月/日缺失或为空时同样按 1 处理
        const moRaw = (ymd[1] === undefined || ymd[1] === null || String(ymd[1]).trim() === '') ? 1 : clockValNum(ymd[1]);
        const daRaw = (ymd[2] === undefined || ymd[2] === null || String(ymd[2]).trim() === '') ? 1 : clockValNum(ymd[2]);
        const mo = moRaw, da = daRaw;
        // v1.193：无年份 → 沿用已有年份（同样支持负年份）
        if (!Number.isInteger(y)) y = clockYearOf(prevYear);
        if (!clockYearInRange(y) || !Number.isInteger(mo) || mo < 1 || mo > 12 || !Number.isInteger(da) || da < 1 || da > 31) return null;
        return clockDateStr(y, mo, da);
    } catch (e) { return null; }
}
// 日期直接扫描（阿拉伯/中文数字 · 完整年月日或 月日 · **v1.184 支持「公元」前缀与「公元X年」纯年份**）
// 统一约定：**第 1 组 = 年、第 2 组 = 月、第 3 组 = 日**（可缺省）；顺序 = 精确 → 宽松。

function clockCnInt(s) {
    try {
        const str = String(s || '').trim();
        if (!str) return NaN;
        const one = str.split('').map(c => (CLOCK_CN_DIG[c] !== undefined ? CLOCK_CN_DIG[c] : NaN));
        if (one.every(v => Number.isInteger(v))) { let n = 0; for (const v of one) { if (!Number.isInteger(v)) return NaN; n = n * 10 + v; } return n; }
        if (str.includes('十')) {
            const parts = str.split('十');
            const ga = (parts[0] && CLOCK_CN_DIG[parts[0]] !== undefined) ? CLOCK_CN_DIG[parts[0]] : (parts[0] ? NaN : 1);
            const gb = (parts[1] && CLOCK_CN_DIG[parts[1]] !== undefined) ? CLOCK_CN_DIG[parts[1]] : (parts[1] ? NaN : 0);
            if (Number.isInteger(ga) && Number.isInteger(gb)) return ga * 10 + gb;
            return NaN;
        }
        return NaN;
    } catch (e) { return NaN; }
}

function clockValNum(v) { return /^\d+$/.test(String(v)) ? Number(v) : clockCnInt(v); }
// ==================== v1.193：公元前（年份为负）支持 ====================
// 用户要求：「年月日兼容公元前，即年份会变为负数。包括角色生日也需兼容。」
// 统一口径：**存储格式 = `-0221-01-02`**（负号 + 4 位补零年份 + 月日），与既有 `YYYY-MM-DD` 同构；
//   历史上没有 0 年（公元前 1 年 = -1，其后直接是公元 1 年），故 y === 0 一律判非法；
//   年份范围 [-9999, 9999]；显示时用 `clockDateLabel()` 加「公元前」前缀（列表/总览/注入）。
// 识别写法：公元前221年1月2日 / 公元前221年 / 公元前九年 / 前221年 / -221-01-02 / `221 BC`·`221 BCE`·`221 B.C.`。

function clockValYear(v) {
    const s = String(v == null ? '' : v).trim().replace(/^(?:公元前|西元前|纪元前|元前|前)\s*/, '');
    if (/^-?\d+$/.test(s)) return Number(s);
    const n = clockCnInt(s.replace(/^-/, ''));
    if (!Number.isInteger(n)) return NaN;
    return /^-/.test(s) ? -n : n;
}
// 日期字符串 → { y, m, d }（支持负年份；非法/不存在返回 null）

function clockYearOf(s) {
    try {
        const m = String(s == null ? '' : s).trim().match(/^(-?\d{1,4})/);
        if (!m) return NaN;
        const y = Number(m[1]);
        return clockYearInRange(y) ? y : NaN;
    } catch (e) { return NaN; }
}
// 解析年份取值（支持负号 / 中文数字 / 「前」前缀写法）

function clockYearInRange(y) { return Number.isInteger(y) && y !== 0 && y >= CLOCK_YEAR_MIN && y <= CLOCK_YEAR_MAX; }
// 年份 → 规范串：正数补零到 4 位；负数 = 负号 + 绝对值补零到 4 位（-221 → `-0221`）

function clockDateLabel(s) {
    try {
        const t = String(s == null ? '' : s).trim();
        const p = clockDateParts(t);
        if (!p) return t;
        return p.y < 0 ? '公元前' + String(Math.abs(p.y)) + t.slice(t.indexOf('-', 1)) : t;
    } catch (e) { return String(s == null ? '' : s); }
}
// 日期串比较（数值口径）：负年份下字典序会错序（'-0009' < '-0221' 但 -9 > -221），统一走剧情日期毫秒

function clockMonthDay(v) {
    try {
        const m = String(v == null ? '' : v).trim().match(/^-?\d{1,4}-(\d{2}-\d{2})/);
        return m ? m[1] : String(v == null ? '' : v);
    } catch (e) { return ''; }
}

function clockAnomalyJumpYears() {
    const n = Number(cfg && cfg.clockAnomalyJumpYears);
    if (!Number.isFinite(n)) return 100;
    return n <= 0 ? 0 : Math.min(9999, Math.round(n));
}

const CLOCK_YEAR_MIN = -9999, CLOCK_YEAR_MAX = 9999;

const CLOCK_CN_DIG = { '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

const CLOCK_BC_PREFIX = /(?:公元前|西元前|纪元前|元前)\s*/g;

const CLOCK_BC_PREFIX_CN = /(?:公元前|西元前|纪元前|元前)\s*([一二三四五六七八九〇零两十]{1,4})/g;

const CLOCK_BC_SUFFIX = /([0-9]{1,4}|[一二三四五六七八九〇零两十]{1,4})\s*年?\s*(?:BCE|B\.C\.E\.?|BC|B\.C\.?)(?![A-Za-z])/gi;

const CLOCK_DATE_SCAN = [
    /(?:前)\s*(-\d{1,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g,                       // v1.193：公元前221年1月2日（归一后为「前-221年1月2日」）
    /(?:前)\s*(-\d{1,4})\s*年\s*(?:(\d{1,2})\s*月\s*(?:(\d{1,2})\s*[日号]?)?)?/g,          // v1.193：公元前221年 / 公元前221年1月
    /(?:前)\s*(-\d{1,4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/g,                          // v1.193：前 221-01-02
    /(?:公元)?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g,                       // 1919年11月29日 / 公元1919年11月29日
    /公元\s*(\d{1,4})\s*年\s*(?:(\d{1,2})\s*月\s*(?:(\d{1,2})\s*[日号]?)?)?/g,               // 公元9年 / 公元99年 / 公元618年6月 / 公元618年6月18日
    /(?:公元)?\s*(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/g,                          // 1919-11-29 / 公元1919-11-29
    /(?:公元)?\s*([一二三四五六七八九〇零两]{1,4})\s*年\s*([一二三四五六七八九〇零两十]{1,3})\s*月\s*([一二三四五六七八九〇零两十]{1,3})\s*[日号]?/g,   // 一九一九年三月一日
    /公元\s*([一二三四五六七八九〇零两十]{1,4})\s*年\s*(?:([一二三四五六七八九〇零两十]{1,3})\s*月\s*(?:([一二三四五六七八九〇零两十]{1,3})\s*[日号]?)?)?/g, // 公元九年 / 公元九九年 / 公元九年三月
    /(?:(?:公元)?\s*([一二三四五六七八九〇零两十]{1,4})\s*年)?\s*([一二三四五六七八九〇零两十]{1,3})\s*月\s*([一二三四五六七八九〇零两十]{1,3})\s*[日号]?/g, // 三月一日（无年份 → 沿用已存年份）
    /(?:(?:公元)?\s*(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g,   // v1.187：阿拉伯数字「11月29日」（年份可选 → 缺年份时沿用已存年份）；分组与其它模式一致：1=年 2=月 3=日
];
// v1.187：拒绝「长日期尾部」的重复命中 —— 例如「公元618年6月18日」里的「6月18日」、
//   「1919年11月29日」里的「11月29日」。否则「取最后一次命中」的归一逻辑会把正确年份换成沿用年份
//   （用户录入/正文里的完整日期会被截成半截）。规则：命中位置紧跟在「年」或数字之后 → 视为尾部，丢弃。

export { clockDateTrim, clockDateParts, clockDateStr, clockDateValid, clockNormBcText, clockYearStr, storyDateMs, storyDateMsFromStr, clockDateFromParts, clockCnInt, clockValNum, clockValYear, clockYearOf, clockYearInRange, clockDateLabel, clockMonthDay, clockAnomalyJumpYears, clockDateAnomaly, clockReplaceYear, clockNormTime, clockAddDays, clockMatchNotInline, CLOCK_DAY_PARTS, CLOCK_DATE_SCAN, CLOCK_YEAR_MIN, CLOCK_CN_DIG, CLOCK_BC_PREFIX, CLOCK_BC_PREFIX_CN, CLOCK_BC_SUFFIX, dateStrCmp, clockParseDateText };

// ==================== 移植补全（内核标识符门禁发现缺失依赖） ====================
function dateStrCmp(a, b) {
    try {
        const x = storyDateMsFromStr(a), y = storyDateMsFromStr(b);
        const xo = Number.isFinite(x), yo = Number.isFinite(y);
        if (xo && yo) return x === y ? 0 : (x < y ? -1 : 1);
        if (xo !== yo) return xo ? -1 : 1;              // 可解析者排在不可解析者之前
        return String(a == null ? '' : a) < String(b == null ? '' : b) ? -1 : (String(a || '') === String(b || '') ? 0 : 1);
    } catch (e) { return 0; }
}
// 取日期串的「日期部分」（剥离时间后缀）：负年份为 11 字符（-0221-01-02），正年份 10 字符

function clockMatchNotInline(text, m) {
    try {
        if (!m) return false;
        const i = Number(m.index) || 0;
        if (i <= 0) return true;
        const prev = String(text).charAt(i - 1);
        if (prev === '年') return false;
        if (/\d/.test(prev)) return false;
        return true;
    } catch (e) { return true; }
}

function clockParseDateText(val, prevYear) {
    try {
        // v1.193：先把各种「公元前 / BC」写法归一为「前-<数字>」形式，再走统一扫描表
        const t = clockNormBcText(String(val || ''));
        if (!t) return null;
        for (const re of CLOCK_DATE_SCAN) {
            const rr = new RegExp(re.source, 'g');
            let m; let best = null;
            while ((m = rr.exec(t)) !== null) {
                if (!clockMatchNotInline(t, m)) continue;      // v1.187：跳过长日期尾部命中
                const cand = clockDateFromParts([m[1], m[2], m[3]], prevYear);
                if (cand) best = cand;
            }
            if (best) return best;
        }
        return null;
    } catch (e) { return null; }
}
// 日期加减天数（v1.184/v1.193：先建基准日再一次性 setUTCFullYear —— 避开「年份 <100 被映射到 19xx」，
//   跨月/跨年进位正确；负年份适用，且历史上无 0 年：-0001-12-31 + 1 → 0001-01-01）
function clockAddDays(dateStr, n) {
    try {
        const p = clockDateParts(String(dateStr == null ? '' : dateStr).slice(0, 11));
        if (!p) return dateStr;
        const d = new Date(Date.UTC(2000, 0, 1));
        d.setUTCFullYear(p.y, p.m - 1, p.d + Number(n || 0));
        let ry = d.getUTCFullYear();
        if (ry === 0) ry = Number(n || 0) < 0 ? -1 : 1;
        return clockDateStr(ry, d.getUTCMonth() + 1, d.getUTCDate());
    } catch (e) { return dateStr; }
}
// ==================== v1.184~v1.193：时段/日期异常/换年份（B8-1 时钟域移植，逐字取自 V1 `09`） ====================
const CLOCK_DAY_PARTS = ['凌晨', '清晨', '早晨', '早上', '上午', '中午', '午间', '午后', '下午', '傍晚', '黄昏', '晚上', '夜晚', '深夜', '夜里', '半夜', '午夜'];

function clockNormTime(raw) {
    try {
        const t = String(raw || '').trim();
        if (!t) return '';
        let m = t.match(/^(\d{1,2})[:：](\d{1,2})(?::\d{2})?$/);
        if (m) { const h = Number(m[1]), mi = Number(m[2]); if (h <= 23 && mi <= 59) return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; return ''; }
        m = t.match(/^(凌晨|清晨|早晨|早上|上午|中午|午间|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|夜里|半夜|午夜)?\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点时]\s*(半|一刻|三刻)?\s*(?:分)?\s*$/);
        if (m) {
            let h = clockValNum(m[2]);                 // v1.184：支持中文数字点数（「下午三点」→ 15:00）
            if (!Number.isInteger(h)) return '';
            const p = m[1] || '';
            if (h < 24 && /^(下午|晚上|傍晚|黄昏|夜晚|夜里|半夜|午夜)/.test(p) && h < 12) h += 12;
            if (p && /^(凌晨|清晨)/.test(p) && h === 12) h = 0;
            let mi = 0;
            if (m[3] === '半') mi = 30; else if (m[3] === '一刻') mi = 15; else if (m[3] === '三刻') mi = 45;
            if (h <= 23) return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
            return '';
        }
        for (const p of CLOCK_DAY_PARTS) if (t === p) return p;
        if (/^\d{1,2}[:：]\d{1,2}/.test(t)) return clockNormTime(t.slice(0, 5));
        return '';
    } catch (e) { return ''; }
}

/** 日期异常判定：格式非法 / 比锚点晚超过阈值年 / 早超过阈值年（v1.187 口径） */
function clockDateAnomaly(dateStr, anchorDate) {
    try {
        const d = String(dateStr == null ? '' : dateStr).trim();
        if (!clockDateValid(d)) return { bad: true, reason: 'invalid', years: 0 };
        const win = clockAnomalyJumpYears();
        if (!win) return { bad: false, reason: '', years: 0 };
        const anchor = clockDateValid(anchorDate) ? String(anchorDate).slice(0, 10) : '';
        if (!anchor) return { bad: false, reason: '', years: 0 };
        const dy = clockYearOf(d) - clockYearOf(anchor);   // v1.193：负年份
        if (dy > win) return { bad: true, reason: 'jump', years: dy };
        if (-dy > win) return { bad: true, reason: 'backward', years: -dy };
        return { bad: false, reason: '', years: dy };
    } catch (e) { return { bad: false, reason: '', years: 0 }; }
}

/** 保留月日、只把年份换成 y（负年份安全；非法/越界返回 ''） */
function clockReplaceYear(dateStr, y) {
    try {
        const p = clockDateParts(dateStr);
        if (!p || !clockYearInRange(Number(y))) return '';
        return clockDateStr(Number(y), p.m, p.d);
    } catch (e) { return ''; }
}

// ============================================================
// core/model/bigdate.js —— **大年份日期与年龄**（v3.50.26，`docs/D22` §4.25 W25 `数-32`）
//
// 用户要求（原话）：「角色出生年月和年龄需支持更大的年份，如 -9999-01-01，对应公元前9999年。
//   其次还有一些玄幻故事线，本身年月是百万计的，如果卡死也是问题。
//   1. 出生年月的结构必然是"正负年份-月份-月份"的结构，且年份不应限制死范围，确保计算不溢出即可。
//   2. 年龄应支持各种大年份的计算，而且如过超过一定量级，需加入单位简化，如102万岁、300亿岁等。」
//
// 改造前（问题）：`core/model/snapshot.js#parseBirthDateParts` 与 `core/clock.js` 的日期族都把年份**卡在 4 位**
//   （`\d{1,4}` + `-9999..9999`），且校验依赖 `new Date(ms)`（Date 只到 ±273,790 年）→ 百万年 / 亿年级直接判非法：
//   出生日期算不出年龄、剧情日期存不进、玄幻长篇「卡死」。
//
// 本模块口径（三条，逐条对应上面的 1/2）：
//   ① **年份不设死范围**：只受**安全整数**约束（`BIG_YEAR_MAX`；远超百万/亿年），**解析 / 比较 / 相减全部走整数**，
//      不经 `Date` —— 因此不会溢出，也不会因 Date 上限被误判；
//   ② **结构固定**：`[正负]年份-月-日`（也接受 `年-月` / `年` 两种低精度，与既有「按年/月估算」口径一致）；
//      分隔符 `-` / `/` / `.` 等价；公元前可用**负年份**（`-9999-01-01`）或**中文/英文文本**（`公元前9999年1月1日` / `9999 BC`）；
//   ③ **年龄单位简化**：`< 1 万` 用「岁」；`≥ 1 万` 用「万岁」；`≥ 1 亿` 用「亿岁」；`≥ 1 万亿` 用「万亿岁」，
//      最多保留 1 位小数（`102万岁` / `3亿岁` / `1.5万亿岁`），并给纯数值与单位两段（界面按需取用）。
//
// 与 `core/clock.js` 的关系：clock 的「毫秒域」（`storyDateMs`，用于按天衰减）**仍受 Date 上限**（|年| ≤ 275760），
//   超出返回 `NaN` 且调用方按「无日期」降级（不崩、不误判）；**本模块的日序（`bigDayNumber`）覆盖全部 `BIG_YEAR_MAX`**，
//   需要大年跨度做差时用它。见 `docs/D45` §3。
// ============================================================

/**
 * 年份上界（**溢出护栏**，不是业务范围）：|年| ≤ 1e13。
 * 取值依据：安全整数上限 2^53-1 ≈ 9.007e15；1e13 年 × 365.2425 ≈ 3.65e15 日 —— 日序仍在安全整数内
 * （日序再乘 86400000 会溢出，故**毫秒域**另有 Date 上限，见 `storyDateMs`）。百万 / 亿年远在上界之内。
 */
export const BIG_YEAR_MAX = 1e13;
/** 年份最大位数（解析用的宽松上限，见 `BIG_YEAR_MAX`） */
export const BIG_YEAR_DIGITS = 13;

/** 年龄单位阶梯（从大到小；`min` = 该单位的起始倍数） */
export const BIG_AGE_UNITS = Object.freeze([
    { unit: '万亿岁', div: 1e12 },
    { unit: '亿岁', div: 1e8 },
    { unit: '万岁', div: 1e4 },
    { unit: '岁', div: 1 },
]);

/** 数字是否是可用的年份（整数、非 0、在护栏内） */
export function bigYearOk(y) {
    const n = Number(y);
    return Number.isInteger(n) && n !== 0 && Math.abs(n) <= BIG_YEAR_MAX;
}

/** 年份 → 规范字符串（负数带 `-`，至少 4 位；超过 4 位按实际位数，不截断） */
export function bigYearStr(y) {
    const n = Number(y);
    if (!Number.isFinite(n)) return '';
    const v = Math.trunc(n);
    const abs = String(Math.abs(v));
    const padded = abs.length < 4 ? abs.padStart(4, '0') : abs;
    return v < 0 ? ('-' + padded) : padded;
}

/** 月/日是否合法（**不依赖 Date**；只做范围检查，进位由 `bigDayNumber` 的往返校验兜住） */
function mdOk(m, d) {
    const mo = Number(m), da = Number(d);
    if (!Number.isInteger(mo) || mo < 1 || mo > 12) return false;
    if (!Number.isInteger(da) || da < 1 || da > 31) return false;
    return true;
}

/**
 * **解析出生年月 / 剧情日期**（大年份、正负年份、三种精度）。
 *
 * 支持的写法（分隔符 `-` / `/` / `.` 等价）：
 *   · `-9999-01-01` · `-0221-01-02` · `3000000-05-01` · `3000000/5/1` · `-9999.1.1`
 *   · `3000000-05`（年-月，日按 1）· `-9999`（只 year，月日按 1）
 *   · 公元前文本：`公元前9999年1月2日` / `前9999年` / `9999 BC`（由调用方先 `clockNormBcText` 归一亦可）
 *   · 允许尾部时间/后缀：`1919-11-29 14:30`（只取日期部分）
 *
 * @param {string|number} v
 * @returns {{y:number, m:number, d:number, precision:'day'|'month'|'year'}|null} 无法解析 → `null`
 */
export function bigDateParse(v) {
    try {
        let s = String(v == null ? '' : v).trim();
        if (!s) return null;
        // 公元前文本（自归一，不依赖调用方）：`公元前9999年1月2日` / `前9999年` / `9999 BC` / `9999BC`
        const bc = (() => {
            let m = s.match(/^(?:公元前|前)\s*(\d{1,13})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号]?)?)?$/);
            if (m) return { sign: -1, y: m[1], mo: m[2], d: m[3] };
            m = s.match(/^(\d{1,13})\s*(?:BC|B\.C\.)$/i);
            if (m) return { sign: -1, y: m[1], mo: undefined, d: undefined };
            return null;
        })();
        if (bc) {
            const y = bc.sign * Math.abs(Number(bc.y));
            const mo = bc.mo === undefined ? 1 : Number(bc.mo);
            const d = bc.d === undefined ? 1 : Number(bc.d);
            if (!bigYearOk(y) || !mdOk(mo, d)) return null;
            if (!bigDayNumber(y, mo, d).ok) return null;
            return { y, m: mo, d, precision: bc.d !== undefined ? 'day' : (bc.mo !== undefined ? 'month' : 'year') };
        }
        // 数值 / 结构化输入
        if (typeof v === 'object' && v) {
            const y = Number(v.y != null ? v.y : v.year), mo = Number(v.m != null ? v.m : (v.month != null ? v.month : 1)), d = Number(v.d != null ? v.d : (v.day != null ? v.day : 1));
            if (!bigYearOk(y) || !mdOk(mo, d)) return null;
            if (!bigDayNumber(y, mo, d).ok) return null;
            return { y, m: mo, d, precision: (v.precision === 'day' || v.precision === 'month' || v.precision === 'year') ? v.precision : 'day' };
        }
        // ISO 形态（允许尾部时间 / 说明；只认前导的日期部分）
        const m = s.match(/^(-?\d{1,13})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
        if (m) {
            const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
            if (!bigYearOk(y) || !mdOk(mo, d)) return null;
            if (!bigDayNumber(y, mo, d).ok) return null;
            return { y, m: mo, d, precision: 'day' };
        }
        const m2 = s.match(/^(-?\d{1,13})[-/.](\d{1,2})$/);
        if (m2) {
            const y = Number(m2[1]), mo = Number(m2[2]);
            if (!bigYearOk(y) || !mdOk(mo, 1)) return null;
            return { y, m: mo, d: 1, precision: 'month' };
        }
        const m3 = s.match(/^(-?\d{1,13})$/);
        if (m3) {
            const y = Number(m3[1]);
            if (!bigYearOk(y)) return null;
            return { y, m: 1, d: 1, precision: 'year' };
        }
        return null;
    } catch (e) { return null; }
}

/** 是否可解析（诊断用） */
export function bigDateValid(v) { return !!bigDateParse(v); }

/** 规范化为 `[-]YYYY…-MM-DD`（无法解析 → 空串） */
export function bigDateStr(v) {
    const p = bigDateParse(v);
    if (!p) return '';
    return bigYearStr(p.y) + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

/** 公历是否闰年（proleptic Gregorian；**整数运算**，负数年份同样成立） */
export function bigIsLeap(y) {
    const n = Math.trunc(Number(y));
    if (!Number.isFinite(n)) return false;
    return (n % 4 === 0 && n % 100 !== 0) || (n % 400 === 0);
}
/** 某年某月的天数 */
export function bigDaysInMonth(y, m) {
    const mo = Math.trunc(Number(m));
    if (mo === 2) return bigIsLeap(y) ? 29 : 28;
    if (mo === 4 || mo === 6 || mo === 9 || mo === 11) return 30;
    return 31;
}

/**
 * **整数日序**（Howard Hinnant 的 `days_from_civil`；无 `Date`、无浮点，任意 `BIG_YEAR_MAX` 内精确）。
 * `1970-01-01` → `0`。
 *
 * **纪年约定（v3.50.26 明确）**：对外是**历史纪年（无 0 年，`-N` = 公元前 N 年，与用户口径一致）**；
 *   日序算法内部用**天文纪年（有 0 年）**，因此负年份进出各偏移 1 年 —— 这样「公元前 1 年 12 月 31 日」
 *   到「公元 1 年 1 月 1 日」恰好 1 天，且跨纪元的排序 / 相差都单调正确。
 * @returns {{ok:boolean, days:number}} `ok=false` = 年/月/日非法或超护栏（**永不抛错**）
 */
export function bigDayNumber(y, m, d) {
    try {
        const yy = Number(y), mm = Number(m), dd = Number(d);
        if (!bigYearOk(yy) || !mdOk(mm, dd)) return { ok: false, days: 0 };
        if (dd > bigDaysInMonth(yy, mm)) return { ok: false, days: 0 };     // 2 月 30 日之类 → 非法（不借位）
        // 历史纪年 → 天文纪年（负年份 +1；-1 年 = 公元前 1 年 = 天文 0 年）
        let Y = yy < 0 ? yy + 1 : yy, M = mm;
        const D = dd;
        if (M <= 2) { Y -= 1; }
        const era = Math.floor((Y >= 0 ? Y : Y - 399) / 400);
        const yoe = Y - era * 400;                                          // [0, 399]
        const mp = (M + 9) % 12;                                            // 3月=0
        const doy = Math.floor((153 * mp + 2) / 5) + D - 1;                 // [0, 365]
        const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
        const days = era * 146097 + doe - 719468;
        if (!Number.isFinite(days) || Math.abs(days) > 8.64e15) return { ok: false, days: 0 };
        return { ok: true, days };
    } catch (e) { return { ok: false, days: 0 }; }
}

/** 日序反解 → `{y,m,d}`（诊断 / 加法用；`days` 超出安全范围 → `null`） */
export function bigDateFromDayNumber(days) {
    try {
        let z = Math.trunc(Number(days)) + 719468;
        if (!Number.isFinite(z)) return null;
        const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
        const doe = z - era * 146097;
        const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
        let y = yoe + era * 400;
        const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
        const mp = Math.floor((5 * doy + 2) / 153);
        const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
        const m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        // 天文纪年 → 历史纪年（天文 0 年 = 公元前 1 年 = 对外 -1）
        const histY = y <= 0 ? y - 1 : y;
        if (histY === 0) return null;                       // 对外不存在 0 年
        return { y: histY, m: m, d: d };
    } catch (e) { return null; }
}

/**
 * **年龄（整年数）**：出生 → 现在。纯整数，无 `Date`。
 *   · `day` 精度：按「生日是否已过」做 -1 修正；
 *   · `month` 精度：按「月份是否已过」做 -1 修正；
 *   · `year` 精度：只做年份相减（估算口径，与既有行为一致）。
 * @returns {number} 整年数（负值 = 出生在「现在」之后，调用方自行决定如何呈现）；无法解析 → `NaN`
 */
export function bigAgeYears(birth, now) {
    try {
        const b = bigDateParse(birth);
        const n = bigDateParse(now);
        if (!b || !n) return NaN;
        let age = n.y - b.y;
        // 历史纪年无 0 年：跨「公元前 → 公元后」时实际年数比年份差少 1（`-1` 到 `1` 是 1 年，不是 2 年）
        if (b.y < 0 && n.y > 0) age -= 1;
        if (b.precision === 'day') { if (n.m < b.m || (n.m === b.m && n.d < b.d)) age -= 1; }
        else if (b.precision === 'month') { if (n.m < b.m) age -= 1; }
        const out = Number(age);
        return Number.isFinite(out) ? out : NaN;
    } catch (e) { return NaN; }
}

/** 年龄 → `{ value, unit, text }`（单位简化：岁 / 万岁 / 亿岁 / 万亿岁；最多 1 位小数） */
export function bigAgeParts(years) {
    if (years === '' || years === null || years === undefined || (typeof years === 'string' && !years.trim())) {
        return { value: NaN, unit: '', text: '' };            // 空值 ≠ 0 岁（不允许「空 → 0岁」的假事实）
    }
    const n = Number(years);
    if (!Number.isFinite(n)) return { value: NaN, unit: '', text: '' };
    const abs = Math.abs(n);
    const pick = BIG_AGE_UNITS.filter((u) => abs >= u.div)[0] || BIG_AGE_UNITS[BIG_AGE_UNITS.length - 1];
    const raw = n / pick.div;
    const rounded = Math.round(raw * 10) / 10;
    const value = (abs >= 1e4) ? rounded : Math.round(raw);          // 万以下不带小数（年龄是整年）
    const text = String(value) + pick.unit;
    return { value: value, unit: pick.unit, text: text };
}

/** 年龄 → 人读文本（`102万岁` / `3亿岁` / `42岁`；无法计算 → 空串） */
export function bigAgeText(years) {
    const p = bigAgeParts(years);
    return p.text || '';
}

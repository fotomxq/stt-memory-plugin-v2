// ============================================================
// core/model/snapshot.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js（角色档案 / 年龄 / 出生日期族））
// 移植口径同 core/model/scalars.js：算法/字段名/字段顺序不变；仅 ESM 化 + 注入视图（cfg/state/getStoryNow）。
// 一致性由 tests/unit/model-golden*.test.js 的黄金样本强制校验。
// ============================================================
import { clamp, hashText, normText, normalizeList, snapNameKey } from '../util.js';
import { cfg, state, getStoryNow } from './runtime.js';
import { dimCap, atomTitle, mergeTags, makeExtra, SNAP_GROUP_MAP, splitListText, clockDateTrim } from './scalars.js';
import { clockDateParts, clockDateStr, clockNormBcText, clockYearInRange, storyDateMsFromStr } from '../clock.js';
import { atomIsHidden } from '../merge.js';
import { atomLatestDated } from '../recall.js';

function stampNowForState() {
    const d = getStoryNow();
    const t = state.state?.time || '';
    if (d) return { date: clockDateTrim(d), time: t };
    const n = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return { date: `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`, time: `${pad(n.getHours())}:${pad(n.getMinutes())}` };
}
// ==================== v1.161：角色档案「剧情时间」采样 ====================
// 用户要求：角色增加记录「最后一次更新时间」与「最后一次见面时间」，两者以**剧情时间**为基准取样。
//   · 剧情时间 = state.state.date（剧情日期）+ state.state.time（剧情时刻，可为「傍晚」这类文本）；
//   · **无剧情日期 → 不采样**（不写现实时间 —— 该字段语义是剧情时间线上的时刻，混入墙钟会误导）；
//   · 单调：采样日期早于已记录日期 → 不回写（正文时间线回退/抽错时不打乱既有记录）；
//   · 同一天内允许推进时刻（同日更晚的观测覆盖该日时刻）。

function storyTimeSample() {
    try {
        const raw = String(getStoryNow() || '').trim();
        const p = clockDateParts(clockDateTrim(raw));   // v1.193：负年份（公元前）
        if (!p) return { date: '', time: '' };
        const date = clockDateStr(p.y, p.m, p.d);
        const time = String((state.state && state.state.time) || '').trim().slice(0, 30);
        return { date, time };
    } catch (e) { return { date: '', time: '' }; }
}
// 给单条档案打「最后更新 / 最后见面」时刻；kind: 'update' | 'seen'。返回是否真的写入了新值

function stampSnapshotTime(s, kind) {
    try {
        if (!s || typeof s !== 'object') return false;
        const now = storyTimeSample();
        if (!now.date) return false;
        const seen = kind === 'seen';
        const dk = seen ? 'lastSeenDate' : 'lastUpdateDate';
        const tk = seen ? 'lastSeenTime' : 'lastUpdateTime';
        const od = String(s[dk] || ''), ot = String(s[tk] || '');
        if (od && now.date < od) return false;      // 剧情时间回退 → 保持既有记录
        let changed = false;
        if (od !== now.date) {
            s[dk] = now.date;
            if (String(s[tk] || '') !== now.time) s[tk] = now.time;
            changed = true;
        } else if (now.time && now.time !== ot) {
            s[tk] = now.time;
            changed = true;
        }
        return changed;
    } catch (e) { return false; }
}
// 档案「实质内容」签名（不含 id/uses/楼层/h/时间采样字段）—— 判断一次合并是否真的改了档案

function snapshotBodySig(s) {
    try {
        if (!s || typeof s !== 'object') return '';
        const pick = {
            name: s.name, identity: s.identity, appearance: s.appearance, personality: s.personality,
            background: s.background, relationships: s.relationships,
            social: s.social, future: s.future, tags: s.tags,
        };
        return hashText(JSON.stringify(pick));
    } catch (e) { return ''; }
}
// 按姓名找档案（精确 → 归一化键 → 管用名前缀/后缀包含；≥2 字才算包含命中，避免单字误伤）

function snapFindByName(name) {
    try {
        const k = snapNameKey(name);
        if (!k) return null;
        const arr = state.snapshots || [];
        const exact = arr.find(s => s && snapNameKey(s.name) === k);
        if (exact) return exact;
        if (k.length < 2) return null;
        return arr.find(s => {
            const sk = snapNameKey(s && s.name);
            if (!sk || sk.length < 2) return false;
            return sk.startsWith(k) || k.startsWith(sk);
        }) || null;
    } catch (e) { return null; }
}
// 在场名单 → 逐条打「最后见面」时刻；返回是否有写入

function stampSnapshotsSeen(names) {
    let changed = false;
    try {
        for (const nm of (Array.isArray(names) ? names : [])) {
            const s = snapFindByName(nm);
            if (s && stampSnapshotTime(s, 'seen')) changed = true;
        }
    } catch (e) { }
    return changed;
}
// v1.164：出生日期合理性 —— 剧情日期之后出生的日期一律视为**未来时间**（修复管道据此拒写），
//   唯一例外：正文/档案明确该角色来自未来（未来人、穿越、时空、来自 2XXX 年等）—— 此时出生日期本就晚于当前剧情时间。

function ageAnchorDate() {
    try {
        const direct = clockDateTrim(getStoryNow());
        if (/^\d{4}/.test(direct)) return direct;
    } catch (e) { }
    try {
        if (typeof storyAnchorDate === 'function') {
            const a = clockDateTrim(storyAnchorDate());
            if (/^-?\d{1,4}/.test(a)) return a;
        }
    } catch (e) { }
    return '';
}

function snapshotStoryAnchor() { return ageAnchorDate(); }
// 是否「未来出生」：出生日期晚于剧情日期（无剧情日期时不判定 → 不拦）
//   v1.176：支持部分精度（年 / 年-月），按「当年/当月 1 日」保守比较

function birthDateInFuture(dateStr) {
    try {
        const b = parseBirthDateParts(dateStr);
        if (!b) return false;
        const a = parseBirthDateParts(snapshotStoryAnchor());
        if (!a) return false;
        const key = (p) => p.y * 10000 + p.m * 100 + p.d;
        return key(b) > key(a);
    } catch (e) { return false; }
}
// 是否「未来来客 / 穿越者」（允许未来出生日期的唯一例外）

function snapshotFutureOrigin(s) {
    try {
        if (!s || typeof s !== 'object') return false;
        const i = s.identity || {}, b = s.background || {};
        const blob = [s.name, i.title, i.occupation, i.species, i.family, i.birthNote, b.origin, b.history,
            (Array.isArray(s.tags) ? s.tags.join(' ') : '')].join(' ');
        return SNAP_FUTURE_ORIGIN_RE.test(blob);
    } catch (e) { return false; }
}
// ==================== v1.172：出生日期「倒挂 / 异常」判定（角色修复的优先处置依据） ====================
// 用户要求：出生年月异常（倒挂日期）必须**优先**进入角色修复的抽取名单。
//   口径：零 AI、幂等、只看数据自身能否自洽（不猜剧情）——返回 '' = 正常，否则返回异常码：
//     future       出生日期晚于当前剧情日期（且该角色不是未来来客 / 穿越者）—— v1.164 口径
//     after-record 档案记录的「最后见面 / 最后更新」日期早于出生日期（人还没出生就出场了）—— 典型倒挂
//     overage      按剧情锚点算出的年龄 > 120 岁（与剧情时间线明显冲突）
//     bad-format   出生日期字段非空但不是 YYYY-MM-DD（脏数据，无法参与任何日期比较）

function snapshotBirthAnomaly(s) {
    try {
        if (!s || typeof s !== 'object') return '';
        const raw = String((s.identity && s.identity.birthDate) || '').trim();
        if (!raw) return '';                                  // 空值交给「缺失清单 + 出生日期兜底」处理，不算倒挂
        // v1.176：「无剧情日期时的现实年份占位」（birthSource='fallback'）是**占位符而非数据** ——
        //   它会被出生日期兜底（有锚点后）自动按剧情日期重推，因此不计入异常（否则每个占位角色都会污染优先档）。
        if (String((s.identity && s.identity.birthSource) || '') === 'fallback') return '';
        const parts = parseBirthDateParts(raw);
        // v1.176：只有年 / 年-月的出生日期**是合法数据**（低精度，年龄按估算给出），不再判为格式非法
        if (!parts) return 'bad-format';
        const bd = raw;
        // 未来来客 / 穿越者豁免（此类档案的生日本就在剧情时间之后、记录日期之前）——
        //   依据只看**档案内容**（身份 / 背景 / 备注 / 标签），**不看姓名**（避免角色名叫「未来」就被误豁免）
        const i0 = s.identity || {}, b0 = s.background || {};
        const originBlob = [i0.title, i0.occupation, i0.species, i0.family, i0.birthNote, b0.origin, b0.history,
            (Array.isArray(s.tags) ? s.tags.join(' ') : '')].join(' ');
        const traveler = SNAP_FUTURE_ORIGIN_RE.test(originBlob);
        if (!traveler) {
            if (birthDateInFuture(bd)) return 'future';
            if (parts.precision === 'day') {
                const bdIso = clockDateStr(parts.y, parts.m, parts.d);   // v1.193：负年份同样规范（-0221-01-02）
                for (const d of [s.lastSeenDate, s.lastUpdateDate]) {
                    const t = String(d || '').trim();
                    if (/^-?\d{1,4}-\d{2}-\d{2}$/.test(t) && storyDateMsFromStr(t) < storyDateMsFromStr(bdIso)) return 'after-record';   // v1.193：改用剧情日期数值比较（负年份下字符串比较会判错）
                }
            }
        }
        const ageTxt = calcAge(bd, ageAnchorDate());
        const age = ageTxt === '' ? NaN : Number(ageTxt);
        // v1.193：**公元前出生（年份为负）不判「超过 120 岁」** —— 跨公元前后的长寿角色（如公元 1919 年的剧情里
        //   出生于公元前 221 年）是用户明确要求支持的写法，年龄上千岁属预期；倒挂（after-record / future）仍照常判定。
        if (Number.isFinite(age) && age > 120 && !(parts.y < 0)) return 'overage';
        return '';
    } catch (e) { return ''; }
}

function snapshotBirthAnomalyLabel(code) { try { return SNAP_BIRTH_ANOMALY_LABEL[code] || ''; } catch (e) { return ''; } }
// 短文案（界面角标 tooltip 用，需整体 ≤30 字：v1163 C10 抽查口径）

function snapshotBirthAnomalyShort(code) { try { return SNAP_BIRTH_ANOMALY_SHORT[code] || ''; } catch (e) { return ''; } }
// v1.164：「已去世」开关的三态归一 —— true=已去世 / false=明确在世 / undefined=未提及（**不写盘，保持旧值**）

function snapshotFlag(v) {
    try {
        if (v === undefined || v === null || v === '') return undefined;
        if (v === true || v === 1) return true;
        if (v === false || v === 0) return false;
        const s = String(v).trim().toLowerCase();
        if (/^(true|yes|y|1|是|已去世|死亡|已死亡|已故|去世|已死)$/.test(s)) return true;
        if (/^(false|no|n|0|否|在世|健在|活着|未去世|未死|生)$/.test(s)) return false;
        return undefined;
    } catch (e) { return undefined; }
}
// v1.176：出生日期**精度归一** —— 只要"存在出生日期"就应当能算出年龄，因此支持三种精度：
//   `YYYY-MM-DD`（day）→ `YYYY-MM`（month，按当月 1 日估算）→ `YYYY`（year，按 1 月 1 日估算）；
//   `/`、`.` 分隔符与 `-` 等价（历史数据/AI 输出常见混用）。
//   返回 { y, m, d, precision }；无法解析（含「约1890年」这类脏值）返回 null。

function parseBirthDateParts(v) {
    try {
        const s = String(v == null ? '' : v).trim();
        if (!s) return null;
        // v1.193：出生日期兼容**公元前**（年份为负）—— 支持文本写法（「公元前221年1月2日」「公元前九年」
        //   「221 BC」）与 ISO 负年份写法（`-0221-01-02` / `-221-1-2`）；先归一为「前-<数字>年…」再解析。
        const norm = (typeof clockNormBcText === 'function') ? clockNormBcText(s) : s;
        const bcM = norm.match(/^前\s*-?\s*(\d{1,4})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号]?)?)?\s*$/);
        if (bcM) {
            const y = -Math.abs(Number(bcM[1]));
            const mo = bcM[2] === undefined ? 1 : Number(bcM[2]);
            const d = bcM[3] === undefined ? 1 : Number(bcM[3]);
            if (!Number.isFinite(y) || y === 0 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
            return { y, m: mo, d, precision: bcM[3] !== undefined ? 'day' : (bcM[2] !== undefined ? 'month' : 'year') };
        }
        let m = norm.match(/^(-?\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (m) {
            const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
            if (!Number.isFinite(y) || y === 0 || y < -9999 || y > 9999) return null;
            if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
            return { y, m: mo, d, precision: 'day' };
        }
        m = norm.match(/^(-?\d{1,4})[-/.](\d{1,2})$/);
        if (m) {
            const y = Number(m[1]), mo = Number(m[2]);
            if (!Number.isFinite(y) || y === 0 || y < -9999 || y > 9999) return null;
            if (mo < 1 || mo > 12) return null;
            return { y, m: mo, d: 1, precision: 'month' };
        }
        m = norm.match(/^(-?\d{1,4})$/);
        if (m) {
            const y = Number(m[1]);
            if (!Number.isFinite(y) || y === 0 || y < -9999 || y > 9999) return null;
            return { y, m: 1, d: 1, precision: 'year' };
        }
        return null;
    } catch (e) { return null; }
}
// 出生日期精度（'day' / 'month' / 'year' / '' = 不可解析）—— 用于界面标注「按出生年（月）估算」

function birthDatePrecision(v) { const p = parseBirthDateParts(v); return p ? p.precision : ''; }
// v1.171：年龄 = 出生日期 + **剧情时间锚点**（ageAnchorDate）。**不再退回现实日期** ——
//   此前无剧情日期时会拿现实年份做减法，1919 年剧情里 1890 年出生的角色被算成 136 岁，
//   并把该错误值落盘到 identity.age（污染世界书 / 导出 / AI 视角）。现在无锚点 → 返回空串
//   （年龄「待算」，由上层按口径决定是否显示），绝不臆造。
// v1.176：出生日期支持**部分精度**（年 / 年-月 / 年-月-日）—— 用户要求「只要发现存在出生日期则自动更新年龄」，
//   只有年或年-月时按「当年/当月 1 日」估算（估算口径在界面注明「按出生年（月）估算」）。

function calcAge(birthDate, storyNow) {
    const b = parseBirthDateParts(birthDate);
    if (!b) return '';
    // 锚点容错：允许「1919-11-29 14:30」这类带时间/后缀的写法（取前导日期部分）
    let n = parseBirthDateParts(storyNow);
    if (!n) {
        const m = String(storyNow == null ? '' : storyNow).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (m) n = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), precision: 'day' };
        else {
            const m2 = String(storyNow == null ? '' : storyNow).match(/^(\d{4})[-/.](\d{1,2})/);
            if (m2) n = { y: Number(m2[1]), m: Number(m2[2]), d: 1, precision: 'month' };
            else {
                const m3 = String(storyNow == null ? '' : storyNow).match(/^(\d{4})/);
                if (m3) n = { y: Number(m3[1]), m: 1, d: 1, precision: 'year' };
            }
        }
    }
    if (!n) return '';
    let age = n.y - b.y;
    if (b.precision === 'day') { if (n.m < b.m || (n.m === b.m && n.d < b.d)) age--; }
    else if (b.precision === 'month') { if (n.m < b.m) age--; }
    // precision === 'year'：只有出生年 → 不做月日修正（估算）
    return age >= 0 ? String(age) : '';
}
// ==================== v1.162：角色档案 schema 收敛 ====================
// 用户要求（原文）：角色信息里「情绪、当前目标、担忧、城市、区域、建筑、室内」等**高动态且没意义**的字段去掉；
//   「年龄备注」改为「年龄」并由出生年月 + 当前剧情日期**自动计算**（不人工填写）；
//   身高 / 发型 / 瞳色等外貌特征**聚合为一个字段**。
// 落地：normalizeSnapshot 不再产出 mind / location 两组；appearance 由分组对象改为**单字段文本**；
//   identity.age 只由 calcAge(birthDate, 剧情日期) 得出；旧数据由 migrateState 一次性收敛（见模块 05）。

function snapshotAppearanceText(e) {
    try {
        if (!e || typeof e !== 'object') return '';
        const parts = [];
        const push = (v) => { const s = String(v == null ? '' : v).trim(); if (s && !parts.includes(s)) parts.push(s); };
        const a = e.appearance;
        let folded = '';
        if (typeof a === 'string') { folded = a.trim(); push(folded); }
        else if (a && typeof a === 'object' && !Array.isArray(a)) {
            for (const [k, label] of SNAP_APPEARANCE_LABELS) {
                const v = String(a[k] == null ? '' : a[k]).trim();
                if (v) push(`${label}${v}`);
            }
        }
        for (const [k, label] of SNAP_APPEARANCE_LABELS) {
            const v = String(e[k] == null ? '' : e[k]).trim();      // 历史扁平键
            if (v && !parts.some(p => p.includes(v))) push(`${label}${v}`);
        }
        return normText(parts.join('；').replace(/\s+/g, ' ').trim(), SNAP_APPEARANCE_LIMIT);
    } catch (err) { return ''; }
}
// v1.162：年龄是**派生字段**（出生日期 + 当前剧情日期）—— 读取时实时计算，缺失出生日期才回退存储值。
//   这样即使剧情日期推进而档案本身没有更新，展示/注入里的年龄也不会过期。
//   v1.171：锚点统一为 ageAnchorDate()（剧情日期 → 最近记录的剧情日期），并给出**来源说明**，
//   让界面能直接回答「这个年龄是按什么算的」（story = 按剧情日期 / timeline = 按最近记录日期 /
//   stored = 无剧情锚点、沿用存档值 / none = 算不出来）。
// v1.205：**已去世则锁定年龄** —— 用户要求「角色中，已去世则锁定年龄。自动计算年龄跳过已去世的角色」。
//   口径：`identity.deceased === true` 即视为「年龄已锁定」——
//     ① 锁定值 = 落盘的 `identity.age`（在**标记去世那一刻**由写入路径结算并落盘）；
//     ② 锁定后**不再随剧情日期推进重算**（`syncSnapshotAge` / `refreshAllSnapshotAges` 都跳过）；
//     ③ 锁定但落盘值为空 / 不合理时，补记一次（按当时锚点算出的值），此后照旧冻结；
//     ④ 取消「已去世」标记后自动恢复为被动更新（无需手工清任何字段）。

function snapshotAgeIsLocked(s) {
    try {
        const id = (s && s.identity) || {};
        return snapshotFlag(id.deceased) === true;
    } catch (e) { return false; }
}

function snapshotAgeInfo(s) {
    const out = { age: '', birth: '', anchor: '', basis: 'none', precision: '', locked: false };
    try {
        if (!s || typeof s !== 'object') return out;
        const id = s.identity || {};
        out.birth = String(id.birthDate || '').trim();
        out.precision = birthDatePrecision(out.birth);     // v1.176：day / month / year（'' = 不可解析）
        // v1.205：已去世 → 优先用**锁定的落盘年龄**，绝不按当前剧情日期重算
        out.locked = snapshotAgeIsLocked(s);
        if (out.locked) {
            const storedL = String(id.age == null ? '' : id.age).trim();
            const numL = Number(storedL);
            if (storedL && Number.isFinite(numL) && numL >= 0 && numL <= 120) {
                out.age = storedL; out.basis = 'locked';
                return out;
            }
            // 锁定但没落盘值（历史数据 / 刚标记）→ 只读地补算一次，写入由 syncSnapshotAge 负责
            const anchorL = ageAnchorDate();
            out.anchor = anchorL;
            const derivedL = calcAge(out.birth, anchorL);
            if (derivedL) { out.age = derivedL; out.basis = 'locked-capture'; }
            return out;
        }
        const anchor = ageAnchorDate();
        out.anchor = anchor;
        const derived = calcAge(out.birth, anchor);
        if (derived) {
            out.age = derived;
            let now = '';
            try { now = clockDateTrim(getStoryNow()); } catch (e) { }
            out.basis = (anchor && now && clockDateTrim(anchor) === clockDateTrim(now)) ? 'story' : 'timeline';
            return out;
        }
        // 无剧情锚点：只在存档值**合理**（0–120）时沿用，避免把历史上被现实年份污染的 1xx 岁带出来
        const stored = String(id.age || '').trim();
        const num = Number(stored);
        if (stored && Number.isFinite(num) && num >= 0 && num <= 120) { out.age = stored; out.basis = 'stored'; }
        return out;
    } catch (e) { return out; }
}

function snapshotAge(s) { return snapshotAgeInfo(s).age; }
// 年龄来源文案（列表行 / 编辑器只读行共用）：如「按剧情日期 1919-11-29」/「按最近记录日期 1919-10-01」/「存档值 · 缺剧情日期」
//   v1.176：出生日期只有年 / 年-月时追加「按出生年（月）估算」，让「估算值」与「精确值」在界面上一眼可辨。
//   v1.205：已去世 → 「已去世 · 年龄锁定（死亡时 X 岁）」，不再显示「按剧情日期」（它与当前剧情日期无关了）。

function snapshotAgeBasisText(s) {
    try {
        const info = snapshotAgeInfo(s);
        if (!info.age) return info.locked ? '已去世 · 年龄锁定（缺死亡时年龄）' : '';
        const est = info.precision === 'year' ? ' · 按出生年估算' : (info.precision === 'month' ? ' · 按出生年月估算' : '');
        if (info.basis === 'locked') return `已去世 · 年龄锁定（${info.age} 岁）${est}`;
        if (info.basis === 'locked-capture') return `已去世 · 补记死亡时年龄 ${info.age}${est}`;
        if (info.basis === 'story') return `按剧情日期 ${info.anchor}${est}`;
        if (info.basis === 'timeline') return `按最近记录日期 ${info.anchor}${est}`;
        return `存档值 · 缺剧情日期${est}`;
    } catch (e) { return ''; }
}
// v1.166：角色档案「社交 + 未来」注入合并一行（**只改注入表达，不动数据、不改界面**）：
//   `社交：与主角 信任 · 态度 亲近 · 未来：待办 还债/赴约 · 承诺 保护她`
//   目的：省 token（原先分散表达），并让「与主角关系 / 待办 / 承诺」在注入体里同处一行、语义连贯。

function snapshotSocialFutureLine(s) {
    try {
        const soc = [];
        const rel = String((s && s.social && s.social.relationToUser) || '').trim();
        const att = String((s && s.social && s.social.attitudeToUser) || '').trim();
        if (rel) soc.push(`与主角 ${rel}`);
        if (att) soc.push(`态度 ${att}`);
        const fut = [];
        const todos = Array.isArray(s && s.future && s.future.todos) ? s.future.todos.filter(Boolean) : [];
        const commits = Array.isArray(s && s.future && s.future.commitments) ? s.future.commitments.filter(Boolean) : [];
        if (todos.length) fut.push(`待办 ${todos.slice(0, 3).join('/')}`);
        if (commits.length) fut.push(`承诺 ${commits.slice(0, 3).join('/')}`);
        const parts = [];
        if (soc.length) parts.push(`社交：${soc.join(' · ')}`);
        if (fut.length) parts.push(`未来：${fut.join(' · ')}`);
        return parts.join(' · ');
    } catch (e) { return ''; }
}
// ==================== v1.176：年龄被动更新（固定规则，零 AI） ====================
// 用户要求：「角色中还是存在年龄计算错误，这部分应该是**被动更新的固定规则**，只要发现存在出生日期则自动更新年龄」；
//   触发时机：**每次更新角色**（AI 摘要合并 / 编辑器保存 / 导入 / 跨端合并）+ **修复角色**（AI 之前的全局机械阶段）。
// 口径（唯一入口，避免各写入路径各算各的）：
//   ① 出生日期可解析（年 / 年-月 / 年-月-日）+ 有剧情锚点 → `identity.age` = `calcAge(...)`（**不采信**外部传入的年龄）；
//   ② 算不出（无出生日期 / 无剧情锚点 / 出生晚于剧情）→ 保留**合理**存档值（0–120），不合理（如被现实年份算出的 1xx）清空；
//   ③ 幂等：值已正确时不产生变化（不写盘、不刷新时间戳）。

function syncSnapshotAge(s) {
    const out = { changed: false, age: '', cleared: false, reason: '', locked: false };
    try {
        if (!s || typeof s !== 'object') return out;
        if (!s.identity || typeof s.identity !== 'object') s.identity = {};
        const birth = String(s.identity.birthDate || '').trim();
        const stored = String(s.identity.age == null ? '' : s.identity.age).trim();
        // v1.205：已去世 → **年龄锁定**：不按当前剧情日期重算；只在落盘值为空 / 不合理时补记一次
        if (snapshotAgeIsLocked(s)) {
            out.locked = true;
            const numL = Number(stored);
            if (stored && Number.isFinite(numL) && numL >= 0 && numL <= 120) { out.age = stored; out.reason = 'locked'; return out; }
            const anchorL = ageAnchorDate();
            const derivedL = calcAge(birth, anchorL);
            if (derivedL) {
                s.identity.age = derivedL;
                out.age = derivedL; out.changed = true; out.reason = 'locked-capture';
                return out;
            }
            if (stored) { s.identity.age = ''; out.changed = true; out.cleared = true; out.reason = 'locked-invalid-stored'; return out; }
            out.reason = 'locked-no-anchor';
            return out;
        }
        const anchor = ageAnchorDate();
        const derived = calcAge(birth, anchor);
        if (derived) {
            out.age = derived;
            if (stored !== derived) { s.identity.age = derived; out.changed = true; out.reason = 'derived'; }
            else out.reason = 'ok';
            return out;
        }
        const num = Number(stored);
        if (stored && !(Number.isFinite(num) && num >= 0 && num <= 120)) {
            s.identity.age = '';
            out.changed = true; out.cleared = true; out.reason = 'invalid-stored';
            return out;
        }
        out.age = stored;
        out.reason = !birth ? 'no-birth' : (anchor ? 'uncomputable' : 'no-anchor');
        return out;
    } catch (e) { return out; }
}
// 全局年龄刷新（零 AI）：对**全部**角色档案套用上面的固定规则；返回统计与逐条明细。
//   调用点：AI 摘要合并后（每次更新角色）、修复角色的 AI 前机械阶段、载入自愈、跨端合并。
//   v1.205：**已去世角色跳过重算**（年龄锁定）—— 单独计入 st.locked，只在他们没有落盘年龄时才补记一次。

function refreshAllSnapshotAges() {
    const st = { total: 0, fixed: 0, cleared: 0, unchanged: 0, pending: 0, locked: 0, items: [] };
    try {
        for (const s of ((state && state.snapshots) || [])) {
            if (!s || typeof s !== 'object') continue;
            st.total++;
            const r = syncSnapshotAge(s);
            if (r.locked) {
                st.locked++;
                if (r.changed) st.items.push({ name: String(s.name || ''), age: r.age, reason: r.reason });
                continue;
            }
            if (r.cleared) { st.cleared++; st.items.push({ name: String(s.name || ''), age: '', reason: r.reason }); }
            else if (r.changed) { st.fixed++; st.items.push({ name: String(s.name || ''), age: r.age, reason: r.reason }); }
            // pending = 当前算不出年龄（无出生日期 / 无剧情锚点 / 出生晚于剧情）—— 供诊断使用
            else if (r.reason === 'no-birth' || r.reason === 'no-anchor' || r.reason === 'uncomputable') st.pending++;
            else st.unchanged++;
        }
    } catch (e) { }
    return st;
}
// 单个角色的「派生年龄 + 存档年龄」是否一致（诊断用，不写数据）
//   v1.205：已去世 = 年龄锁定（本来就不该重算）→ 永远不算「过期」

function snapshotAgeStale(s) {
    try {
        if (snapshotAgeIsLocked(s)) return false;
        const info = snapshotAgeInfo(s);
        if (!info.age) return false;
        const stored = String((s && s.identity && s.identity.age) || '').trim();
        return stored !== String(info.age);
    } catch (e) { return false; }
}
// v1.162 迁移（幂等）：删除 mind / location；外貌对象 → 聚合文本；年龄备注并入「年龄」并按剧情日期重算。
//   旧「年龄备注」里的年龄线索（如「约 30 岁」）在缺出生日期时立刻折算为出生日期（v1.152 口径），避免线索丢失。

function migrateSnapshotV1162(s) {
    let changed = false;
    try {
        if (!s || typeof s !== 'object') return false;
        if (s.mind !== undefined) { delete s.mind; changed = true; }
        if (s.location !== undefined) { delete s.location; changed = true; }
        for (const k of ['emotion', 'currentGoal', 'concern']) { if (s[k] !== undefined) { delete s[k]; changed = true; } }
        const ap = snapshotAppearanceText(s);
        if (typeof s.appearance !== 'string' || s.appearance !== ap) { s.appearance = ap; changed = true; }
        if (s.identity && typeof s.identity === 'object') {
            const note = String(s.identity.ageNote || '').trim();
            if (s.identity.ageNote !== undefined) { delete s.identity.ageNote; changed = true; }
            if (note && !String(s.identity.birthDate || '').trim()) {
                try { const r = ensureSnapshotBirthDate(s, { ageHint: note }); if (r && r.changed) changed = true; } catch (e2) { }
            }
            // v1.171：年龄自愈 —— 派生值优先；无剧情锚点时清掉**不合理**的历史值
            //   （历史版本会在缺剧情日期时用现实年份算出 1xx 岁并落盘，读一次即修正/清空）
            // v1.176：统一走 syncSnapshotAge()（被动更新的固定规则唯一入口）
            try { if (syncSnapshotAge(s).changed) changed = true; } catch (e3) { }
        } else if (s.identity === undefined) {
            s.identity = {};
            s.identity.age = '';
            changed = true;
        }
    } catch (e) { }
    return changed;
}
// 修复：SNAP_GROUP_MAP 必须在 loadState/migrateState 调用前初始化（TDZ）

function foldSnapshotFlat(e) {
    if (!e || typeof e !== 'object') return e;
    const out = { ...e };
    const listKeys = new Set(['traits', 'quirks', 'values', 'todos', 'commitments']);
    for (const [k, g] of Object.entries(SNAP_GROUP_MAP)) {
        if (out[k] !== undefined) {
            out[g] = out[g] || {};
            if (out[g][k] === undefined) out[g][k] = listKeys.has(k) ? splitListText(out[k]) : out[k];
        }
    }
    return out;
}

function normalizeSnapshot(e0) {
    const e = foldSnapshotFlat(e0);
    const name = normText(e?.name, 40);
    if (!name) return null;
    const fs = Number(e?.floorStart);
    const fe = Number(e?.floorEnd);
    const src = e?.profile || e?.identity || {};
    const birthDate = normText(e?.birthDate || src?.birthDate || src?.birth_date, 10);
    // v1.162：年龄**不是可填字段** —— 只由「出生日期 + 剧情时间锚点」自动计算（缺出生日期/缺锚点则为空；
    //   v1.171 起锚点 = 剧情日期 → 最近记录剧情日期，**不再用现实年份**，也不再落盘被污染的值）
    const age = calcAge(birthDate, ageAnchorDate());
    // v1.164：「已去世」开关 —— 三态（true/false/undefined）；未提及时不写字段（增量合并保持旧值）
    const deceasedRaw = (e?.identity && e.identity.deceased !== undefined) ? e.identity.deceased
        : ((e?.profile && e.profile.deceased !== undefined) ? e.profile.deceased : e?.deceased);
    const deceased = snapshotFlag(deceasedRaw);
    const identity = {
        gender: normText(src?.gender || e?.gender || '', 10),
        birthDate, age,
        species: normText(src?.species || '', 20),
        occupation: normText(src?.occupation || src?.title || '', 40),
        title: normText(src?.title || '', 40),
        family: normText(src?.family || '', 60),
    };
    if (deceased !== undefined) identity.deceased = deceased;
    return {
        id: String(e?.id || `snapshot_${hashText(name.toLowerCase())}`),
        name,
        identity,
        // v1.162：外貌特征**聚合为单字段文本**（身高/体型/发色发型/瞳色/肤色/显著特征 → 一句话）
        appearance: snapshotAppearanceText(e),
        personality: {
            traits: normalizeList(e?.personality?.traits || src?.traits),
            quirks: normalizeList(e?.personality?.quirks || src?.quirks),
            values: normalizeList(e?.personality?.values || src?.values),
            speechStyle: normText(e?.personality?.speechStyle || src?.speechStyle || '', 60),
        },
        background: {
            origin: normText(e?.background?.origin || src?.origin || '', 60),
            history: normText(e?.background?.history || src?.history || '', 200),
        },
        relationships: Array.isArray(e?.relationships) ? e.relationships.filter(r => r && r.name).map(r => ({ name: normText(r.name, 40), relation: normText(r.relation, 30), attitude: normText(r.attitude, 60) })).slice(0, 30) : [],
        // v1.162：删除「内心（情绪 / 当前目标 / 担忧）」与「位置（城市 / 区域 / 建筑 / 室内）」两组高动态字段
        social: { relationToUser: normText(e?.social?.relationToUser, 60), attitudeToUser: normText(e?.social?.attitudeToUser, 60) },
        future: { todos: normalizeList(e?.future?.todos), commitments: normalizeList(e?.future?.commitments) },
        // 角色（档案/快照）条目承载 标签组（列表统计上一行展示 + 编辑器/AI 可写）
        tags: mergeTags(Array.isArray(e?.tags) ? e?.tags : splitListText(e?.tags), e?.keywords),
        keywords: [],
        floorStart: Number.isInteger(fs) && fs >= 0 ? fs : 0,
        floorEnd: Number.isInteger(fe) && fe >= 0 ? fe : 0,
        uses: Number(e?.uses) || 0,
        // v1.161：以**剧情时间**为基准采样的两个时刻（角色档案专属）——
        //   lastUpdate*：档案内容被新增/更新时的剧情时间；lastSeen*：角色最近一次在场的剧情时间。
        //   无剧情日期时不采样（不写现实时间，避免把墙钟混进剧情时间线）；详见 stampSnapshotTime()。
        lastUpdateDate: normText(e?.lastUpdateDate, 10),
        lastUpdateTime: normText(e?.lastUpdateTime, 30),
        lastSeenDate: normText(e?.lastSeenDate, 10),
        lastSeenTime: normText(e?.lastSeenTime, 30),
        // 原子层：标准化字段 + 可扩展插槽
        category: 'snapshots',
        title: name,
        content: normText(e?.background?.history || '', 300),
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ gender: src?.gender, occupation: src?.occupation, species: src?.species, traits: src?.traits }),        };
}
// ==================== v1.181：货币大类（归属 + 币种 + 额度 + 收支流水） ====================
// 用户要求：① 记当前主角持有的货币（多主角支持；其他角色必须明确指定）；② 支持任意币种（贝壳 / 银元 / 美元…）；
//   ③ 额度是**数字**，显示时按 万 / 亿 / 兆 / 京 **动态适配**；④ 归属默认主角，明确指定则记其他角色；
//   ⑤ 提示词两条（通用 + 动态）；⑥ 条目内支持**收支记录**；⑦ 记录/注入有开关（默认开）。
// 显示：`formatMoney(n)` —— 千分位 + 中文数量级（万 1e4 / 亿 1e8 / 兆 1e12 / 京 1e16；≥1e20 用「垓」），
//   保留 2 位小数并去尾零；负数（净支出/负债）保留符号；非数字 → ''。

export { stampNowForState, storyTimeSample, stampSnapshotTime, snapshotBodySig, snapFindByName, stampSnapshotsSeen, ageAnchorDate, snapshotStoryAnchor, birthDateInFuture, snapshotFutureOrigin, snapshotBirthAnomaly, snapshotBirthAnomalyLabel, snapshotBirthAnomalyShort, snapshotFlag, parseBirthDateParts, birthDatePrecision, calcAge, snapshotAppearanceText, guessAgeFromCues, snapshotAgeIsLocked, snapshotAgeInfo, snapshotAge, snapshotAgeBasisText, snapshotSocialFutureLine, syncSnapshotAge, refreshAllSnapshotAges, snapshotAgeStale, migrateSnapshotV1162, foldSnapshotFlat, normalizeSnapshot, SNAP_APPEARANCE_LABELS, SNAP_APPEARANCE_LIMIT, SNAP_BIRTH_ANOMALY_LABEL, SNAP_BIRTH_ANOMALY_SHORT, SNAP_FUTURE_ORIGIN_RE, ensureSnapshotBirthDate, storyAnchorDate, storyClockReference };

// ==================== 移植补全（内核标识符门禁发现缺失依赖） ====================
const SNAP_FUTURE_ORIGIN_RE = /(未来|穿越|时空|平行世界|异世界|来自\s*(?:公元前|前)?\s*-?\d{1,4}\s*年|后世|转生|重生)/;   // v1.193：含「来自公元前221年」
// 剧情时间锚点（剧情日期优先；缺失时退回剧情时间线里**最近记录的日期**（情节 → 记忆）；
//   两者都无 → 空 = 无法判定）。**绝不退回现实日期** —— 现实时间不是剧情时间（v1.161 口径）。

const SNAP_BIRTH_ANOMALY_LABEL = {
    future: '出生日期晚于当前剧情日期',
    'after-record': '出生日期晚于该角色的「最后见面 / 最后更新」日期（倒挂）',
    overage: '按剧情日期算出的年龄超过 120 岁',
    'bad-format': '出生日期格式非法（非 年-月-日）',
};

const SNAP_BIRTH_ANOMALY_SHORT = {
    future: '晚于剧情日期',
    'after-record': '早于出生日期就被记录（倒挂）',
    overage: '按剧情算超过 120 岁',
    'bad-format': '日期格式非法',
};

const SNAP_APPEARANCE_LIMIT = 120;   // 外貌聚合文本上限（中文按字）
// 旧分组字段 → 中文标签（拼聚合文本用；顺序即展示顺序）

const SNAP_APPEARANCE_LABELS = [
    ['height', '身高'], ['build', '体型'], ['hair', '发色发型'], ['eyes', '瞳色'], ['skin', '肤色'], ['distinguishing', '特征'],
];
// 外貌特征聚合为一段文本：① 已是字符串 → 直接用；② 旧分组对象 → 逐项拼「标签+值」；
//   ③ 兼容历史扁平键（height/hair/… 直接挂在档案顶层）。幂等：聚合结果再聚合不变。

function storyAnchorDate() {
    try {
        const direct = String(getStoryNow() || '').trim();
        if (/^-?\d{1,4}/.test(direct)) return clockDateTrim(direct);
        const ref = (typeof storyClockReference === 'function') ? storyClockReference() : null;
        if (ref && /^-?\d{1,4}/.test(String(ref.date || ''))) return clockDateTrim(ref.date);
        const atoms = (state && state.atoms) || [];
        const dated = atoms.filter(a => a && !atomIsHidden(a) && /^-?\d{1,4}/.test(String((a && a.date) || ''))).map(a => clockDateTrim(a.date)).sort((x, y) => dateStrCmp(x, y));
        if (dated.length) return dated[dated.length - 1];
        const mems = (state && state.memories) || [];
        const mdated = mems.filter(m => /^-?\d{1,4}/.test(String((m && m.date) || ''))).map(m => clockDateTrim(m.date)).sort((x, y) => dateStrCmp(x, y));
        if (mdated.length) return mdated[mdated.length - 1];
    } catch (e) { }
    return '';
}
// 从「年龄备注 / 年龄字段」解析岁数（支持「约 25 岁」「26岁」「二十五」这类只取数字的场景）

function parseAgeYears(text) {
    try {
        const s = String(text == null ? '' : text);
        const m = s.match(/(\d{1,3})\s*(?:岁|周岁|餘歲|余岁)?/);
        if (!m) return 0;
        const n = Number(m[1]);
        return (n > 0 && n < 130) ? n : 0;
    } catch (e) { return 0; }
}
// 无年龄信息时按身份/称呼线索估龄（合理推测，可被 cfg.characterBirthDefaultAge 覆盖默认值）

function guessAgeFromCues(snap) {
    try {
        const s = snap || {};
        const blob = [s.name, s.identity && s.identity.occupation, s.identity && s.identity.title,
            s.background && s.background.history, snapshotAppearanceText(s),
            (s.personality && Array.isArray(s.personality.traits)) ? s.personality.traits.join(' ') : ''].join(' ');
        if (/(婴儿|幼童|孩童|幼儿|小孩)/.test(blob)) return 6;
        if (/(少年|少女|学生|学徒|儿童)/.test(blob)) return 15;
        if (/(中年|大叔|大婶|父亲|母亲|家长)/.test(blob)) return 45;
        if (/(老年|老人|年迈|白发|花甲|古稀|祖母|祖父|奶奶|爷爷)/.test(blob)) return 68;
        if (/(青年|年轻人)/.test(blob)) return 22;
        const def = Number(cfg && cfg.characterBirthDefaultAge);
        return (def > 0 && def < 120) ? Math.round(def) : 25;
    } catch (e) { return 25; }
}

function birthDateFromAge(age, anchor) {
    try {
        const a = parseAgeYears(age) || Number(age) || 25;
        const ap = clockDateParts(clockDateTrim(anchor));   // v1.193：负年份锚点
        if (!ap) return '';
        const y = ap.y - a;
        if (!clockYearInRange(y)) return '';
        const mo = ap.m, day = Math.min(28, ap.d);
        return clockDateStr(y, mo, day);
    } catch (e) { return ''; }
}
// 单个档案：确保出生日期存在（**正文明确给出时绝不改写**；v1.172 起「异常值」例外，会被视为无效并重推）

function ensureSnapshotBirthDate(snap, opts) {
    const o = opts || {};
    const out = { changed: false, date: '', source: '', note: '' };
    try {
        if (!snap || typeof snap !== 'object') return out;
        if (!snap.identity) snap.identity = {};
        if (cfg && cfg.characterBirthInfer === false) { out.date = String(snap.identity.birthDate || ''); out.source = 'off'; return out; }
        const cur = String(snap.identity.birthDate || '').trim();
        // v1.164：已有的「未来出生日期」视为无效记录 —— 不采信，改由下方按剧情日期重新推算
        //   （未来人 / 穿越者的档案照常采信；无剧情日期时无法判定，不拦）
        // v1.172：**格式非法**的出生日期（非 年-月-日，如「约1890年」）同样视为无效 → 清空并按线索重推；
        //   「倒挂（after-record）」与「年龄超 120」交给 AI 优先处置（可能是长生物种，不机械改写）。
        // v1.176：**只有年 / 年-月 的出生日期是合法数据**（低精度，年龄按估算给出）—— 不再当作格式非法清掉。
        const curParsed = parseBirthDateParts(cur);
        const curValid = !!curParsed;
        const curBadFormat = !!cur && !curValid;
        const curOk = curValid && !!clockYearInRange(curParsed.y);   // v1.193：负年份（公元前）同样有效
        const curFuture = curOk && birthDateInFuture(cur) && !snapshotFutureOrigin(snap);
        if (curBadFormat) { snap.identity.birthDate = ''; out.changed = true; out.badFormatFixed = true; }
        // v1.171：**占位出生日期**（birthSource='fallback'：当时没有剧情日期，用现实年份占位）不是「正文明确」——
        //   一旦有了剧情锚点，按当时记录的岁数（birthNote / age 里的数字）重新推算，
        //   避免把 1919 年的角色生到 2011 年（此后年龄永远对不上）。
        const curFallback = curOk && String(snap.identity.birthSource || '') === 'fallback';
        const anchorNow = ageAnchorDate();
        if (curFallback && !curFuture && /^-?\d{1,4}/.test(anchorNow)) {
            const keepAge = parseAgeYears(snap.identity.birthNote) || parseAgeYears(snap.identity.age) || 0;
            const re = keepAge ? birthDateFromAge(keepAge, anchorNow) : '';
            if (re) {
                snap.identity.birthDate = re;
                snap.identity.birthSource = 'age';
                snap.identity.birthNote = `推测：据年龄 ${keepAge} 岁与剧情日期 ${anchorNow.slice(0, 7)} 推算（原为无剧情日期时的现实年份占位，已按剧情日期校正）`;
                try { const a = calcAge(re, anchorNow); if (a) snap.identity.age = a; } catch (e) { }
                out.changed = true; out.date = re; out.source = 'age'; out.note = snap.identity.birthNote;
                out.fallbackFixed = true;
                try { stampSnapshotTime(snap, 'update'); } catch (e) { }
                return out;
            }
        }
        if (curOk && !curFuture) {
            out.date = cur;
            // v1.176：**占位值不得被误标为「正文明确」** —— 无剧情日期时写的现实年份占位（birthSource='fallback'）
            //   保持 fallback 标注，等有剧情锚点后再按剧情日期校正（否则占位值会被当成真实数据永久留下）。
            const src0 = String(snap.identity.birthSource || '');
            out.source = src0 === 'fallback' ? 'fallback' : 'text';
            if (src0 !== 'text' && src0 !== 'fallback') snap.identity.birthSource = 'text';
            if (!snap.identity.birthNote) snap.identity.birthNote = src0 === 'fallback' ? '无剧情日期时的现实年份占位（待剧情日期确认后校正）' : '正文明确';
            return out;
        }
        // v1.162：年龄线索来源 —— ① 调用方显式给（如迁移时的旧「年龄备注」）；② 防御性兼容旧年龄备注字段；③ 档案里的年龄（仅缺出生日期时才有意义）
        const explicitAge = parseAgeYears(o.ageHint) || parseAgeYears(snap.identity.ageNote) || parseAgeYears(snap.identity.age);
        const anchor = String(o.anchor || ageAnchorDate() || '');
        const anchorOk = /^-?\d{1,4}/.test(anchor);
        const useAnchor = anchorOk ? anchor : `${new Date().getFullYear()}-01-01`;
        const age = explicitAge || guessAgeFromCues(snap);
        const date = birthDateFromAge(age, useAnchor);
        if (!date) return out;
        const cueHit = /(婴儿|幼童|孩童|幼儿|小孩|少年|少女|学生|学徒|儿童|中年|大叔|大婶|父亲|母亲|家长|老年|老人|年迈|白发|花甲|古稀|祖母|祖父|奶奶|爷爷|青年|年轻人)/.test(
            String(snap.name || '') + String((snap.identity || {}).occupation || '') + String((snap.identity || {}).title || ''));
        const srcBase = explicitAge ? 'age' : (cueHit ? 'era' : 'default');
        const source = anchorOk ? srcBase : 'fallback';
        const anchorText = anchorOk ? anchor.slice(0, 7) : '（无剧情日期，用现实年份）';
        const basis = explicitAge
            ? `据年龄 ${explicitAge} 岁`
            : `按${cueHit ? '身份线索' : '默认成人年龄'}估算 ${age} 岁`;
        snap.identity.birthDate = date;
        snap.identity.birthSource = source;
        snap.identity.birthNote = `推测：${basis}与${anchorOk ? '剧情日期' : '现实年份'} ${anchorText} 推算`
            + (curFuture ? '（原出生日期晚于剧情日期，已按剧情日期校正）' : (curBadFormat ? '（原出生日期格式非法，已重新推算）' : ''));
        // v1.162：不再写「年龄备注」（该字段已取消）—— 年龄统一由出生日期 + 剧情锚点计算
        //   v1.171：锚点用 ageAnchorDate()（无锚点时用现实年份占位的那一次不写年龄，避免落盘 1xx 岁）
        try { const a = calcAge(date, anchorOk ? anchor : ''); if (a) snap.identity.age = a; else if (String(snap.identity.age || '').trim() && !anchorOk) snap.identity.age = ''; } catch (e) { }
        out.changed = true; out.date = date; out.source = source; out.note = snap.identity.birthNote;
        out.futureFixed = curFuture;   // v1.164：本次是否修正了「未来出生日期」
        try { stampSnapshotTime(snap, 'update'); } catch (e) { }   // v1.161：自动补全出生日期亦算一次档案更新
        return out;
    } catch (e) { return out; }
}
// 批量：确保全部档案都有出生日期（返回统计与逐条明细；供修复流程与诊断使用）
//   v1.176：只有年 / 年-月 的出生日期视为**已存在**（低精度数据不再被"补全"成推测值覆盖）

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

function storyClockReference() {
    try {
        const n = atomLatestDated();
        if (!n) return { date: '', time: '', location: '' };
        return { date: n.date || '', time: n.time || '', location: n.location || '' };
    } catch (e) { return { date: '', time: '', location: '' }; }
}
// ==================== v1.184：AI 捕捉正文 → 生成时钟正则（设定页按钮） ====================
// 用户要求：「在设定中，增加 AI 捕捉正文日期、时间、地点，形成正则表达式的按钮功能」。
// 流程：取最近 N 楼投喂文本 → 交 AI 产出 {日期正则, 时间正则, 地点正则, 说明} → JS **校验**（可编译 / 不匹配空串 /
//   在样本中确有命中）→ 写入 cfg.clockDateRegex / clockTimeRegex / clockLocationRegex → 立即用样本试算并回报结果。

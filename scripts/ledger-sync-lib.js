// ============================================================
// scripts/ledger-sync-lib.js —— **设计稿实施规格 ↔ 开发待办清单 双向一致**的纯函数库
//   （v3.45.0，`docs/D22` W5 `技-24`，`docs/D14` §7 的 **C12** 判据）
//
// 用户要求（原话）：「新版本v3.45.0 / 开发W5待开发事项。」
// 设计依据：`docs/D21` §3.2 / §8 `技-24` ——
//   「**C12**：设计稿『实施规格』↔ 本清单**双向一致**校验（含 `U` 编号存在性 + 反向探针）」。
//
// 为什么需要这条判据（本仓库的既有教训）：
//   · `docs/D17` §0 就写明「本表按来源记事实，`D22` 按维度序给执行视图，**两者销账时必须同时改**」——
//     但「必须同时改」此前**只靠人记**：一份设计稿新增一条实施规格、清单忘了加行（或反过来），
//     任何门禁都发现不了（`check-drafts` 只核**单份**稿子的结构，不核**跨稿**一致性）。
//   · 这条 C12 把「同时改」变成机械判据：**任一方向缺一条即失败**。
//
// 口径（写死在这里，CLI 与单测共用）：
//   ① 「实施规格行」= 表格行且**单元格数 ≥ 9** 且首个单元格以**编号**开头（`业务/应用/数据/技术` 的前缀
//      各稿自定：`业-` / `应-` / `数-` / `技-`，故编号用「中文或字母 + `-` + 数字」的通用形态识别）；
//   ② 编号后允许**任意装饰**：`**加粗**`、反引号、`[契约]`、`（后半）`……（取**首个**编号即可）——
//      第一版没容忍这些装饰，于是把 `技-6`（后半）与 `数-3` **[契约]** 误判成「双向不一致」；
//   ③ `U` 编号存在性：清单里引用的每个 `U<数字>` 都必须在 `docs/D17` 里有对应行（`| U123 |`）；
//   ④ 只做**一致性**判定，不判定编号的语义/顺序/状态 —— 那些是人写的，机械判不了。
// ============================================================

/** 编号形态：`业-3` / `应-24` / `数-10` / `技-6` / `D20 Q4` 里的 `Q` 不算（那条是需求来源表，不是实施规格） */
const ID_RE = /([\u4e00-\u9fa5]{1,4}|[A-Za-z]{1,4})[-‐-]\s*(\d+)/;

/** 表格行 → 单元格数组（首尾空串去掉） */
export function cellsOf(line) {
    const s = String(line == null ? '' : line).trim();
    if (!s.startsWith('|')) return null;
    const parts = s.split('|');
    parts.shift();
    parts.pop();
    return parts.map((x) => x.trim());
}

/**
 * 首个单元格 → 编号（容忍任意装饰；取**第一个**匹配）。
 * @returns {string} 如 `数-10`；不是编号行 → 空串
 */
export function leadingId(cell) {
    const head = String(cell == null ? '' : cell).trim();
    if (!head) return '';
    // 只认「单元格**开头**」的编号 —— 避免把正文里提到的编号当成行编号
    const m = new RegExp('^[^\\u4e00-\\u9fa5A-Za-z]{0,6}' + ID_RE.source).exec(head);
    if (!m) return '';
    return m[1] + '-' + m[2];
}

/**
 * 收集某份文档里的**实施规格行**编号。
 * @param {string} text 文档全文
 * @param {number} [minCells=9] 最少单元格数（`开发守则.md` §2.6 的实施规格是 9 字段）
 * @returns {Map<string, {line:number, cells:number}>}
 */
export function collectSpecIds(text, minCells) {
    const min = Number(minCells) || 9;
    const out = new Map();
    const lines = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const cells = cellsOf(lines[i]);
        if (!cells || cells.length < min) continue;
        const id = leadingId(cells[0]);
        if (!id) continue;
        if (!out.has(id)) out.set(id, { line: i + 1, cells: cells.length });
    }
    return out;
}

/**
 * 收集**清单**里的编号（任何表格行的首个单元格；清单用反引号包裹编号，但同样容忍装饰）。
 * @param {string} text
 * @returns {Map<string, {line:number}>}
 */
export function collectLedgerIds(text) {
    const out = new Map();
    const lines = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const cells = cellsOf(lines[i]);
        if (!cells || !cells.length) continue;
        const id = leadingId(cells[0]);
        if (!id) continue;
        if (!out.has(id)) out.set(id, { line: i + 1 });
    }
    return out;
}

/**
 * 双向比对。
 * @returns {{onlySpec:Array<{id:string,from:string}>, onlyLedger:Array<{id:string}>}}
 *   `onlySpec` = 设计稿有实施规格、清单缺行；`onlyLedger` = 清单有行、任何设计稿的实施规格里都没有
 */
export function compareIds(specById, ledgerById) {
    const onlySpec = [];
    const onlyLedger = [];
    for (const [id, meta] of (specById instanceof Map ? specById : new Map())) {
        if (!(ledgerById instanceof Map ? ledgerById : new Map()).has(id)) onlySpec.push({ id: id, from: String((meta && meta.from) || '') });
    }
    for (const [id] of (ledgerById instanceof Map ? ledgerById : new Map())) if (!(specById instanceof Map ? specById : new Map()).has(id)) onlyLedger.push({ id: id });
    onlySpec.sort((a, b) => a.id.localeCompare(b.id));
    onlyLedger.sort((a, b) => a.id.localeCompare(b.id));
    return { onlySpec: onlySpec, onlyLedger: onlyLedger };
}

/** 文档里引用的全部 `U<数字>`（去重） */
export function collectURefs(text) {
    const out = new Set();
    const re = /\bU(\d+)\b/g;
    let m;
    const s = String(text == null ? '' : text);
    while ((m = re.exec(s))) out.add('U' + m[1]);
    return out;
}

/** `docs/D17` 里**登记过**的 U 编号（`| U123 |` 形态） */
export function collectRegisteredUs(text) {
    const out = new Set();
    const re = /^\|\s*U(\d+)\s*\|/;
    for (const line of String(text == null ? '' : text).split('\n')) {
        const m = re.exec(line);
        if (m) out.add('U' + m[1]);
    }
    return out;
}

/**
 * 清单引用了、但事实台账里没有的 U 编号。
 * @returns {string[]} 升序
 */
export function missingURefs(refs, registered) {
    const r = (refs instanceof Set) ? refs : new Set(refs || []);
    const g = (registered instanceof Set) ? registered : new Set(registered || []);
    return Array.from(r).filter((u) => !g.has(u)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

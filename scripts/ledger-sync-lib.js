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
 * 实施规格行的**详情**：编号 → 行号 + 该行引用的全部 `U<n>`。
 *   v2.0（`docs/D22` 改为「只列未完成」）：清单不再保留已完成行，
 *   故「已落地」这一侧必须由 `docs/D17` 证明 —— 证据入口就是实施规格行的「台账」列
 *   （`开发守则.md` §2.8 **R2**：实施规格条目号 ↔ `D22` 条目 ↔ `D17` 的 `U<n>`）。
 * @param {string} text 文档全文
 * @param {number} [minCells=9]
 * @returns {Map<string, {line:number, cells:number, u:Set<string>}>}
 */
export function collectSpecDetails(text, minCells) {
    const min = Number(minCells) || 9;
    const out = new Map();
    const lines = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const cells = cellsOf(lines[i]);
        if (!cells || cells.length < min) continue;
        const id = leadingId(cells[0]);
        if (!id) continue;
        if (out.has(id)) continue;
        const u = new Set();
        for (const c of cells) for (const x of collectURefs(c)) u.add(x);
        out.set(id, { line: i + 1, cells: cells.length, u: u });
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

/**
 * `docs/D17` 里**已落地**的 `U` 编号。
 *   口径：以 `| U<数字> |` 开头的**整块**为单位 —— 台账行允许跨行续写
 *   （例：`U215` 的 `✅` 写在第二行），只按单行匹配会把这类行误判成「未落地」。
 *   块内出现 `✅` 即视为已落地；块在「下一条 `| U<n> |` / 表格其它行 / 空行」处结束。
 * @param {string} text `docs/D17-未落实事项台账.md` 全文
 * @returns {Set<string>}
 */
export function collectSettledUs(text) {
    const out = new Set();
    const lines = String(text == null ? '' : text).split('\n');
    let cur = null;
    const flush = () => {
        if (cur && cur.settled) out.add(cur.u);
        cur = null;
    };
    for (const line of lines) {
        const m = /^\|\s*(U\d+)\s*\|/.exec(line);
        if (m) {
            flush();
            cur = { u: m[1], settled: line.indexOf('✅') >= 0 };
            continue;
        }
        if (!cur) continue;
        const s = line.trim();
        if (!s || s.charAt(0) === '|') { flush(); continue; }   // 空行 / 表格其它行 = 块结束
        if (line.indexOf('✅') >= 0) cur.settled = true;
    }
    flush();
    return out;
}

/**
 * **未被任何一侧承接**的实施规格编号 = 「设计稿有实施规格、清单缺行、台账也没说它做完了」。
 *
 *   两态判据（v2.0，随 `docs/D22` 改为「只列未完成」）：
 *     ① 清单（`docs/D22`）里有这一行 → 待办，承接；
 *     ② 否则，该行「台账」列引用的 `U<n>` 里**只要有一个**在 `docs/D17` 标已落地 → 已交付并移出清单，承接。
 *   两条都不满足 → 真遗漏（设计稿改了却没立待办，或清单行被误删）。
 * @param {Map<string, {u:Set<string>}>} specDetails `collectSpecDetails` 的结果
 * @param {Map<string, *>} ledgerById `collectLedgerIds` 的结果
 * @param {Set<string>} settledUs `collectSettledUs` 的结果
 * @returns {string[]} 编号升序
 */
export function unaccountedSpecIds(specDetails, ledgerById, settledUs) {
    const specs = (specDetails instanceof Map) ? specDetails : new Map();
    const ledger = (ledgerById instanceof Map) ? ledgerById : new Map();
    const settled = (settledUs instanceof Set) ? settledUs : new Set(settledUs || []);
    const out = [];
    for (const [id, meta] of specs) {
        if (ledger.has(id)) continue;
        const u = (meta && meta.u instanceof Set) ? meta.u : new Set();
        const done = Array.from(u).some((x) => settled.has(x));
        if (!done) out.push(id);
    }
    return out.sort((a, b) => a.localeCompare(b));
}

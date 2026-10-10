// ============================================================
// scripts/docs-facts-lib.js —— `check-docs-facts.js` 的**纯函数**部分
//
// 为什么单独成模块（v3.40.3 / `docs/D22` `技-12`，登记 `docs/D17` U132）：
//   C5 的「批次档前缀唯一匹配」与 C6 的「目录树结构化解析」都需要**反向探针**
//   （构造不合法输入 → 必须报错；构造干扰输入 → 必须仍能正确比对）。
//   探针若要驱动整个门禁脚本，就得往 `docs/` 写临时文件（会牵动目录树集合判据）；
//   把这两处判据抽成**无副作用纯函数**后，探针可以直接调用它们，既精确又不污染仓库。
//
// 口径与调用方一致：本模块不读盘、不打印、不退出；输入全是字符串与数组。
// ============================================================

/**
 * 批次档前缀引用的**匹配形态**：`P10c46` / `history/P10c46` / `docs/history/P10c46`（**无扩展名**）。
 *   动机：C5 旧实现只校验**带扩展名**的引用 → 「批次档前缀」这类引用从未被拦住
 *   （`docs/README.md` §2 自述「最近一次界面变更」的指向就这样悄悄过期了）。
 */
export const BATCH_REF_RE = /^(?:docs\/)?(?:history\/)?(P\d[\w-]*)$/;

/**
 * 前缀 → 命中的批次档文件名（**唯一匹配**判据）。
 *   口径：文件名**恰为** `<前缀>.md`，或以 **`<前缀>-`** 开头 ——
 *   这样 `P10c6` 只认 `P10c6-…`（不会把 `P10c60`–`P10c68` 一起吞进来），`P10c` 只认 `P10c-…`。
 * @param {string} prefix 形如 `P10c46`
 * @param {string[]} names `docs/history/` 下的文件名（不含 `README.md`）
 * @returns {string[]} 命中列表（长度 1 = 唯一；0 = 不存在；>1 = 不唯一）
 */
export function batchHits(prefix, names) {
    const p = String(prefix == null ? '' : prefix);
    const list = Array.isArray(names) ? names : [];
    if (!p) return [];
    return list.filter((n) => n === p + '.md' || String(n).indexOf(p + '-') === 0);
}

/**
 * **C6：目录树的结构化解析** —— 取 `## 1. 目录结构` 代码块里的**顶层条目**名。
 *
 * 历史缺陷：用 `block.indexOf('history/')` 做**裸子串截断** —— 只要树里**任何一个条目的描述文字**
 *   出现该子串，比较范围就被静默截短（实测触发：`D22` 的树条目描述含该路径 → 三行被截掉、报「漏列」）。
 *
 * 现在：只认**行首（允许缩进）的树分支符号** `├──` / `└──`，并取紧随其后的**条目名**
 *   （到空白或 `#` 为止）；以「条目名本身就是 `history/`（或以 `history/` 开头）」作为顶层条目的终止点。
 *   描述文字里出现什么都不影响解析。
 * @param {string} mdText `docs/README.md` 全文
 * @returns {string[]} 顶层条目里的 `.md` 文件名（不含 `README.md`）
 */
export function parseTopTreeNames(mdText) {
    const text = String(mdText == null ? '' : mdText);
    const out = [];
    const i = text.indexOf('## 1. 目录结构');
    if (i < 0) return out;
    const j = text.indexOf('```', text.indexOf('```', i) + 3);
    const block = (j > i) ? text.slice(i, j) : '';
    for (const line of block.split('\n')) {
        const mm = /^\s*[├└]──\s+([^\s#]+)/.exec(line);
        if (!mm) continue;
        const name = mm[1];
        if (name === 'history/' || name.indexOf('history/') === 0) break;   // `history/` 子树起点 → 顶层条目到此为止
        if (name === 'README.md') continue;
        if (!/\.md$/.test(name)) continue;
        out.push(name);
    }
    return out;
}

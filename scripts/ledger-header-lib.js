// ============================================================
// scripts/ledger-header-lib.js —— **台账头部机械判据**（v3.50.11，`docs/D22` §4.25 `技-54` / `docs/D45` §2.6 F5）
//
// 缺陷（本轮前实测）：两份台账的头部口径（§1 标题区间 / 「事实条目 N 条」/「关联 U1–Un」/「事实基准 vX」）
//   全靠**人手同步**，任何门禁都不核 → 实测已漂移（如 §1 标题 `U1–U227` 而实际已到 `U242`；
//   「事实条目 227 条」而实际 242 条；「事实基准 v3.45.x」而程序已 v3.50.x）。
//
// 判据设计（宁少不误报 —— 措辞不匹配就**跳过该项**，绝不因此报错）：
//   ① `U` 区间：`collectRegisteredUs()` 实测的**最大** U 号 vs 头里声明的 `U1–U<n>` / `U1~U<n>`；
//   ② `U` 条数：实测登记条数 vs 头里声明的「事实条目（**N 条**）」/「N 条」；
//   ③ 事实基准：`core/constants.js#VERSION` vs 头里声明的「事实基准：程序 **vX.Y.Z**」。
//   每项都返回 `{ declared, actual, source }`（供 `check-ledger-sync` 逐行核对）或 `null`（措辞不匹配 → 跳过）。
// 纯函数（不读文件），便于单测与反向探针（把声明改错 → 必须报错）。
// ============================================================

/** 从文本里抓第一个匹配；没有则返回 null（= 措辞不匹配 → 跳过该判据） */
function grab(text, re) {
    const m = re.exec(String(text == null ? '' : text));
    return m ? m : null;
}

/**
 * 头部声明：`U` 区间（`U1–U<n>` / `U1~U<n>` / `U1-U<n>`）
 * @returns {number|null}
 */
export function declaredUMax(text) {
    const m = grab(text, /U1\s*[–\-~—]\s*U(\d+)/);
    return m ? Number(m[1]) : null;
}

/**
 * 头部声明：事实条目条数（「事实条目（**254 条**…）」「事实条目 **254** 条」等写法）
 * @returns {number|null}
 */
export function declaredUCount(text) {
    const m = grab(text, /事实条目[^0-9]{0,40}?(\d+)\s*条/) || grab(text, /U<n>[^\n]{0,80}?(\d+)\s*条/);
    return m ? Number(m[1]) : null;
}

/**
 * 头部声明：事实基准版本（「事实基准：程序 **v3.50.9**」「事实基准 = v3.50.9」等写法）
 * @returns {string|null}
 */
export function declaredBaselineVersion(text) {
    const m = grab(text, /事实基准[^\n]{0,60}?v(\d+\.\d+(?:\.\d+)?)/);
    return m ? String(m[1]) : null;
}

/**
 * 机械核对：把「头部声明」与「实测值」逐项比对。
 * @param {{truthText:string, ledgerText:string, actualUMax:number, actualUCount:number, programVersion:string}} ctx
 * @returns {{ok:boolean, checks:Array<{name:string, declared:any, actual:any, ok:boolean, skipped?:boolean}>}}
 */
export function checkLedgerHeaders(ctx) {
    const c = ctx || {};
    const checks = [];
    const push = (name, declared, actual) => {
        if (declared === null || declared === undefined) { checks.push({ name: name, declared: null, actual: actual, ok: true, skipped: true }); return; }
        checks.push({ name: name, declared: declared, actual: actual, ok: String(declared) === String(actual) });
    };
    // ① D17 §1 标题区间（只认 `## 1.` 那一行里的 `U1–Un`；避免抓到变更块里的历史区间）
    const sec1 = (String(c.truthText || '').split('\n').filter((l) => /^##\s*1\./.test(l))[0]) || '';
    push('D17 §1 标题区间 U 上限', declaredUMax(sec1), Number(c.actualUMax) || 0);
    // ② D22 头部「按来源登记 `U1–Un`」
    const d22Head = String(c.ledgerText || '').split('\n').filter((l) => /U1\s*[–\-~—]\s*U\d+/.test(l)).slice(0, 1)[0] || '';
    push('D22 头部关联区间 U 上限', declaredUMax(d22Head), Number(c.actualUMax) || 0);
    // ③ D22 粒度行「事实条目（**N 条**…）」
    const granLine = String(c.ledgerText || '').split('\n').filter((l) => /事实条目/.test(l))[0] || '';
    push('D22「事实条目 N 条」', declaredUCount(granLine), Number(c.actualUCount) || 0);
    // ④ D22 头部「事实基准：程序 vX.Y.Z」
    const baseLine = String(c.ledgerText || '').split('\n').filter((l) => /事实基准/.test(l))[0] || '';
    push('D22「事实基准」程序版本', declaredBaselineVersion(baseLine), String(c.programVersion || ''));
    // ⑤ D17 头部若有「事实基准」也核
    const tBase = String(c.truthText || '').split('\n').filter((l) => /事实基准/.test(l)).slice(0, 1)[0] || '';
    push('D17「事实基准」程序版本', declaredBaselineVersion(tBase), String(c.programVersion || ''));
    const ok = checks.every((x) => x.ok);
    return { ok: ok, checks: checks };
}

// ============================================================
// 单元测试 · v3.45.0 `docs/D22` W5 **`技-24`** —— C12：实施规格 ↔ 待办清单 **双向一致**
//   设计：`docs/D21` §3.2 / §8 `技-24`（含 `U` 编号存在性 + **反向探针**）
//   实现：`scripts/ledger-sync-lib.js`（纯函数）+ `scripts/check-ledger-sync.js`（CLI，不一致即退出 1，已进 `gate`）
//
// 本文件锁四件事：
//   ① **编号解析容忍装饰**：`**数-3** **[契约]**` / `` `技-6`（后半） `` 都要能取出编号 ——
//      第一版没容忍装饰，把这两条真实存在的行误判成「双向不一致」（本轮实测）；
//   ② **双向**：设计稿多一条 → 报「清单缺行」；清单多一条 → 报「实施规格里没有定义」；
//   ③ **U 编号存在性**：清单引用的 U 必须在 `docs/D17` 里登记过；
//   ④ **反向探针**：用合成文本构造不一致，**必须**被报出来（否则这条门禁是「永远绿」的摆设）。
//
// 运行：node tests/unit/ledger-sync.test.js
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import {
    cellsOf, collectLedgerIds, collectRegisteredUs, collectSpecIds, collectURefs, compareIds, leadingId, missingURefs,
} from '../../scripts/ledger-sync-lib.js';

const R = makeReporter('ledger-sync v3.45.0 C12 实施规格↔清单双向一致（D22 W5 技-24）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = join(ROOT, 'docs');

A('L1 单元格拆分与编号提取：`` `数-10` `` / `**技-6** **[契约]**` / `` `技-6`（后半） `` / `**应-24**` 都能取出编号；非编号行返回空串', (() => {
    const idOf = (row) => { const c = cellsOf(row); return c ? leadingId(c[0]) : ''; };
    return J(cellsOf('| a | b | c |')) === J(['a', 'b', 'c'])
        && J(cellsOf('  not a row')) === J(null)
        && idOf('| `数-10` | 数据 | x |') === '数-10'
        && idOf('| **技-6** **[契约]** | 技术 | x |') === '技-6'
        && idOf('| `技-6`（后半） | 技术 | x |') === '技-6'
        && idOf('| **应-24** | 应用 | x |') === '应-24'
        && idOf('| `业-3` | 业务 | x |') === '业-3'
        && idOf('| 编号 | 维度 | 事项 |') === ''
        && idOf('| `D10` Q3 + Q10 | 技术 | x |') === '';
})(), '');

A('L2 实施规格行识别：**只认 ≥9 单元格**（`开发守则` §2.6 的 9 字段）——少一列的普通表格行不算实施规格', (() => {
    const wide = '| **数-1** | 数据 | 目标 | 落点 | 前置 | 步骤 | 验收 | 回退 | U39 |';
    const narrow = '| **数-1** | 数据 | 目标 | 落点 |';
    const spec = collectSpecIds(['| 编号 | 维度 | 目标 | 落点 | 前置 | 步骤 | 验收 | 回退 | 台账 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', wide, narrow].join('\n'));
    const loose = collectSpecIds(['| **数-1** | 数据 | 目标 | 落点 |', '| **数-2** | 数据 | 目标 | 落点 |'].join('\n'), 4);
    return spec.size === 1 && spec.has('数-1') && spec.get('数-1').cells === 9
        && loose.size === 2;
})(), '');

A('L3 反向探针（设计稿多一条）：合成文本里设计稿有 `数-99`、清单没有 → `onlySpec` 必须报出来', (() => {
    // 设计稿定义 数-1 与 数-99；清单只有 数-1 → 报「清单缺 数-99」，且**不**报反向
    const specDoc = [
        '| **数-1** | 数据 | 目标 | 落点 | 前置 | 步骤 | 验收 | 回退 | U1 |',
        '| **数-99** | 数据 | 目标 | 落点 | 前置 | 步骤 | 验收 | 回退 | U1 |',
    ].join('\n');
    const ledgerDoc = '| `数-1` | 数据 | 事项 | 无 | U1 | ⬜ | | |';
    const r = compareIds(collectSpecIds(specDoc), collectLedgerIds(ledgerDoc));
    return J(r.onlySpec.map((x) => x.id)) === J(['数-99']) && r.onlyLedger.length === 0;
})(), '');

A('L4 反向探针（清单多一条）：清单有 `应-99`、任何设计稿的实施规格里都没有 → `onlyLedger` 必须报出来', (() => {
    const specDoc = '| **应-4** | 应用 | 目标 | 落点 | 前置 | 步骤 | 验收 | 回退 | U52 |';
    const ledgerDoc = '| `应-4` | 应用 | x | 无 | U52 | ⬜ | | |\n| `应-99` | 应用 | y | 无 | U52 | ⬜ | | |';
    const r = compareIds(collectSpecIds(specDoc), collectLedgerIds(ledgerDoc));
    return r.onlySpec.length === 0 && J(r.onlyLedger.map((x) => x.id)) === J(['应-99']);
})(), '');

A('L5 反向探针（U 编号未登记）：清单引用 `U999` 而台账没有这一行 → `missingURefs` 必须报出来；已登记的 U 不报', (() => {
    const ledger = '| `数-1` | 数据 | x | 无 | U1 · U999 | ⬜ | | |';
    const truth = '| U1 | 事项 | 类型 | 来源 | P1 | ⬜ |\n| U2 | 事项 | 类型 | 来源 | P1 | ⬜ |';
    const refs = collectURefs(ledger), reg = collectRegisteredUs(truth);
    return J(Array.from(refs).sort()) === J(['U1', 'U999']) && J(Array.from(reg).sort()) === J(['U1', 'U2'])
        && J(missingURefs(refs, reg)) === J(['U999']);
})(), '');

A('L6 **正向（真实仓库）**：当前工作区「设计稿实施规格 ↔ `D22` 清单」双向一致，且清单引用的 U 编号全部已在 `D17` 登记', (() => {
    const designFiles = readdirSync(DOCS).filter((f) => /^D\d+.*\.md$/.test(f) && f !== 'D22-开发待办清单.md');
    const specById = new Map();
    for (const f of designFiles) {
        const text = readFileSync(join(DOCS, f), 'utf8');
        for (const [id, meta] of collectSpecIds(text)) if (!specById.has(id)) specById.set(id, { from: f, line: meta.line });
    }
    const ledgerText = readFileSync(join(DOCS, 'D22-开发待办清单.md'), 'utf8');
    const truthText = readFileSync(join(DOCS, 'D17-未落实事项台账.md'), 'utf8');
    const r = compareIds(specById, collectLedgerIds(ledgerText));
    const missU = missingURefs(collectURefs(ledgerText), collectRegisteredUs(truthText));
    return r.onlySpec.length === 0 && r.onlyLedger.length === 0 && missU.length === 0
        && specById.size > 90;                       // 顺带锁住「解析器没有把整份表吃掉」
})(), '');

A('L7 这条判据**进了 gate**（否则「双向一致」只是文档里的一句话）；CLI 在不一致时**退出 1**（不是 warning）', (() => {
    const cli = readFileSync(join(ROOT, 'scripts', 'check-ledger-sync.js'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const gate = String(pkg.scripts.gate || '');
    return gate.indexOf('check-ledger-sync.js') >= 0
        && /process\.exit\(1\)/.test(cli) && /process\.exit\(0\)/.test(cli)
        && cli.indexOf('--quiet') >= 0;
})(), '');

A('L8 零依赖（`docs/D21` Q5）：库与 CLI 只 import `node:` 内置或本地文件', (() => {
    const bad = [];
    for (const f of ['ledger-sync-lib.js', 'check-ledger-sync.js']) {
        const src = readFileSync(join(ROOT, 'scripts', f), 'utf8');
        const re = /from '([^']+)'/g;
        let m;
        while ((m = re.exec(src))) {
            const s = m[1];
            if (s.startsWith('node:') || s.startsWith('./') || s.startsWith('../')) continue;
            bad.push(f + ' → ' + s);
        }
    }
    return bad.length === 0;
})(), '');

R.done();

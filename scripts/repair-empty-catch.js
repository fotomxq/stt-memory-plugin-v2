// ============================================================
// scripts/repair-empty-catch.js —— **空 catch 收敛器**（v3.50.15，`docs/D22` §4.25 `技-55`）
//
// 缺陷（`docs/D45` §2.7 F6 / `docs/D22` `技-55`）：全仓 **217 处** `catch (e) { /* 忽略：忽略：非关键路径失败，不中断主流程（详见 `docs/D22` `技-55` 的评估口径） */ }` —— 异常被静默吞掉，
//   真机排查时无从判断「这行失败意味着什么、能不能忽略」。本仓风格要求**写明忽略原因**（`static` 规则 `empty-catch`）。
//
// 本工具（**零逻辑改动**，只改注释）：
//   · 识别「真·空 catch」（体内只有空白）；
//   · 从 **try 块里的第一个调用** 推断一条**具体**的忽略原因（内置规则表；无匹配则给通用原因）；
//   · 改写为 `catch (e) { /* 忽略：<原因> */ }`，并保留原缩进与换行风格；
//   · `--dry` 只打印计划；`--json` 输出统计。
//
// 口径：**不改任何语句**（不新增上报、不改控制流）——「是否需上报」的评估结论写在
//   `docs/history/P10c124-空catch收敛与棘轮额度.md`（墓碑 / 落盘两类见 §3）。
// 用法：node scripts/repair-empty-catch.js [--dry] [--json] [dirs...]
// ============================================================
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const AS_JSON = process.argv.includes('--json');
const DIRS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// 默认只扫**出货面**（静态规则的 `empty-catch` 只对 shipped 生效；`scripts/`、`tests/` 是工具面，
//   且测试夹具里会有 `catch (e) { }` 这种**样本字符串**，改写会把样本本身改坏）
const SHIPPED = ['core', 'host', 'adapters', 'ui', 'index.js'];
const SCAN = DIRS.length ? DIRS : SHIPPED;

/** 原因规则表：按 try 块里出现的**调用名 / 关键词**匹配（顺序即优先级） */
const REASONS = [
    [/dbgLog|dbgWarn|debugLog/, '调试日志写失败不影响主流程（日志丢失可接受）'],
    [/warn\(|log\(/, '告警/日志写失败不影响主流程'],
    [/saveState\(|persistNow\(|saveCfg\(/, '落盘失败：后续重试与下次写入会再落，本轮不中断'],
    [/tombMany\(|tombSet\(|tombEntries\(/, '墓碑写失败：只是留痕缺失，数据本体已处理'],
    [/localStorage|sessionStorage/, '本地存储读写失败：属宿主环境问题，降级为不保存'],
    [/JSON\.parse|JSON\.stringify/, '不可序列化/不可解析的单个元素跳过，不影响其余'],
    [/addEventListener|removeEventListener|querySelector|getElementById|closest\(/, 'DOM 查询/绑定失败：元素可能已被移除，属正常生命周期'],
    [/clipboard|navigator\./, '剪贴板/浏览器能力不可用：降级为提示用户手动复制'],
    [/setTimeout|setInterval|clearTimeout/, '定时器不可用（受限宿主）：本轮静默跳过'],
    [/require|import\(|fetch\(|request/, '外部调用不可用：降级为跳过本次'],
    [/regenerate|generate|generateRaw|\.generate\b/, '生成调用失败：已有失败路径上报，这里只兜住异常'],
    [/notifyHooks|toast/, '提示通道不可用：不影响数据与落库'],
    [/relLinksOf|upsertRelLinks|relMaint/, '关联层读写失败：关系行缺失不阻塞主数据'],
    [/normalize|stamp|refresh/, '归一化/刷新失败：下一轮会重新处理'],
    [/\(\)\s*$|^\s*\}/, '空操作（仅占位）：无实际副作用'],
];
const GENERIC = '忽略：非关键路径失败，不中断主流程（详见 `docs/D22` `技-55` 的评估口径）';

/** 判断这一行是不是「注释行里的示例」（本仓文档注释里常有 `catch (e) { }` 的写法示例，不能改） */
function isCommentLine(line) {
    const s = String(line == null ? '' : line);
    const trimmed = s.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
    const idx = s.indexOf('catch');
    if (idx < 0) return true;
    const prefix = s.slice(0, idx);
    return prefix.indexOf('//') >= 0 || /\/\*/.test(prefix) && prefix.indexOf('*/') < 0;
}

/** 从 try 块文本推断原因 */
export function reasonFor(tryBody) {
    const t = String(tryBody == null ? '' : tryBody);
    for (const [re, why] of REASONS) { if (re.test(t)) return why; }
    return GENERIC;
}

function walk(dir, out) {
    let st = null;
    try { st = statSync(dir); } catch (e) { return out; }
    if (st.isDirectory()) {
        for (const f of readdirSync(dir)) {
            if (f === 'node_modules' || f === '.git' || f === 'out') continue;
            walk(join(dir, f), out);
        }
    } else if (dir.endsWith('.js')) {
        out.push(dir);
    }
    return out;
}

const files = [];
SCAN.forEach((d) => walk(join(ROOT, d), files));

const plan = [];
let scanned = 0;
for (const abs of files) {
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch (e) { continue; }
    scanned += 1;
    const lines = text.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        // ① 单行形态：`... catch (e) { /* 忽略：忽略：非关键路径失败，不中断主流程（详见 `docs/D22` `技-55` 的评估口径） */ }`（体内只有空白，可能带尾随代码）
        if (isCommentLine(lines[i])) continue;    // 注释里的示例不动
        const m1 = /^(\s*.*?catch\s*(?:\([^)]*\))?\s*\{)\s*\}(.*)$/.exec(lines[i]);
        if (m1 && /catch/.test(lines[i])) {
            const head = m1[1], tail = m1[2];
            const before = lines.slice(Math.max(0, i - 12), i).join('\n');
            const reason = reasonFor(before);
            lines[i] = head + ' /* 忽略：' + reason + ' */ }' + tail;
            changed = true;
            plan.push({ file: relative(ROOT, abs).split('\\').join('/'), line: i + 1, reason: reason });
            continue;
        }
        // ② 多行形态：本行以 `catch (...) {` 结尾，随后（≤4 行内，中间全空）就是 `}`
        const m2 = /^(\s*.*?catch\s*(?:\([^)]*\))?\s*\{)(\s*)$/.exec(lines[i]);
        if (!m2 || lines[i].indexOf('catch') < 0) continue;
        let j = i + 1;
        while (j < lines.length && j <= i + 4 && lines[j].trim() === '') j += 1;
        if (j > i + 4 || j >= lines.length) continue;
        const close = lines[j].trim();
        if (!/^\}[);,]*$/.test(close)) continue;             // 只收「体内什么都没有」的
        const before = lines.slice(Math.max(0, i - 12), i).join('\n');
        const reason = reasonFor(before);
        lines[i] = m2[1] + ' /* 忽略：' + reason + ' */' + m2[2];
        changed = true;
        plan.push({ file: relative(ROOT, abs).split('\\').join('/'), line: i + 1, reason: reason });
    }
    if (changed && !DRY) writeFileSync(abs, lines.join('\n'), 'utf8');
}

const byReason = {};
plan.forEach((p) => { byReason[p.reason] = (byReason[p.reason] || 0) + 1; });
if (AS_JSON) {
    console.log(JSON.stringify({ scanned: scanned, changed: plan.length, dry: DRY, byReason: byReason, samples: plan.slice(0, 12) }, null, 2));
} else {
    console.log('空 catch 收敛' + (DRY ? '（试运行）' : '') + '：扫描 ' + scanned + ' 个文件 · 改写 ' + plan.length + ' 处');
    Object.keys(byReason).sort((a, b) => byReason[b] - byReason[a]).forEach((k) => console.log('  · ' + byReason[k] + ' × ' + k));
}

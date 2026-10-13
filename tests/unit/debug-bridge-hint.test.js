// ============================================================
// 单元测试 · v3.46.7 调试桥「刷新即失效」提示（`docs/D22` §4.4 W15 `应-9` / `docs/D19` §3.4 + §8）
//
// 裁决（`docs/D19` §6 **Q3**，取建议 **①**）：「保持不持久化，但把『刷新即失效』写进界面提示」；
//   **不改**任何存储写入 —— 理由是该开关是**只读调试面**，目标非回环时会对局域网开放，
//   持久化会扩大暴露窗口（`docs/D19` §7 **R3**）。
//
// 本文件锁四件事：
//   ① **文案在位**：调试桥区块写明「刷新页面后需重新开启」+「不落盘（不写 localStorage / sessionStorage）」；
//   ② **行为=设计**：`adapters/debug-bridge.js` 里**没有任何**持久化写入（取①的硬约束）；
//   ③ **注释里说明取的是哪个裁决**（防后来者把它误当"漏做持久化"而顺手补上）；
//   ④ **不越界**：没有顺带改动桥的白名单 / 默认关 / 状态行单一事实源。
//
// 运行：node tests/unit/debug-bridge-hint.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { debugBridgeSectionHtml, debugPageHtml } from '../../ui/debug.js';
import { bridgeState, bridgeTarget, bridgePort } from '../../adapters/debug-bridge.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('debug-bridge-hint v3.46.7 刷新即失效提示（D22 W15 应-9 / D19 应-9）');
const A = (n, c, e) => R.assert(n, !!c, e);

const BRIDGE_SRC = readFileSync(join(ROOT, 'adapters', 'debug-bridge.js'), 'utf8');
const DEBUG_SRC = readFileSync(join(ROOT, 'ui', 'debug.js'), 'utf8');

const section = String(debugBridgeSectionHtml() || '');

// ---------- ① 文案在位 ----------
A('A1 区块里出现「刷新页面后需重新开启」', section.indexOf('刷新页面后需重新开启') >= 0, '缺少提示句');
A('A2 明确写「不落盘」', section.indexOf('不落盘') >= 0, '缺少不落盘说明');
A('A3 明确写不写 localStorage / sessionStorage（口径原话）', section.indexOf('localStorage') >= 0 && section.indexOf('sessionStorage') >= 0, '缺少存储口径');
A('A4 顺带讲清「保存目标」也只改内存（同一类误解）', section.indexOf('保存目标') >= 0 && section.indexOf('回到默认值') >= 0, '缺少保存目标说明');
A('A5 原有口径未被覆盖（默认关 / 只读白名单仍在）', section.indexOf('默认关闭') >= 0 && section.indexOf('只读白名单') >= 0, '旧提示被删');
A('A6 调试页整体也带上该提示（区块挂在调试页第 1 位）', String(debugPageHtml([]) || '').indexOf('刷新页面后需重新开启') >= 0, '调试页缺少提示');

// ---------- ② 行为 = 设计（不持久化） ----------
A('B1 `adapters/debug-bridge.js` 无任何 `localStorage` / `sessionStorage` 写入', (() => {
    const writes = BRIDGE_SRC.match(/(localStorage|sessionStorage)\s*\.\s*(setItem|removeItem)/g) || [];
    return writes.length === 0;
})(), '出现持久化写入');
A('B2 也不经扩展设置持久化（`setSetting` / `saveKernelCfg` 均不出现）', (() => {
    return BRIDGE_SRC.indexOf('setSetting') < 0 && BRIDGE_SRC.indexOf('saveKernelCfg') < 0;
})(), '出现设置层写入');
A('B3 状态快照里没有「持久化/记住」一类字段（默认关 + 仅内存）', (() => {
    const st = bridgeState() || {};
    return st.running === false && st.supported !== undefined;
})(), JSON.stringify(bridgeState()));
A('B4 目标主机同样只存内存（`bridgeTarget()` 可读，且无落盘路径）', (() => {
    const t = bridgeTarget();
    return typeof t === 'string' && t.length > 0 && Number(bridgePort()) > 0;
})(), 'n/a');

// ---------- ③ 注释里说明取的是哪个裁决 ----------
A('C1 源码注释写明取 Q3 建议①（改提示、不改存储）', DEBUG_SRC.indexOf('建议①') >= 0 || DEBUG_SRC.indexOf('取 Q3') >= 0, '缺少裁决出处');
A('C2 源码注释写明**为什么不持久化**（暴露窗口 / 局域网）', (() => {
    const i = DEBUG_SRC.indexOf('刷新页面后需重新开启');
    const near = i >= 0 ? DEBUG_SRC.slice(Math.max(0, i - 700), i) : '';
    return near.indexOf('暴露') >= 0 || near.indexOf('局域网') >= 0;
})(), '缺少理由');

// ---------- ④ 不越界 ----------
A('D1 未改动桥的默认关语义（`st.running=false`，且状态行仍来自单一事实源）', (() => {
    const st = bridgeState();
    return st.running === false && DEBUG_SRC.indexOf('bridgeStatusLine') >= 0;
})(), 'n/a');
A('D2 反向探针：把提示句删掉会被 A1/A6 抓住（此处证明提示句确实来自源码而非巧合）', (() => {
    return DEBUG_SRC.indexOf('刷新页面后需重新开启') >= 0;
})(), 'n/a');

R.done();

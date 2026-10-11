// ============================================================
// 单元测试 · v3.45.1「关于页不再显示过期更新状态」（`docs/D22` §4.7 W6 `应-22` · 台账 U178）
//
// 真机事实（`docs/D29` §2 第 9 行）：
//   `update.state.lastResult = {current:"3.40.0", remote:"3.40.1", status:"newer"}`、`hasUpdate true`，
//   而运行版本已是 **3.40.6** —— 界面在版本已最新时仍显示「有新版本」，直到下一次 24h 检查。
// 口径（`docs/D29` §8 `应-22`）：
//   ① 「是否真的更新」用**当前运行版本**与 `lastResult.remote` 比较（本地不低于远端 → 不显示「有新版本」）；
//   ② 陈旧 `lastResult`（其 `current` ≠ 当前运行版本，或超过一个检查周期）→ 标「已过期（时间）」并保留原始记录。
//
// 本文件把这两个口径钉成回归，并给出**反向探针**：S1 用真机形状的记录（current 是旧版本、status='newer'）
//   构造 —— 回退成旧实现（只看 `status === 'newer'`）时 S1 的「不显示有新版本」断言立即失败。
// 运行：node tests/unit/about-update-stale.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { MODULE_NAME, VERSION } from '../../core/constants.js';
import { writeUpdateState, judgeUpdateState, UPDATE_RESULT_STALE_MS } from '../../adapters/update-state.js';
import { hasUpdate } from '../../host/update.js';
import { aboutUpdateLine, aboutHtml, aboutClearCache } from '../../ui/about.js';

const R = makeReporter('about-update-stale v3.45.1 关于页不再显示过期更新状态（应-22 / U178）');
const J = (v) => JSON.stringify(v);

// ---- 宿主 / localStorage / fetch 桩（与 about-golden.test.js 同款） ----
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
const host = makeHost({});
host.ctx.extensionSettings[MODULE_NAME] = {};
installGlobalHost(host, doc);
setKernelState(emptyState());
const lsMap = new Map();
const ls = {
    getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
    setItem: (k, v) => { lsMap.set(String(k), String(v)); },
    removeItem: (k) => { lsMap.delete(String(k)); },
    clear: () => lsMap.clear(),
    key: (i) => Array.from(lsMap.keys())[i] || null,
    get length() { return lsMap.size; },
};
globalThis.window = Object.assign({}, globalThis.window, { localStorage: ls });
// 断网桩：关于页会顺带拉版本清单；本文件只关心更新状态行 → 一律 404，绝不真的联网
const unFetch = installGlobalFetch(() => ({ status: 404, body: {} }));

// ---- 版本号**派生**（不硬编码：VERSION 升位时测试不失效） ----
const SEG = String(VERSION).split('.').map((x) => Number(String(x).replace(/\D/g, '')) || 0);
const OLD_LOCAL = [SEG[0], Math.max(0, SEG[1] - 1), 0].join('.');        // 记录里的「当时本机版本」（真机 = 3.40.0）
const NEWER_REMOTE = [SEG[0], SEG[1] + 1, 0].join('.');                  // 远端更新（真机 = 3.40.1）
const OLDER_REMOTE = [SEG[0], Math.max(0, SEG[1] - 2), 0].join('.');     // 远端更旧
const WHEN = 1700000000000;                                              // 记录里的检查时刻（受控）
const fmt = (t) => new Date(Number(t)).toLocaleString('zh-CN', { hour12: false });

/** 写入一份「上次检查结果」（真机形态：`lastResult` + 同一状态里的 `lastCheckAt`） */
function setResult(lastResult, lastCheckAt) {
    aboutClearCache();
    writeUpdateState({ lastResult: lastResult, lastCheckAt: Number(lastCheckAt) || 0 });
}
const staleRec = (extra) => Object.assign({ at: WHEN, ok: true, current: OLD_LOCAL, remote: NEWER_REMOTE, status: 'newer' }, extra || {});

// ---------- S1：真机复现（**反向探针**）—— 陈旧记录不再冒充「有新版本」 ----------
{
    setResult(staleRec(), WHEN);
    const v = judgeUpdateState();
    const line = aboutUpdateLine();
    const h = aboutHtml();
    R.assert('S1 **反向探针**（真机形状：`lastResult.current=' + OLD_LOCAL + '` 是旧版本、`remote=' + NEWER_REMOTE + '`、'
        + '`status="newer"`，而运行版本是 ' + VERSION + '）：判为陈旧 → `hasUpdate() === false`、'
        + '关于页只显示「已过期（' + fmt(WHEN) + '）」并保留当时记录，**不出现「发现新版本」**'
        + '（回退成旧实现「只看 status === newer」时本断言必须失败）',
        v.status === 'stale' && v.stale === true && hasUpdate() === false
        && !!line && line.status === 'stale' && line.text.indexOf('已过期（' + fmt(WHEN) + '）') > 0
        && line.text.indexOf('当时记录：远端 ' + NEWER_REMOTE + ' / 本机 ' + OLD_LOCAL) > 0
        && line.text.indexOf('发现新版本') < 0
        && h.indexOf('已过期（' + fmt(WHEN) + '）') > 0 && h.indexOf('发现新版本') < 0,
        J({ v, line: line && line.text, hasUpdate: hasUpdate() }));
}

// ---------- S2：本地 == 远端 → 不再显示「有新版本」 ----------
{
    setResult({ at: Date.now(), ok: true, current: VERSION, remote: VERSION, status: 'same' }, Date.now());
    const v = judgeUpdateState();
    const line = aboutUpdateLine();
    const h = aboutHtml();
    R.assert('S2 本地 = 远端（' + VERSION + '）：`status="same"`、`hasUpdate() === false`，关于页显示「本机已是最新」且**不含**「发现新版本」',
        v.status === 'same' && v.stale === false && hasUpdate() === false
        && !!line && line.text.indexOf('本机已是最新（' + VERSION + '）') > 0
        && h.indexOf('本机已是最新') > 0 && h.indexOf('发现新版本') < 0,
        J({ v, line: line && line.text }));
}

// ---------- S3：远端更新 → 正确显示「发现新版本」 ----------
{
    setResult({ at: Date.now(), ok: true, current: VERSION, remote: NEWER_REMOTE, status: 'newer' }, Date.now());
    const v = judgeUpdateState();
    const line = aboutUpdateLine();
    const h = aboutHtml();
    R.assert('S3 远端更新（' + NEWER_REMOTE + ' > ' + VERSION + '）：`status="newer"`、`hasUpdate() === true`，'
        + '关于页显示「发现新版本 ' + NEWER_REMOTE + '（当前 ' + VERSION + '）」',
        v.status === 'newer' && v.stale === false && hasUpdate() === true
        && !!line && line.text.indexOf('发现新版本 ' + NEWER_REMOTE + '（当前 ' + VERSION + '）') > 0
        && h.indexOf('发现新版本 ' + NEWER_REMOTE) > 0,
        J({ v, line: line && line.text }));
}

// ---------- S4：远端更旧（本机开发版）→ 也不显示「有新版本」 ----------
{
    setResult({ at: Date.now(), ok: true, current: VERSION, remote: OLDER_REMOTE, status: 'older' }, Date.now());
    const v = judgeUpdateState();
    const line = aboutUpdateLine();
    R.assert('S4 远端更旧（' + OLDER_REMOTE + ' < ' + VERSION + '）：`status="older"`、`hasUpdate() === false`，'
        + '文案如实说「本机版本高于远端」而不是「发现新版本」（本地不低于远端一律不说有新版本）',
        v.status === 'older' && hasUpdate() === false
        && !!line && line.text.indexOf('本机版本（' + VERSION + '）高于远端（' + OLDER_REMOTE + '）') > 0
        && line.text.indexOf('发现新版本') < 0,
        J({ v, line: line && line.text }));
}

// ---------- S5：时间陈旧（版本号对得上，但记录超过一个检查周期） ----------
{
    const old = Date.now() - (UPDATE_RESULT_STALE_MS + 3600 * 1000);
    setResult({ at: old, ok: true, current: VERSION, remote: NEWER_REMOTE, status: 'newer' }, old);
    const v = judgeUpdateState();
    const line = aboutUpdateLine();
    R.assert('S5 记录里的本机版本与运行版本一致（' + VERSION + '），但已超过有效期 ' + (UPDATE_RESULT_STALE_MS / 3600000) + 'h（与自动检查间隔同源）→ 同样判陈旧：'
        + '`hasUpdate() === false`，文案为「已过期（' + fmt(old) + '）」而不是「发现新版本」',
        v.status === 'stale' && v.stale === true && hasUpdate() === false
        && !!line && line.text.indexOf('已过期（' + fmt(old) + '）') > 0 && line.text.indexOf('发现新版本') < 0,
        J({ v, line: line && line.text }));
}

// ---------- S6：时间字段缺失 → 兜底 `lastCheckAt`；两者都没有 → 「时间未知」（绝不用 Date.now() 冒充） ----------
{
    // 真机形态①：`lastResult` 里没有 `at`（历史记录可能如此），同一状态里有 `lastCheckAt`
    setResult({ ok: true, current: VERSION, remote: NEWER_REMOTE, status: 'newer' }, WHEN);
    const v1 = judgeUpdateState();
    const l1 = aboutUpdateLine();
    const nowStr = fmt(Date.now());
    R.assert('S6a `lastResult` 缺时间字段时，时间取同一状态里的 `lastCheckAt`（' + fmt(WHEN) + '）—— 不用 `Date.now()` 冒充检查时间',
        v1.at === WHEN && v1.atKnown === true && !!l1 && l1.text.indexOf('已过期（' + fmt(WHEN) + '）') > 0
        && l1.text.indexOf(nowStr) < 0,
        J({ at: v1.at, line: l1 && l1.text }));

    // 真机形态②：两处时间都没有 → 如实写「时间未知」，仍标明「已过期」
    setResult({ ok: true, current: OLD_LOCAL, remote: NEWER_REMOTE, status: 'newer' }, 0);
    const v2 = judgeUpdateState();
    const l2 = aboutUpdateLine();
    R.assert('S6b 两处时间字段都缺失（at / lastCheckAt 均为 0）：如实标注「已过期（时间未知）」，**不得**填当前时间充数',
        v2.status === 'stale' && v2.at === 0 && v2.atKnown === false
        && !!l2 && l2.text.indexOf('已过期（时间未知）') > 0 && l2.text.indexOf(fmt(Date.now())) < 0,
        J({ v: v2, line: l2 && l2.text }));
}

// ---------- S7：无记录 → 不渲染该行（不编造状态） ----------
{
    aboutClearCache();
    writeUpdateState({ lastResult: null, lastCheckAt: 0 });
    const v = judgeUpdateState();
    const line = aboutUpdateLine();
    const h = aboutHtml();
    R.assert('S7 从未检查（`lastResult === null`）：`status="none"`、状态行返回 `null`，关于页**不出现**这一行（宁可不说，也不编造「有新版本」）',
        v.status === 'none' && line === null && h.indexOf('更新检查：') < 0 && h.indexOf('发现新版本') < 0,
        J({ v, line, hasLine: h.indexOf('更新检查：') }));
}

// ---------- S8：判定用的是**当前运行版本**（而非记录里的 current / status） ----------
{
    // 记录里只有「远端 = 本机当前版本」+ 旧结论 `status: 'newer'`（真机上 lastResult 的 current/status 都是**当时**的值）
    //   → 按运行版本比较得到「本地 = 远端」→ 必须改口 `same`；只按 `status === 'newer'` 就会继续谎报有新版本
    setResult({ at: Date.now(), ok: true, remote: VERSION, status: 'newer' }, Date.now());
    const relabeled = judgeUpdateState();
    R.assert('S8 记录写着 `status: "newer"`、`remote` 恰等于运行版本（' + VERSION + '）→ 判定为 `same`（比较的是**当前运行版本**'
        + '而不是记录里的 `status`；真机「界面在已最新时仍说有新版本」就是同一根因）',
        relabeled.status === 'same' && relabeled.stale === false && hasUpdate() === false,
        J(relabeled));
}

// ---------- S9：git 真值与原始结果形状（判定口径被 host/update.js 复用） ----------
{
    const now = Date.now();
    setResult({ at: now, ok: true, current: VERSION, remote: VERSION, status: 'same', commitOnly: true }, now);
    const git = judgeUpdateState();
    R.assert('S9a Git 真值优先：端点报「同版本新提交」（`commitOnly`）时版本号比较判不出差异，仍算有更新（`status="newer"`）—— 与修复前语义一致',
        git.status === 'newer' && git.commitOnly === true && hasUpdate() === true,
        J(git));

    R.assert('S9b 逐次检查的**原始结果**（`runUpdateCheck` 输出形状：`judge.status`）同样走这套判定：远端更高 → 有更新；失败 → 不算有更新',
        hasUpdate({ ok: true, judge: { status: 'newer', current: VERSION, remote: NEWER_REMOTE } }) === true
        && hasUpdate({ ok: true, judge: { status: 'same', current: VERSION, remote: VERSION } }) === false
        && hasUpdate({ ok: false, judge: { status: 'newer', current: VERSION, remote: NEWER_REMOTE }, error: 'HTTP 500' }) === false
        && judgeUpdateState({ lastResult: { ok: false, at: now, current: VERSION, remote: NEWER_REMOTE, status: 'newer', error: 'HTTP 500' } }).status === 'error',
        J({ newer: hasUpdate({ ok: true, judge: { status: 'newer', current: VERSION, remote: NEWER_REMOTE } }) }));
}

aboutClearCache();
unFetch();
R.done();

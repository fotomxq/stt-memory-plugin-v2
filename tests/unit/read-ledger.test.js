// ============================================================
// 单元测试 · v3.0.23「读取台账」（core/read-ledger.js）
//
// 用户要求（原话）：「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志，
//   方便追踪问题。」
//
// 本文件把台账的四条硬约定钉成回归：
//   · 每条记录都有**来源 / 动作 / 目标 / 耗时 / 体积 / 条数 / 结果**（缺一不可，且**不含正文**）；
//   · 分来源统计（次数 / 成功 / 失败 / 未命中 / 累计与最慢耗时 / 体积 / 条数）可直接读；
//   · 内存恒定（环形上限 `READ_LEDGER_CAP`，最新在前）；
//   · **绝不抛**：宿主注入的日志出口抛错也不影响记录本身（观测设施不能反过来弄坏主流程）。
//
// 运行：node tests/unit/read-ledger.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import {
    READ_LEDGER_CAP, READ_SRC_LABEL, readSrcLabel, setReadLedgerHooks, readLedgerBegin, readLedgerEnd,
    readLedgerRecord, readLedgerList, readLedgerStats, readLedgerLine, readLedgerLines, readLedgerSummaryText,
    resetReadLedger, fmtBytes, fmtMs,
} from '../../core/read-ledger.js';

const R = makeReporter('read-ledger v3.0.23 读取台账：统计 / 时间 / 环形上限 / 绝不抛');
const J = (v) => JSON.stringify(v);

// 受控时钟（台账内所有时间都经 `hooks.now`，可注入 → 测试可精确断言耗时）
let clock = 1700000000000;
setReadLedgerHooks({ now: () => clock, log: () => undefined });
resetReadLedger();

// ---------- A 组：记录字段与耗时 ----------
{
    const tok = readLedgerBegin('读主文件', 'file', { target: 'ftt2-state-char1.json' });
    clock += 37;
    const rec1 = readLedgerEnd(tok, { ok: true, bytes: 40960, items: 120, hash: 'abc123def456', note: '信封校验通过' });
    clock += 5;
    const rec2 = readLedgerRecord({ action: '读本机缓冲', src: 'local', target: 'ftt2_state_char1', ok: true, miss: true, reason: 'no-local-buffer' });
    clock += 3;
    const rec3 = readLedgerRecord({ action: '通道读取失败', src: 'file', target: 'ftt2-shard-x-atoms.json', ms: 12, ok: false, reason: 'timeout' });
    const list = readLedgerList();
    R.assert('A1 每次读取都是一条结构化记录：来源（含中文标签）/ 动作 / 目标 / 耗时 / 体积 / 条数 / 哈希 / 结果（成功 · 未命中 · 失败）与原因，且**不含任何正文**',
        !!rec1 && rec1.srcLabel === READ_SRC_LABEL.file && rec1.ms === 37 && rec1.bytes === 40960 && rec1.items === 120
        && rec1.ok === true && rec1.miss === false && rec1.hash === 'abc123def456'
        && rec2.miss === true && rec2.ok === true && rec2.reason === 'no-local-buffer'
        && rec3.ok === false && rec3.ms === 12 && rec3.reason === 'timeout'
        && list.length === 3 && list[0].action === '通道读取失败'
        && !('text' in rec1) && !('payload' in rec1) && !('data' in rec1),
        J({ rec1, rec2, rec3, list: list.length }));
}

// ---------- B 组：分来源统计 ----------
{
    resetReadLedger();
    readLedgerRecord({ action: '读分片', src: 'shard', ms: 8, bytes: 1024, items: 6 });
    readLedgerRecord({ action: '读分片', src: 'shard', ms: 4, bytes: 512, items: 2 });
    readLedgerRecord({ action: '读分片', src: 'shard', ms: 20, bytes: 0, items: 0, ok: false, reason: 'hash-mismatch' });
    readLedgerRecord({ action: '读分片清单', src: 'meta', ms: 6, bytes: 300, fields: 15 });
    readLedgerRecord({ action: '读聊天元数据', src: 'chatmeta', miss: true });
    const st = readLedgerStats();
    const sh = st.bySrc.shard;
    R.assert('B1 分来源统计：次数 / 成功 / 失败 / 未命中 / 累计与平均与最慢耗时 / 体积 / 条数 / 字段数——逐层可直接读（「到底读了哪一层、哪层慢、哪层老失败」一眼可见）',
        !!sh && sh.n === 3 && sh.ok === 2 && sh.fail === 1 && sh.ms === 32 && sh.maxMs === 20 && sh.avgMs === 11
        && sh.bytes === 1536 && sh.items === 8 && sh.label === READ_SRC_LABEL.shard
        && st.bySrc.meta.fields === 15 && st.bySrc.meta.n === 1
        && st.bySrc.chatmeta.miss === 1 && st.bySrc.chatmeta.n === 1
        && st.totalReads === 5 && st.fail === 1 && st.miss === 1 && st.cap === READ_LEDGER_CAP
        && st.slowest.length === 5 && st.slowest[0].ms === 20 && st.recent.length === 5,
        J({ sh, total: st.totalReads, fail: st.fail, miss: st.miss, slowest: st.slowest.length, recent: st.recent.length }));
}

// ---------- C 组：内存恒定（环形上限） ----------
{
    resetReadLedger();
    for (let i = 0; i < READ_LEDGER_CAP + 50; i++) readLedgerRecord({ action: '读第 ' + i + ' 次', src: 'file', ms: 1 });
    const list = readLedgerList();
    const st = readLedgerStats();
    R.assert('C1 内存恒定：环形缓冲固定 ' + READ_LEDGER_CAP + ' 条、**最新在前**（第 ' + (READ_LEDGER_CAP + 49) + ' 次在最前）；累计次数仍如实统计（不受缓冲上限影响）',
        list.length === READ_LEDGER_CAP && list[0].action === '读第 ' + (READ_LEDGER_CAP + 49) + ' 次'
        && list[READ_LEDGER_CAP - 1].action === '读第 50 次' && st.totalReads === READ_LEDGER_CAP + 50
        && st.bySrc.file.n === READ_LEDGER_CAP + 50,
        J({ len: list.length, head: list[0].action, tail: list[list.length - 1].action, total: st.totalReads }));
}

// ---------- D 组：日志出口（宿主注入）与「绝不抛」 ----------
{
    resetReadLedger();
    const logged = [];
    setReadLedgerHooks({ now: () => clock, log: (rec) => logged.push(rec) });
    // v3.10.4（真机 A5）：**常规成功读取不再镜像进调试日志**（真机上它曾占满 69% 的日志环）
    readLedgerRecord({ action: '读主文件', src: 'file', ms: 3, bytes: 10, items: 1 });
    const afterRoutine = logged.length;
    // 失败 / 未命中 / 慢读才镜像；`quiet` 可单条静默；`mirror:true` 可强制
    readLedgerRecord({ action: '读分片', src: 'shard', ms: 2, ok: false, reason: 'HTTP 500' });
    readLedgerRecord({ action: '注入内存态', src: 'memory', ms: 0, items: 9, quiet: true });
    readLedgerRecord({ action: '读慢文件', src: 'file', ms: 200 });
    readLedgerRecord({ action: '手工强制', src: 'other', ms: 1, mirror: true });
    const afterGoodHook = logged.length;
    // 宿主日志出口抛错 → 记录仍然进台账（观测设施绝不弄坏主流程）
    setReadLedgerHooks({ log: () => { throw new Error('host log exploded'); } });
    readLedgerRecord({ action: '读分片失败', src: 'shard', ms: 2, ok: false, reason: 'boom' });
    const n = readLedgerList().length;
    // 非法入参（null / 非对象）也不抛
    const bad1 = readLedgerEnd(null, {});
    const bad2 = readLedgerRecord({ src: '不存在的来源' });
    setReadLedgerHooks({ log: () => undefined });
    R.assert('D1 日志出口只收**异常 / 未命中 / 慢读**（常规成功读取不镜像 —— A5 修复）；`quiet` 可静默、`mirror:true` 可强制；**出口抛错也不影响台账**（记录照进、调用方不炸），非法入参同样不抛、未知来源回落「其它」',
        afterRoutine === 0 && afterGoodHook === 3 && n === 6 && bad1 === null && !!bad2 && bad2.srcLabel === READ_SRC_LABEL.other,
        J({ afterRoutine, afterGoodHook, n, bad1, bad2: bad2 && bad2.src }));
}

// ---------- E 组：人读文本（日志 / 调试包） ----------
{
    resetReadLedger();
    readLedgerRecord({ action: '读主文件', src: 'file', target: 'ftt2-state-char1.json', ms: 42, bytes: 40960, items: 120, hash: 'a1b2c3d4e5' });
    readLedgerRecord({ action: '读分片', src: 'shard', target: 'ftt2-shard-x-atoms.json', ms: 8, bytes: 2048, items: 6, ok: false, reason: 'hash-mismatch' });
    const line = readLedgerLine(readLedgerList()[1]);
    const lines = readLedgerLines(10);
    const text = readLedgerSummaryText(10);
    R.assert('E1 人读文本：单行 = 时间 · 来源 · 动作 · 目标 · 结果 · 耗时 · 体积 · 条数 · 哈希 · 原因；汇总 = 总次数与耗时 + 分来源一行一条（调试页区块与调试包共用同一份口径）',
        line.indexOf('服务端文件') >= 0 && line.indexOf('读主文件') >= 0 && line.indexOf('✓') >= 0 && line.indexOf('42ms') >= 0
        && line.indexOf('40.0KB') >= 0 && line.indexOf('120 条') >= 0 && line.indexOf('#a1b2c3d4') >= 0
        && lines.length === 2 && lines[0].indexOf('失败') >= 0 && lines[0].indexOf('原因：hash-mismatch') >= 0
        && text.indexOf('读取台账：共 2 次') >= 0 && text.indexOf('成功 1 / 失败 1') >= 0
        && text.indexOf('服务端文件：1 次') >= 0 && text.indexOf('服务端分片：1 次') >= 0,
        J({ line, lines, head: text.split('\n').slice(0, 4) }));
}

// ---------- F 组：格式化 + 复位 + 来源表 ----------
{
    resetReadLedger();
    readLedgerRecord({ action: '读文件', src: 'file', ms: 1 });
    const beforeReset = readLedgerList().length;
    resetReadLedger();
    const st = readLedgerStats();
    const srcs = Object.keys(READ_SRC_LABEL);
    const need = ['file', 'shard', 'meta', 'local', 'idb', 'chatmeta', 'remote', 'settings', 'cfg', 'memory'];
    const missing = need.filter((k) => srcs.indexOf(k) < 0);
    R.assert('F1 体积 / 时长格式化（B / KB / MB；ms / s）+ 复位清空 + 来源标签表覆盖「服务端 / 本地 / 内存」全部层次（未知来源回落「其它」，绝不出现空标签）',
        fmtBytes(512) === '512B' && fmtBytes(2048) === '2.0KB' && fmtBytes(3 * 1024 * 1024) === '3.00MB'
        && fmtMs(0) === '0ms' && fmtMs(999) === '999ms' && fmtMs(1500) === '1.5s'
        && beforeReset === 1 && st.totalReads === 0 && st.bySrc && Object.keys(st.bySrc).length === 0
        && missing.length === 0 && readSrcLabel('nope') === READ_SRC_LABEL.other && readSrcLabel('') === READ_SRC_LABEL.other,
        J({ missing, st: st.totalReads }));
}

R.done();

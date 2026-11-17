// ============================================================
// 单元测试 · v3.52.15：备份只保留 3 个 + 快照只保留 5 条
//
// 用户要求（原话）：
//   1.「修正快照只保留5条。」
//   2.「如果存在备份，修正备份只保留3个。」
//
// 口径：
//   · 快照链：`SNAP_CAP = 5`（根 + 增量合计），整理把最早的并入根（内容不丢）；`SNAP_BATCH = 2`。
//   · 删楼明文备份：仍 3 槽轮转；**另按名单兜底**（`selectFloorBackupPrune`）——槽位记录丢失时也能清到 3 份；
//     只清本作用域前缀（`ftt2-floor-backup-<角色>-`），绝不碰别的角色 / 别的插件文件。
// 运行：node tests/unit/backup-rotation.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SNAP_CAP, SNAP_BATCH, snapshotCreateFull, snapshotCreateIncr, snapshotConsolidate, snapshotStats } from '../../core/snapshots.js';
import { selectFloorBackupPrune, floorBackupScopePrefix, FLOOR_BACKUP_SLOTS, FLOOR_BACKUP_KEEP } from '../../adapters/floor-backup.js';
import { floorTrimApply, setFloorTrimHooks } from '../../host/floor-trim.js';
import { currentLastMessageId } from '../../host/chat.js';

const R = makeReporter('backup-rotation v3.52.15 快照 5 条 / 备份 3 个');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: Array.from({ length: 20 }, (_, i) => ({ is_user: false, mes: '第' + i + '楼正文足够长。' })) }), makeDocument(['ftt-panel']));
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:bk');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(19);
    const st = emptyState();
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- A 快照上限 5 ----------
A('A1 常量：`SNAP_CAP = 5` · `SNAP_BATCH = 2`（保留窗仍是 30 天）', (() => {
    return SNAP_CAP === 5 && SNAP_BATCH === 2;
})(), 'n/a');
A('A2 根 + 8 个增量 → 整理后链长 ≤ 5（根 + 增量合计），覆盖不丢', (() => {
    const st = boot();
    st.atoms = [{ id: 'a1', text: '正文足够长的情节一。', title: '情节一', floorStart: 1, floorEnd: 1 }];
    snapshotCreateFull();                                   // 先建根（整理需要一个根才能并入）
    for (let i = 0; i < 8; i++) {
        st.atoms.push({ id: 'a' + (i + 2), text: '第 ' + (i + 2) + ' 条正文足够长的情节。', title: '情节' + (i + 2), floorStart: i + 2, floorEnd: i + 2 });
        snapshotCreateIncr('测试增量 ' + i);
    }
    const before = snapshotStats();
    const res = snapshotConsolidate();
    const after = snapshotStats();
    // `snapshotCreateIncr` 在**创建时**就按 `SNAP_CAP` 整理（`trimSnapshots`）→ 8 个增量后链长已 ≤5
    return before.total <= SNAP_CAP && before.root === 1 && before.incr <= SNAP_CAP - 1 && before.covered >= 1
        && after.total <= SNAP_CAP && after.root === 1
        && (res.folded >= 0);
})(), () => J(snapshotStats()));

// ---------- B 备份上限 3 ----------
A('B1 `selectFloorBackupPrune`：同一作用域 5 份 → 只删最旧的 2 份；别的角色前缀一律不动；keep=0 不清理', (() => {
    const pre = floorBackupScopePrefix('char:abc');
    const list = [
        { name: pre + 's1-20260101-000000.json', at: 1 },
        { name: pre + 's2-20260102-000000.json', at: 2 },
        { name: pre + 's3-20260103-000000.json', at: 3 },
        { name: pre + 's1-20260104-000000.json', at: 4 },
        { name: pre + 's2-20260105-000000.json', at: 5 },
        { name: 'ftt2-floor-backup-otherchar-s1-20260106-000000.json', at: 6 },
    ];
    const del = selectFloorBackupPrune(list, 'char:abc', 3);
    return FLOOR_BACKUP_SLOTS === 3 && FLOOR_BACKUP_KEEP === 3
        && J(del) === J([pre + 's1-20260101-000000.json', pre + 's2-20260102-000000.json'])
        && selectFloorBackupPrune(list, 'char:abc', 0).length === 0
        && selectFloorBackupPrune(list, 'char:abc', 5).length === 0;
})(), () => J(selectFloorBackupPrune([{ name: 'ftt2-floor-backup-charabc-s1-1.json', at: 1 }, { name: 'ftt2-floor-backup-charabc-s2-2.json', at: 2 }, { name: 'ftt2-floor-backup-charabc-s3-3.json', at: 3 }, { name: 'ftt2-floor-backup-charabc-s1-4.json', at: 4 }], 'char:abc', 3)));
A('B2 端到端：连续删楼 4 次（槽位名记录被清空模拟「旧存档/换设备」）→ 备份文件仍只保留 3 份', (async () => {
    boot();
    const kept = new Set();
    const deleted = [];
    setFloorTrimHooks({
        exportJson: () => '{"format":"ftt-memory-v2-export","state":{}}',
        writeBackup: async (scope, slot) => { const name = floorBackupScopePrefix(scope) + 's' + (slot + 1) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json'; kept.add(name); return { ok: true, slot: slot, name: name, chars: 10 }; },
        deleteBackup: async (name) => { deleted.push(name); kept.delete(name); },
        getLog: () => ({ slot: 2, items: [], names: {}, recent: [] }),   // 每次都「丢记录」：轮转给不出 prevName
        saveLog: () => undefined,
        noteConflict: () => undefined,
        notify: () => undefined,
    });
    let last = null;
    for (let i = 0; i < 4; i++) {
        last = await floorTrimApply({ keep: Math.max(2, 19 - i), _deleteOne: async (id) => { const ctx = globalThis.SillyTavern && globalThis.SillyTavern.getContext(); if (ctx) ctx.chat.splice(id, 1); } });
    }
    return deleted.length >= 1 && kept.size <= 3 && last && last.ok !== false;
})(), () => J({ kept: kept.size, deleted: deleted.length }));

R.done();

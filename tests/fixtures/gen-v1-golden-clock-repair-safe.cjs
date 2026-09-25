'use strict';
// ============================================================
// v2.50.0 oracle：「时间巡检修复」的两处**改错时钟数据**（V1 现状 = 缺陷 #7 证据）
//   → tests/fixtures/v1-golden-clock-repair-safe.json
// 用户报告：「时间循环（巡检）修复，会改错时钟数据。」
//
// 固化 V1 v1.206 的两个危险行为：
//   ① `clockPatrolRepairItem` 对**格式合法但年份漂移**的条目也先做「按内容重解析」→
//      一条日期本是对的记录，只要内容里提到别的年份，就会被覆盖成内容里的日期；
//   ② 总览「🩺 时间巡检修复」按钮走 `runClockPatrolRepair({ force: true })`（v1.206 27505）→
//      **绕过**「锚点与库内多数年份冲突」闸门 → 锚点一旦错，整库年份被按错锚点改写。
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// ============================================================
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, waitPipelineIdle } = require(path.join(V1, 'tests/unit/helpers.js'));
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const REAL_STDOUT = process.stdout.write.bind(process.stdout);
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

const ANCHOR = '1919-11-25';

async function boot(statePatch, cfgPatch) {
    const F = await loadPlugin(makeTavernEnv({}));
    const st = F.cfg.storage;
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { st[k] = false; });
    st.localStorage = true; st.syncOnSave = false; st.autoIdleCheck = false;
    await waitPipelineIdle(F);
    F.cfg.stateDecayEnabled = false; F.cfg.memoryForgetEnabled = false; F.cfg.parallelDecayEnabled = false;
    F.cfg.clockAutoPatrol = false; F.cfg.clockForceDegrade = false;
    F.cfg.clockAnomalyJumpYears = 50;
    if (cfgPatch) Object.assign(F.cfg, cfgPatch);
    F.state = Object.assign({}, F.state, {
        currentStates: [], snapshots: [], memories: [], items: [], currencies: [], rumors: [], plans: [], suspense: [],
        scenes: [], concepts: [], parallels: [], links: [], summaries: [], processedFloors: [], lastKnownFloor: -1,
        atoms: [], state: { date: ANCHOR, time: '', location: '', present: [] },
    }, proj(statePatch || {}));
    return F;
}
const datesOf = (F) => (F.state.atoms || []).map((a) => ({ id: a.id, date: a.date, time: a.time || '' }));

(async function main() {
    const out = {
        meta: {
            v1Version: 'v1.206',
            generatedBy: 'tests/fixtures/gen-v1-golden-clock-repair-safe.cjs',
            note: 'V1 时间巡检修复的两处危险行为：①「格式合法但年份漂移」的条目也会被「按内容重解析」覆盖；② 手动巡检 force:true 绕过锚点冲突闸门按错锚点整库改年。V2 v2.50.0 已收紧（#7）。',
            anchor: ANCHOR,
        },
    };

    // ---------- A 组：年份漂移的条目被「按内容重解析」覆盖（本应只校正年份或保留） ----------
    {
        const F = await boot({
            atoms: [
                // 日期 2035-05-05（年份漂移）——但正文里提到 1919年11月20日
                { id: 'a1', text: '甲回忆起 1919年11月20日 在码头交货的旧事。', date: '2035-05-05', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
                // 库内多数：1919 年（保证锚点=1919、且不触发锚点冲突）
                { id: 'a2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
                { id: 'a3', text: '丙把账册锁进木箱。', date: '1919-11-20', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
            ],
        });
        let rep = null;
        try { rep = F.runClockPatrolRepair({ force: true }); } catch (e) { rep = { error: String(e.message) }; }
        out.A = {
            before: [{ id: 'a1', date: '2035-05-05' }],
            after: datesOf(F),
            fixed: Number(rep && rep.fixed) || 0,
            details: proj((rep && rep.details) || []),
            note: 'V1 把 a1 的日期改成正文里的 1919-11-20（**改错**：该条原本是 2035 的年份漂移项，正确修法是保留月日换年份或保留原值）',
        };
    }

    // ---------- B 组：手动巡检 force 绕过锚点冲突（错锚点 → 整库改年） ----------
    {
        const atomsB = [
            { id: 'b1', text: '甲在码头交货。', date: '1919-11-18', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
            { id: 'b2', text: '乙在钟鼓楼等人。', date: '1919-11-19', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
            { id: 'b3', text: '丙锁上木箱。', date: '1919-11-20', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
            { id: 'b4', text: '丁把钥匙交给甲。', date: '1919-11-21', type: '支线', floorStart: 7, floorEnd: 8, uses: 0, tags: [] },
        ];
        const manualState = (date) => ({ state: { date: date || '', time: '', location: '', present: [], clockManual: { date: '1800-01-01', time: '', location: '', at: 1 } } });
        // ① 不带 force（V2 默认路径的等价物）
        const Fsafe = await boot({ atoms: proj(atomsB), ...manualState() }, { clockManualLock: true });
        const info = (() => { try { return Fsafe.clockPatrolAnchorInfo ? Fsafe.clockPatrolAnchorInfo() : null; } catch (e) { return null; } })();
        let repSafe = null;
        try { repSafe = Fsafe.runClockPatrolRepair({}); } catch (e) { repSafe = { error: String(e.message) }; }
        // ② force:true（V1 总览按钮的等价物）
        const Fforce = await boot({ atoms: proj(atomsB), ...manualState() }, { clockManualLock: true });
        let repForce = null;
        try { repForce = Fforce.runClockPatrolRepair({ force: true }); } catch (e) { repForce = { error: String(e.message) }; }
        out.B = {
            anchor: (info && info.date) || '',
            anchorSource: (info && info.source) || '',
            conflict: proj(info && info.conflict),
            safePath: { fixed: Number(repSafe && repSafe.fixed) || 0, blocked: String((repSafe && repSafe.blocked) || ''), after: datesOf(Fsafe) },
            force: { fixed: Number(repForce && repForce.fixed) || 0, blocked: String((repForce && repForce.blocked) || ''), after: datesOf(Fforce) },
            note: '不带 force → 锚点冲突时「只统计不修改」；force:true（V1 按钮）→ 按错锚点 1800 整库改年（V2 v2.50.0 起手动按钮默认走安全路径，强制需显式二次动作）',
        };
    }

    // ---------- C 组：真正坏的（格式非法）仍应被修复或清空 ----------
    {
        const F = await boot({
            atoms: [
                { id: 'c1', text: '甲把铜箱交给乙。', date: '1919-11-20', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
                { id: 'c2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
                { id: 'c3', text: '丙记下日期：1919年11月21日。', date: '1919-13-45', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
            ],
        });
        let rep = null;
        try { rep = F.runClockPatrolRepair({ force: true }); } catch (e) { rep = { error: String(e.message) }; }
        out.C = { after: datesOf(F), fixed: Number(rep && rep.fixed) || 0, details: proj((rep && rep.details) || []), note: '格式非法仍可按内容重解析（或清空）—— 这条修复是安全的' };
    }

    const text = JSON.stringify(out, null, 1);
    REAL_STDOUT(text, () => process.exit(0));
})();

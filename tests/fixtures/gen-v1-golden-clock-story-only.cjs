'use strict';
// ============================================================
// v2.39.0 oracle：「时钟不得取真实日期」对照样本
//   → tests/fixtures/v1-golden-clock-story-only.json
// 目的：把 **V1 v1.206 的现状**（无剧情日期时 `stampNowForState()` 回退现实墙钟 → 把现实日期写进
//   `memories[].date` / `currentStates[].updatedAt|updatedAtTime` 并进入注入正文）固化成**可复查的证据**，
//   以便 V2 的修正（改为「只取剧情时间」）能逐项断言差异 —— 与既有三处「V1 故障明确修正」同口径。
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致；
//   现实日期/时刻归一为 <TODAY> / <NOW>（跨午夜仍可复现）。
// ============================================================
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, waitPipelineIdle } = require(path.join(V1, 'tests/unit/helpers.js'));
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const REAL_STDOUT = process.stdout.write.bind(process.stdout);
const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-clock-story-only.json');
const norm = (s) => {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return String(s == null ? '' : s)
        .split(today).join('<TODAY>')
        .split(hhmm).join('<NOW>')
        .split(String(d.getFullYear())).join('<YEAR>');
};
const clone = (o) => JSON.parse(JSON.stringify(o));

async function boot() {
    const F = await loadPlugin(makeTavernEnv());
    const st = F.cfg.storage;
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { st[k] = false; });
    st.localStorage = true; st.syncOnSave = false; st.autoIdleCheck = false;
    await waitPipelineIdle(F);
    F.cfg.stateDecayEnabled = false; F.cfg.memoryForgetEnabled = false; F.cfg.parallelDecayEnabled = false;
    F.cfg.clockAutoPatrol = false; F.cfg.clockForceDegrade = false; F.cfg.clockAnomalyJumpYears = 50;
    return F;
}
function reset(F, date) {
    F.state = Object.assign({}, F.state, {
        atoms: [], currentStates: [], snapshots: [], memories: [], items: [], currencies: [], plotSegments: [],
        plans: [], suspense: [], scenes: [], concepts: [], parallels: [], links: [], vars: {},
        state: { date: date || '', time: date ? '傍晚' : '', location: '', present: [] },
        summaries: [], processedFloors: [], lastKnownFloor: -1,
    });
    return F;
}

(async function main() {
    const out = { meta: { v1Version: 'v1.206', generatedBy: 'tests/fixtures/gen-v1-golden-clock-story-only.cjs', note: 'V1 在无剧情日期时把现实墙钟写进剧情时间字段（memories[].date / currentStates[].updatedAt|updatedAtTime）并进入注入正文 —— V2 v2.39.0 已修正为「只取剧情时间」，本样本用于断言差异' } };
    // ---------- A 组：无剧情日期（V1 写现实日期） ----------
    {
        const F = await boot();
        reset(F, '');
        F.mergeDelta({ memories: { add: [{ title: '记忆甲', content: '甲在码头清点铜箱' }] }, states: { add: [{ subject: '甲', field: '体力', value: '疲惫' }] } });
        out.A = {
            memories: (F.state.memories || []).map(m => ({ title: m.title, date: norm(m.date) })),
            states: (F.state.currentStates || []).map(s => ({ subject: s.subject, updatedAt: norm(s.updatedAt), updatedAtTime: norm(s.updatedAtTime) })),
            // 注意：此处「11月29日」被 V1 **接受**并沿用 2026 —— 因为上一步刚把现实日期写进记忆，
            //   而手工录入的「可用年份」来源之一就是**原子数据多数派**（含记忆）→ 现实年份被反向污染锚点。
            //   （若在写入前调用，V1 会拒绝并提示补全年份 —— 见 v1.187 的口径。）
            manualYearless: (() => { try { const r = F.parseClockManualInput({ date: '11月29日' }); return { ok: r.ok, date: norm(r.date), notes: (r.notes || []).map(norm) }; } catch (e) { return { error: String(e.message) }; } })(),
            majorityYear: (() => { try { const m = F.clockPatrolMajority ? F.clockPatrolMajority() : null; return m ? { year: norm(m.year), count: m.count, total: m.total } : null; } catch (e) { return null; } })(),
        };
        try {
            const inj = String(await F.buildInjectText());
            out.A.injectMemoryLines = inj.split('\n').filter(l => l.indexOf('记忆甲') >= 0).map(norm);
        } catch (e) { out.A.injectErr = String(e.message); }
    }
    // ---------- B 组：有剧情日期（V1 用剧情日期 —— V2 必须保持一致） ----------
    {
        const F = await boot();
        reset(F, '1919-11-20');
        F.mergeDelta({ memories: { add: [{ title: '记忆乙', content: '乙在钟鼓楼' }] }, states: { add: [{ subject: '乙', field: '状态', value: '警戒' }] } });
        out.B = {
            memories: (F.state.memories || []).map(m => ({ title: m.title, date: norm(m.date) })),
            states: (F.state.currentStates || []).map(s => ({ subject: s.subject, updatedAt: norm(s.updatedAt), updatedAtTime: norm(s.updatedAtTime) })),
        };
        try {
            const inj = String(await F.buildInjectText());
            out.B.injectMemoryLines = inj.split('\n').filter(l => l.indexOf('记忆乙') >= 0).map(norm);
        } catch (e) { out.B.injectErr = String(e.message); }
    }
    const text = JSON.stringify(out, null, 1);
    REAL_STDOUT(text, () => process.exit(0));
})();

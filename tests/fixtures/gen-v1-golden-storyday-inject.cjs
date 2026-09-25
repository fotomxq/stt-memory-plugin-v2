'use strict';
// ============================================================
// v2.48.0 oracle：「剧情第 N 天」是否进入**注入体**（V1 缺陷 #6 证据）
//   → tests/fixtures/v1-golden-storyday-inject.json
// 用户要求：「**剧情第N天，不允许注入**，这个设定只是在插件内校准时间用的。」
//
// 做法：boot 真实 V1 v1.206 → 写入带 `storyDay` 的 state → 取 `buildMemoryBodyForInject('', { diagnose:true })`
//   的 `bodyText`（即真正注入给 AI 的正文），记录其中是否含「剧情天数:第N天」；
//   同时取「内部校准」两件事的证据：① `▶第 N 天` 正文头解析出 `storyDay`；
//   ② 设定 `clockStoryDayEpoch`（纪元首日）后，「第 N 天」能否换算成**日期**（这才是该设定的用途）。
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// ============================================================
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, waitPipelineIdle } = require(path.join(V1, 'tests/unit/helpers.js'));
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const REAL_STDOUT = process.stdout.write.bind(process.stdout);
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

const STORY_DAY = 500;                       // 「▶第 500 天」
const EPOCH = '1919-11-01';                  // 纪元首日（设定 clockStoryDayEpoch）
const HEADER_TEXT = '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路)';
const PLAIN_TEXT = '▷1919年11月29日（东汉建武二十七年）·冬(长街)\n▷码头仓库\n甲推开木门。';

async function boot(epoch) {
    const F = await loadPlugin(makeTavernEnv({}));
    const st = F.cfg.storage;
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { st[k] = false; });
    st.localStorage = true; st.syncOnSave = false; st.autoIdleCheck = false;
    await waitPipelineIdle(F);
    F.cfg.stateDecayEnabled = false; F.cfg.memoryForgetEnabled = false; F.cfg.parallelDecayEnabled = false;
    F.cfg.clockAutoPatrol = false; F.cfg.clockForceDegrade = false;
    F.cfg.clockStoryDayEpoch = epoch || '';
    F.cfg.injectConstraintBlock = false;      // 只关心 [当前状态] 块，约束段略去
    F.state = Object.assign({}, F.state, {
        atoms: [{ id: 'a1', text: '甲把铜箱交给乙。', date: '1919-11-20', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: ['码头'] }],
        memories: [], currentStates: [], snapshots: [], items: [], currencies: [], rumors: [], plans: [], suspense: [],
        scenes: [], concepts: [], parallels: [], links: [], summaries: [], processedFloors: [], lastKnownFloor: -1,
        state: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'], storyDay: STORY_DAY, clockStoryDayEpoch: epoch || '' },
    });
    return F;
}

(async function main() {
    const out = {
        meta: {
            v1Version: 'v1.206',
            generatedBy: 'tests/fixtures/gen-v1-golden-storyday-inject.cjs',
            note: 'V1 把「剧情天数:第N天」写进注入体的 [当前状态] 块（用户明确要求**不允许注入**：该值只在插件内做时间校准）。V2 v2.48.0 已移除，本样本用于断言差异（V1 故障明确修正 #6）。',
            storyDay: STORY_DAY,
            epoch: EPOCH,
        },
    };

    // ---------- A 组：注入体（V1 现状） ----------
    {
        const F = await boot('');
        let body = '';
        try { body = String((F.buildMemoryBodyForInject('', { diagnose: true }) || {}).bodyText || ''); } catch (e) { body = 'ERR:' + String(e.message); }
        const stateLines = body.split('\n').filter((l) => l.indexOf('日期:') >= 0 || l.indexOf('时间:') >= 0 || l.indexOf('地点:') >= 0 || l.indexOf('在场角色') >= 0 || l.indexOf('剧情天数') >= 0);
        out.A = {
            bodyHasStoryDay: body.indexOf('剧情天数') >= 0 || body.indexOf('第' + STORY_DAY + '天') >= 0,
            storyDayLine: stateLines.filter((l) => l.indexOf('剧情天数') >= 0)[0] || '',
            stateLines: stateLines,
            bodyHead: body.split('\n').slice(0, 8),
        };
    }

    // ---------- B 组：内部校准 —— `▶第 N 天` 解析出 storyDay（未设纪元首日 → 只记天数） ----------
    {
        const F = await boot('');
        F.state.state.date = '';                 // 无已知剧情日期
        F.state.atoms = [];                      // 也无带日期的情节 → 只剩「第 N 天」可用
        let r = {};
        try { r = F.resolveStoryClock({ text: HEADER_TEXT }) || {}; } catch (e) { r = { error: String(e.message) }; }
        out.B = {
            header: HEADER_TEXT,
            storyDay: Number(r.storyDay) || 0,
            date: r.date || null,
            time: r.time || '', timeEnd: r.timeEnd || '',
            source: proj(r.source),
            note: '未设纪元首日（默认留空）→ 只记录天数、不换算日期',
        };
    }

    // ---------- C 组：内部校准 —— 设 `clockStoryDayEpoch` 后由「第 N 天」换算出**日期** ----------
    {
        const F = await boot(EPOCH);
        F.state.state.date = '';
        F.state.atoms = [];                      // 同上：排除数据侧候选，专门验证「天数 → 日期」校准
        let r = {};
        try { r = F.resolveStoryClock({ text: HEADER_TEXT }) || {}; } catch (e) { r = { error: String(e.message) }; }
        out.C = {
            epoch: EPOCH,
            storyDay: Number(r.storyDay) || 0,
            date: r.date || null,
            source: proj(r.source),
            note: '纪元首日 + (N-1) 天 → 日期（这正是该设定的用途：插件内校准，不注入）',
        };
    }

    // ---------- D 组：常规正文头（对照组：不含第 N 天时注入体也不该出现该行） ----------
    {
        const F = await boot(EPOCH);
        const r = F.extractClockFromText(PLAIN_TEXT, { date: '', time: '', location: '' });
        out.D = { date: r.date || null, location: r.location || null, storyDay: Number(r.storyDay) || 0 };
    }

    const text = JSON.stringify(out, null, 1);
    REAL_STDOUT(text, () => process.exit(0));
})();

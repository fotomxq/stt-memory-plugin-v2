'use strict';
// ============================================================
// oracle（出生日期异常）：真实 V1 插件 v1.206 `snapshotBirthAnomaly()` 的结论
//   → 生成 tests/fixtures/v1-golden-birth-anomaly.json
//
// 被测（用户报告）：「主角大类当主角为 0001-01-01 出生，剧情到 0191-09-23 时，会触发生日日期异常。
//   请核对原因并修复该异常判断。」
//
// V1 事实源（v1.206 8235~8270）：
//   · 空出生日期 / `birthSource='fallback'` /「未来来客」→ 不判；
//   · `birthDateInFuture` → 'future'；记录日期早于出生日期 → 'after-record'；解析失败 → 'bad-format'；
//   · `calcAge(bd, ageAnchorDate()) > 120 && !(出生年为负)` → 'overage'（**只豁免公元前出生**）。
// V2 v2.69.0 在 overage 上新增两条豁免（非人/长生设定、非现实纪元 < 1000 年），其余判据逐字保持。
//
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// 运行：node tests/fixtures/gen-v1-golden-birth-anomaly.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const V1 = '/home/ubuntu/st/STT记忆插件';
const V2 = path.join(__dirname, '..', '..');
const { makeTavernEnv, loadPlugin } = require(path.join(V1, 'tests/unit/helpers.js'));

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-birth-anomaly.json');
const imp = (rel) => import(pathToFileURL(path.join(V2, rel)).href);

(async function main() {
    const { SCENARIOS } = await imp('tests/fixtures/birth-anomaly-scenarios.mjs');
    const env = makeTavernEnv();
    const F = await loadPlugin(env);

    const out = {
        generatedFrom: 'src/FTT记忆组件-v1.205.js（当前 src 最新版）snapshotBirthAnomaly',
        v1Rule: 'age > 120 && !(出生年为负) → overage；只豁免公元前出生',
        labels: Object.assign({}, F.SNAP_BIRTH_ANOMALY_LABEL || {}),
        shorts: Object.assign({}, F.SNAP_BIRTH_ANOMALY_SHORT || {}),
        scenarios: [],
    };

    for (const sc of SCENARIOS) {
        // V1：剧情锚点写 `state.state`，角色档案放 `state.snapshots`
        try {
            F.state.state = Object.assign({}, F.state.state, { date: String(sc.story || ''), time: '' });
            F.state.snapshots = [Object.assign({}, sc.snap, { id: 'snap-' + sc.name })];
        } catch (e) { /* 忽略 */ }
        let v1 = '';
        let v1Label = '';
        let v1Short = '';
        try {
            v1 = String(F.snapshotBirthAnomaly(F.state.snapshots[0]) || '');
            v1Label = v1 ? String(F.snapshotBirthAnomalyLabel(v1) || '') : '';
            v1Short = v1 ? String(F.snapshotBirthAnomalyShort(v1) || '') : '';
        } catch (e) { v1 = 'ERR:' + String((e && e.message) || e); }
        out.scenarios.push({
            name: sc.name, note: sc.note, story: sc.story, snap: sc.snap,
            v1: v1, v1Label: v1Label, v1Short: v1Short,
            expect: String(sc.expect == null ? '' : sc.expect),
            deviation: String(sc.deviation || ''),
        });
    }

    const json = JSON.stringify(out, null, 1) + '\n';
    if (OUT) fs.writeFileSync(OUT, json);
    process.stdout.write(json);
    process.exit(0);
})().catch((e) => { process.stderr.write('ERR: ' + (e && e.stack || e) + '\n'); process.exit(1); });

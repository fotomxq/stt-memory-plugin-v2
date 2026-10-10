// ============================================================
// 单元测试 · v3.40.3（`docs/D22` `技-19`）—— **设计稿结构合规**（C10，`scripts/check-drafts.js`）
//
// 依据 `开发守则.md` §2.2（9 个必备块）· §2.6（实施规格 9 字段 + 维度标注 + 禁止表述）。
//
// 覆盖：
//   正向：当前工作区通过（`--strict` exit 0），且 **`D18`/`D19`/`D20` 三个范例零违规**（`docs/D22` `技-19` 验收）；
//   反向探针（同一验收判据「构造缺块/缺字段的稿子 → 脚本报错」）：
//     S1 缺一个必备块（分阶段落地）→ 报「缺必备块」；
//     S2 实施规格表头缺字段（删 验收 / 回退）→ 报「表头缺字段」；
//     S3 某行维度不是四大维度之一 → 报「维度不合规」；
//     S4 出现 §2.6 禁止表述 → 报「禁止表述」；同句加 `<!-- 结构豁免 -->` 后**不再**报（豁免闸有效）。
//
// 探针手法：写一份**临时合规稿** `docs/D99-结构探针.md`，按探针需要删掉一处 → 子进程跑脚本 → `finally` 删除。
//   探针只驱动 `check-drafts.js`（不跑 `docs:facts`），因此不会牵动目录树集合判据。
//
// 运行：node tests/unit/draft-structure.test.js
// ============================================================
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';

const R = makeReporter('draft-structure v3.40.3 设计稿结构合规 C10（9 块 + 实施规格 9 字段 + 维度 + 禁止表述）');
const A = (n, c, e) => R.assert(n, !!c, e);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = join(ROOT, 'docs', 'D99-结构探针.md');

function runScript(extraArgs) {
    const args = [join(ROOT, 'scripts', 'check-drafts.js')].concat(extraArgs || []);
    try {
        return { code: 0, out: String(execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' }) || '') };
    } catch (e) {
        return { code: Number(e.status) || 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
}
/**
 * 生成一份**合规**探针稿；`omit` 用于按探针需要删掉某一块 / 某字段 / 改某行的维度。
 * @param {{block?:string, fields?:string[], dim?:string, phrase?:boolean, exempt?:boolean}} o
 */
function probeDraft(o) {
    const opt = o || {};
    const block = (name) => name !== opt.block;
    const fields = ['编号', '维度', '目标', '落点', '前置', '步骤', '验收', '回退', '台账']
        .filter((x) => (opt.fields || []).indexOf(x) < 0);
    const dim = opt.dim || '技术';
    const lines = [
        '# D99 · 结构探针（临时）',
        '',
        '> 文档版本：v1.0 ｜ 日期：2026-10-10 ｜ 类型：**设计稿（不发版）** ｜ 状态：临时 ｜ **维度归属：技术**',
        '',
    ];
    if (block('目标')) { lines.push('## 1. 目标 / 非目标', '目标：验证结构判据；非目标：不改任何实现。', ''); }
    if (block('现状核对')) { lines.push('## 2. 现状核对', '证据：`core/util.js#hashText`。', ''); }
    if (block('方案')) { lines.push('## 3. 方案', '方案内容。', ''); }
    if (block('分阶段落地')) { lines.push('## 4. 分阶段落地', '阶段一：探针。', ''); }
    if (block('风险')) { lines.push('## 5. 风险与对策', '风险：无。', ''); }
    if (block('待确认问题')) { lines.push('## 6. 待确认问题清单', '无。', ''); }
    if (block('维度归属')) { lines.push('## 7. 维度归属与优先级', '技术。', ''); }
    lines.push('## 8. 实施规格（`开发守则.md` §2.6 格式）', '');
    lines.push('| ' + fields.join(' | ') + ' |');
    lines.push('| ' + fields.map(() => '---').join(' | ') + ' |');
    // 行也按 fields 裁剪，保持列数与表头一致
    const row = { '编号': '`技-99`', '维度': dim, '目标': '目标', '落点': '`core/util.js#hashText`', '前置': '无', '步骤': '步骤', '验收': '验收', '回退': '回退', '台账': 'U999' };
    lines.push('| ' + fields.map((x) => row[x]).join(' | ') + ' |');
    lines.push('');
    if (opt.phrase) {
        lines.push('## 附：探针语句', '本条按**视情况而定**处理。' + (opt.exempt ? '<!-- 结构豁免 -->（探针：确需保留该表述，已写明理由）' : ''), '');
    }
    return lines.join('\n');
}
function withProbe(content, fn) {
    try {
        writeFileSync(PROBE, content, 'utf8');
        return fn();
    } finally { try { rmSync(PROBE, { force: true }); } catch (e) { /* 忽略 */ } }
}

// ---------- 正向 ----------
A('S0 当前工作区通过（`--strict` exit 0），且 **D18 / D19 / D20 三个范例零违规**', (() => {
    const r = runScript(['--strict']);
    const bad = ['D18-', 'D19-', 'D20-'].filter((p) => r.out.indexOf(p) >= 0);
    return r.code === 0 && r.out.indexOf('设计稿结构合规通过') >= 0 && bad.length === 0 && existsSync(PROBE) === false;
})(), '');

// ---------- 反向探针 ----------
A('S1 **缺必备块**：临时稿删掉「分阶段落地」→ 脚本必须报错并点名该块（`--strict` exit 1）', (() => {
    return withProbe(probeDraft({ block: '分阶段落地' }), () => {
        const r = runScript(['--strict']);
        return r.code === 1 && r.out.indexOf('缺必备块') >= 0 && r.out.indexOf('分阶段落地') >= 0;
    });
})(), '');

A('S2 **实施规格表头缺字段**：临时稿的表头删掉 验收 / 回退 → 脚本必须报「表头缺字段」并点名', (() => {
    return withProbe(probeDraft({ fields: ['验收', '回退'] }), () => {
        const r = runScript(['--strict']);
        return r.code === 1 && r.out.indexOf('实施规格表头缺字段') >= 0
            && r.out.indexOf('验收') >= 0 && r.out.indexOf('回退') >= 0;
    });
})(), '');

A('S3 **维度不合规**：某行维度写「其它」→ 脚本必须报「维度不合规」（§2.5 只认 业务/应用/数据/技术）', (() => {
    return withProbe(probeDraft({ dim: '其它' }), () => {
        const r = runScript(['--strict']);
        return r.code === 1 && r.out.indexOf('维度不合规') >= 0 && r.out.indexOf('其它') >= 0;
    });
})(), '');

A('S4 **禁止表述**：正文出现「视情况而定」→ 必须报；同一句加 `<!-- 结构豁免 -->` 后**不再**报（豁免闸有效）', (() => {
    const a = withProbe(probeDraft({ phrase: true, exempt: false }), () => {
        const r = runScript(['--strict']);
        return r.code === 1 && r.out.indexOf('禁止表述') >= 0 && r.out.indexOf('视情况而定') >= 0;
    });
    if (!a) return false;
    return withProbe(probeDraft({ phrase: true, exempt: true }), () => {
        const r = runScript(['--strict']);
        return r.code === 0 && r.out.indexOf('设计稿结构合规通过') >= 0;
    });
})(), '');

R.done();

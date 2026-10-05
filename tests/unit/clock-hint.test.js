// ============================================================
// 单元测试 · v3.20.1「时钟工具行右侧的『自动同步中』提示」
//
// 用户报告（原话）：「手动改日期右侧总是显示'自动同步中'，请核对原因并修正该错误提示信息。」
//
// 核对结论（`ui/clock.js#clockSectionHtml` 手工改写工具行）—— 两个毛病，都不是「卡在同步」：
//   ① **用词让人误判成进度态**：旧文案「自动同步中」的「中」与「加载中」同构，读起来像**正在进行的进度**，
//      而它其实是**常驻的模式说明**（只要没有手工锚点就一直显示）→ 用户看到「一直显示自动同步中」，
//      以为卡住了；
//   ② **它不看开关，会写假话**：`cfg.clockExtractEnabled=false`（消息后自动同步已关）与
//      `cfg.enabled=false`（组件总开关已关）两种情形下，旧文案渲染出来的仍然是「自动同步中」，
//      而当时根本不会自动同步。
//
// 修法：按开关如实分三种说法 + 把「…中」换成「已开启 / 已关闭 / 已停用」（模式说明而非进度）；
//   手工锚点存在时维持「🔒 已手工锁定 + 🔓 解锁」两段（该分支本来正确）。
//
// 覆盖：A 三种自动同步档位；B 手工锁定/解锁切换；C 工具行与编辑面板结构不回归。
// 运行：node tests/unit/clock-hint.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { clockSectionHtml, clockAction, setClockEditing } from '../../ui/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-clock.json'), 'utf8'));
const R = makeReporter('clock-hint v3.20.1 时钟工具行「自动同步」提示按开关如实显示');
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);

/** 装载场景（与 B8-1 黄金样本同一输入） */
function boot(tweaks) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char-clock-hint');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), JSON.parse(JSON.stringify(G.scenarioA))));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    Object.assign(cfg, tweaks || {});
    setClockEditing(false);
    return state;
}
/** 只取手工改写工具行（按钮之后到该 div 结束）的可见文本 */
const hint = () => {
    const html = String(clockSectionHtml() || '');
    const i = html.indexOf('✏️ 手工改写日期/时间/地点');
    if (i < 0) return '(工具行缺失)';
    const tail = html.slice(i);
    const end = tail.indexOf('</div>');
    return tail.slice(0, end < 0 ? 600 : end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

// ---------- A 组：三种自动同步档位（旧文案在 ②③ 两种情形下写假话） ----------
A('A1 组件与自动同步都开着 → 「自动同步：已开启」+ 说明只取**本聊天的最新情节**；**不再出现**进度腔的「自动同步中」', (() => {
    boot({ enabled: true, clockExtractEnabled: true });
    const t = hint();
    return t.indexOf('自动同步：') >= 0 && t.indexOf('已开启') >= 0 && t.indexOf('本聊天的最新情节') >= 0
        && t.indexOf('自动同步中') < 0;
})(), () => hint());

A('A2 「消息后自动同步时钟」关闭（cfg.clockExtractEnabled=false）→ 如实写「已关闭」并给出开关位置（旧文案此处仍写「自动同步中」= 假话）', (() => {
    boot({ enabled: true, clockExtractEnabled: false });
    const t = hint();
    return t.indexOf('已关闭') >= 0 && t.indexOf('消息后自动同步时钟') >= 0
        && t.indexOf('已开启') < 0 && t.indexOf('自动同步中') < 0;
})(), () => hint());

A('A3 组件总开关关闭（cfg.enabled=false）→ 如实写「已停用」（旧文案此处仍写「自动同步中」= 假话）', (() => {
    boot({ enabled: false, clockExtractEnabled: true });
    const t = hint();
    return t.indexOf('已停用') >= 0 && t.indexOf('已开启') < 0 && t.indexOf('已关闭') < 0 && t.indexOf('自动同步中') < 0;
})(), () => hint());

A('A4 三个档位文案**两两不同**（同一个常驻位置要能一眼区分「开 / 关 / 停用」）', (() => {
    boot({ enabled: true, clockExtractEnabled: true }); const on = hint();
    boot({ enabled: true, clockExtractEnabled: false }); const off = hint();
    boot({ enabled: false, clockExtractEnabled: true }); const stopped = hint();
    return on !== off && off !== stopped && on !== stopped;
})(), '');

// ---------- B 组：手工锁定 / 解锁（该分支本来正确，防回归） ----------
A('B1 保存手工值后 → 「🔒 已手工锁定」+「🔓 解锁并恢复自动同步」按钮，且不再显示自动同步说明', (() => {
    boot({ enabled: true, clockExtractEnabled: true });
    return clockAction('clockManualSave', { date: '1919-11-29' }).then((r) => {
        const t = hint();
        return r.ok === true && t.indexOf('已手工锁定') >= 0 && t.indexOf('解锁并恢复自动同步') >= 0
            && t.indexOf('自动同步：') < 0 && state.state.date === '1919-11-29';
    });
})(), () => hint());

A('B2 解锁后 → 回到「自动同步：已开启」那一段（不再残留手工提示）', (() => {
    boot({ enabled: true, clockExtractEnabled: true });
    return clockAction('clockManualSave', { date: '1919-11-29' })
        .then(() => clockAction('clockManualClear', {}))
        .then(() => {
            const t = hint();
            return t.indexOf('已手工锁定') < 0 && t.indexOf('已开启') >= 0;
        });
})(), () => hint());

// ---------- C 组：结构与编辑面板不回归 ----------
A('C1 工具行按钮仍在；展开编辑面板后三个输入框与「保存并锁定」齐备（v2.x 结构不回归）', (() => {
    boot({ enabled: true, clockExtractEnabled: true });
    const closed = String(clockSectionHtml() || '');
    return clockAction('clockEdit', {}).then((r) => {
        const opened = String(clockSectionHtml() || '');
        return r.ok === true
            && closed.indexOf('data-ftt-action="clockEdit"') >= 0 && closed.indexOf('data-ftt-clock-manual="date"') < 0
            && opened.indexOf('data-ftt-clock-manual="date"') >= 0
            && opened.indexOf('data-ftt-clock-manual="time"') >= 0
            && opened.indexOf('data-ftt-clock-manual="location"') >= 0
            && opened.indexOf('data-ftt-action="clockManualSave"') >= 0;
    });
})(), '');

un();
R.done();

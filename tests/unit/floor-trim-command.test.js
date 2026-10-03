// ============================================================
// 单元测试 · v3.4.0「删楼优先走酒馆自带命令（/cut）」+ 逐层回退
//
// 用户要求（原话）：「删除聊天楼层的三个按钮，需改进为酒馆自带的命令删除，提高删除效率。
//   当前可能是逐层删除，非常消耗资源，需修复。」
//
// 覆盖：
//   A **能力探测**：有 `executeSlashCommandsWithOptions` → `command:true` 且 `via:'command'`；只有 `deleteMessage` → `via:'api'`；都没有 → 不支持；
//   B **命令路径**：一次调用删整段（**不再逐层** `deleteMessage`），`via:'command'`、`chat` 长度与保留层一致、耗时可观；
//   C **回退路径**：命令抛错 / 命令没生效（chat 没变短）→ 如实记录并回退到逐层删除（`via:'command+api'`），最终仍到保留层数；
//   D **无命令能力**：走逐层（`via:'api'`），调用次数 = 待删层数（既有口径不变）；
//   E **记账**：结果 / 摘要 / 账本 `last` 都带 `via` 与 `ms`；UI 诊断行与按钮 title 显示删除方式。
//
// 运行：node tests/unit/floor-trim-command.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { floorTrimCapability, floorTrimStatus, floorTrimApply, floorTrimPrecheck } from '../../host/floor-trim.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';

const R = makeReporter('floor-trim-command v3.4.0 删楼：酒馆自带命令优先 + 逐层回退');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
host.ctx.characters = [{ name: '角色甲', avatar: 'trimcmd.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);

/** 造 n 层聊天（正文足够长，便于哈希/台账逻辑） */
function mkChat(n) {
    host.ctx.chat.length = 0;
    for (let i = 0; i < n; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' });
    host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
}
function boot(n) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('trimcmd.png');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    mkChat(n);
}
/** 宿主桩：真实的 `deleteMessage`（splice + MESSAGE_DELETED）+ 可选的 `/cut` 命令实现 */
function installHost(opts) {
    const o = opts || {};
    const rec = { deleteCalls: [], commands: [] };
    host.ctx.deleteMessage = async (id) => {
        rec.deleteCalls.push(Number(id));
        const i = Number(id);
        if (Number.isFinite(i) && i >= 0 && i < host.ctx.chat.length) host.ctx.chat.splice(i, 1);
        host.ctx.eventSource && host.ctx.eventSource.emit('MESSAGE_DELETED', i);
    };
    if (o.command === 'cut') {
        host.ctx.executeSlashCommandsWithOptions = async (cmd) => {
            rec.commands.push(String(cmd));
            const n = Number(String(cmd).split(/\s+/)[1]);
            if (Number.isFinite(n) && n >= 0 && n < host.ctx.chat.length) host.ctx.chat.splice(n, host.ctx.chat.length - n);
            return '';
        };
    } else if (o.command === 'throw') {
        host.ctx.executeSlashCommandsWithOptions = async (cmd) => { rec.commands.push(String(cmd)); throw new Error('ACL denied'); };
    } else if (o.command === 'noop') {
        host.ctx.executeSlashCommandsWithOptions = async (cmd) => { rec.commands.push(String(cmd)); return ''; };   // 命令被吞、chat 不变
    } else {
        delete host.ctx.executeSlashCommandsWithOptions;
    }
    return rec;
}
const BACKUP_OK = { writeBackup: async (scope, slot, text) => ({ ok: true, name: 'ftt2-floor-backup-x-s' + (slot + 1) + '-20260930-120000.json', slot: slot, chars: String(text).length }), exportJson: () => '{"format":"ftt-memory-v2-export","state":{}}' };
async function runTrim(keep, opts) {
    const FH = await import('../../host/floor-trim.js');
    FH.setFloorTrimHooks(BACKUP_OK);
    return await FH.floorTrimApply(Object.assign({ keep: keep }, opts || {}));
}

// ---------- A 组：能力探测 ----------
{
    boot(20);
    installHost({ command: 'cut' });
    const cap = floorTrimCapability();
    const st = floorTrimStatus();
    installHost({});
    const cap2 = floorTrimCapability();
    const st2 = floorTrimStatus();
    A('A1 能力探测区分「命令」与「逐层 API」：宿主有 `executeSlashCommandsWithOptions` → `command:true` 且 `via:"command"`（按钮 title / 诊断行据此说明删除方式）；只有 `deleteMessage` → `command:false`、`via:"api"`；两者都没有 → 不支持（如实降级，不静默失败）',
        cap.ok === true && cap.supported === true && cap.command === true && st.via === 'command' && st.command === true
        && cap2.supported === true && cap2.command === false && st2.via === 'api',
        J({ cap, via: st.via, cap2, via2: st2.via }));
}

// ---------- B 组：命令路径 ----------
await (async () => {
    boot(50);
    const rec = installHost({ command: 'cut' });
    const r = await runTrim(10, {});
    A('B1 **命令路径**：一次 `/cut 10` 删掉整段（`chat` 50 → 10），**一次 `deleteMessage` 都不调用**；结果与摘要如实回报「删除方式 酒馆命令」+ 耗时 `ms`；账本 `last.via` 也记下路径',
        r.ok === true && rec.commands.length === 1 && rec.commands[0] === '/cut 10'
        && rec.deleteCalls.length === 0 && host.ctx.chat.length === 10
        && r.via === 'command' && r.deleted === 40 && typeof r.ms === 'number'
        && r.summary.indexOf('删除方式 酒馆命令') >= 0
        && floorTrimStatus().last && floorTrimStatus().last.via === 'command',
        J({ commands: rec.commands, deleteCalls: rec.deleteCalls.length, floors: host.ctx.chat.length, via: r.via, deleted: r.deleted, ms: r.ms, summary: r.summary }));
})();

// ---------- C 组：回退路径（命令抛错 / 命令没生效） ----------
await (async () => {
    boot(30);
    const rec1 = installHost({ command: 'throw' });
    const r1 = await runTrim(8, {});
    const ok1 = r1.ok === true && rec1.commands.length === 1 && rec1.deleteCalls.length === 22 && host.ctx.chat.length === 8 && r1.via === 'command+api';
    boot(30);
    const rec2 = installHost({ command: 'noop' });
    const r2 = await runTrim(8, {});
    const ok2 = r2.ok === true && rec2.commands.length === 1 && rec2.deleteCalls.length === 22 && host.ctx.chat.length === 8 && r2.via === 'command+api';
    A('C1 **回退路径**：命令抛错（宿主 ACL 拒绝等）或命令被吞（`chat` 没变短）→ 如实记录 `command+api` 并**逐层回退**（调用次数 = 待删层数），最终仍到达保留层数；**绝不假装命令成功**',
        ok1 && ok2,
        J({ throwPath: { commands: rec1.commands, deleteCalls: rec1.deleteCalls.length, floors: host.ctx.chat.length, via: r1.via }, noopPath: { commands: rec2.commands, deleteCalls: rec2.deleteCalls.length, floors: host.ctx.chat.length, via: r2.via } }));
})();

// ---------- D 组：无命令能力 → 逐层（既有口径不变） ----------
await (async () => {
    boot(20);
    const rec = installHost({});
    const r = await runTrim(6, {});
    A('D1 宿主没有酒馆命令能力时走**逐层官方 API**（与 v2.94.0 口径一致：从后往前、每步核对 `chat` 确实变短）：调用 14 次、`chat` 20 → 6、`via:"api"`',
        r.ok === true && rec.deleteCalls.length === 14 && host.ctx.chat.length === 6 && r.via === 'api'
        && rec.deleteCalls[0] === 13 && rec.deleteCalls[13] === 0,
        J({ calls: rec.deleteCalls.length, first: rec.deleteCalls[0], last: rec.deleteCalls[rec.deleteCalls.length - 1], floors: host.ctx.chat.length, via: r.via }));
})();

// ---------- E 组：界面口径 ----------
await (async () => {
    boot(20);
    installHost({ command: 'cut' });
    const html = settingsPageHtml('data', '');
    installHost({});
    const html2 = settingsPageHtml('data', '');
    A('E1 数据管理页如实说明删除方式：诊断行给出「删除方式 酒馆命令（一次截断）／逐层删除」，按钮 title 也写明当前宿主会走哪条路径（有命令 → 酒馆自带 `/cut`，无命令 → 逐层官方 `deleteMessage`）',
        html.indexOf('删除方式 酒馆命令（一次截断）') >= 0 && html.indexOf('酒馆自带命令 /cut（一次截断整段，快）') >= 0
        && html2.indexOf('删除方式 逐层删除') >= 0 && html2.indexOf('逐层调用官方 deleteMessage') >= 0,
        J({ cmd: html.indexOf('酒馆自带命令 /cut') >= 0, api: html2.indexOf('逐层调用官方 deleteMessage') >= 0 }));
})();

R.done();

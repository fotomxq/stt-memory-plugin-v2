// ============================================================
// ui/commands.js —— 斜杠命令与宏（ST 原生入口，替代 V1 的按钮专用面板）
// 事实源：ST 官方文档「Registering slash commands (new way)」/「Registering custom macros」
// ============================================================
import { VERSION } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';
import { updateStatusText } from '../host/update.js';
// v2.42.0：命令/宏调用入流（『用户命令 → 底层调用 → 结果』可追溯，cat='cmd'）
import { traceEvent, traceOpStart, traceOpEnd, traceSite } from '../core/trace.js';
// v3.45.4（`docs/D22` W10 `技-41` ⑥）：**只读清单的单一事实源** —— `/ftt-readonly` 与 `FTT.readonly()` 同源
//   （`docs/D31` §8 Q4 裁决：清空型动作显式标注、永不进桥白名单）。
import { readonlyOutletList, debugCapList, debugKindList, REQUIRED_CONTENT } from '../core/debug-catalog.js';
// v3.45.4（W10 `技-41` ④ · `docs/D31` §3.2「命令 = `/ftt` 前缀 + 与桥方法**同名**」）：桥方法 `ftt.perf*`
//   对应的命令是 `/ftt-perf`（同一读数两个入口不得异名）。
import { perfReport, perfJankList, perfTargets, perfBaselineReport, perfReportText } from '../core/perf-probe.js';

/**
 * v2.42.0：命令回调的追踪包装（cat='cmd'）—— 记录命令名 / 参数摘要 / 结果 / 耗时 / **站点**，
 *   并用 opId 关联该命令期间发生的宿主与内核事件（见 `core/trace.js` 的 op 栈约定）。
 */
function tracedCommand(name, fn) {
    const run = (typeof fn === 'function') ? fn : (() => '');
    return async (...args) => {
        const op = traceOpStart('cmd.' + name, { args: args.map((a) => (typeof a === 'string' ? a.slice(0, 60) : typeof a)) });
        try {
            const r = await run(...args);
            const ended = traceOpEnd(op, { ok: true });
            const detail = { source: 'slash', args: args.map((a) => (typeof a === 'string' ? a.slice(0, 60) : typeof a)), ret: (typeof r === 'string' ? r.slice(0, 80) : typeof r) };
            try { traceEvent({ cat: 'cmd', kind: name, level: 'info', ok: true, ms: ended ? ended.ms : 0, detail, site: traceSite(), opId: op.opId, op: op.name }); } catch (e) { /* 忽略 */ }
            return r;
        } catch (e) {
            const ended = traceOpEnd(op, { ok: false, reason: String((e && e.message) || e) });
            try { traceEvent({ cat: 'cmd', kind: name, level: 'warn', ok: false, reason: String((e && e.message) || e), ms: ended ? ended.ms : 0, detail: { source: 'slash' }, site: traceSite(), opId: op.opId, op: op.name }); } catch (e2) { /* 忽略 */ }
            throw e;
        }
    };
}
/** v2.42.0：宏回调的追踪包装（cat='cmd'，source='macro'） */
function tracedMacro(name, fn) {
    const run = (typeof fn === 'function') ? fn : (() => '');
    return (...args) => {
        const op = traceOpStart('macro.' + name);
        try {
            const r = run(...args);
            const ended = traceOpEnd(op, { ok: true });
            try { traceEvent({ cat: 'cmd', kind: name, level: 'trace', ok: true, ms: ended ? ended.ms : 0, detail: { source: 'macro' }, site: traceSite(), opId: op.opId, op: op.name }); } catch (e) { /* 忽略 */ }
            return r;
        } catch (e) {
            traceOpEnd(op, { ok: false, reason: String((e && e.message) || e) });
            try { traceEvent({ cat: 'cmd', kind: name, level: 'warn', ok: false, reason: String((e && e.message) || e), detail: { source: 'macro' }, site: traceSite() }); } catch (e2) { /* 忽略 */ }
            throw e;
        }
    };
}

/** 状态文本（/ftt 与调试导出共用） */
export function statusText(extra) {
    const lines = [
        'FTT记忆组件 V2 ' + VERSION,
        extra && extra.host ? '宿主：已连接' : '宿主：未连接（纯逻辑模式）',
    ];
    if (extra && extra.probe) {
        const miss = extra.probe.missing || [];
        lines.push('能力探测：' + (miss.length ? '缺 ' + miss.join('、') : '全部可用'));
    }
    if (extra && extra.cfg) lines.push('内核配置：' + Number(extra.cfg.keys || 0) + ' 键' + (extra.cfg.changed ? '（本次补入默认值）' : ''));
    if (extra && extra.inject) lines.push('注入：构建 ' + extra.inject.builds + ' · 推送 ' + extra.inject.pushes + ' · 当前 ' + extra.inject.lastChars + ' 字' + (extra.inject.keptLast ? '（保留上次 ' + extra.inject.keptLast + ' 次）' : ''));
    if (extra && extra.bind) lines.push('事件绑定：' + (extra.bind.bound || []).length + ' 个（缺 ' + ((extra.bind.missing || []).length) + '）');
    if (extra && extra.interceptor) lines.push('拦截器调用：' + extra.interceptor.calls + ' 次（最近类型 ' + (extra.interceptor.lastType || '—') + '）');
    if (extra && extra.update) lines.push('更新：' + updateStatusText(extra.update));
    if (extra && extra.import) lines.push('旧版导入：' + extra.import);
    if (extra && extra.bootstrap && extra.bootstrap.popup) {
        const pu = extra.bootstrap.popup;
        lines.push('界面：V1 同构浮层（' + (pu.tabs || []).length + ' 个分页）· 已挂载 ' + ((pu.mounted || pu.open) ? '是' : '否')
            + ' · 抽屉卡片 ' + (pu.showDrawer ? '开' : '关'));
    }
    if (extra && extra.bootstrap) {
        const b = extra.bootstrap;
        const panel = b.panel || {};
        lines.push('装配：' + (b.ready ? '已初始化' : '未初始化') + ' · 触发 ' + ((b.triggers || []).join('→') || '—')
            + ' · 面板 ' + (panel.ok ? ('已挂载 #' + (panel.container || '?')) : ('未挂载：' + (panel.reason || '未知'))));
        // v2.65.0：入口按「显示界面开关」的设置如实报告（扩展菜单项 = 主入口，强制开启）
        if (b.entries && b.entries.installed) {
            const ins = b.entries.installed;
            const 名 = b.entries.labels || {};
            // 扩展菜单项 = 强制主入口（用户不得关闭）：无论装没装上都要出现在这一行里，便于用户/维护者核对
            const on = ['menu', 'qr', 'float', 'topbar'].filter((k) => ins[k]).map((k) => 名[k] || k);
            const off = ['menu', 'topbar', 'qr', 'float'].filter((k) => !ins[k]).map((k) => 名[k] || k);
            lines.push('入口：' + (on.length ? on.join(' · ') : '（无）') + (off.length ? '（未显示：' + off.join(' · ') + '）' : ''));
        } else if (b.menu) {
            lines.push('菜单入口：' + (b.menu.installed ? '已加入扩展菜单（魔杖）' : '未加入（' + (b.menu.menuFound ? '插入失败' : '无 #extensionsMenu') + '）'));
        }
    }
    if (extra && extra.i18n) lines.push('语言：' + extra.i18n.locale + ' · 词条 ' + extra.i18n.keys + ' 条 · 注册 ' + (extra.i18n.registered.ok ? extra.i18n.registered.locales.join('/') : '未注册'));
    if (extra && extra.extract) {
        const e = extra.extract;
        const p = (extra.extractPending === undefined || extra.extractPending === null) ? '' : ' · 待分析 ' + extra.extractPending;
        lines.push('提取：运行 ' + e.runs + ' · 成功 ' + e.ok + ' · 失败 ' + e.fail + (e.lastReason ? '（最近 ' + e.lastReason + '）' : '') + p);
    }
    return lines.join('\n');
}

/**
 * 注册 /ftt 命令（不可用时静默跳过，返回 false）。
 * @param {Function} getExtra 状态文本的数据来源
 * @param {object} [hooks] { importV1(opts) } —— 提供时额外注册 `/ftt-import`
 */
export function registerSlashCommand(getExtra, hooks) {
    const ctx = getCtx();
    if (!ctx || !ctx.SlashCommandParser || typeof ctx.SlashCommandParser.addCommandObject !== 'function') return false;
    if (!ctx.SlashCommand || typeof ctx.SlashCommand.fromProps !== 'function') return false;
    // v2.42.0：命令回调统一包一层追踪（保持对象字面量结构不变）
    const addCmd = (def) => ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps(Object.assign({}, def, {
        callback: tracedCommand(String((def && def.name) || 'cmd'), def && def.callback),
    })));
    try {
        addCmd({
            name: 'ftt',
            callback: () => statusText(typeof getExtra === 'function' ? getExtra() : {}),
            helpString: 'FTT记忆组件 V2 状态：版本 / 宿主 / 能力探测 / 事件绑定 / 拦截器统计',
            returns: '状态文本',
        });
        if (hooks && typeof hooks.importV1 === 'function') {
            addCmd({
                name: 'ftt-import',
                callback: async (named, unnamed) => {
                    const raw = String(unnamed || '').toLowerCase();
                    const apply = raw.indexOf('apply') >= 0 || raw.indexOf('写入') >= 0 || raw.indexOf('确认') >= 0;
                    // 修正（B9 专项）：`runV1Import` 只认 `apply === true`（`o.apply`），此前传 `{ dryRun: !apply }` 会被吞掉 → 永远干跑
                    const res = await hooks.importV1({ apply });
                    const t = res && res.report ? res.report.totals : { v1Entries: 0, add: 0, exist: 0, conflict: 0 };
                    const head = (res && res.dryRun ? '【干跑】' : '【已写入】') + '旧版导入：' + (res && res.via ? res.via + ' / ' + res.name : '未发现数据');
                    const body = 'V1 条目 ' + t.v1Entries + ' → 新增 ' + t.add + ' · 已存在 ' + t.exist + ' · 冲突 ' + t.conflict;
                    const notes = (res && res.notes ? res.notes : []).map((n) => '· ' + n).join('\n');
                    return [head, body, notes, (!res || res.dryRun) ? '（确认写入请用 /ftt-import apply）' : ''].filter(Boolean).join('\n');
                },
                helpString: 'V1 数据导入：默认干跑差异报告；`/ftt-import apply` 才真正写入（源数据不删）',
                returns: '导入报告文本',
            });
        }
        if (hooks && typeof hooks.ui === 'function') {
            addCmd({
                name: 'ftt-ui',
                callback: async (named, unnamed) => {
                    const tab = String(unnamed || '').trim();
                    const r = await hooks.ui(tab || undefined);
                    return r && r.ok
                        ? ('已打开 V1 同构面板：' + (r.tab || '') + '（分页：总览 / 情节 / 状态 / 角色 / 记忆 / 物品 / 货币 / 传言 / 计划悬念 / 场景 / 概念 / 平行 / 设置）')
                        : ('面板打开失败：' + String((r && r.reason) || '未知') + '（可改用 /ftt-panel 诊断）');
                },
                helpString: '打开 FTT 弹窗主界面：`/ftt-ui` 或 `/ftt-ui console|extract|settings`',
                returns: '打开结果文本',
            });
        }
        if (hooks && typeof hooks.panel === 'function') {
            addCmd({
                name: 'ftt-panel',
                callback: async () => {
                    const r = await hooks.panel();
                    const info = (r && r.info) || {};
                    const lines = [
                        '面板挂载：' + (r && r.ok ? ('✅ 已挂载 → #' + (r.container || '?') + '（' + (r.via || '') + '）') : ('❌ ' + String((r && r.reason) || '未知原因'))),
                        '候选容器：' + Object.keys(info.found || {}).map((k) => k + (info.found[k] ? '✓' : '✗')).join(' · '),
                        '菜单入口：' + ((r && r.menu && r.menu.ok) ? '✅ 已加入扩展菜单（魔杖）' : ('❌ ' + String((r && r.menu && r.menu.reason) || '未加入'))),
                        '提示：面板在「扩展设置」抽屉（左侧栏扩展按钮 → 扩展设置）里，标题为「FTT记忆组件 V2」，点标题可展开。',
                    ];
                    return lines.join('\n');
                },
                helpString: 'FTT 面板诊断与强制挂载：报告面板容器/菜单入口状态并立即重新挂载一次',
                returns: '诊断文本',
            });
        }
        if (hooks && typeof hooks.extract === 'function') {
            addCmd({
                name: 'ftt-analyze',
                callback: async (named, unnamed) => {
                    const raw = String(unnamed || '').trim();
                    const opts = {};
                    if (/^\d+$/.test(raw)) opts.floor = Number(raw);
                    else if (raw && typeof hooks.pending === 'function') return '待分析楼层：' + (hooks.pending({}).join('、') || '（无）');
                    const r = await hooks.extract(opts);
                    if (r && Array.isArray(r.results)) {
                        // v3.23.0：多楼提取改为**按段**推进（每段 ≤ cfg.summaryChunkSize，默认 3 个正文）→
                        //   回报按"段"渲染（`4-6 楼`），不再假装是逐楼结果。
                        const seg = (x) => (Number(x.end) > Number(x.start) ? ('第 ' + x.start + '-' + x.end + ' 楼') : ('第 ' + x.floor + ' 楼'));
                        const head = '分析完成：成功 ' + r.done + ' / 共 ' + r.results.length
                            + (Number(r.segments) > 1 ? ('（' + r.segments + ' 段 · 每段 ≤' + (r.chunkSize || '?') + ' 楼）') : '')
                            + (r.note ? '（' + r.note + '）' : '');
                        const rows = r.results.map((x) => '· ' + seg(x) + ' ' + (x.ok ? '✅ 新增 ' + x.added + ' 条' : '❌ ' + (x.reason || '失败')));
                        return [head].concat(rows).join('\n');
                    }
                    if (r && r.ok) return '第 ' + r.floor + ' 楼分析完成：新增 ' + r.added + ' 条（共 ' + r.total + ' 条）· ' + r.ms + 'ms';
                    return '分析未完成：' + String((r && r.reason) || '未知原因');
                },
                helpString: 'FTT 记忆提取：`/ftt-analyze` 分析未分析楼层；`/ftt-analyze 12` 指定楼层；`/ftt-analyze list` 列出待分析',
                returns: '提取结果文本',
            });
        }
        // v3.45.4（`docs/D22` W10 `技-41` ⑥）：**只读清单**命令 ——
        //   把「调试面到底有哪些只读出口、哪些是清空型动作」一次列清楚，并与桥白名单**对齐**（同一份清单源）。
        //   口径（`docs/D31` §8 Q4）：清空型动作保留在面板 / 命令里（走既有二次确认），**永不进桥白名单**，此处显式标注。
        addCmd({
            name: 'ftt-readonly',
            callback: (named, unnamed) => {
                const raw = String(unnamed || '').toLowerCase();
                let list = [];
                let caps = [];
                let kinds = [];
                try { list = readonlyOutletList(); } catch (e) { list = []; }
                try { caps = debugCapList(); } catch (e) { caps = []; }
                try { kinds = debugKindList(); } catch (e) { kinds = []; }
                if (raw.indexOf('cap') >= 0) {
                    return ['【CAP 汇总表（唯一事实源：core/debug-catalog.js）· ' + caps.length + ' 行】',
                        '· 载体 ｜ 上限 ｜ 保留窗 ｜ 事实源',
                    ].concat(caps.map((c) => '· ' + c.carrier + ' ｜ ' + c.cap + ' ｜ ' + c.window + ' ｜ ' + String(c.source || '')).slice(0, 60)).join('\n');
                }
                if (raw.indexOf('kind') >= 0) {
                    return ['【业务调试日志 kind 枚举（冻结；新增需登记）· ' + kinds.length + ' 类】',
                    ].concat(kinds.map((k) => '· ' + k.kind + ' —— ' + k.note).slice(0, 60)).join('\n');
                }
                const read = list.filter((x) => x.kind !== 'clear');
                const clear = list.filter((x) => x.kind === 'clear');
                const groups = [];
                for (const x of read) if (groups.indexOf(x.group) < 0) groups.push(x.group);
                const lines = ['【只读清单（与调试桥白名单同源）· 只读 ' + read.length + ' 项 / 清空型 ' + clear.length + ' 项】'];
                for (const g of groups) lines.push('· ' + g + '：' + read.filter((x) => x.group === g).map((x) => x.name).join('、'));
                lines.push('【清空型动作（永不进桥白名单；在面板 / 命令里走二次确认）】');
                lines.push(clear.map((x) => x.name).join('、') || '（无）');
                lines.push('【必要内容完整性】共 ' + REQUIRED_CONTENT.length + ' 类（明细见 设定 → 调试 的清单区块与 scripts/check-debug-coverage.js）');
                lines.push('用法：`/ftt-readonly cap` 看 CAP 汇总表；`/ftt-readonly kind` 看 kind 枚举。');
                return lines.join('\n');
            },
            helpString: 'FTT 只读清单：列出全部只读出口与清空型动作（与调试桥白名单同源）；`/ftt-readonly cap|kind` 另看 CAP 表 / kind 枚举',
            returns: '只读清单文本',
        });
        // v3.45.4（W10 `技-40` / `技-41` ④）：`/ftt-perf` —— 与桥方法 `ftt.perf` / `ftt.perfJank` /
        //   `ftt.perfTargets` / `ftt.perfBaseline` **同名同源**（同一批 core 函数，命令只做文本渲染）。
        addCmd({
            name: 'ftt-perf',
            callback: (named, unnamed) => {
                const raw = String(unnamed || '').toLowerCase();
                if (raw.indexOf('jank') >= 0) {
                    const list = (() => { try { return perfJankList({ limit: 30 }); } catch (e) { return []; } })();
                    return ['【超阈段明细（后 30 条）· 只记 notice≥50ms / stall≥200ms / freeze≥1000ms】']
                        .concat(list.map((x) => '· ' + String(x.at ? new Date(Number(x.at)).toLocaleString('zh-CN', { hour12: false }) : '') + ' ' + x.level + ' ' + Number(x.ms) + 'ms @ ' + String(x.site)).slice(0, 30))
                        .join('\n');
                }
                if (raw.indexOf('target') >= 0) {
                    const t = (() => { try { return perfTargets(); } catch (e) { return null; } })();
                    const list = (t && Array.isArray(t.list)) ? t.list : [];
                    return ['【潜在优化清单 · ' + list.length + ' 条（只输出候选，不自动开单）】']
                        .concat(list.map((x, i) => '#' + (i + 1) + ' ' + String(x.title || x.id || '') + ' · 证据：' + String(x.evidence || '') + ' · 建议：' + String(x.suggest || '') + ' · 台账：' + String(x.u || '未立项')))
                        .join('\n');
                }
                if (raw.indexOf('baseline') >= 0 || raw.indexOf('base') >= 0) {
                    const b = (() => { try { return perfBaselineReport(); } catch (e) { return null; } })();
                    if (!b || !b.available) return '【性能基线】未跑过基线（' + String((b && b.reason) || 'no-baseline') + '）—— 开发期可跑 `node scripts/perf-baseline.js --write` 生成，门禁脚本 `node scripts/check-perf-baseline.js`';
                    return ['【性能基线对比 · 基线 ' + new Date(Number(b.baselineAt) || 0).toLocaleString('zh-CN', { hour12: false }) + '】',
                        '· 回归 ' + (b.regressions || []).length + ' 项 · 可收紧 ' + (b.improvements || []).length + ' 项',
                    ].concat((b.regressions || []).map((x) => '· 回归：' + String(x.key || '') + ' 基线 ' + String(x.baseline) + ' → 当前 ' + String(x.current)))
                        .join('\n');
                }
                const r = (() => { try { return perfReport(); } catch (e) { return null; } })();
                if (!r) return '性能探针不可用（读取失败）';
                return ['【性能与卡顿 · 窗口 ' + Number(r.window || 0) + ' 条 · ' + String(r.ver || '') + '】',
                    perfReportText(),
                    '用法：`/ftt-perf jank` 看超阈段明细；`/ftt-perf targets` 看优化清单；`/ftt-perf baseline` 看与基线的差异。',
                ].join('\n');
            },
            helpString: 'FTT 性能与卡顿：`/ftt-perf`（四类读数 + 卡顿摘要）· `/ftt-perf jank|targets|baseline`（与桥方法 `ftt.perf*` 同名同源）',
            returns: '性能读数文本',
        });
        return true;
    } catch (e) {
        return false;
    }
}

/** 注册宏（新系统优先，旧 API 兜底；不可用时返回 false） */
export function registerMacros(getExtra) {
    const ctx = getCtx();
    if (!ctx) return false;
    const handler = () => statusText(typeof getExtra === 'function' ? getExtra() : {});
    try {
        if (ctx.macros && typeof ctx.macros.register === 'function') {
            ctx.macros.register('fttVersion', { description: 'FTT记忆组件 V2 版本', handler: () => VERSION });
            ctx.macros.register('fttStatus', { description: 'FTT记忆组件 V2 状态', handler });
            return true;
        }
        if (typeof ctx.registerMacro === 'function') {
            ctx.registerMacro('fttVersion', tracedMacro('fttVersion', () => VERSION));
            ctx.registerMacro('fttStatus', tracedMacro('fttStatus', handler));
            return true;
        }
    } catch (e) { /* 忽略：宏只是增强项 */ }
    return false;
}

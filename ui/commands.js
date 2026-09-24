// ============================================================
// ui/commands.js —— 斜杠命令与宏（ST 原生入口，替代 V1 的按钮专用面板）
// 事实源：ST 官方文档「Registering slash commands (new way)」/「Registering custom macros」
// ============================================================
import { VERSION } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';
import { updateStatusText } from '../host/update.js';

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
    if (extra && extra.bind) lines.push('事件绑定：' + (extra.bind.bound || []).length + ' 个（缺 ' + ((extra.bind.missing || []).length) + '）');
    if (extra && extra.interceptor) lines.push('拦截器调用：' + extra.interceptor.calls + ' 次（最近类型 ' + (extra.interceptor.lastType || '—') + '）');
    if (extra && extra.update) lines.push('更新：' + updateStatusText(extra.update));
    if (extra && extra.import) lines.push('V1 导入：' + extra.import);
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
    try {
        ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
            name: 'ftt',
            callback: () => statusText(typeof getExtra === 'function' ? getExtra() : {}),
            helpString: 'FTT记忆组件 V2 状态：版本 / 宿主 / 能力探测 / 事件绑定 / 拦截器统计',
            returns: '状态文本',
        }));
        if (hooks && typeof hooks.importV1 === 'function') {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'ftt-import',
                callback: async (named, unnamed) => {
                    const raw = String(unnamed || '').toLowerCase();
                    const apply = raw.indexOf('apply') >= 0 || raw.indexOf('写入') >= 0 || raw.indexOf('确认') >= 0;
                    const res = await hooks.importV1({ dryRun: !apply });
                    const t = res && res.report ? res.report.totals : { v1Entries: 0, add: 0, exist: 0, conflict: 0 };
                    const head = (res && res.dryRun ? '【干跑】' : '【已写入】') + 'V1 导入：' + (res && res.via ? res.via + ' / ' + res.name : '未发现数据');
                    const body = 'V1 条目 ' + t.v1Entries + ' → 新增 ' + t.add + ' · 已存在 ' + t.exist + ' · 冲突 ' + t.conflict;
                    const notes = (res && res.notes ? res.notes : []).map((n) => '· ' + n).join('\n');
                    return [head, body, notes, (!res || res.dryRun) ? '（确认写入请用 /ftt-import apply）' : ''].filter(Boolean).join('\n');
                },
                helpString: 'V1 数据导入：默认干跑差异报告；`/ftt-import apply` 才真正写入（源数据不删）',
                returns: '导入报告文本',
            }));
        }
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
            ctx.registerMacro('fttVersion', () => VERSION);
            ctx.registerMacro('fttStatus', handler);
            return true;
        }
    } catch (e) { /* 忽略：宏只是增强项 */ }
    return false;
}

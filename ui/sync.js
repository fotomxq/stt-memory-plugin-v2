// ============================================================
// ui/sync.js —— **存储页同步区块与动作**（B7-2；结构与文案对齐 V1 `13-UI-设置与存储开关.js`）
// 覆盖：记忆文件状态行 / 快照与清单状态 / 一致性开关 / 状态与操作（刷新状态·立即同步·校验并修复）/
//   同步日志（最近 30 条：本地 → 对端 → 同步后 的条数与大小 + 处置 + 本端源头）。
// 说明：V1 的「存储治理（统一抽象·只读）」「宿主原生存储（TauriTavern）」两节依赖 V1 的多后端抽象，
//   V2 为「本机缓冲 + 服务端记忆文件」两型 → 以只读说明行呈现（不使用假实现），详见 docs/P8i。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { VERSION } from '../core/constants.js';
import { escHtml } from '../core/util.js';
import { syncLogShortHash } from '../core/sync-log.js';
import {
    storageStatusInfo, stateFileStatus, syncLogServerStatus, syncLogList, syncLogClear,
    syncLogServerMerge, storageVerify, crossSyncManual, refreshFromServer, syncLocalSource,
    noteSyncReport, syncToast, syncInfo,
} from '../adapters/sync.js';
import { settingsControlHtml } from './settings-pages.js';

const esc = (v) => escHtml(v == null ? '' : v);
const pad2 = (x) => String(x).padStart(2, '0');
function fmtTime(ts) {
    try {
        const d = new Date(Number(ts));
        if (!Number.isFinite(d.getTime())) return '—';
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    } catch (e) { return '—'; }
}
function fmtBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
}
const mono = (s) => '<span class="ftt-mono-sm">' + esc(s) + '</span>';

/** 记忆文件状态行（V1 `stateFileStatusHtml` 口径：存档名 → slug / 主·备份·快照·清单文件名 / 最近写入） */
export function stateFileStatusHtml() {
    try {
        const s = stateFileStatus();
        if (!s.enabled) return '记忆文件：<b>已关闭</b>（改用存档变量通道 —— 不推荐）';
        const when = Number(s.lastOkAt) ? fmtTime(s.lastOkAt) : '';
        return '记忆文件：<b>已启用</b>（存档名 <b>' + esc(s.archive || '—') + '</b> → slug <span class="ftt-mono">' + esc(s.slug || '') + '</span>）<br>'
            + '主文件 ' + mono(s.name) + (s.bakEnabled ? (' · 备份 ' + mono(s.bak)) : '') + (s.snapEnabled ? (' · 快照 ' + mono(s.snap)) : '') + '<br>'
            + '清单 ' + mono(s.meta) + '（' + (Number(s.metaOkAt) ? ('最近写入 ' + fmtTime(s.metaOkAt)) : (s.metaErr ? ('不可用 ' + esc(s.metaErr)) : '本会话尚未写入')) + '）<br>'
            + (when ? ('最近写入 ' + when) : '本会话尚未写入（打开页面会自动拉取合并）')
            + (s.mirrorSettings ? ' · settings 镜像已开启' : ' · settings 已剥离')
            + (Number(s.bytes) ? (' · 主文件 ' + fmtBytes(s.bytes)) : '');
    } catch (e) { return '记忆文件：状态读取失败'; }
}

/** 同步日志服务端通道状态行（开/关 / 本会话不可用 / 最近写入 / 文件名） */
export function syncLogServerStatusHtml() {
    try {
        const s = syncLogServerStatus();
        if (!s.enabled) return '服务端日志：<b>已关闭</b>（仅本机保存）';
        if (s.disabled) return '服务端日志：<span class="ftt-hint-warn">本会话不可用' + (s.error ? ('（' + esc(s.error) + '）') : '') + '</span> —— 仅本机保存，刷新页面后可重试';
        const when = Number(s.lastOkAt) ? fmtTime(s.lastOkAt) : '';
        return '服务端日志：<b>已启用</b> · 文件 ' + mono(s.file) + (when ? (' · 最近写入 ' + when) : ' · 本次打开页面会自动拉取合并');
    } catch (e) { return '服务端日志：状态读取失败'; }
}

/** 同步日志列表（新→旧，最近 30 条；每行含 本地 → 对端 → 同步后 的条数与大小 + 哈希 + 本端源头） */
export function syncLogHtml() {
    try {
        const list = syncLogList();
        if (!list.length) return '<div class="ftt-empty">暂无同步记录。执行 跨端对账 / 立即同步 / 镜像推送 后自动记录最近 30 条。</div>';
        const sh = (h, fallback) => { const s = String(h || '').trim(); return s ? ('<span class="ftt-dbg-pre">' + esc(syncLogShortHash(s)) + '</span>') : ('<span class="ftt-muted">' + esc(fallback || '—') + '</span>'); };
        return list.slice(0, 30).map((r) => {
            const changed = !!(r && r.changed);
            const modeTag = changed ? '<span class="ftt-dot-ok ftt-text">' : '<span class="ftt-desc">';
            const cell = (n, b) => (Number(n) || 0) + ' 条 / ' + fmtBytes(Number(b) || 0);
            const src = String((r && r.src) || '').trim();
            return '<div class="ftt-dashed-b ftt-pad-y">\n'
                + '<div class="ftt-baseline-row"><span class="ftt-muted ftt-hint">' + esc(fmtTime(r && r.ts)) + '</span>'
                + (src ? ('<span class="ftt-hint ftt-hint-purple">📡' + esc(src) + '</span>') : '')
                + '<span class="ftt-hint-info">' + esc(String((r && r.action) || '同步')) + '</span>'
                + modeTag + esc(String((r && r.mode) || '')) + '</span>'
                + (r && r.ms ? ('<span class="ftt-muted ftt-hint">' + Math.round(Number(r.ms)) + 'ms</span>') : '') + '</div>\n'
                + '<div class="ftt-muted ftt-hint ftt-mt-1">本地 ' + cell(r && r.localN, r && r.localBytes) + ' → 对端 ' + cell(r && r.remoteN, r && r.remoteBytes) + ' → 同步后 ' + cell(r && r.afterN, r && r.afterBytes) + '</div>\n'
                + '<div class="ftt-hint ftt-mt-1">哈希：本地 ' + sh(r && r.localHash) + ' · 远端 ' + sh(r && r.remoteHash) + (r && r.afterHash ? (' · 同步后 ' + sh(r && r.afterHash)) : '') + '</div>\n'
                + '<div class="ftt-muted ftt-hint">' + esc(String((r && r.note) || '')) + '</div>\n'
                + '</div>';
        }).join('\n');
    } catch (e) { return '<div class="ftt-empty">同步日志读取失败</div>'; }
}

/** 同步区块内的一次性小工具行（本端源头 / 流量门控状态） */
function syncMiniInfoHtml() {
    try {
        const info = syncInfo();
        const g = storageStatusInfo().gates;
        return '<div class="ftt-muted ftt-hint">本端源头 📡' + esc(syncLocalSource())
            + ' · 流量门控 ' + (g.traffic ? '<b>开</b>' : '<b>关</b>')
            + ' · 镜像签名 ' + (g.mirrorNeeded ? '待推送' : '已一致')
            + ' · 楼层门控 ' + esc(String((g.floor && g.floor.why) || ''))
            + ' · 文件缓存 ' + Number(info.cacheNames || 0) + ' 项</div>';
    } catch (e) { return ''; }
}

/**
 * 存储页正文（对齐 V1 的分节布局；控件来自 `SETTINGS_CONTROLS.storage`，不重复定义）
 * @param {Array} controls 存储页控件表
 */
export function storagePageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const box = (keys) => list.filter((c) => keys.indexOf(String(c.key)) >= 0).map((c) => settingsControlHtml(c)).join('\n');
    const other = list.filter((c) => ['storage.stateFile', 'storage.stateFileBak', 'storage.snapshotFile', 'storage.settingsMirror',
        'storage.deletedKeepDays', 'storage.tauriNative', 'storage.tauriMirror', 'storage.verifyOnLoad', 'storage.syncOnSave',
        'storage.crossPullOnActivity', 'storage.crossPullOnVisible', 'storage.syncMetaProbe', 'syncTrafficGuard', 'storage.syncLogServer',
        'storage.worldbook', 'storage.worldbookName', 'storage.worldbookMode', 'storage.worldbookScanDepth', 'storage.worldbookPosition',
        'storage.worldbookDepth', 'storage.worldbookPreventRecursion', 'storage.worldbookProbability', 'storage.worldbookSticky',
        'storage.worldbookCooldown', 'storage.worldbookDelay', 'storage.worldbookMaxBytes'].indexOf(String(c.key)) < 0);
    return [
        '<div class="ftt-muted ftt-mb-2">只列开关与状态；统一存储抽象（分类 → 载体 → 后端 → 策略）为 V1 的治理视图，V2 收敛为「本机缓冲 + 服务端记忆文件」两型（见 docs/P8i）。</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">记忆文件（服务端 · 核心基准）</div>',
        '<div class="ftt-muted">记忆数据<b>独立成文件</b>存于服务端用户目录（不塞进 settings）；文件名固定 ' + mono('ftt2-state-&lt;slug&gt;.json') + '。</div>',
        '<div class="ftt-muted ftt-my-1" data-ftt-state-file-status>' + stateFileStatusHtml() + '</div>',
        box(['storage.stateFile', 'storage.stateFileBak', 'storage.snapshotFile', 'storage.settingsMirror', 'storage.deletedKeepDays']),
        '<div class="ftt-muted">删除条目记「id + 内容哈希」双墓碑并随文件同步：对端以新 id 重写也不会复活。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">宿主平台 · 原生存储（自动切换）</div>',
        '<div class="ftt-muted ftt-my-1">V1 在检测到 TauriTavern（<span class="ftt-mono">window.__TAURITAVERN__</span>）时改走其原生存储 <span class="ftt-mono">api.extension.store</span>；'
        + 'V2 现阶段统一走酒馆用户目录文件（原生存储通道属后续批次，本页仅保留同名配置键与说明）。</div>',
        box(['storage.tauriNative', 'storage.tauriMirror']) + '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">本机缓冲（仅缓冲 · 权威=记忆文件）</div>',
        '<div class="ftt-muted">localStorage / IndexedDB 仅作本机<b>缓冲</b>（常驻、无开关）：加速读取与离线回退；权威数据是<b>服务端记忆文件</b>。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">一致性</div>',
        box(['storage.verifyOnLoad', 'storage.syncOnSave', 'storage.crossPullOnActivity', 'storage.crossPullOnVisible', 'storage.syncMetaProbe', 'syncTrafficGuard']),
        '<div class="ftt-muted">关闭「服务端清单预判」则每轮完整下载远端记忆文件（慢链路一次省 20s+）；关闭「楼层哈希差异门控」则每次保存都联网对账（不推荐）。</div>',
        '<div class="ftt-muted">统一「标准化信封」+ 哈希校验/损坏降级；本机缓冲常驻，权威=服务端记忆文件，跨端异步对账补充。</div>',
        syncMiniInfoHtml() + '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">世界书存储（单向写入 · 由下方开关联动）</div>',
        box(['storage.worldbook', 'storage.worldbookName', 'storage.worldbookMode', 'storage.worldbookScanDepth', 'storage.worldbookPosition',
            'storage.worldbookDepth', 'storage.worldbookPreventRecursion', 'storage.worldbookProbability', 'storage.worldbookSticky',
            'storage.worldbookCooldown', 'storage.worldbookDelay', 'storage.worldbookMaxBytes']),
        '<div class="ftt-muted">词条镜像（类目常驻 + 原子分层重建、变更后延迟自动同步）依赖世界书写入能力，属后续批次（B8）；本页先保留同名配置键。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">状态与操作</div>',
        '<div class="ftt-muted" data-ftt-storage-status>' + stateFileStatusHtml() + '</div>',
        '<div class="ftt-row">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="storageStatusRefresh" title="读取服务端真值并与本端合并">🔄 刷新状态（取服务端最新并合并）</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="storageSync" title="双向同步并写入服务端（含备份与快照）">🔄 立即同步（含备份）</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="storageVerify">✅ 校验并修复</button>',
        '<span class="ftt-muted">📤 导出 / 📥 导入已移至「设定 → 数据管理」。</span></div>',
        '<div class="ftt-muted">「刷新状态」＝取服务端最新并合并；「立即同步」＝双向同步 + 备份 + 快照。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">🔄 同步日志（最近 30 条 · 本角色）</div>',
        '<div class="ftt-muted ftt-mb-1">每次对账/镜像记一条：<b>本地 → 对端 → 同步后</b>（条数/大小）+ 处置；新→旧，用于追溯不同步。</div>',
        box(['storage.syncLogServer']),
        '<div class="ftt-muted ftt-mb-1">开启后日志存服务端（随账号持久化）；打开页面自动与服务端交叉合并（去重取并集，最近 30 条），仅本机更全时回传。关闭则只存本机。</div>',
        '<div class="ftt-muted ftt-mb-1" data-ftt-sync-log-status>' + syncLogServerStatusHtml() + '</div>',
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="syncLogRefresh">🔄 刷新日志（与服务端合并）</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="syncLogClear">🧹 清空日志</button><span class="ftt-muted">（仅本聊天角色）</span></div>',
        '<div data-ftt-sync-log style="max-height:280px;overflow-y:auto;margin-top:6px">' + syncLogHtml() + '</div></div>',

        (other.length ? ('<div class="ftt-section"><div class="ftt-sec-title">其它</div>' + other.map((c) => settingsControlHtml(c)).join('\n') + '</div>') : ''),
    ].join('\n');
}

/**
 * 存储页动作（V1 同名动作：storageStatusRefresh / storageSync / storageVerify / syncLogRefresh / syncLogClear）
 * @returns {Promise<{ok:boolean, action:string, note:string, detail?:object}>}
 */
export async function syncAction(action, payload) {
    const a = String(action || '');
    const p = payload || {};
    try {
        if (a === 'storageSync') {
            syncToast('sync', '正在跨端同步…', '读取对端并判定处置方式…（完成后自动写入备份文件）');
            const r = await crossSyncManual();
            noteSyncReport('manual', r);
            const info = r.info || {};
            let note = '镜像同步完成';
            if (r.mode === 'none') note = '未检测到对端数据（已写入本端记忆文件 + 备份）';
            else if (r.mode === 'same') note = '两端已一致（本端 ' + (info.localN || 0) + ' 条 / 对端 ' + (info.remoteN || 0) + ' 条）· 已更新备份文件';
            else if (r.mode === 'replace') note = (r.side === 'remote' ? '已采用对端（较新/更全）' : '本端较新（保留本地）') + ' · 时间差 ' + (info.tsDiff || 0) + 'ms · 本端 ' + (info.localN || 0) + ' / 对端 ' + (info.remoteN || 0) + ' 条 · 整体替换（已备份）';
            else if (r.mode === 'merge') note = '已双向融合：新增 ' + ((r.stat && r.stat.added) || 0) + ' · 冲突 远端胜 ' + ((r.stat && r.stat.conflictWinRemote) || 0) + ' / 本地胜 ' + ((r.stat && r.stat.conflictWinLocal) || 0);
            else if (r.mode === 'blocked') { note = '同步已推迟（任务进行中）'; syncToast('warning', '同步已推迟', r.error || ''); }
            else if (r.mode === 'busy') { note = '另有同步在进行中'; syncToast('warning', '同步忙', r.error || ''); }
            else note = String(r.error || '跨端同步完成');
            if (r.mode !== 'blocked' && r.mode !== 'busy') syncToast(r.mode === 'none' ? 'info' : 'success', note, '');
            return { ok: r.mode !== 'error' && r.mode !== 'blocked' && r.mode !== 'busy', action: a, note, detail: r };
        }
        if (a === 'storageStatusRefresh') {
            syncToast('sync', '正在获取服务端最新数据…', '记忆文件（主/备份）+ 快照文件 → 自动合并');
            const rep = await refreshFromServer();
            noteSyncReport('refresh', rep);
            if (rep.err) {
                syncToast('warning', rep.blocked ? '刷新已推迟（任务进行中）' : '刷新失败', rep.err);
                return { ok: false, action: a, note: rep.err, detail: rep };
            }
            const src = rep.file ? (rep.bakFallback ? '备份文件(-bak)' : '记忆文件') : '无';
            const m = rep.merged || {};
            const note = '服务端：' + (rep.file ? (rep.file.entries + ' 条') : '无数据')
                + ' · 本机合并后：' + (m.entries || 0) + ' 条 / ' + (m.snaps || 0) + ' 个快照'
                + ' · ' + (rep.pushed ? '已回推服务端' : '无需回推');
            syncToast('success', '已获取服务端最新并合并（源：' + src + '）', note);
            return { ok: true, action: a, note, detail: rep };
        }
        if (a === 'storageVerify') {
            const r = await storageVerify(true);
            const bad = (r.details || []).filter((d) => d.has && !d.ok);
            const note = bad.length ? ('发现 ' + bad.length + ' 个损坏后端，已以最新有效源修复：' + bad.map((d) => d.name).join('、')) : '全部存储校验通过';
            syncToast(bad.length ? 'warning' : 'success', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        if (a === 'syncLogRefresh') {
            const info = await syncLogServerMerge({ force: true });
            let note = '同步日志已刷新（仅本机记录）';
            if (info && info.ok) note = '同步日志已对齐服务端：本机 ' + info.localN + ' 条 · 服务端 ' + info.remoteN + ' 条 → 合并 ' + info.mergedN + ' 条' + (info.uploaded ? '（已回传服务端）' : '');
            else if (info && info.reason === 'off') note = '同步日志服务端化已关闭（仅本机保存）';
            else if (info && info.reason === 'disabled') note = '服务端日志通道本会话不可用（仅本机保存）';
            syncToast(info && info.ok ? 'success' : 'info', note, '');
            return { ok: true, action: a, note, detail: info };
        }
        if (a === 'syncLogClear') {
            syncLogClear();
            const n = syncLogList().length;
            syncToast('success', '同步日志已清空', '新记录将自动续写（最近 30 条）');
            return { ok: true, action: a, note: '同步日志已清空（剩余 ' + n + ' 条）', detail: { n } };
        }
        return { ok: false, action: a, note: '未知存储动作：' + a };
    } catch (e) {
        const note = String((e && e.message) || e).slice(0, 160);
        syncToast('error', '存储动作失败', note);
        return { ok: false, action: a, note, error: note };
    }
}

/** 存储/同步动作名判定（供面板分发；保持 V1 动作名逐字一致） */
export const SYNC_ACTIONS = Object.freeze(['storageSync', 'storageStatusRefresh', 'storageVerify', 'syncLogRefresh', 'syncLogClear']);

/** 存储页版本行（关于页/调试用；确认页面与内核同版本） */
export function syncVersionLine() { return VERSION + ' · ' + String((cfg && cfg.updateRepo) || ''); }

// ============================================================
// ui/sync.js —— **存储页同步区块与动作**（B7-2；结构与文案对齐 V1 `13-UI-设置与存储开关.js`）
// 覆盖：记忆文件状态行 / 快照与清单状态 / 一致性开关 / 状态与操作（刷新状态·立即同步·校验并修复）/
//   同步日志（最近 30 条：本地 → 对端 → 同步后 的条数与大小 + 处置 + 本端源头）。
// B9-d 追加：**跨端分歧待选横幅**（V1 `renderStorageStatus` 尾部 `ftt-warn-box`(~26490)）+ 两个 V1 同名动作
//   `syncPickLocal`(~26862「保留本端（覆盖对端）」)/ `syncPickRemote`(~26882「采用对端（整体替换）」)。
// v3.0.4（用户要求）：「设定跨端同步分歧中，应增加合并差异选项，即将对端下载后合并去重。」→ 横幅第三项
//   `syncPickMerge`（下载对端 → 并集 + 去重 + 冲突按时间取新 + 墓碑生效 → 写回服务端；两端数据都不丢，
//   故不进危险动作清单、无需二次确认）；另见 v3.0.3 起「自动路径已改为一律自动合并」。
// 说明：V1 的「存储治理（统一抽象·只读）」依赖其多后端抽象，V2 为「本机缓冲 + 文件通道」两型 →
//   以只读说明行呈现；「宿主原生存储」自 v2.77.0 起为**真实实现**（`adapters/tt-store.js` 官方契约 +
//   `adapters/file-transport.js` 后端路由）→ 存储页恢复该分区与通道状态行。
// ============================================================
import { cfg, state } from '../core/model/runtime.js';
import { VERSION } from '../core/constants.js';
import { escHtml } from '../core/util.js';
import { syncLogShortHash, syncLogStat } from '../core/sync-log.js';
import {
    storageStatusInfo, stateFileStatus, syncLogServerStatus, syncLogList, syncLogClear,
    syncLogServerMerge, storageVerify, crossSyncManual, refreshFromServer, syncLocalSource,
    noteSyncReport, syncToast, crossPendingView, crossPendingGet, crossPendingClear, applyRemoteReplaceState,
    applyRemoteMergeToState,
    storageWriteAll, slimGzipInfo, syncLogPush,
} from '../adapters/sync.js';
import { storageEnvelope } from '../core/envelope.js';
import { dataAggHash } from '../core/cross-sync.js';
import { settingsControlHtml } from './settings-pages.js';
import { hintDetailsHtml } from './hints.js';   // v3.16.0：本地文件模式的折叠说明
// v2.92.0（用户要求）：需人工确认项 —— 设定 → 存储 展示同一份清单（总览亦有醒目提示）
import { listConflicts, pendingConflictCount, clearConflicts } from '../core/conflicts.js';
import { refreshWorldbookNames, worldbookNames } from '../host/worldbook.js';
// v2.77.0：文件通道后端（宿主原生存储 / 酒馆用户目录文件）—— 状态行 + 折叠详情
import { ttChannelStatusHtml, ttChannelDetailHtml } from '../adapters/tt-store.js';
// v3.16.0（用户要求）：本地文件存储模式 —— 状态展示 + 「立即对齐本机层」动作
// v3.26.0（用户要求）：目录选择器（候选 / 新建 / 系统选择 / 校验）+ 采用目录的单一入口
import {
    localFileStatsGet, localFilePathSanitize, localFileDirCandidates, localFileDirRemember,
    localFileDirScanHost, localFileProbeDir, localFileRealLocation,
} from '../adapters/local-file.js';
import { localLayerInfo, switchLocalLayer } from '../adapters/store.js';
// v3.26.0：目录选择器写回配置（与设定页同一落盘入口）
import { saveKernelCfg } from '../adapters/config-store.js';
// v3.26.0：「从系统选择文件夹…」—— 取文件夹名（宿主限制下只能作为数据目录内的子目录名）
import { pickDirectoryName } from './file-io.js';
// v2.94.0（`docs/D12` §3.4 / 阶段 S3）：楼层校准只读诊断 + 「重新校准楼层」幂等动作
import { floorCalibrateStatus } from '../host/floor-trim.js';

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
        return '记忆文件：<b>已启用</b>' + (s.archive ? (' · 角色「' + esc(s.archive) + '」') : '') + '<br>'
            + '主文件 ' + mono(s.name) + (s.bakEnabled ? ' · 含备份' : '') + (s.snapEnabled ? ' · 含快照' : '') + '<br>'
            + (when ? ('最近写入 ' + when) : '本次会话尚未写入')
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

/**
 * 跨端分歧待选横幅（V1 `renderStorageStatus` 尾部 `ftt-warn-box` 逐字口径，~26490）：
 *   标题「⚠️ 跨端同步分歧 · 请选择保留哪个版本」+ 统计行（本地/对端条数与更新时间、时间差、仅本端/仅对端/冲突）
 *   + 两个动作按钮。**按钮文案与 V1 逐字一致**（`保留本地（N 条）` / `采用对端（N 条）`）；V1 未给这两个按钮
 *   `title` 属性 —— 此处同样**不加 title**（逐字对齐，不臆造）。
 * 与 V1 的唯一差异：时间用 V2 既有 `fmtTime`（避免 `toLocaleString` 的环境相关输出，便于单测逐字断言）。
 */
export function divergenceBannerHtml() {
    try {
        const p = crossPendingView();
        if (!p || !p.hasEnv) return '';
        const s = '<div class="ftt-warn-box"><b class="ftt-pend-title">⚠️ 跨端同步分歧 · 请选择保留哪个版本</b>'
            + '<div class="ftt-desc ftt-my-1">本地 ' + p.localN + ' 条（更新 ' + fmtTime(p.localTs) + '）／ 对端 ' + p.remoteN + ' 条（更新 ' + fmtTime(p.remoteTs) + '）'
            + '· 时间差 ' + (Number(p.tsDiff) / 1000).toFixed(1) + 's'
            + ' · 仅本端 ' + p.onlyLocal + ' / 仅对端 ' + p.onlyRemote + ' / 冲突 ' + p.conflict + '</div>'
            + '<div class="ftt-row ftt-mt-2">'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="syncPickLocal">保留本地（' + p.localN + ' 条）</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="syncPickRemote">采用对端（' + p.remoteN + ' 条）</button>'
            // v3.0.4（用户要求）：「设定跨端同步分歧中，应增加合并差异选项，即将对端下载后合并去重。」
            //   即：**下载对端 → 并集合并 + 去重 + 冲突按时间取新 + 墓碑生效**，两端数据都不丢；合并结果写回服务端。
            //   口径说明：两个覆盖型选择会**丢弃**另一方的差异（故需二次确认）；本选项**不丢数据** → 无需确认。
            + '<button class="ftt-btn ftt-sm" data-ftt-action="syncPickMerge" title="下载对端后并集合并去重 —— 两端数据都不丢（推荐）">🔀 合并差异（下载对端后去重合并）</button>'
            + '</div>'
            + '<div class="ftt-muted ftt-hint">合并差异 = 下载对端 → 并集去重（同 id 按时间取新，删除墓碑生效）→ 写回服务端；两端数据都不丢。</div>'
            + '</div>';
        return s;
    } catch (e) { return ''; }
}

/** 条目瘦身 / gzip 写入的只读说明行（如实呈现当前开关与写入名，不做假控件） */
export function slimGzipInfoHtml() {
    try {
        const i = slimGzipInfo();
        return '<div class="ftt-muted ftt-hint" data-ftt-slim-gzip>存储编码：瘦身 ' + (i.slim ? '<b>已开启</b>' : '关')
            + ' · gzip ' + (i.gzip ? '<b>已开启</b>' : '关')
            + ' · 当前写入名 ' + mono(i.writeName)
            + '；旧文件仍可读</div>';
    } catch (e) { return ''; }
}

/** 同步区块内的一次性小工具行（本端源头 / 流量门控状态） */
function syncMiniInfoHtml() {
    try {
        const g = storageStatusInfo().gates;
        return '<div class="ftt-muted ftt-hint">本端源头 📡' + esc(syncLocalSource())
            + ' · 流量门控 ' + (g.traffic ? '<b>开</b>' : '<b>关</b>') + '</div>';
    } catch (e) { return ''; }
}

/**
 * 存储通道状态行（宿主原生存储 / 酒馆用户目录文件；只读数据行）
 * 行内只给「当前通道 + 读写计数」，命名空间与原因放折叠详情（避免页面提示罗嗦）。
 */
export function storageChannelHtml() {
    try {
        return '<div class="ftt-muted ftt-hint" data-ftt-tt-channel>' + ttChannelStatusHtml() + '</div>'
            + '<details class="ftt-details ftt-hint-details"><summary>通道详情</summary>'
            + '<div class="ftt-desc">' + ttChannelDetailHtml() + '</div></details>';
    } catch (e) { return ''; }
}

/**
 * 存储页正文（对齐 V1 的分节布局；控件来自 `SETTINGS_CONTROLS.storage`，不重复定义）
 *
 * v2.56.0 精简（用户要求：「设定-存储中的大量提示信息需优化，避免出现历史版本、无关内容、罗嗦提示」）：
 *   ① 删除历史/开发说明：V1 治理视图说明、「V1 在检测到 TauriTavern 时…V2 现阶段…（后续批次）」整节、
 *      docs/P8i 指向、「标准化信封」「统一存储抽象」等架构描述、「墓碑/哈希/魔数」等内部术语；
 *   ② 删除无关内容：「📤 导出 / 📥 导入已移至数据管理」的指路、与按钮 title 重复的操作解释、
 *      重复渲染两次的记忆文件状态行（只在这一节保留一份）；
 *   ③ 每条提示只讲「这是什么 + 会有什么后果」，并修掉文件名里 `<slug>` 被二次转义显示成 `&lt;slug&gt;` 的问题。
 * v2.77.0：宿主原生存储通道**已实现**（`adapters/tt-store.js`）→ 恢复「存储通道」分区：
 *   状态行 + 后端选择（自动/强制/关闭）+ 镜像开关；未检测到宿主时同样如实呈现「当前 = 酒馆用户目录文件」。
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
    // v2.92.0：待人工确认项（跨端合并冲突 / 并集自检异常）—— 有才显示，附「全部已确认」按钮
    const conflictSection = (() => {
        try {
            const n = pendingConflictCount();
            if (n <= 0) return '<div class="ftt-hint" data-ftt-conflicts>无待确认项（跨端合并冲突与并集自检均正常）</div>';
            const rows = listConflicts().slice(0, 6).map((x) => '<div class="ftt-muted">· ' + esc(String(x.kind || '')) + '：' + esc(String(x.detail || '').slice(0, 110)) + '（×' + Math.max(1, Number(x.count) || 1) + '）</div>').join('');
            return '<div class="ftt-section" data-ftt-conflicts><div class="ftt-sec-title">⚠️ 待确认（共 ' + n + ' 项）</div>'
                + '<div class="ftt-muted">这些是**需人工核对**的情况（合并冲突 / 并集自检异常），已按「并集 + 按时间取新」处理，**不会自动改数据**。</div>'
                + rows
                + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="resolveConflicts" title="全部标记为已确认（只清提示，不动数据）">✅ 全部已确认</button></div></div>';
        } catch (e) { return ''; }
    })();
    return [
        conflictSection,
        '<div class="ftt-section"><div class="ftt-sec-title">记忆文件（服务端 · 核心基准）</div>',
        '<div class="ftt-muted">记忆数据存在服务端的独立文件里（文件名 ' + mono('ftt2-state-<角色>.json') + '）。</div>',
        '<div class="ftt-muted ftt-my-1" data-ftt-state-file-status>' + stateFileStatusHtml() + '</div>',
        box(['storage.stateFile', 'storage.stateFileBak', 'storage.snapshotFile', 'storage.settingsMirror', 'storage.deletedKeepDays']),
        '<div class="ftt-muted">删除条目会留下记录并随文件同步，对端不会把已删条目复活。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">本机缓冲（仅缓冲 · 权威=记忆文件）</div>',
        '<div class="ftt-muted">本机只做加速读取与离线回退，可随时清除；权威数据是服务端记忆文件。</div>',
        // v3.16.0（用户要求「本地存储除了当前内存和变量外，增加本地文件存储模式，用于替代变量存储，避免超出限制。
        //   但需用户在设定-存储中约定本地化路径。如果没约定路径，则视为不开启。开启后将取代变量方式」）
        localFileModeHtml(), '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">存储通道（自动识别宿主）</div>',
        storageChannelHtml(),
        box(['storage.tauriNative', 'storage.tauriMirror']),
        '<div class="ftt-muted">宿主提供原生存储时记忆文件改走它；读取未命中会回退到酒馆文件。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">一致性</div>',
        box(['storage.verifyOnLoad', 'storage.syncOnSave', 'storage.crossPullOnActivity', 'storage.crossPullOnVisible', 'storage.syncMetaProbe', 'syncTrafficGuard']),
        '<div class="ftt-muted">上面两个「省流量」开关关闭后，每次保存都会联网对账（更慢，不推荐关闭）。</div>',
        syncMiniInfoHtml() + '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">世界书存储（单向写入 · 由下方开关联动）</div>',
        box(['storage.worldbook', 'storage.worldbookName', 'storage.worldbookMode', 'storage.worldbookScanDepth', 'storage.worldbookPosition',
            'storage.worldbookDepth', 'storage.worldbookPreventRecursion', 'storage.worldbookProbability', 'storage.worldbookSticky',
            'storage.worldbookCooldown', 'storage.worldbookDelay', 'storage.worldbookMaxBytes']),
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="worldbookRefresh">📚 刷新世界书列表</button>'
        + '<span class="ftt-muted">只写世界书、不读回；记忆变更后自动重建。</span></div>',
        '<div class="ftt-muted">写入需要酒馆的世界书接口；宿主不支持时会提示，且不影响记忆数据。</div></div>',

        // v2.94.0（`docs/D12` §3.4 / 阶段 S3）：楼层校准 —— 只读诊断（最近一次收缩时间 / 影响条数）+
        //   「重新校准楼层」幂等动作（用于「用户在酒馆里自己删了楼」或跨端合并后编号可疑的兜底）。
        floorCalibrateSectionHtml(),

        '<div class="ftt-section"><div class="ftt-sec-title">状态与操作</div>',
        divergenceBannerHtml(),
        // v3.0.3（用户要求）：「如果发现本地与服务端不一致，自动下载合并」—— 说明当前口径（无需人工选择）
        '<div class="ftt-muted ftt-hint" data-ftt-auto-merge>不一致时<b>自动下载并合并</b>，再推回服务端；无需人工选择。</div>',
        '<div class="ftt-row">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="storageStatusRefresh" title="读取服务端真值并与本端合并">🔄 刷新状态（取服务端最新并合并）</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="storageSync" title="双向同步并写入服务端（含备份与快照）">🔄 立即同步（含备份）</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="storageVerify">✅ 校验并修复</button>',
        '</div>',
        slimGzipInfoHtml() + '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">🔄 同步日志（最近 30 条 · 本角色）</div>',
        '<div class="ftt-muted ftt-mb-1">每次对账 / 同步 / 镜像推送记一条（本地 → 对端 → 同步后），用于追溯不同步。</div>',
        box(['storage.syncLogServer']),
        '<div class="ftt-muted ftt-mb-1">开启后日志随账号存到服务端（双端可见），关闭则只存本机。</div>',
        '<div class="ftt-muted ftt-mb-1" data-ftt-sync-log-status>' + syncLogServerStatusHtml() + '</div>',
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="syncLogRefresh">🔄 刷新日志（与服务端合并）</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="syncLogClear">🧹 清空日志</button><span class="ftt-muted">（仅本聊天角色）</span></div>',
        '<div data-ftt-sync-log style="max-height:280px;overflow-y:auto;margin-top:6px">' + syncLogHtml() + '</div></div>',

        (other.length ? ('<div class="ftt-section"><div class="ftt-sec-title">其它</div>' + other.map((c) => settingsControlHtml(c)).join('\n') + '</div>') : ''),
    ].join('\n');
}

/**
 * v2.94.0（`docs/D12` §3.4 / 阶段 S3）——**楼层校准分节**（设定 → 存储）。
 * 用户会**主动删楼**（酒馆对高楼层支持差）→ 楼层编号失去一致性时必须能自查、能手动兜底：
 *   · 只读诊断：当前楼层数 / 台账标记数 / 最近一次收缩时间 / 已标记「楼层信息失效」的条目数；
 *   · 「🔄 重新校准楼层」（幂等）：按当前聊天现实重跑一次收缩处理（哈希归位台账 + 按**内容哈希**把还能对上的条目
 *     记到**新的位置**（`floorNow*`）+ 找不到原文的条目打「**原文已移除**」+ 收紧基线）。
 *     v3.7.0（用户要求）：**原始来源楼层永不变动**，记忆条目与文案都**绝不删除**。
 */
function floorCalibrateSectionHtml() {
    let st = null;
    try { st = floorCalibrateStatus(); } catch (e) { st = null; }
    if (!st) return '';
    const when = (() => {
        if (!st.at) return '尚未发生楼层收缩';
        try { return new Date(Number(st.at)).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(st.at); }
    })();
    const staleTxt = (st.stale > 0)
        ? ('<b>' + st.stale + '</b> 条条目的<b>原文已移除</b>（来源楼层仍保留可查，数据仍在）')
        : '没有条目的原文被移除';
    return '<div class="ftt-section" data-ftt-floor-calibrate><div class="ftt-sec-title">🧱 楼层校准</div>'
        + '<div class="ftt-muted">你在酒馆里删除楼层后，记忆数据<b>不会丢</b>，但记忆里的「第几楼」会失准，可在此自查并一键重算。</div>'
        + '<div class="ftt-muted ftt-my-1">当前 ' + Number(st.floors) + ' 层 · 已分析标记 ' + Number(st.marks) + ' 条 · 最近一次收缩：' + escHtml(when) + ' · ' + staleTxt + '</div>'
        + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="floorRecalibrate" title="按当前聊天重新校准楼层编号（幂等；只改编号，不删除任何条目）">🔄 重新校准楼层</button>'
        + '<span class="ftt-muted">只改编号，条目一条不删。</span></div></div>';
}

/**
 * v3.16.0（用户要求）——**本地文件存储模式**分节（设定 → 存储）。
 *   · 路径留空 = 不开启（变量层 + 内存库照旧）；填写 = 本机缓冲写进宿主的本地文件。
 *   · 路径输入框走通用 `data-ftt-cfg="storage.localFilePath"`（改动即落盘 + 自动对齐两层）。
 * v3.26.0（用户要求）：
 *   ① 「除了保留当前的 input，还需增加选择目录，可手动选择目录」→ 追加**目录选择器**
 *      （候选目录 / 新建目录并写探针校验 / 系统文件夹选择 / 校验当前目录），原 input **原样保留**；
 *   ② 「如果设置了本地缓冲目录，则存储不再使用内存或变量存储，只保留本地目录和服务端存储」
 *      → 状态行如实写出「变量层与内存库已停用」，并把本机层对齐语义改为**三层对齐**（迁移时清两层）。
 */
function localFileModeHtml() {
    let info = null;
    try { info = localLayerInfo(); } catch (e) { info = null; }
    const on = !!(info && info.enabled);
    const mode = on ? ('本地目录（' + esc(String(info.path || '')) + '）') : '变量（localStorage）+ 内存库';
    // v3.26.2（用户报告「本机缓冲超预算 → 本次跳过」）：普通模式下如实写出**留存形态**与**是否已停更**
    const plainTxt = (() => {
        if (!info) return '';
        if (on) return '';
        const stored = Number(info.localChars || 0);
        const plain = Number(info.plainChars || stored);
        const budget = Number(info.budget || 0);
        if (info.overBudget) {
            return ' · <b>已超出浏览器配额 → 本机层停更</b>（' + plain.toLocaleString() + ' > ' + budget.toLocaleString()
                + ' 字符；服务端与内存库不受影响）→ 建议在下方设置<b>本机缓冲目录</b>';
        }
        if (info.gz) return ' · <b>压缩留存</b>（原始 ' + plain.toLocaleString() + ' → 存 ' + stored.toLocaleString() + ' 字符）';
        return ' · 明文留存 ' + stored.toLocaleString() + '/' + budget.toLocaleString() + ' 字符';
    })();
    const staleTxt = (() => {
        const s = info && info.stale;
        if (!s || !Number(s.at)) return '';
        const when = (() => { try { return new Date(Number(s.at)).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(s.at); } })();
        return ' · ⚠️ 本机层自 <b>' + esc(when) + '</b> 起未更新（上次写入被跳过）';
    })();
    const stat = '<div class="ftt-muted ftt-my-1" data-ftt-local-file-status><b>本机缓冲模式：' + mode + '</b>'
        + (on
            ? (' · <b>变量层与内存库已停用</b>（只留目录 + 服务端） · 后端 ' + esc(String(info.backend || '—'))
                + ' · 最近写入 ' + Number(info.fileBytes || 0).toLocaleString() + ' 字符'
                + (Number(info.failures) ? (' · 失败 ' + Number(info.failures)) : ''))
            : plainTxt)
        + staleTxt
        + '</div>';
    const one = '<div class="ftt-muted">填目录 = 只写目录 + 服务端；留空 = 变量层 + 内存库。</div>';
    const desc = (() => { try { return settingsControlHtml({ key: 'storage.localFilePath', label: '本地文件目录（留空 = 不开启）', type: 'text' }); } catch (e) { return ''; } })();
    const detail = hintDetailsHtml('本地文件/目录模式说明', '<div class="ftt-hint">开启后：本机缓冲改写宿主的<b>本地目录</b>，'
        + '<b>不再写浏览器变量、也不再写内存库</b>（按要求：只保留本地目录与服务端存储）→ 不受浏览器本地化配额限制'
        + '（旧模式信封超过 1.8M 字符会<b>静默停更</b>）。<br>'
        + '目录只能在<b>宿主数据目录之内</b>（盘符 / 前导斜杠 / <code>..</code> 会被剥离，非法字符转 <code>_</code>）：'
        + 'TauriTavern → 真实目录 <code>_tauritavern/extension-store/&lt;命名空间&gt;/kv/local/</code>；网页版酒馆 → <code>user/files/&lt;目录&gt;/</code>。<br>'
        + '开启/关闭时自动对齐：开启 → 变量层与内存库里<b>较新的那份</b>迁进目录（写 → 回读校验 → 才清两层）；'
        + '关闭 → 目录内容迁回变量层与内存库。迁移<b>先写后清</b>，任何一步失败都不清数据。<br>'
        + '<b>停用范围</b>：记忆数据的变量层与内存库；调试日志 / 同步标记等辅助键体积有硬上限（如调试日志 0.6M 字符），仍留浏览器本地。</div>');
    const extra = on
        ? '<div class="ftt-muted">目录：读 ' + Number(info.reads || 0) + ' · 写 ' + Number(info.writes || 0)
            + ' · 校验 ' + Number(info.probes || 0) + ' 次</div>'
        : '';
    const ops = '<div class="ftt-row">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="localFileAlign" title="按当前路径约定对齐：开启时把变量层与内存库里较新的那份迁进目录并清空两层（写→回读校验→才清）；关闭时把目录内容迁回两层">🔁 立即对齐本机层</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="localFileStatusRefresh">🔄 刷新状态</button>'
        + '<span class="ftt-muted">先写后清，失败不清数据。</span></div>';
    return stat + one + desc + localFileDirPickerHtml(info) + detail + extra + ops;
}

/** v3.26.0：目录扫描结果缓存（动作里异步取，取完重绘即可见） */
let dirScanCache = null;

/** v3.26.0：目录选择器（折叠块；候选目录 / 新建 / 系统选择 / 校验） */
function localFileDirPickerHtml(info) {
    const cand = (() => { try { return localFileDirCandidates(); } catch (e) { return { items: [], host: { supported: false } }; } })();
    const items = (cand.items || []).concat(dirScanCache && dirScanCache.dirs ? dirScanCache.dirs.map((d) => ({ path: d, label: d, source: 'host', note: '宿主已有目录' })) : [])
        .filter((it, i, arr) => arr.findIndex((x) => x.path === it.path) === i);
    const rows = items.map((it) => '<button class="ftt-btn ftt-sm" data-ftt-action="localFileDirUse" data-ftt-dir="'
        + esc(it.path) + '" title="' + esc(it.note || '') + '">' + (it.current ? '✓ ' : '') + esc(it.label)
        + (it.source === 'host' ? '（宿主）' : '') + '</button>').join('');
    const realTxt = (() => { try { return localFileRealLocation(String((info && info.path) || '')).text; } catch (e) { return ''; } })();
    const scanRow = cand.host && cand.host.supported
        ? '<button class="ftt-btn ftt-sm" data-ftt-action="localFileDirScan" title="列举宿主扩展存储里已有的目录">🔍 扫描宿主已有目录</button>'
        : '<span class="ftt-muted">宿主未提供目录枚举（可手动输入）</span>';
    return '<details class="ftt-details" data-ftt-local-dir-picker><summary>📁 选择目录…（' + items.length + ' 个候选）</summary>'
        + (rows ? ('<div class="ftt-row">' + rows + '</div>') : '')
        + '<div class="ftt-row"><input type="text" data-ftt-local-dir-new placeholder="新建目录名（数据目录内的相对路径）">'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="localFileDirCreate" title="按输入框内容新建目录：写探针 → 回读校验 → 采用">➕ 新建并使用</button></div>'
        + '<div class="ftt-row">' + scanRow
        + '<button class="ftt-btn ftt-sm" data-ftt-action="localFileDirSystem" title="调用系统文件夹选择框；受宿主限制只取文件夹名，实际仍写到数据目录内">📂 从系统选择文件夹…</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="localFileDirProbe" title="对当前目录写探针并回读校验（证明真的可写）">✅ 校验当前目录</button></div>'
        + '<div class="ftt-hint">真实落盘：' + esc(realTxt) + '</div>'
        + (dirScanCache ? ('<div class="ftt-hint">' + esc(dirScanCache.note || '') + '</div>') : '')
        + '</details>';
}

/** 目录输入框（新建）的当前值：优先 payload（测试/程序化调用），否则读面板 DOM */
function domDirInput() {
    try {
        const doc = globalThis.document;
        const el = doc && typeof doc.querySelector === 'function' ? doc.querySelector('[data-ftt-local-dir-new]') : null;
        return el ? String(el.value == null ? '' : el.value) : '';
    } catch (e) { return ''; }
}

/**
 * v3.26.0：**采用一个目录**（选择器 / 新建 / 系统选择共用同一条路）：
 *   归一 → **写探针 + 回读校验**（证明可写）→ 落配置 → 记忆进候选清单 → 三层对齐（迁移 + 清两层）。
 * 校验不过**不改配置**（绝不让用户切到一个写不进去的目录）。
 */
async function adoptLocalDir(raw, action) {
    const norm = (() => { try { return localFilePathSanitize(raw); } catch (e) { return ''; } })();
    if (!norm) return { ok: false, action: action, note: '请先填写或选择一个目录名（数据目录内的相对路径）' };
    const probe = await localFileProbeDir(norm);
    if (!probe.ok) {
        const note = '目录不可写：' + norm + '（' + String(probe.error || 'unknown') + '）';
        try { syncToast('warning', '目录校验未通过', note); } catch (e) { /* 忽略 */ }
        return { ok: false, action: action, note: note, detail: probe };
    }
    const prev = String((cfg && cfg.storage && cfg.storage.localFilePath) || '');
    try {
        cfg.storage = Object.assign({}, cfg.storage || {});
        cfg.storage.localFilePath = norm;
        saveKernelCfg();
    } catch (e) { /* 落盘失败不影响内存态 */ }
    try { localFileDirRemember(norm); } catch (e) { /* 忽略 */ }
    const sw = await switchLocalLayer({ previousPath: prev });
    const note = '已采用目录 ' + norm + '（探针校验通过）· ' + String(sw.reason || '');
    try { syncToast(sw.ok === false ? 'warning' : 'success', '本机缓冲目录', note); } catch (e) { /* 忽略 */ }
    return { ok: sw.ok !== false, action: action, note: note, detail: { probe: probe, switch: sw } };
}

/**
 * 存储页动作（V1 同名动作：storageStatusRefresh / storageSync / storageVerify / syncLogRefresh / syncLogClear）
 * @returns {Promise<{ok:boolean, action:string, note:string, detail?:object}>}
 */
export async function syncAction(action, payload) {
    const a = String(action || '');
    const p = payload || {};
    try {
        // v3.26.0（用户要求「增加选择目录，可手动选择目录」）：
        //   `localFileDirUse`    = 候选目录一键采用（payload.dir）
        //   `localFileDirCreate` = 新建目录并采用（payload.dir，缺省读面板输入框）
        //   `localFileDirSystem` = 调系统文件夹选择框 → 取文件夹名 → 与新建同一条路（如实告知宿主限制）
        //   `localFileDirScan`   = 扫描宿主已有目录（宿主不支持时如实说明，不假装）
        //   `localFileDirProbe`  = 对当前目录写探针并回读校验
        if (a === 'localFileDirUse') return await adoptLocalDir(String(p.dir || ''), a);
        if (a === 'localFileDirCreate') return await adoptLocalDir(String(p.dir || '') || domDirInput(), a);
        if (a === 'localFileDirScan') {
            const r = await localFileDirScanHost();
            dirScanCache = { at: Date.now(), dirs: r.dirs || [], note: r.ok ? ('扫描到 ' + (r.dirs || []).length + ' 个宿主目录') : ('扫描未成功：' + String(r.note || r.reason || '')) };
            return { ok: !!r.ok, action: a, note: dirScanCache.note, detail: r };
        }
        if (a === 'localFileDirSystem') {
            const pk = await pickDirectoryName({});
            if (!pk || !pk.ok) {
                const why = String((pk && pk.reason) || 'cancelled');
                const note = why === 'empty-folder'
                    ? '所选文件夹是空的：系统选择框只在含文件时返回路径 → 请在上方手动输入目录名'
                    : ('未取到文件夹（' + why + '）→ 可手动输入目录名');
                try { syncToast('warning', '选择文件夹未完成', note); } catch (e) { /* 忽略 */ }
                return { ok: false, action: a, note: note };
            }
            const note0 = '已取到文件夹名「' + String(pk.name) + '」——宿主限制：扩展只能写到游戏数据目录内，故按该名字新建子目录。';
            const r = await adoptLocalDir(String(pk.name), a);
            return Object.assign({}, r, { note: note0 + String(r.note || '') });
        }
        if (a === 'localFileDirProbe') {
            const path = String((cfg && cfg.storage && cfg.storage.localFilePath) || '');
            if (!path) return { ok: false, action: a, note: '尚未设置目录（先选择或输入一个目录名）' };
            const pr = await localFileProbeDir(path);
            const note = pr.ok
                ? ('目录可写：' + path + '（写探针 → 回读校验通过 → 已删除探针）· ' + localFileRealLocation(path).text)
                : ('目录校验未通过：' + path + '（' + String(pr.error || 'unknown') + '）');
            try { syncToast(pr.ok ? 'success' : 'warning', '目录校验', note); } catch (e) { /* 忽略 */ }
            return { ok: !!pr.ok, action: a, note: note, detail: pr };
        }
        // v3.16.0（用户要求）：按当前「本地文件目录」约定对齐两层（变量 ↔ 本地文件；先写后清）
        if (a === 'localFileAlign') {
            const r = await switchLocalLayer();
            const note = (r.ok ? '本机层对齐完成：' : '本机层对齐未完成：') + String(r.reason || '');
            try { syncToast(r.ok ? 'success' : 'warning', note, ''); } catch (e) { /* 忽略 */ }
            return { ok: r.ok !== false, action: a, note: note, detail: r };
        }
        if (a === 'localFileStatusRefresh') {
            const info = (() => { try { return localFileStatsGet(); } catch (e) { return null; } })();
            return { ok: true, action: a, note: '本地文件模式：' + (info && info.enabled ? ('已开启（' + String(info.path || '') + '）') : '未开启（使用变量层）'), detail: info };
        }
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
        if (a === 'syncPickLocal' || a === 'syncPickRemote' || a === 'syncPickMerge') {
            // 分歧选择（V1 `syncPickLocal`(~26862) / `syncPickRemote`(~26882)；v3.0.4 增 `syncPickMerge`）：
            //   · 先取出并**立即清空**待选（V1 原样：无论成功与否都不再重复处置同一份待选）；
            //   · 保留本端 = 本端推送覆盖对端（`storageWriteAll`）；采用对端 = `applyRemoteReplaceState` 整体替换后再写回；
            //   · **合并差异（v3.0.4，用户要求）**：下载对端 → `applyRemoteMergeToState`（并集 + 去重 + 同 id 按时间取新 +
            //     墓碑生效）→ 写回服务端；两端数据都不丢，故**不进危险动作清单**（无需二次确认）。
            //   · 三者都写同步日志留痕（action='分歧选择'，V1 文案逐字）。
            const pend = crossPendingView();
            const pendEnv = (() => { try { const raw = crossPendingGet(); return raw && raw.env ? raw.env : null; } catch (e) { return null; } })();
            crossPendingClear();
            const t0 = Date.now();
            if (a === 'syncPickLocal') {
                await storageWriteAll(storageEnvelope(state));
                try {
                    const st = syncLogStat(state);
                    const rp = pend ? pend.remoteN : 0;
                    syncLogPush({ action: '分歧选择', mode: '保留本端(覆盖对端)', changed: true, ms: Date.now() - t0, localN: st.n, localBytes: st.bytes, remoteN: rp, remoteBytes: 0, afterN: st.n, afterBytes: st.bytes, localHash: dataAggHash(state), remoteHash: '', afterHash: dataAggHash(state), note: '用户选择保留本地版本，本端推送覆盖对端' });
                } catch (e2) { /* 忽略 */ }
                syncToast('success', '已保留本地版本', '本端将覆盖对端');
                return { ok: true, action: a, note: '已保留本地版本 —— 本端将覆盖对端', detail: { pending: pend } };
            }
            if (a === 'syncPickMerge') {
                // v3.0.4（用户要求）：「将**对端下载后合并去重**」——与另两个处置动作同口径：无待选时如实报「未找到待选对端」
                //   （不拿本端信封自合并假装成功）；有待选则**下载对端 + 并集去重 + 冲突按时间取新 + 墓碑生效**，再写回。
                const r = pendEnv ? applyRemoteMergeToState(pendEnv) : null;
                const st2 = (r && r.mode === 'merge' && r.stat) ? r.stat : {};
                await storageWriteAll(storageEnvelope(state));
                try {
                    const st = syncLogStat(state);
                    syncLogPush({
                        action: '分歧选择', mode: r ? '合并差异(下载对端去重合并)' : '未找到待选对端',
                        changed: !!(r && r.mode !== 'same'), ms: Date.now() - t0,
                        localN: (pend ? pend.localN : st.n), localBytes: st.bytes, remoteN: (pend ? pend.remoteN : 0), remoteBytes: 0,
                        afterN: st.n, afterBytes: st.bytes, localHash: dataAggHash(state), remoteHash: (pend ? pend.remoteHash : ''), afterHash: dataAggHash(state),
                        note: r ? '用户选择合并差异：已下载对端并**并集去重**（同 id 按时间取新，删除墓碑生效）后写回服务端（对端新增 ' + Number(st2.added || 0) + ' · 冲突远端胜 ' + Number(st2.conflictWinRemote || 0) + ' / 本地胜 ' + Number(st2.conflictWinLocal || 0) + '）' : '待选对端缺失，未改动本端数据',
                    });
                } catch (e2) { /* 忽略 */ }
                const noteM = r ? ('已合并差异 —— 对端已下载并去重（对端新增 ' + Number(st2.added || 0) + ' · 冲突 ' + (Number(st2.conflictWinRemote || 0) + Number(st2.conflictWinLocal || 0)) + ' 条按时间取新）') : '未找到待选对端（未改动本端）';
                syncToast(r ? 'success' : 'warning', r ? '已合并差异' : '未找到待选对端', r ? '两端数据都不丢，合并结果已写回服务端' : '本端数据未被改动');
                return { ok: !!r, action: a, note: noteM, detail: { merged: r, pending: pend } };
            }
            const ok = pendEnv ? applyRemoteReplaceState(pendEnv) : false;
            await storageWriteAll(storageEnvelope(state));
            try {
                const st = syncLogStat(state);
                syncLogPush({ action: '分歧选择', mode: ok ? '采用对端(整体替换)' : '未找到待选对端', changed: !!ok, ms: Date.now() - t0, localN: st.n, localBytes: st.bytes, remoteN: st.n, remoteBytes: st.bytes, afterN: st.n, afterBytes: st.bytes, localHash: dataAggHash(state), remoteHash: ok ? dataAggHash(state) : '', afterHash: dataAggHash(state), note: ok ? '用户选择采用对端版本，本端已替换为对端数据' : '待选对端缺失，未改动' });
            } catch (e2) { /* 忽略 */ }
            const noteR = ok ? '已采用对端版本 —— 本端已替换为对端数据' : '未找到待选对端（未改动本端）';
            syncToast(ok ? 'success' : 'warning', ok ? '已采用对端版本' : '未找到待选对端', ok ? '本端已替换为对端数据' : '');
            return { ok: !!ok, action: a, note: noteR, detail: { replaced: ok, pending: pend } };
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
        if (a === 'worldbookRefresh') {
            // V1 设定⑥「📚 刷新世界书列表」：重新拉取酒馆世界书名列表（供 storage.worldbookName 下拉使用）
            const names = await refreshWorldbookNames();
            const note = names.length ? ('世界书列表已刷新（' + names.length + ' 本）') : '未读取到世界书（需酒馆提供世界书接口）';
            syncToast(names.length ? 'success' : 'warning', note, '');
            return { ok: true, action: a, note, names, detail: { n: names.length } };
        }
        return { ok: false, action: a, note: '未知存储动作：' + a };
    } catch (e) {
        const note = String((e && e.message) || e).slice(0, 160);
        syncToast('error', '存储动作失败', note);
        return { ok: false, action: a, note, error: note };
    }
}

/** 存储/同步动作名判定（供面板分发；保持 V1 动作名逐字一致） */
export const SYNC_ACTIONS = Object.freeze(['storageSync', 'storageStatusRefresh', 'storageVerify', 'syncLogRefresh', 'syncLogClear', 'worldbookRefresh', 'syncPickLocal', 'syncPickRemote', 'syncPickMerge',
    // v3.16.0：本地文件模式（对齐两层 / 刷新状态）
    // v3.26.0：目录选择器（采用候选目录 / 新建并采用 / 系统选择 / 扫描宿主 / 校验目录）
    'localFileAlign', 'localFileStatusRefresh',
    'localFileDirUse', 'localFileDirCreate', 'localFileDirSystem', 'localFileDirScan', 'localFileDirProbe']);

/** 存储页版本行（关于页/调试用；确认页面与内核同版本） */
export function syncVersionLine() { return VERSION + ' · ' + String((cfg && cfg.updateRepo) || ''); }

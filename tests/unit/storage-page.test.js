// ============================================================
// 单元测试 · v2.56.0「设定 → 存储：提示信息精简」
//
// 用户要求：「设定-存储中的大量提示信息需优化，避免出现历史版本、无关内容、罗嗦提示。」
// 本批处理（逐项断言）：
//   · 删除历史/沿革：V1 治理视图说明、指向 docs/P8i 的引用、「后续批次」承诺、
//     「V1 在检测到 TauriTavern（window.__TAURITAVERN__）时改走 api.extension.store」整节；
//   · 删除无关内容：「📤 导出 / 📥 导入已移至数据管理」的指路、与按钮 title 重复的操作解释、
//     重复渲染两次的记忆文件状态行（现只留「记忆文件」节一份）；
//   · 删除内部术语：墓碑 / 哈希（页面提示层）/ 魔数 / 标准化信封 / 统一存储抽象 / 治理视图 / 通道支持压缩；
//   · 修掉文件名里 `<角色>` 被二次转义（页面显示成 &lt;角色&gt;）的真实渲染缺陷；
//   · 控制项标签去术语：删除墓碑保留（天）→ 已删除条目的保留天数 等；
//   · 宿主原生存储（V2 无实现）不再展示无效开关（配置键仍保留，供 V1 导入兼容）。
// 另：所有提示行长度 ≤ 80 字（状态行除外，那是状态不是提示）。
// 运行：node tests/unit/storage-page.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { storagePageHtml, stateFileStatusHtml } from '../../ui/sync.js';
import { SETTINGS_CONTROLS, settingsControlHtml } from '../../ui/settings-pages.js';

const R = makeReporter('storage-page v2.56.0 存储页提示精简');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

installGlobalHost(makeHost({}), makeDocument(['ftt-panel']));
setKernelState(emptyState());
globalThis.window = Object.assign({}, globalThis.window, {
    localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true },
});

const page = () => storagePageHtml(SETTINGS_CONTROLS.storage);

/** 页面上的「提示行」文本（`ftt-muted` 块；排除状态行/同步日志行） */
function hintTexts(html) {
    const out = [];
    const re = /<div class="ftt-muted[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
        const full = m[0];
        if (full.indexOf('data-ftt-state-file-status') >= 0) continue;    // 状态行不是提示
        if (full.indexOf('data-ftt-sync-log-status') >= 0) continue;      // 服务端日志状态行
        if (full.indexOf('data-ftt-slim-gzip') >= 0) continue;            // 存储编码状态行（含写入文件名）
        out.push(full.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim());
    }
    return out;
}

// ---- S 组：结构仍在（精简不能把功能删掉） ----
A('S1 七个分节与全部动作入口保持不变（只精简文案）', (() => {
    const h = page();
    const sections = ['记忆文件（服务端 · 核心基准）', '本机缓冲（仅缓冲 · 权威=记忆文件）', '一致性',
        '世界书存储（单向写入 · 由下方开关联动）', '状态与操作', '🔄 同步日志（最近 30 条 · 本角色）'];
    const actions = ['storageStatusRefresh', 'storageSync', 'storageVerify', 'syncLogRefresh', 'syncLogClear', 'worldbookRefresh'];
    return sections.every((s) => h.indexOf(s) >= 0)
        && actions.every((a) => h.indexOf('data-ftt-action="' + a + '"') >= 0)
        && h.indexOf('data-ftt-state-file-status') >= 0 && h.indexOf('data-ftt-sync-log') >= 0
        && h.indexOf('data-ftt-sync-log-status') >= 0;
})(), page().slice(0, 160));

A('S2 记忆文件状态行只渲染一份（旧版在「记忆文件」与「状态与操作」各渲染一次）', (() => {
    const h = page();
    return (h.match(/data-ftt-state-file-status/g) || []).length === 1
        && (h.match(/记忆文件：/g) || []).length === 1;
})(), '见断言');

// ---- N 组：历史 / 无关 / 内部术语必须消失 ----
A('N1 无历史与沿革：不出现 V1 / V2 / docs 路径 / 批次 / 治理视图 / TauriTavern 原生存储整节', (() => {
    const h = page();
    const gone = ['V1', 'V2', 'docs/', 'P8i', '批次', '治理视图', '统一存储抽象', '标准化信封',
        'TauriTavern', '__TAURITAVERN__', 'api.extension.store', '宿主平台 · 原生存储'];
    const hit = gone.filter((s) => h.indexOf(s) >= 0);
    return hit.length === 0;
})(), '见断言（hit 为空）');

A('N2 无无关指路与重复解释：不出现「导出 / 📥 导入已移至」、「刷新状态」＝ 的重复说明', (() => {
    const h = page();
    return h.indexOf('已移至「设定 → 数据管理」') < 0
        && h.indexOf('「刷新状态」＝') < 0 && h.indexOf('「立即同步」＝') < 0;
})(), '见断言');

A('N3 提示层无内部术语：墓碑 / 哈希 / 魔数 / 支持压缩 / slug 均不出现', (() => {
    const h = page();
    const gone = ['墓碑', '哈希', '魔数', '支持压缩', 'slug', 'id + 内容'];
    const hit = gone.filter((s) => h.indexOf(s) >= 0);
    return hit.length === 0;
})(), J({ hints: hintTexts(page()) }));

A('N4 无效的宿主原生存储开关不再展示（配置键与控件定义仍保留，供 V1 导入兼容）', (() => {
    const h = page();
    const keys = SETTINGS_CONTROLS.storage.map((c) => String(c.key));
    const native = SETTINGS_CONTROLS.storage.filter((c) => c.key === 'storage.tauriNative')[0];
    return h.indexOf('storage.tauriNative') < 0 && h.indexOf('storage.tauriMirror') < 0
        && h.indexOf('原生存储通道') < 0 && h.indexOf('原生模式下同时镜像写酒馆文件') < 0
        && keys.indexOf('storage.tauriNative') >= 0 && keys.indexOf('storage.tauriMirror') >= 0
        && !!native && settingsControlHtml(native).indexOf('<select') >= 0;
})(), '见断言');

A('N5 文件名里的尖括号只转义一次（旧版把 &lt;slug&gt; 再转义成 &amp;lt;slug&amp;gt;，页面显示成 &lt;slug&gt;）', (() => {
    const h = page();
    return h.indexOf('ftt2-state-&lt;角色&gt;.json') >= 0 && h.indexOf('&amp;lt;') < 0 && h.indexOf('&amp;gt;') < 0;
})(), '见断言');

A('N6 提示不罗嗦：每条提示 ≤ 70 字（状态行与同步日志行不计）', (() => {
    const hs = hintTexts(page());
    const tooLong = hs.filter((t) => t.length > 70);
    return hs.length > 0 && tooLong.length === 0;
})(), J(hintTexts(page()).map((t) => t.length)));

// ---- L 组：控制项标签去术语（用户看得懂） ----
A('L1 控制项标签去术语但语义不变：删除墓碑 → 已删除条目的保留天数；哈希校验 → 数据完整性；镜像 → 同步到服务端', (() => {
    const labels = SETTINGS_CONTROLS.storage.map((c) => String(c.label));
    return labels.indexOf('已删除条目的保留天数') >= 0 && labels.indexOf('载入时校验数据完整性') >= 0
        && labels.indexOf('保存时同步到服务端') >= 0 && labels.indexOf('同步前先比对清单（省流量·推荐开启）') >= 0
        && labels.indexOf('仅变化时同步（省流量·推荐开启）') >= 0 && labels.indexOf('同时写回存档变量（兼容旧格式）') >= 0
        && labels.indexOf('删除墓碑保留（天）') < 0 && labels.indexOf('载入时哈希校验') < 0
        && labels.indexOf('保存时同步镜像') < 0 && labels.indexOf('楼层哈希差异门控（省流量·推荐开启）') < 0;
})(), '见断言');

// ---- B 组：状态行仍给出关键事实（不是被删空） ----
A('B1 记忆文件状态行保留：已启用 / 角色 / 主文件（+备份/快照）/ 最近写入 / settings 归属', (() => {
    const s = stateFileStatusHtml();
    return s.indexOf('记忆文件：') >= 0 && s.indexOf('已启用') >= 0
        && s.indexOf('主文件') >= 0 && s.indexOf('settings 已剥离') >= 0
        && s.indexOf('slug') < 0 && s.indexOf('清单 ') < 0;
})(), stateFileStatusHtml());

A('B2 存储编码行只讲「开关 + 当前写入名 + 旧文件仍可读」，不提通道能力与魔数', (() => {
    const h = page();
    return h.indexOf('data-ftt-slim-gzip') >= 0 && h.indexOf('存储编码：条目瘦身') >= 0
        && h.indexOf('当前写入名') >= 0 && h.indexOf('读取自动识别格式，旧文件仍可读') >= 0
        && h.indexOf('魔数') < 0 && h.indexOf('不支持压缩') < 0;
})(), '见断言');

R.done();

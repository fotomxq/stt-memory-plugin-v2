'use strict';
// ============================================================
// oracle（显示界面开关）：真实 V1 插件 v1.206 的「设定 → 基础 → 显示界面开关」区块与控制语义
//   → 生成 tests/fixtures/v1-golden-entry-buttons.json
//
// 被测（用户报告）：「设定的显示界面开关存在问题，应该与 V1 对齐，且根据需求展示对应的按钮入口。
//   其中注意，当前扩展中的窗口入口选项是**强制开启**的，禁止被关闭，且**不展示该开关**。」
//
// 事实源（V1 v1.206）：
//   · `BTN_LOCATIONS = ['topbar','qr','float','menu']`（1130）；
//   · `BTN_LOC_LABELS = { topbar:'顶栏按钮', qr:'页面底部按钮', float:'悬浮按钮', menu:'扩展菜单项' }`（1131）；
//   · 默认 `buttonLocations = { topbar:false, qr:true, float:false, menu:false }`（1428，载入归一化在 2396/2412）；
//   · 区块 `buttonLocationRowsHtml()`（24538）渲染在 显示界面开关（25401~25404）；
//   · `syncButtons()`（23021）：topbar/float/menu 为真则建、qr 只要 `!== false` 就建，各自 id 见 create*；
//   · 保存（26591~26594）：`data-ftt-loc="<loc>"` → `cfg.buttonLocations[loc] = checked` → `saveCfg()` → `syncButtons()`。
//
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// 运行：node tests/fixtures/gen-v1-golden-entry-buttons.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin } = require(path.join(V1, 'tests/unit/helpers.js'));

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-entry-buttons.json');

const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** 从 V1 设定页 HTML 里投影「显示界面开关」区块（语义投影，不比对整体标记） */
function projectDisplaySection(html) {
    const h = String(html || '');
    const titleAt = h.indexOf('显示界面开关');
    if (titleAt < 0) return null;
    const rest = h.slice(titleAt);
    const nextAt = rest.indexOf('<div class="ftt-section">', 10);
    const body = nextAt >= 0 ? rest.slice(0, nextAt) : rest;
    const rows = [];
    const rowRe = /<div class="ftt-loc-row">([\s\S]*?)<\/div>/g;
    let m;
    while ((m = rowRe.exec(body))) {
        const seg = m[1];
        const label = strip((seg.match(/<span class="ftt-loc-name">([\s\S]*?)<\/span>/) || [])[1] || '');
        const loc = (seg.match(/data-ftt-loc="([^"]*)"/) || [])[1] || '';
        const checked = /data-ftt-loc="[^"]*"[^>]*\schecked/.test(seg);
        const hasSwitch = seg.indexOf('ftt-switch') >= 0;
        const stateText = strip(seg.replace(/^[\s\S]*?<\/label>/, ''));
        rows.push({ loc: loc, label: label, hasSwitch: hasSwitch, checked: checked, stateText: stateText });
    }
    const hint = strip((body.match(/<div class="ftt-muted">([\s\S]*?)<\/div>\s*$/) || [])[1] || '');
    return { title: '显示界面开关', rows: rows, hint: hint };
}

/** 入口 id（V1 create* 里的字符串常量） */
const IDS = { topbar: 'ftt-topbar-button', qr: 'ftt-qr-button', float: 'ftt-float-button', menu: 'ftt-menu-button' };

/** 观察 V1 `syncButtons()` 落地：登记各宿主容器 → 看容器 children 里有没有对应 id 的节点 */
function observeSync(F, doc) {
    const holder = doc.getElementById('top-settings-holder');
    const sendForm = doc.getElementById('send_form');
    const menu = doc.getElementById('extensionsMenu');
    const body = doc.body;
    const has = (nodes, id) => (nodes || []).some((n) => n && (n.id === id || (n.children || []).some((c) => c && (c.children || []).some((x) => x && x.id === id))));
    const out = {
        topbar: !!holder && has(holder.children, IDS.topbar),
        qr: !!sendForm && has(sendForm.children, IDS.qr),
        float: !!body && has(body.children, IDS.float),
        menu: !!menu && has(menu.children, IDS.menu),
    };
    return out;
}

(async function main() {
    const env = makeTavernEnv();
    const F = await loadPlugin(env);
    const doc = env.parentDoc;

    // 菜单容器：V1 默认没有 → 测试桩里显式登记（真实酒馆里由核心提供）
    if (!doc.getElementById('extensionsMenu')) {
        const el = { id: 'extensionsMenu', children: [], html: '', appendChild(c) { c.parentNode = this; this.children.push(c); return c; }, addEventListener() { }, querySelector() { return null; }, querySelectorAll() { return []; } };
        doc.register('extensionsMenu', el);
    }

    const out = {
        generatedFrom: 'src/FTT记忆组件-v1.205.js（当前 src 最新版）',
        locations: ['topbar', 'qr', 'float', 'menu'],
        labels: { topbar: '顶栏按钮', qr: '页面底部按钮', float: '悬浮按钮', menu: '扩展菜单项' },
        defaults: Object.assign({}, F.cfg.buttonLocations || {}),
        ids: Object.assign({}, IDS),
        section: null,
        sectionAllOff: null,
        syncAllOn: null,
        syncDefaults: null,
        notes: [
            'V1 的「扩展菜单项」与其他入口一样可关闭（syncButtons: loc.menu 为真才建）——V2 按用户要求**强制开启且不展示开关**（有意差异）。',
            'V1 的页面底部按钮（qr）默认开启（`loc.qr !== false`），顶栏/悬浮/扩展菜单默认关闭。',
            'V1 的关闭路径用 `getElementById(id).remove()`；测试桩的 getElementById 不登记动态节点，故 off 方向只在源码层面成立，此处只观察 on 方向。',
        ],
    };

    // ① 区块投影（默认态 / 全关态）
    F.setSettingsSub('base');
    out.section = projectDisplaySection(F.settingsHtml());
    F.cfg.buttonLocations = { topbar: false, qr: false, float: false, menu: false };
    out.sectionAllOff = projectDisplaySection(F.settingsHtml());

    // ② syncButtons 落地（全开）
    F.cfg.buttonLocations = { topbar: true, qr: true, float: true, menu: true };
    try { F.syncButtons(); } catch (e) { out.syncError = String((e && e.message) || e); }
    out.syncAllOn = observeSync(F, doc);

    // ③ 默认态（V1 归一的默认值：topbar/float/menu 关、qr 开）
    F.cfg.buttonLocations = Object.assign({}, out.defaults);
    out.syncDefaults = { locations: Object.assign({}, F.cfg.buttonLocations) };

    const json = JSON.stringify(out, null, 1) + '\n';
    if (OUT) fs.writeFileSync(OUT, json);
    process.stdout.write(json);
    process.exit(0);
})().catch((e) => { process.stderr.write('ERR: ' + (e && e.stack || e) + '\n'); process.exit(1); });

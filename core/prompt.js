// ============================================================
// core/prompt.js —— **逐字移植自 V1**（AI 摘要提示词构造）
// 覆盖：`buildSummaryPrompt(floorsText, dims)`、`armorPresetText()` 及其直接依赖 ——
//   提示词模板全部取自 `cfg.promptTemplates`（默认值在 core/config.js），仅读 cfg/state，零宿主依赖。
// ============================================================

import { defaultCfg } from './config.js';
import { DIMENSIONS } from './constants.js';
import { defaultCurrencyOwner, formatMoney, isTrackedCurrencyOwner, trackedCurrencyRoles } from './model/money.js';
import { cfg, dbgLog, log, state, warn, worldbookHooks } from './model/runtime.js';
import { nsfwSoftenRuleText } from './nsfw.js';
function compileRegexList(list) {
    const out = [];
    for (const item of list || []) {
        const s = String(item || '').trim();
        if (!s) continue;
        try { out.push(new RegExp(escapeRegex(s), 'i')); } catch (e) { warn('标签编译失败:', s, e); }
    }
    return out;
}
// 统计投喂过滤结果（供 UI 预览与日志），总行数=非空行

function applyFeedRegex(text) {
    try {
        const black = compileRegexList(cfg.feedRegexBlacklist);
        const white = compileRegexList(cfg.feedRegexWhitelist);
        if (!black.length && !white.length) return text;
        const raw = String(text || '');
        // 白名单「HTML 标签内容提取」—— 正文常带 HTML 标签（如 <content>…</content>），
        // 白名单项视为标签名，提取其内部内容作为投喂文本（大小写不敏感、可跨行、去空白）。
        if (white.length) {
            const extracted = [];
            for (const tagItem of cfg.feedRegexWhitelist || []) {
                const tag = String(tagItem || '').trim();
                if (!tag) continue;
                try {
                    const rx = new RegExp('<' + escapeRegex(tag) + '>([\\s\\S]*?)<\\/' + escapeRegex(tag) + '>', 'gi');
                    let m;
                    while ((m = rx.exec(raw))) { const c = String(m[1] || '').trim(); if (c) extracted.push(c); }
                } catch (e) { }
            }
            if (extracted.length) {
                let body = extracted.join('\n');
                if (black.length) body = body.split('\n').filter(l => !black.some(rx => rx.test(l))).join('\n');
                return body.replace(/\n{3,}/g, '\n\n').trim();
            }
            // 无标签形式 → 回退「行内包含」语义（兼容旧配置）
        }
        const lines = raw.split('\n');
        const out = [];
        let kept = 0;
        for (const line of lines) {
            // 修复：空行不再无条件保留（此前白名单过滤后留下大量空行 → "一大堆换行符"）。
            // 空行作为结构分隔在过滤后统一压缩；统计 kept 只计非空命中行。
            if (!line.trim()) continue;
            if (black.length && black.some(rx => rx.test(line))) continue;
            if (white.length && !white.some(rx => rx.test(line))) continue;
            kept++;
            out.push(line);
        }
        // 白名单存在但没有任何行命中 → 回退原文（避免把正文投喂成空白），并记录调试日志
        if (white.length && kept === 0 && lines.some(l => l.trim())) {
            dbgLog('摘要', { action: '白名单未命中已回退原文', whitelist: (cfg.feedRegexWhitelist || []).slice(), note: '没有任何行包含这些标签；请检查标签名与正文是否匹配（匹配不区分大小写）' });
            return text;
        }
        // 修复：过滤后压缩连续空行、清理首尾空行，避免输出堆叠换行符
        return out.join('\n').replace(/\n{2,}/g, '\n').trim();
    } catch (e) { warn('投喂正则过滤失败', e); return text; }
}

// 投喂标签「自动分析」（扫描最新 AI 正文的结构，供白/黑名单一键收录）
//   背景：白名单/黑名单标签过去只能手填，用户难以知道正文里到底有哪些结构可用。
//   现在点「分析最新正文结构」即扫描最近一条 AI 正文，列出：
//     · HTML/XML 标签名（如 content / thinking；成对闭合的排前）—— 白名单对这类标签走「提取标签内部内容」模式；
//     · 行内标记（如【战斗】【系统】[状态]）—— 白名单对这类走「行内包含」模式。
//   结果缓存在 rxTagScan（跨 renderPanel 保留），设置页据此渲染可点击标签；点击即收录（自动排重）。

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ==================== 旧实例接管（v1.24）====================
// 若页面上已运行旧版 FTT 实例（如旧的嵌入版 v1.23 与远程加载版同时启用），
// 先调用旧实例的 cleanup() 清理其 UI/事件/注入，再启动本实例，避免双实例冲突。

// ==================== 日期工具 ====================
// v1.193：年份可为**负数**（公元前）—— 统一格式 `-0221-01-02`（符号 + 4 位补零 + 月日）；
//   `parseDate` / `parseDateParts` / `storyDateMs` 三处共用同一口径（见 module09 的 clockDateStr/clockDateParts）。

function armorPresetText() {
    try {
        if (!cfg || cfg.armorPresetEnabled === false) return '';
        const pt = (cfg && cfg.promptTemplates) || {};
        const cur = pt.armorPreset;
        const def = (defaultCfg.promptTemplates && defaultCfg.promptTemplates.armorPreset) || '';
        const t = String(cur == null ? '' : cur);
        return (t.trim() ? t : def).trim();
    } catch (e) { return ''; }
}

async function getActiveWorldbooks() {
    // V1 调 TH 的 getCurrentCharPrimaryLorebook / getCharWorldbookNames：V2 由宿主注入视图（缺失 → 空集）
    try { return await worldbookHooks.getActive(); } catch (e) { warn('活跃世界书获取失败', e); return { primary: null, additional: [], global: [] }; }
}

async function getWorldbookEntries(name) {
    // V1 调 TH 的 getWorldbook(name)：V2 由宿主注入视图（缺失 → 空数组）
    if (!name) return [];
    try { return await worldbookHooks.getEntries(String(name)); } catch (e) { warn(`世界书词条获取失败:${name}`, e); return []; }
}
// 收集最近楼层原始行（未过滤，供 buildFeedFloorText 与投喂预览统计共用）
// 楼层角色判定（未摘要楼层只统计 AI 楼，用户输入仅作参考）

async function buildWorldbookFeedText() {
    try {
        const cfgWb = Array.isArray(cfg.feedWorldbooks) ? cfg.feedWorldbooks : [];
        let targets = [];
        if (cfgWb.length) {
            targets = cfgWb.slice();
        } else {
            const active = await getActiveWorldbooks();
            targets = [active.primary, ...active.additional, ...active.global].filter(Boolean);
        }
        if (!targets.length) return '';
        const lines = [];
        for (const name of targets.slice(0, 5)) {
            const entries = await getWorldbookEntries(name);
            if (!entries.length) continue;
            const entryNames = (cfg.feedWorldbookEntries && cfg.feedWorldbookEntries[name]) || [];
            const picked = entryNames.length ? entries.filter(e => entryNames.includes(e.name)) : entries;
            if (!picked.length) continue;
            lines.push(`【世界书：${name}】`);
            picked.slice(0, 15).forEach(e => {
                lines.push(`- ${e.name}：${e.content.replace(/\n+/g, ' ').slice(0, 300)}`);
            });
        }
        return applyFeedRegex(lines.join('\n').slice(0, 6000));
    } catch (e) { warn('世界书投喂构建失败', e); return ''; }
}

function buildExistingIndexText() {
    try {
        const cut = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
        const lines = [];
        const sceneP = [];
        const seenP = new Set();
        for (const sc of (state.scenes || [])) {
            const p = Array.isArray(sc && sc.pathArr) && sc.pathArr.length ? sc.pathArr.join('>') : String((sc && sc.pathStr) || '');
            if (!p || seenP.has(p)) continue;
            seenP.add(p); sceneP.push(p);
            if (sceneP.length >= 40) break;
        }
        if (sceneP.length) lines.push(`- 已有场景路径（同一地点只允许一条，请复用其中写法；相似写法请合并到最早的那条，不要新建）：${sceneP.map(p => cut(p, 60)).join('；')}`);
        const itemN = [];
        const seenI = new Set();
        for (const it of (state.items || [])) {
            const n = String((it && it.name) || '').trim();
            if (!n || seenI.has(n.toLowerCase())) continue;
            seenI.add(n.toLowerCase()); itemN.push(n);
            if (itemN.length >= 40) break;
        }
        if (itemN.length) lines.push(`- 已有物品名称（同名称或同物异名一律用「更新」，不要新增；无流转、无剧情的环境杂物不要再录入）：${itemN.map(n => cut(n, 24)).join('；')}`);
        const subjN = [];
        const seenS = new Set();
        for (const s of (state.currentStates || [])) {
            const n = String((s && s.subject) || '').trim();
            if (!n || seenS.has(n.toLowerCase())) continue;
            seenS.add(n.toLowerCase()); subjN.push(n);
            if (subjN.length >= 40) break;
        }
        if (subjN.length) lines.push(`- 已有状态主体（同一角色只能有一个主体名，必须与角色档案一致；「名」与「全名」指向同一人时用「更新」写进既有那一组）：${subjN.map(n => cut(n, 30)).join('；')}`);
        const snapN = [];
        for (const sn of (state.snapshots || [])) {
            const n = String((sn && sn.name) || '').trim();
            if (n && snapN.indexOf(n) < 0) snapN.push(n);
            if (snapN.length >= 30) break;
        }
        if (snapN.length) lines.push(`- 已有角色档案姓名（状态主体 / 名册 / 平行事件涉及角色请与此一致）：${snapN.map(n => cut(n, 30)).join('；')}`);
        const planT = [], suspT = [];
        for (const p of (state.plans || [])) {
            if (p && p.status === 'open') { planT.push(cut(p.title || p.content, 24)); if (planT.length >= 20) break; }
        }
        for (const s of (state.suspense || [])) {
            if (s && s.status === 'open') { suspT.push(cut(s.title || s.content, 24)); if (suspT.length >= 20) break; }
        }
        if (planT.length) lines.push(`- 已有计划标题（同一目标只占一条：请用「更新」补进度，已完成/放弃的用「了结」）：${planT.join('；')}`);
        if (suspT.length) lines.push(`- 已有悬念标题（同一疑问只占一条：请用「更新」，已揭晓的用「了结」）：${suspT.join('；')}`);
        if (!lines.length) return '';
        return '【已有条目索引（抽取前必须先查，避免重复录入）】\n' + lines.join('\n');
    } catch (e) { return ''; }
}
// v1.181：货币「动态识别」段落 —— 从本轮正文里找出**主角之外**的角色名（依据已知角色档案 / 情节实体），
//   用 `currenciesDynamic` 模板填充后追加到摘要提示词；没有发现其他角色 → 返回 ''（只留通用模板）

function buildCurrencyDynamicSection(floorsText) {
    try {
        if (!cfg || cfg.currencyEnabled === false || cfg.currencyDynamicEnabled === false) return '';
        const pt = cfg.promptTemplates || defaultCfg.promptTemplates;
        const tpl = String(pt.currenciesDynamic || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.currenciesDynamic) || '').trim();
        if (!tpl) return '';
        const text = String(floorsText == null ? '' : floorsText);
        if (!text.trim()) return '';
        const me = String((typeof defaultCurrencyOwner === 'function' ? defaultCurrencyOwner() : '') || '');
        const names = [];
        const push = (n) => {
            const nm = String(n == null ? '' : n).trim();
            if (!nm || nm.length < 2 || nm === me) return;
            if (nm === '主角' || nm === '我') return;
            if (names.indexOf(nm) >= 0) return;
            // 只认「已知角色档案 / 情节实体」，避免把任意名词当角色
            const known = (state.snapshots || []).some(s => s && s.name === nm)
                || (state.atoms || []).some(a => (a && Array.isArray(a.entities) ? a.entities : []).some(x => String(x) === nm));
            if (!known) return;
            if (text.indexOf(nm) < 0) return;   // 本轮正文确实出现
            names.push(nm);
        };
        for (const s of (state.snapshots || [])) push(s && s.name);
        for (const a of (state.atoms || [])) for (const e of (Array.isArray(a && a.entities) ? a.entities : [])) push(e);
        if (!names.length) return '';
        const picked = names.slice(0, 3);
        return tpl.split('{{角色}}').join(picked.join('、'));
    } catch (e) { return ''; }
}
// v1.183：货币「标定跟踪」段落 —— 用户在货币页指定的角色（配置 `currencyTrackedRoles`），
//   **恒定**追加（不要求本轮正文出现）：结合【当前货币账本】判断这些角色的货币是否发生变化。

function buildCurrencyTrackedSection() {
    try {
        if (!cfg || cfg.currencyEnabled === false || cfg.currencyDynamicEnabled === false) return '';
        const names = (typeof trackedCurrencyRoles === 'function') ? trackedCurrencyRoles() : [];
        if (!names.length) return '';
        const pt = cfg.promptTemplates || defaultCfg.promptTemplates;
        const tpl = String(pt.currenciesTracked || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.currenciesTracked) || '').trim();
        if (!tpl) return '';
        return tpl.split('{{标定角色}}').join(names.join('、')).split('{{角色}}').join(names.join('、'));
    } catch (e) { return ''; }
}
// v1.183：当前货币账本（主角 + 标定角色）—— 作为摘要提示词的**更新参照**，让 AI 结合现状判断
//   「是更新已有条目还是新增」，避免同一角色同一币种被反复当成新条目登记。

function buildCurrencyLedgerText() {
    try {
        if (!cfg || cfg.currencyEnabled === false) return '';
        const me = String((typeof defaultCurrencyOwner === 'function' ? defaultCurrencyOwner() : '') || '');
        const list = (state.currencies || []).filter((cu) => {
            if (!cu || !cu.name) return false;
            const owner = String(cu.owner || '');
            if (!owner || owner === me || owner === '主角' || owner === '我') return true;
            return (typeof isTrackedCurrencyOwner === 'function') && isTrackedCurrencyOwner(owner);
        });
        if (!list.length) return '';
        const cap = Math.max(1, Number((cfg && cfg.maxCurrencies) || 8));
        const rows = list.slice(-cap).map((cu) => {
            const owner = String(cu.owner || me || '主角');
            const unit = cu.unit ? ` ${cu.unit}` : '';
            const last = Array.isArray(cu.history) && cu.history.length ? cu.history[cu.history.length - 1] : null;
            const lastTxt = last ? `（最近：${last.date ? last.date + ' ' : ''}${last.delta >= 0 ? '收入' : '支出'}${formatMoney(Math.abs(last.delta))}${last.note ? '·' + String(last.note).slice(0, 20) : ''}）` : '';
            return `- ${owner}·${cu.name} ${formatMoney(cu.amount)}${unit}${cu.date ? `（${cu.date}）` : ''}${lastTxt}`;
        });
        return `【当前货币账本（主角 + 已标定跟踪角色；**更新参照**，请勿重复新增）】\n${rows.join('\n')}\n（同名归属 + 同币种只保留一条：有变化用「更新」给出新额度与本次收支；无变化不要输出。）`;
    } catch (e) { return ''; }
}

async function buildSummaryPrompt(floorsText, dims) {        const pt = cfg.promptTemplates || defaultCfg.promptTemplates;
    const dimList = dims && dims.length ? dims : DIMENSIONS;
    const lines = [];
    // v1.179：**分析记忆前置提示词**（提示词面板「⓪」组可编辑；开关 `armorPresetEnabled`，默认开）——
    //   投喂在系统提示词**最前面**（通用规范之前）：这是「读本轮正文 → 分析成记忆」这一步的前置约束。
    //   只作用于本函数构造的「AI 摘要」提示词；关键词提取 / 记忆筛选 / 各类修复 / 推演结构上都不经过它。
    const prefix = armorPresetText();
    if (prefix) lines.push(prefix, '');
    lines.push(
        pt.general || defaultCfg.promptTemplates.general,
        '以下各维度说明告诉你「这是什么、如何填写、填写格式、边界」：',
        pt.state || '',
    );
    for (const d of dimList) {
        if (d === 'plans') { lines.push(pt.plans || ''); }
        else if (pt[d]) lines.push(pt[d]);
    }
    lines.push(pt.vars || '');
    // v1.181：货币维度 —— 通用模板已在维度列表里；再按**本轮正文发现的其他角色**追加「动态识别」说明
    //   （用户要求：提示词动态变化，根据发现的角色去识别需要 AI 识别哪一种货币）
    try {
        const dyn = buildCurrencyDynamicSection(floorsText);
        if (dyn) lines.push(dyn);
        // v1.183：标定跟踪段（恒定追加 —— 用户指定的角色即使本轮未出场也要考虑其货币变化）
        const tracked = buildCurrencyTrackedSection();
        if (tracked) lines.push(tracked);
    } catch (e) { }
    // v1.195：内容弱化（NSFW）—— 开关开启（默认关）时把共用规则追加进系统提示词，
    //   让「读正文 → 分析成记忆」这一步就不产生露骨内容；关闭时**完全不追加**（既有行为不变）。
    try { const nsfwRule = nsfwSoftenRuleText(); if (nsfwRule) lines.push(nsfwRule); } catch (e) { }
    // v1.17：用户输入不作分析对象——记忆只从 AI 回复中提取，用户楼仅作参考上下文
    lines.push('【提取规则】以下【本轮对话】中，只有标记为「AI」的楼层是记忆提取对象；标记为「用户」的楼层仅作为理解语境的参考，**绝对不要从用户输入中提取记忆**。');
    const wbFeed = await buildWorldbookFeedText();
    const userParts = [];
    if (wbFeed) userParts.push(`【世界书参考】以下是从世界书中读取的设定信息，作为背景参考，可帮助校准时间线、地名与人物设定：\n${wbFeed}`);
    // v1.135：已有条目索引（防重复录入：场景同地异名 / 物品无意义重复 / 状态全名与名双记录）
    try { const existIdx = buildExistingIndexText(); if (existIdx) userParts.push(existIdx); } catch (e) { }
    // v1.183：当前货币账本（主角 + 标定角色）—— 让 AI「同时考虑对应角色货币情况」（更新而非重复新增）
    try { const ledger = buildCurrencyLedgerText(); if (ledger) userParts.push(ledger); } catch (e) { }
    userParts.push(`【本轮对话】\n${String(floorsText == null ? '' : floorsText).slice(-16000)}`);
    return [
        { role: 'system', content: lines.join('\n') },
        { role: 'user', content: userParts.join('\n\n') },
    ];
}

// 状态摘要（设置页/总览/诊断与测试用：只读扫描，零 AI）

export { buildSummaryPrompt, armorPresetText, applyFeedRegex, buildExistingIndexText, buildCurrencyLedgerText };

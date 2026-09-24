// ============================================================
// rumor.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js（v1.192 传言大类））
// 生成方式：从 V1 段 07 按**传递闭包**提取目标函数与其纯内部辅助（避免 try/catch 静默吞掉常量依赖）；
//   仅 ESM 化 + 注入视图（cfg/state）；碰宿主/迁移/UI 的部分**不在此层**（属批次 3 的状态与合并层）。
// 一致性由 tests/unit/model-golden3.test.js 的黄金样本强制校验。
// ============================================================
import { normText, normalizeList, clamp, hashText } from '../util.js';
import { cfg } from './runtime.js';

function normalizeRumor(e) {
    try {
        const t = e || {};
        const rawContent = t.content !== undefined ? t.content : (t.text !== undefined ? t.text : (t['说法'] !== undefined ? t['说法'] : t['正文']));
        const content = normText(rawContent, Math.max(40, Number((cfg && cfg.dimCharLimits && cfg.dimCharLimits.rumors) || 240)));
        let subject = normText(t.subject || t['主体'] || t.name || t.title || '', 60);
        if (!subject && content) subject = content.slice(0, 30);
        if (!subject || !content) return null;
        const fs = Number(t.floorStart), fe = Number(t.floorEnd);
        const fermentRaw = Number(t.ferment != null ? t.ferment : t['发酵度']);
        const ferment = Math.max(0, Math.min(100, Number.isFinite(fermentRaw) ? Math.round(fermentRaw) : 20));
        const stage = normRumorStage(t.stage) || (ferment >= 90 ? '异变' : ferment >= 70 ? '发酵' : ferment >= 40 ? '扩散' : ferment >= 15 ? '萌芽' : '消退');
        const id = String(t.id || '').trim() || rumorId({ subject });
        const branchKey = String(t.branchKey || '').trim();
        const out = {
            id: (branchKey && !String(t.id || '').trim()) ? rumorId({ subject, branchKey }) : id,
            subject,
            content,
            objectivity: normRumorObjectivity(t.objectivity !== undefined ? t.objectivity : t['客观性']),
            stage,
            ferment,
            pending: normalizeRumorPending(t.pending),
            carriers: normalizeRumorCarriers(t.carriers !== undefined ? t.carriers : (t['传播者'] !== undefined ? t['传播者'] : (t.carriersText !== undefined ? parseRumorCarriersText(t.carriersText) : t['关联角色']))),
            media: normalizeRumorMediaList(t.media !== undefined ? t.media : (t['载体'] !== undefined ? t['载体'] : (t.mediaText !== undefined ? parseRumorMediaText(t.mediaText) : t['传播载体']))),
            chain: normalizeRumorChain(t.chain !== undefined ? t.chain : t['传导链路']),
            lineage: normalizeRumorLineage(t.lineage, id),
            parallelRefs: (Array.isArray(t.parallelRefs) ? t.parallelRefs : []).map(x => String(x || '')).filter(Boolean).slice(0, 12),
            source: normText(t.source || t['来源'], 80),
            date: normText(t.date || t['日期'], 20),
            tags: normalizeList(t.tags !== undefined ? t.tags : t['标签']).slice(0, 8),
            uses: Number(t.uses) || 0,
            floorStart: Number.isInteger(fs) && fs > 0 ? fs : 0,
            floorEnd: Number.isInteger(fe) && fe > 0 ? fe : 0,
            createdAt: Number(t.createdAt) || Date.now(),
            updatedAt: Number(t.updatedAt) || Number(t.createdAt) || Date.now(),
            category: 'rumors',
            title: subject,
            text: content,
            strength: Number(t.strength) || 0.5,
            extra: Array.isArray(t.extra) ? t.extra : [],
        };
        return out;
    } catch (e) { return null; }
}
// 阶段 → 依据发酵度重算（机械演化用；保留「异变」这种由裂变/联动带来的阶段）

function rumorId(e) {
    const t = e || {};
    const subject = t.subject || t['主体'] || t.title || t.name || '';
    const branch = String(t.branchKey || '').trim();
    return `rum_${hashText(rumorSubjectKey(subject) + (branch ? '#' + branch : ''))}`;
}
// 裂变子条目的稳定 id：父 id + 变体名（确定性 → 两端各自演化出的同一分支收敛为同一条）

function rumorChildId(parent, variant) {
    const pid = String((parent && parent.id) || rumorId(parent) || '');
    return `rum_${hashText(String(pid) + '#' + String(variant || '变体'))}`;
}

function rumorSubjectKey(subject) {
    return String(subject == null ? '' : subject)
        .replace(/\s+/g, '')
        .replace(/[（(]([^）)]*)[）)]/g, '($1)')
        .replace(/[。，,、；;：:!！?？~～\-—]+$/g, '')
        .trim();
}

function normalizeRumorCarriers(raw) {
    const arr = Array.isArray(raw) ? raw : splitListText(raw);
    const seen = new Set(), out = [];
    for (const x of arr) {
        const c = normalizeRumorCarrier(x);
        if (!c) continue;
        const k = c.who.replace(/\s+/g, '').toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
        if (out.length >= 12) break;
    }
    return out;
}

function normalizeRumorMediaList(raw) {
    const arr = Array.isArray(raw) ? raw : splitListText(raw);
    const seen = new Set(), out = [];
    for (const x of arr) {
        const m = normalizeRumorMedia(x);
        if (!m) continue;
        const k = m.type + '|' + m.name.replace(/\s+/g, '').toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(m);
        if (out.length >= 12) break;
    }
    return out;
}
// 编辑器文本 → 传播者（每行 `角色名` 或 `角色名:源头/传播者/听闻者`）

function normalizeRumorChain(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const x of arr) {
        const s = normalizeRumorChainStep(x);
        if (s) out.push(s);
        if (out.length >= 80) break;
    }
    return out.slice(-60);   // 只保留最近 60 步（哈希与存储体积上限）
}

function normalizeRumorLineage(raw, fallbackId) {
    const l = (raw && typeof raw === 'object') ? raw : {};
    const children = (Array.isArray(l.children) ? l.children : []).map(x => String(x || '')).filter(Boolean).slice(0, 24);
    return {
        rootId: String(l.rootId || fallbackId || ''),
        parentId: String(l.parentId || ''),
        children,
        generation: Math.max(0, Math.round(Number(l.generation) || 0)),
    };
}

function normalizeRumorPending(raw) {
    const p = (raw && typeof raw === 'object') ? raw : null;
    if (!p) return null;
    const kind = normText(p.kind, 20);
    if (!kind) return null;
    const need = Math.max(1, Math.round(Number(p.need) || 2));
    return {
        kind,
        need,
        progress: Math.max(0, Math.min(need, Math.round(Number(p.progress) || 0))),
        target: normText(p.target, 60),
        at: normText(p.at, 20),
    };
}
// 传言条目归一化：主体 + 当前说法为必填（缺主体时以说法开头兜底）；其余字段全部容错。

function parseRumorCarriersText(text) {
    const out = [];
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
        const s = String(line).trim();
        if (!s) continue;
        const m = /^([^:：]+)[:：]\s*(.+)$/.exec(s);
        out.push(m ? { who: m[1].trim(), role: m[2].trim() } : { who: s });
    }
    return out;
}
// 编辑器文本 → 载体（每行 `类型|名称|日期|耐久度` 或 `类型:名称`）

function parseRumorMediaText(text) {
    const out = [];
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
        const s = String(line).trim();
        if (!s) continue;
        if (s.indexOf('|') >= 0) {
            const p = s.split('|').map(x => String(x).trim());
            out.push({ type: p[0], name: p[1] || p[0], at: p[2] || '', durability: Math.max(1, Math.min(5, Math.round(Number(p[3]) || 1))) });
        } else {
            const m = /^([^:：]+)[:：]\s*(.+)$/.exec(s);
            out.push(m ? { type: m[1].trim(), name: m[2].trim() } : { type: s, name: s });
        }
    }
    return out;
}

function rumorStageByFerment(ferment) {
    const f = Math.max(0, Math.min(100, Number(ferment) || 0));
    if (f >= 90) return '异变';
    if (f >= 70) return '发酵';
    if (f >= 40) return '扩散';
    if (f >= 15) return '萌芽';
    if (f <= 3) return '沉寂';
    return '消退';
}
// 从一组「活跃载体」估算耐久度总和（注入展示与演化增益共用）

function mergeRumorObjects(a, b, ctx) {
    try {
        const l = (a && typeof a === 'object') ? a : {};
        const r = (b && typeof b === 'object') ? b : {};
        const winRemote = !!(ctx && ctx.winRemote);
        const base = winRemote ? r : l;
        const out = JSON.parse(JSON.stringify(base));
        const key = (x, fields) => fields.map(f => String((x && x[f]) || '')).join('|');
        const unionBy = (arr, fn) => {
            const seen = new Set(), o = [];
            for (const x of arr) { const k = fn(x); if (seen.has(k)) continue; seen.add(k); o.push(x); }
            return o;
        };
        const num = (v) => Number(v) || 0;
        out.carriers = unionBy([].concat(l.carriers || [], r.carriers || []), x => key(x, ['who', 'role'])).slice(0, 12);
        out.media = unionBy([].concat(l.media || [], r.media || []), x => key(x, ['type', 'name', 'at'])).slice(0, 12);
        out.chain = unionBy([].concat(l.chain || [], r.chain || []), x => key(x, ['kind', 'at', 'from', 'to', 'note'])).slice(-60);
        out.parallelRefs = Array.from(new Set([].concat(l.parallelRefs || [], r.parallelRefs || []).map(x => String(x || '')).filter(Boolean))).slice(0, 12);
        const lc = (l.lineage && l.lineage.children) || [];
        const rc = (r.lineage && r.lineage.children) || [];
        out.lineage = Object.assign({}, base.lineage || {}, {
            children: Array.from(new Set([].concat(lc, rc).map(x => String(x || '')).filter(Boolean))).slice(0, 24),
            generation: Math.max(num(l.lineage && l.lineage.generation), num(r.lineage && r.lineage.generation)),
        });
        if (!out.lineage.rootId) out.lineage.rootId = String(out.id || '');
        out.uses = Math.max(num(l.uses), num(r.uses));
        const created = [num(l.createdAt), num(r.createdAt)].filter(v => v > 0);
        out.createdAt = created.length ? Math.min.apply(null, created) : num(base.createdAt) || Date.now();
        out.updatedAt = Math.max(num(l.updatedAt), num(r.updatedAt)) || out.createdAt;
        const fs = [num(l.floorStart), num(r.floorStart)].filter(v => v > 0);
        const fe = [num(l.floorEnd), num(r.floorEnd)].filter(v => v > 0);
        out.floorStart = fs.length ? Math.min.apply(null, fs) : 0;
        out.floorEnd = fe.length ? Math.max.apply(null, fe) : 0;
        return out;
    } catch (e) { return null; }
}

// ==================== 词条 CRUD ====================

function normRumorObjectivity(v) {
    const s = String(v == null ? '' : v).trim();
    if (/主观|揣测|臆测|无依据|情绪/.test(s)) return '主观';
    if (/客观|可核查|有依据|属实/.test(s)) return '客观';
    return s === '客观' ? '客观' : '主观';   // 缺省按主观（传言默认不可信）
}

function normRumorStage(v) {
    const s = String(v == null ? '' : v).trim();
    const hit = RUMOR_STAGES.find(x => s === x || (s && s.indexOf(x) >= 0));
    return hit || '';
}

function splitListText(s) { return normalizeList(String(s ?? '').split(/[,，、;；]/)); }

function normalizeRumorCarrier(raw) {
    try {
        if (!raw || typeof raw !== 'object') {
            const who = normText(raw, 60);
            return who ? { who, role: '传播者', at: '' } : null;
        }
        const who = normText(raw.who || raw['角色'] || raw.name || raw['姓名'] || raw.character, 60);
        if (!who) return null;
        return { who, role: normRumorRole(raw.role || raw['角色性质'] || raw['性质'] || raw.kind), at: normText(raw.at || raw['日期'] || raw.date, 20) };
    } catch (e) { return null; }
}

function normalizeRumorMedia(raw) {
    try {
        if (!raw || typeof raw !== 'object') {
            const name = normText(raw, 60);
            return name ? { type: normRumorMediaType(name), name, at: '', durability: 1, active: true } : null;
        }
        const name = normText(raw.name || raw['名称'] || raw.title || raw['类型'], 60);
        const type = normRumorMediaType(raw.type || raw['类型'] || name);
        if (!name && !type) return null;
        const dur = Math.max(1, Math.min(5, Math.round(Number(raw.durability != null ? raw.durability : raw['耐久度']) || 1)));
        return {
            type, name: name || type,
            at: normText(raw.at || raw['日期'] || raw.date, 20),
            durability: dur,
            active: raw.active === undefined ? true : !!raw.active,
        };
    } catch (e) { return null; }
}

function normalizeRumorChainStep(raw) {
    try {
        if (!raw || typeof raw !== 'object') return null;
        const kind = normRumorChainKind(raw.kind || raw['类型']);
        const note = normText(raw.note || raw['说明'] || raw['备注'], 160);
        const at = normText(raw.at || raw['日期'] || raw.date, 20);
        const from = normText(raw.from || raw['从'], 60);
        const to = normText(raw.to || raw['到'], 60);
        if (!note && !at && !from && !to) return null;
        return { at, round: Math.max(0, Math.round(Number(raw.round) || 0)), kind, from, to, note };
    } catch (e) { return null; }
}

const RUMOR_STAGES = ['萌芽', '扩散', '发酵', '异变', '消退', '沉寂'];

function normRumorRole(v) {
    const s = String(v == null ? '' : v).trim();
    const hit = RUMOR_ROLES.find(x => s === x || (s && s.indexOf(x) >= 0));
    return hit || '传播者';
}
// 载体类型归一（含常见别名：传媒/报纸/刊物 → 报刊；布告/揭帖 → 告示；碑文/石刻 → 刻字）

function normRumorMediaType(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '口耳相传';
    if (RUMOR_MEDIA_ALIAS[s]) return RUMOR_MEDIA_ALIAS[s];
    const hit = RUMOR_MEDIA_TYPES.find(x => s === x || s.indexOf(x) >= 0 || x.indexOf(s) >= 0);
    if (hit) return hit;
    for (const [k, val] of Object.entries(RUMOR_MEDIA_ALIAS)) if (s.indexOf(k) >= 0) return val;
    return '口耳相传';
}

function normRumorChainKind(v) {
    const s = String(v == null ? '' : v).trim();
    const hit = RUMOR_CHAIN_KINDS.find(x => s === x || (s && s.indexOf(x) >= 0));
    return hit || '传播';
}
// 主体归一（识别同一谱系）：去空白 / 全角括号统一 / 去尾部标点 —— 使「码头沉船？」「码头 沉船」视为同一主体

const RUMOR_ROLES = ['源头', '传播者', '听闻者'];

const RUMOR_MEDIA_TYPES = ['口耳相传', '报刊', '大字报', '书', '刻字', '书信', '告示'];

const RUMOR_MEDIA_ALIAS = {
    传媒: '报刊', 报纸: '报刊', 刊物: '报刊', 杂志: '报刊', 新闻: '报刊', 官报: '报刊',
    布告: '告示', 揭帖: '告示', 榜文: '告示',
    碑文: '刻字', 石刻: '刻字', 石碑: '刻字', 刻石: '刻字',
    书籍: '书', 书本: '书', 册子: '书',
    信: '书信', 信件: '书信', 家书: '书信',
    口头: '口耳相传', 口传: '口耳相传', 风闻: '口耳相传', 传闻: '口耳相传', 流言: '口耳相传',
};

const RUMOR_CHAIN_KINDS = ['起源', '传播', '发酵', '消退', '异变', '裂变', '联动', '载体停用'];

export { normalizeRumor, rumorId, rumorChildId, rumorSubjectKey, normalizeRumorCarriers, normalizeRumorMediaList, normalizeRumorChain, normalizeRumorLineage, normalizeRumorPending, parseRumorCarriersText, parseRumorMediaText, rumorStageByFerment, mergeRumorObjects };

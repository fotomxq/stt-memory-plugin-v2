// ============================================================
// core/model/atom.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js `normalizeAtom`）
// 移植口径：算法与字段名保持与 V1 完全一致（保证 V1 数据可导入、跨端哈希一致）；
//   仅做两处适配：① 去掉 IIFE/全局依赖，改为 ESM 显式导入；② `cfg.dimCharLimits` 改为可注入的维度上限表。
// 一致性由 tests/unit/model-golden.test.js 使用 V1 源码切片产出的黄金样本强制校验。
// ============================================================
import { normText, normalizeList, clamp, hashText } from '../util.js';
import { dimCap, atomTitle, mergeTags, makeExtra, clockDateTrim, nsfwField } from './scalars.js';

function normalizeAtom(e, fallbackFloor) {
    const text = dimCap('atoms', normText(e?.text || e?.content));
    if (!text || text.length < 8) return null;
    let fs = Number(e?.floorStart);
    let fe = Number(e?.floorEnd);
    if ((!Number.isInteger(fs) || fs < 0) && Number.isInteger(fallbackFloor?.start) && fallbackFloor.start >= 0) fs = fallbackFloor.start;
    if ((!Number.isInteger(fe) || fe < 0) && Number.isInteger(fallbackFloor?.end) && fallbackFloor.end >= 0) fe = fallbackFloor.end;
    return {
        id: String(e?.id || `atom_${hashText(text + fs + fe)}`),
        kind: 'plot_atom',
        text,
        title: normText(e?.title || '', 40) || atomTitle({ text }),   // 独立标题字段（缺省取正文首段，原子层 title 保持非空）
        type: normText(e?.type || '事件', 20),
        date: normText(e?.date || (typeof e?.eventTime === 'string' && /^-?\d{1,4}-\d{2}-\d{2}/.test(e.eventTime) ? clockDateTrim(e.eventTime) : ''), 10),
        time: normText(e?.time || e?.eventTime || '', 30),
        entities: normalizeList(e?.entities),
        locations: normalizeList(e?.locations),
        tags: mergeTags(e?.tags, e?.keywords),   // tags 统一（含历史 keywords）
        keywords: [],
        importance: clamp(Number(e?.importance) || 0.5, 0, 1),
        validity: ['active', 'inactive', 'uncertain'].includes(e?.validity) ? e.validity : 'active',
        permanence: ['permanent', 'temporary', 'episodic'].includes(e?.permanence) ? e.permanence : 'episodic',
        // 情节不再携带「未了结」—— 已发生事件为固定事实，不标注计划/悬念式状态（旧数据残留字段不再持久化）
        floorStart: Number.isInteger(fs) && fs >= 0 ? fs : 0,
        floorEnd: Number.isInteger(fe) && fe >= 0 ? fe : 0,
        // v3.7.0（用户要求）：**来源楼层 floorStart/floorEnd 创建后永不变动**；删楼/楼层突变只更新
        //   `floorNowStart/floorNowEnd`（当前位置）或打 `originGone`（原文已移除）——这些字段不参与内容哈希，
        //   归一化时必须原样保留（否则下一次合并/AI 更新会把标记丢掉）。
        ...(Number.isInteger(Number(e?.floorNowStart)) && Number(e.floorNowStart) >= 0 ? { floorNowStart: Number(e.floorNowStart) } : {}),
        ...(Number.isInteger(Number(e?.floorNowEnd)) && Number(e.floorNowEnd) >= Number(e.floorNowStart) ? { floorNowEnd: Number(e.floorNowEnd) } : {}),
        ...(e?.floorNowHash ? { floorNowHash: String(e.floorNowHash) } : {}),
        ...(e?.originGone === true ? { originGone: true, originGoneAt: Number(e.originGoneAt) > 0 ? Number(e.originGoneAt) : Date.now() } : {}),
        // v3.8.0（用户要求）：**NSFW 等级留档**（无/弱/强）—— 只升不降、弱化后不变，见 core/nsfw-level.js
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'atoms',
        content: text,
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ type: e?.type, time: e?.time || e?.eventTime, entities: e?.entities, locations: e?.locations, keywords: e?.keywords, validity: e?.validity, permanence: e?.permanence }),        ...nsfwField(e),
        extra: makeExtra({ type: e?.type, time: e?.time || e?.eventTime, entities: e?.entities, locations: e?.locations, keywords: e?.keywords, validity: e?.validity, permanence: e?.permanence }),        };
}

export { normalizeAtom };

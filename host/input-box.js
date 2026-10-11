// ============================================================
// host/input-box.js —— **宿主输入框写入能力探针 + 降级链**（v3.45.0，`docs/D22` W5 `技-26`）
//
// 用户要求（原话）：「新版本v3.45.0 / 开发W5待开发事项。」
// 设计依据：`docs/D21` §8 `技-26` ——「宿主输入框写入能力前置验证（**无既有先例**）+ 降级链确定」；
//   事实登记：`docs/D17` **U160**（`docs/D27` §3.6 / §8 的依赖项 —— 地图「点击插入套话」`应-21` 的前置）。
//
// U160 的原文事实：「全仓 `textarea` 均为插件自身面板控件、**无既有先例**」→ 于是本模块做两件事：
//   ① 把「能不能往宿主输入框里追加文本」做成**可探测、可降级、可如实回报**的一件小事；
//   ② 把**降级链**定死（宿主输入框 → 剪贴板 → 只读文本框让人自己复制），**每一档都带可读原因**，
//      绝不静默失败（`04` §4 的提示纪律）。
//
// ⚠️ **诚实边界（必读）**：本机**没有真机（SillyTavern 页面）**，因此：
//   · 下面的选择器表是**待验证假设**（来自 ST 前端既有约定 `#send_textarea`，不是本仓库实测所得）；
//   · 真机要验的是「哪一档真的可用」→ 在真机控制台执行 `FTT.inputBox()`（`devtools.js` 已导出只读探针）
//     看 `via` 与 `reason`；`docs/05-开发指南.md` §3 记了这条步骤。
//   · **未在真机验证前，本模块的结论不得当成「已验证」使用**（与 `docs/D21` §8 `技-8` 的纪律一致）。
//
// 纪律：
//   · **只追加、不覆盖**：把文本接到现有内容**尾部**（`D27` §3.6 的用户要求），并派发 `input` 事件让宿主 UI 同步；
//   · **不写任何数据**：本模块只碰 DOM / 剪贴板，不读也不改 `cfg` / `state`（`D27` §3.6「点击不写数据」）；
//   · **绝不抛错**：所有失败都转成 `{ ok:false, via:'', reason:'可读原因' }`（调用方据此给提示）。
// ============================================================

/** 候选选择器（**有序**；命中第一个可写的即停）—— 待真机验证的假设，见文件头「诚实边界」 */
export const INPUT_BOX_SELECTORS = Object.freeze([
    '#send_textarea',
    'textarea#send_textarea',
    '#chat_form textarea[name="message"]',
    '#chat_form textarea',
]);

/** 降级链（**顺序即优先级**；报告与文档共用这一份，避免两处漂移） */
export const INPUT_FALLBACK_CHAIN = Object.freeze(['host-textarea', 'clipboard', 'manual']);

/** 取文档对象（**经宿主注入**：本模块不直接摸全局 `document`，便于桩化与内核纯净度边界） */
function docOf(opts) {
    try {
        if (opts && opts.doc) return opts.doc;
        if (typeof document !== 'undefined') return document;
    } catch (e) { /* 忽略 */ }
    return null;
}

/** 剪贴板对象（同上，可注入） */
function clipOf(opts) {
    try {
        if (opts && opts.clipboard) return opts.clipboard;
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard) return navigator.clipboard;
    } catch (e) { /* 忽略 */ }
    return null;
}

/**
 * **只读能力探针**：宿主输入框是否可写。不写任何东西、不派发事件。
 * @param {{doc?:object, clipboard?:object}} [opts] 可注入（测试用）
 * @returns {{textarea:boolean, selector:string, clipboard:boolean, via:string, reason:string}}
 *   `via` = 当前**首选**档（`host-textarea` / `clipboard` / `manual`）
 */
export function inputBoxCapability(opts) {
    const out = { textarea: false, selector: '', clipboard: false, via: 'manual', reason: '', errors: 0 };
    try {
        const doc = docOf(opts);
        if (doc && typeof doc.querySelector === 'function') {
            for (const sel of INPUT_BOX_SELECTORS) {
                let el = null;
                try { el = doc.querySelector(sel); } catch (e) { el = null; out.errors++; }   // 单个选择器抛错 → 记数（不静默）
                if (el && typeof el === 'object' && 'value' in el) { out.textarea = true; out.selector = sel; break; }
            }
        }
        const clip = clipOf(opts);
        out.clipboard = !!(clip && typeof clip.writeText === 'function');
        out.via = out.textarea ? 'host-textarea' : (out.clipboard ? 'clipboard' : 'manual');
        out.reason = out.textarea ? ('命中 ' + out.selector)
            : (out.clipboard ? '宿主输入框不可用 → 降级到剪贴板'
                : '宿主输入框与剪贴板都不可用 → 只能手动复制');
        // 选择器查询抛错说明「宿主 DOM 形态与假设不符」——如实附在原因里（否则会与「就是没有输入框」混为一谈）
        if (out.errors) out.reason += '（' + out.errors + ' 个候选选择器查询抛错：宿主 DOM 形态与假设不符）';
        return out;
    } catch (e) {
        out.reason = '探针异常：' + String((e && e.message) || e);
        return out;
    }
}

/**
 * 往宿主输入框**尾部追加**文本（不覆盖既有内容），并派发 `input` 事件让宿主 UI 同步。
 * @param {string} text
 * @param {{doc?:object, focus?:boolean}} [opts]
 * @returns {{ok:boolean, via:string, reason:string, chars:number}}
 */
export function appendToHostInput(text, opts) {
    const out = { ok: false, via: '', reason: '', chars: 0 };
    try {
        const s = String(text == null ? '' : text);
        if (!s) { out.reason = '空文本（不插入）'; return out; }
        const doc = docOf(opts);
        if (!doc || typeof doc.querySelector !== 'function') { out.reason = '取不到宿主文档对象'; return out; }
        let el = null, sel = '';
        for (const cand of INPUT_BOX_SELECTORS) {
            let hit = null;
            try { hit = doc.querySelector(cand); } catch (e) { hit = null; }
            if (hit && typeof hit === 'object' && 'value' in hit) { el = hit; sel = cand; break; }
        }
        if (!el) { out.reason = '找不到宿主输入框（候选选择器都没命中）'; return out; }
        const prev = String(el.value == null ? '' : el.value);
        // **只追加**：既有内容原样保留，新文本接在尾部（需要空行时由调用方在 text 里给）
        el.value = prev + s;
        try { if (typeof el.dispatchEvent === 'function') el.dispatchEvent({ type: 'input' }); } catch (e) { /* 事件失败不影响写入 */ }
        try { if (opts && opts.focus === true && typeof el.focus === 'function') el.focus(); } catch (e) { /* 忽略 */ }
        out.ok = true; out.via = 'host-textarea'; out.chars = s.length;
        out.reason = '已追加到宿主输入框（' + sel + '，原 ' + prev.length + ' 字 → ' + String(el.value).length + ' 字）';
        return out;
    } catch (e) {
        out.reason = '写入异常：' + String((e && e.message) || e);
        return out;
    }
}

/**
 * 写剪贴板（降级链第二档）。
 * @returns {Promise<{ok:boolean, via:string, reason:string, chars:number}>}
 */
export async function writeClipboard(text, opts) {
    const out = { ok: false, via: '', reason: '', chars: 0 };
    try {
        const s = String(text == null ? '' : text);
        if (!s) { out.reason = '空文本（不写入）'; return out; }
        const clip = clipOf(opts);
        if (!clip || typeof clip.writeText !== 'function') { out.reason = '宿主未提供剪贴板接口'; return out; }
        await clip.writeText(s);
        out.ok = true; out.via = 'clipboard'; out.chars = s.length;
        out.reason = '已复制到剪贴板（' + s.length + ' 字）';
        return out;
    } catch (e) {
        out.reason = '剪贴板写入失败：' + String((e && e.message) || e);
        return out;
    }
}

/**
 * **降级链执行**（`技-26` 的核心交付）：宿主输入框 → 剪贴板 → 手动。
 * 无论走到哪一档，返回结构一致（`{ok, via, reason, chars}`），失败必带**可读原因**。
 * @param {string} text
 * @param {{doc?:object, clipboard?:object, focus?:boolean, onManual?:Function}} [opts]
 * @returns {Promise<{ok:boolean, via:string, reason:string, chars:number, manual:boolean}>}
 */
export async function insertTextToHost(text, opts) {
    const base = { ok: false, via: '', reason: '', chars: 0, manual: false };
    try {
        const hits = appendToHostInput(text, opts);
        if (hits.ok) return Object.assign(base, hits);
        const clip = await writeClipboard(text, opts);
        if (clip.ok) return Object.assign(base, clip);
        // 最后一档：把原因合成一句完整的话（把前两档的失败原因也带上，便于排查）
        base.via = 'manual';
        base.manual = true;
        base.chars = String(text == null ? '' : text).length;
        base.reason = '无法自动插入（' + hits.reason + '；' + clip.reason + '）→ 请手动复制';
        try { if (opts && typeof opts.onManual === 'function') opts.onManual(String(text == null ? '' : text), base.reason); } catch (e) { /* 忽略 */ }
        return base;
    } catch (e) {
        base.reason = '插入流程异常：' + String((e && e.message) || e);
        return base;
    }
}

/**
 * **真机验证步骤**（纯文本，供文档与调试页共用 —— 让「怎么验」只有一处）。
 * 本机没有真机，故把步骤写成可复制的形式，而不是声称已经验过。
 */
export function inputBoxVerifySteps() {
    return [
        '① 在真机（SillyTavern 页面）打开扩展，进入任意聊天；',
        '② 控制台执行 `FTT.inputBox()` → 记录 `via` 与 `reason`（决定默认走哪一档）；',
        '③ 执行 `FTT.insertText("测试尾部追加")` → 观察宿主输入框：既有内容**保留**、新文本在**尾部**；',
        '④ 把输入框清空后再执行一次 → 只应出现新文本；',
        '⑤ 关掉剪贴板权限（或换不支持剪贴板的浏览器）再执行 → 应落到 `manual` 并给出可读原因；',
        '⑥ 把结论回填 `docs/D17` U160 与 `docs/03-技术架构.md` §4（**未验证前不得写成已验证**）。',
    ].join('\n');
}

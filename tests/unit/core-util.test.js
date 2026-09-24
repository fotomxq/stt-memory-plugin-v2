// ============================================================
// 单元测试 · core/util（纯内核，零宿主依赖）
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { hashText, escHtml, normText, clamp, normalizeList, cmpDateStr, extractJsonObject, emptyState } from '../../core/util.js';
import { DIMENSIONS, STATE_KEYS, PROMPT_POSITION, PROMPT_ROLE, EXTENSION_FOLDER, HOST_EVENTS } from '../../core/constants.js';

const R = makeReporter('core-util 纯内核工具');

R.assert('U1 hashText 稳定且等值同哈希', hashText('abc') === hashText('abc') && hashText('abc') !== hashText('abd') && /^[0-9a-f]{8}$/.test(hashText('abc')), hashText('abc'));
R.assert('U2 hashText 对 null/undefined 不抛异常', hashText(null) === hashText('') && hashText(undefined) === hashText(''), null);
R.assert('U3 escHtml 转义五类字符', escHtml('<a href="x">&\'') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;', escHtml('<a href="x">&\''));
R.assert('U4 normText 单行化 + 截断', normText('  a\n\n b  ', 3) === 'a b' && normText('abcdef', 3) === 'abc', normText('abcdef', 3));
R.assert('U5 clamp 越界与非法输入', clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp('x', 2, 9) === 2, [clamp(5, 0, 3), clamp('x', 2, 9)]);
R.assert('U6 normalizeList 去空/去重/保序/截断', JSON.stringify(normalizeList([' a ', '', 'a', 'b', 'c'], 2)) === JSON.stringify(['a', 'b']), normalizeList([' a ', '', 'a', 'b', 'c'], 2));
R.assert('U7 cmpDateStr 支持负年份且空值排最后', cmpDateStr('-0221-01-02', '1919-11-29') < 0 && cmpDateStr('', '1919-01-01') > 0 && cmpDateStr('1919-01-01', '1919-01-01') === 0, '');
R.assert('U8 extractJsonObject 处理围栏/前后噪声/嵌套', (() => {
    const a = extractJsonObject('前言\n```json\n{"a":1}\n```\n后记');
    const b = extractJsonObject('噪声 {"a":{"b":2},"c":[1,2]} 尾巴');
    const c = extractJsonObject('没有 JSON');
    return !!a && a.a === 1 && !!b && b.a.b === 2 && b.c.length === 2 && c === null;
})(), '');
R.assert('U9 extractJsonObject 容忍字符串里的花括号', (() => {
    const r = extractJsonObject('{"t":"含 } 与 { 的说明","n":3}');
    return !!r && r.n === 3 && r.t.indexOf('}') >= 0;
})(), '');
R.assert('U10 emptyState 覆盖 14 类容器 + dataVersion', (() => {
    const st = emptyState();
    return st.dataVersion === 1 && STATE_KEYS.every(k => Array.isArray(st[k])) && STATE_KEYS.length === 14 && !!st.state && !!st.deleted && !!st.deletedH;
})(), '');
R.assert('U11 常量：维度 14 类且 kind 唯一', DIMENSIONS.length === 14 && new Set(DIMENSIONS.map(d => d.kind)).size === 14, DIMENSIONS.length);
R.assert('U12 常量：注入枚举与 ST 源码一致', PROMPT_POSITION.IN_PROMPT === 0 && PROMPT_POSITION.IN_CHAT === 1 && PROMPT_POSITION.BEFORE_PROMPT === 2 && PROMPT_ROLE.SYSTEM === 0 && PROMPT_ROLE.USER === 1 && PROMPT_ROLE.ASSISTANT === 2, '');
R.assert('U13 常量：扩展目录名与九事件清单', EXTENSION_FOLDER === 'third-party/ftt-memory-v2' && HOST_EVENTS.length === 9 && HOST_EVENTS.indexOf('GENERATION_ENDED') >= 0, HOST_EVENTS.length);

R.done();

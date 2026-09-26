// ============================================================
// tests/fixtures/birth-anomaly-scenarios.mjs —— 「出生日期异常」判定 oracle 与单测**共用**场景表
// 用途：`gen-v1-golden-birth-anomaly.cjs`（真实 V1 v1.206）与 `tests/unit/birth-anomaly.test.js`（实时 V2）读同一份场景。
// 字段：name / note / story（剧情锚点日期）/ snap（角色档案）/ expect（V2 应有结论）/ deviation（与 V1 的差异说明）
// ============================================================

export const SCENARIOS = [
    {
        name: 'low-epoch-overage',
        note: '用户报告的场景：主角 0001-01-01 出生、剧情到 0191-09-23（自设纪元/编年起点）→ 190 岁属设定',
        story: '0191-09-23',
        snap: { name: '主角', isProtagonist: true, identity: { birthDate: '0001-01-01' } },
        expect: '',
        deviation: 'V1 判 overage（age>120）；V2 因「剧情锚点年份 < 1000 = 非现实纪元」豁免',
    },
    {
        name: 'real-epoch-overage',
        note: '现实纪元下的真异常：0019-03-02 出生（1919 的笔误）、剧情 1919-11-29',
        story: '1919-11-29',
        snap: { name: '角色甲', identity: { birthDate: '0019-03-02' } },
        expect: 'overage',
        deviation: '',
    },
    {
        name: 'long-lived-species',
        note: '非人/长生设定：高等精灵 0719-03-02 出生、现实纪元 1919 年（1200 岁）',
        story: '1919-11-29',
        snap: { name: '精灵长老', identity: { birthDate: '0719-03-02', species: '高等精灵' } },
        expect: '',
        deviation: 'V1 判 overage；V2 因「非人/长生设定」豁免',
    },
    {
        name: 'bc-birth',
        note: '公元前出生（V1 已有豁免）：公元前 221 年 → 1919 年剧情',
        story: '1919-11-29',
        snap: { name: '古人', identity: { birthDate: '-0221-01-02' } },
        expect: '',
        deviation: '',
    },
    {
        name: 'future-birth',
        note: '出生日期晚于剧情日期 → 仍是异常（未放宽）',
        story: '0191-09-23',
        snap: { name: '未来者', identity: { birthDate: '9999-01-01' } },
        expect: 'future',
        deviation: '',
    },
    {
        name: 'after-record',
        note: '出生日期晚于该角色的「最后见面」日期（但早于剧情日期）→ 倒挂，仍是异常（未放宽）',
        story: '0191-09-23',
        snap: { name: '倒挂者', identity: { birthDate: '0100-01-01' }, lastSeenDate: '0050-01-01' },
        expect: 'after-record',
        deviation: '',
    },
    {
        name: 'bad-format',
        note: '出生日期格式非法 → 仍是异常（未放宽）',
        story: '1919-11-29',
        snap: { name: '脏数据', identity: { birthDate: '很久以前' } },
        expect: 'bad-format',
        deviation: '',
    },
    {
        name: 'fallback-placeholder',
        note: '`birthSource=fallback` 的现实年份占位符 → 不算异常（V1 已有规则）',
        story: '1919-11-29',
        snap: { name: '占位者', identity: { birthDate: '0019-01-01', birthSource: 'fallback' } },
        expect: '',
        deviation: '',
    },
    {
        name: 'traveler-future-origin',
        note: '档案明确「来自未来/穿越」→ 未来出生豁免（V1 已有规则）',
        story: '1919-11-29',
        snap: { name: '穿越者', identity: { birthDate: '2500-01-01' }, background: { origin: '来自未来的时空旅行者' } },
        expect: '',
        deviation: '',
    },
    {
        name: 'boundary-1000',
        note: '纪元边界：锚点正好 1000 年（不算非现实纪元）→ 凡人 300 岁仍判异常',
        story: '1000-01-01',
        snap: { name: '边界者', identity: { birthDate: '0700-01-01' } },
        expect: 'overage',
        deviation: '',
    },
    {
        name: 'boundary-0999',
        note: '纪元边界：锚点 0999 年 → 视为自设纪元，凡人 299 岁不判异常',
        story: '0999-12-31',
        snap: { name: '边界者二', identity: { birthDate: '0700-01-01' } },
        expect: '',
        deviation: 'V1 判 overage；V2 在锚点年份 < 1000 时豁免',
    },
];

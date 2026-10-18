// 临时诊断（用完即删）：找多选复选框在行渲染里的位置与相关动作名
import { readFileSync } from 'node:fs';
const files = ['ui/panel.js', 'ui/select-bar.js', 'ui/fields.js'];
for (const f of files) {
    const t = readFileSync(f, 'utf8').split('\n');
    console.log('=== ' + f + ' ===');
    t.forEach((l, i) => {
        if (/selToggle|selClear|selectAll|multiToggle|ftt-sel|selOf\(|data-ftt-action="sel/.test(l)) {
            console.log((i + 1) + ': ' + l.trim().slice(0, 190));
        }
    });
}

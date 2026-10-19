/**
 * 单测: 自定义主题色 (src/themePaint.ts)
 *
 * 核心不变量: 用户输入的**任意**颜色(哪怕纯黑/纯白/荧光绿)经 paintTheme 推导后,
 * 正文对比度必须 >= 7:1 —— 否则用户粘一个深色进来就直接"字看不见了"。
 */
'use strict';
const assert = require('assert');
const { normalizeHex, customTheme, contrastRatio } = require('../dist/themePaint');

// ---------------------------------------------------------------- normalizeHex
{
    assert.strictEqual(normalizeHex('#1a2847'), '#1a2847');
    assert.strictEqual(normalizeHex('#1A2847'), '#1a2847', '应转小写');
    assert.strictEqual(normalizeHex('  #1a2847  '), '#1a2847', '应去空格');
    assert.strictEqual(normalizeHex('#abc'), '#aabbcc', '三位应展开为六位');
    assert.strictEqual(normalizeHex('#1A2'), '#11aa22');
    assert.strictEqual(normalizeHex('1a2847'), '#1a2847', '可省略 #');
    assert.strictEqual(normalizeHex('rgb(26,40,71)'), '#1a2847', '应支持 rgb()');
    assert.strictEqual(normalizeHex('rgb(26, 40, 71)'), '#1a2847', 'rgb() 允许空格');
    assert.strictEqual(normalizeHex('rgba(26,40,71,0.5)'), '#1a2847', 'rgba() 应忽略 alpha');
    assert.strictEqual(normalizeHex('rgb(300,40,71)'), '#ff2847', '越界分量应 clamp 到 255');
    for (const bad of ['', '   ', '#12', '#12345', 'nope', 'rgb(1,2)', '#gggggg', '#1234567']) {
        assert.strictEqual(normalizeHex(bad), null, '非法输入应返回 null: ' + JSON.stringify(bad));
    }
}
console.log('颜色归一化(#rgb/#rrggbb/rgb()/rgba()/clamp/非法拒绝): 通过');

// ---------------------------------------------------------------- 对比度保障
{
    // 极端输入: 纯黑、纯白、荧光色、灰阶... 全部必须推出可读色板
    const extremes = [
        '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff',
        '#7f7f7f', '#ff0001', '#010101', '#123456', '#abcdef', '#0a0a0a', '#f0f0f0',
    ];
    let minBody = Infinity;
    let minMuted = Infinity;
    let minAccent = Infinity;
    for (const hex of extremes) {
        const t = customTheme(hex);
        const body = contrastRatio(t.fg, t.bg);
        const muted = contrastRatio(t.muted, t.bg);
        const accent = contrastRatio(t.accent, t.bg);
        minBody = Math.min(minBody, body);
        minMuted = Math.min(minMuted, muted);
        minAccent = Math.min(minAccent, accent);

        assert.ok(body >= 7, `正文对比度需 >= 7:1, ${hex} 推出 ${body.toFixed(2)}:1`);
        assert.ok(muted >= 4.5, `次要文字对比度需 >= 4.5:1, ${hex} 推出 ${muted.toFixed(2)}:1`);
        assert.ok(accent >= 4.5, `强调色对比度需 >= 4.5:1, ${hex} 推出 ${accent.toFixed(2)}:1`);
        // 主色上的文字也要可读
        assert.ok(contrastRatio(t.accentFg, t.accent) >= 3, `${hex} 主色上的字对比度不足`);
        // 所有色值必须是合法 #rrggbb(否则 CSS 变量会失效)
        for (const k of ['bg', 'fg', 'pageBg', 'chromeBg', 'chromeBorder', 'accent', 'accentFg', 'muted', 'panelAccent', 'panelHover']) {
            assert.match(t[k], /^#[0-9a-f]{6}$/, `${hex} 的 ${k} 非法: ${t[k]}`);
        }
    }
    console.log(
        `极端色输入可读性(正文最低 ${minBody.toFixed(2)}:1 / 次要 ${minMuted.toFixed(2)}:1 / 强调 ${minAccent.toFixed(2)}:1): 通过`
    );
}

// ---------------------------------------------------------------- 色相保持
{
    // 同一色相的不同明度应推出**同一色相**的色板(用户直觉: 换深浅不换色系)
    const a = customTheme('#ff0000');
    const b = customTheme('#ff5555');
    // bg 的色相应一致: 转换回 HSL 比较 hue
    const toH = (hex) => {
        const n = parseInt(hex.slice(1), 16);
        const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
        const max = Math.max(r, g, bl), min = Math.min(r, g, bl), d = max - min;
        if (d === 0) { return 0; }
        let h;
        if (max === r) { h = ((g - bl) / d + (g < bl ? 6 : 0)) / 6; }
        else if (max === g) { h = ((bl - r) / d + 2) / 6; }
        else { h = ((r - g) / d + 4) / 6; }
        return h * 360;
    };
    assert.ok(Math.abs(toH(a.bg) - toH(b.bg)) < 1, '同色相应推出一致色相');
    // 不同色相应产出明显不同的纸面(否则"自定义"名不副亡)
    assert.ok(customTheme('#ff0000').bg !== customTheme('#0000ff').bg, '不同色相应推出不同纸面');
}
console.log('色相保持(同色相一致/异色相可辨): 通过');

// ---------------------------------------------------------------- 兜底
{
    const t = customTheme(undefined);
    assert.strictEqual(t.id, 'custom');
    assert.strictEqual(t.name, '自定义色');
    assert.ok(contrastRatio(t.fg, t.bg) >= 7, '缺省/非法色值也必须可读');
    assert.strictEqual(customTheme('not-a-color').bg, t.bg, '非法输入走同一兜底');
}
console.log('缺省与非法输入兜底(仍满足对比度): 通过');
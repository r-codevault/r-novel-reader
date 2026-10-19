/**
 * 单测: 文本编码识别 (src/encoding.ts)
 *
 * 背景: 站点下载的 txt 常为 GB18030; 窗口恢复路径曾硬解 UTF-8 导致乱码,
 * 这里锁定 BOM / 严格 UTF-8 / GB18030 回退三条分支。
 */
const assert = require('assert');
const { decodeBuffer } = require('../dist/encoding');

const cases = [];

// UTF-8 BOM
{
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一章', 'utf8')]);
    const r = decodeBuffer(buf);
    assert.strictEqual(r.encoding, 'utf8-bom');
    // BOM 是否保留属既有行为(parseNovel 侧自行处理), 这里只锁定"按 utf8 解码、不乱码"
    assert.strictEqual(r.text.replace(/\uFEFF/g, ''), '第一章');
    cases.push('utf8-bom');
}
// 纯 UTF-8 (无 BOM)
{
    const r = decodeBuffer(Buffer.from('正文内容', 'utf8'));
    assert.strictEqual(r.encoding, 'utf8');
    assert.strictEqual(r.text, '正文内容');
    cases.push('utf8');
}
// UTF-16LE / BE
{
    const le = Buffer.from('第二章', 'utf16le');
    const leBom = Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
    assert.strictEqual(decodeBuffer(leBom).encoding, 'utf16le');
    assert.strictEqual(decodeBuffer(leBom).text.replace(/\uFEFF/g, ''), '第二章');

    const be = Buffer.from('第二章', 'utf16le');
    be.swap16();
    const beBom = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    assert.strictEqual(decodeBuffer(beBom).encoding, 'utf16be');
    assert.strictEqual(decodeBuffer(beBom).text.replace(/\uFEFF/g, ''), '第二章');
    cases.push('utf16le', 'utf16be');
}
// GB18030 回退: 中文编码的字节不是合法 UTF-8 -> 必须回退且无替换字符
{
    const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]); // "中文正文" GB18030
    const r = decodeBuffer(buf);
    assert.strictEqual(r.encoding, 'gb18030', '非法 UTF-8 字节应回退 GB18030');
    assert.ok(!r.text.includes('\uFFFD'), 'GB18030 解码结果不应含替换字符');
    cases.push('gb18030');
}

// 回归: 同一份 GB18030 文本, 走 decodeBuffer 与硬解 UTF-8 的结果不同(证明修复有意义)
{
    const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    const naive = buf.toString('utf-8');
    assert.ok(naive.includes('\uFFFD'), '硬解 UTF-8 应产生乱码(对照组)');
    assert.ok(!decodeBuffer(buf).text.includes('\uFFFD'), 'decodeBuffer 不应产生乱码');
}

console.log(`文本编码识别(${cases.join(' / ')} + GB18030 回退不乱码): 通过`);
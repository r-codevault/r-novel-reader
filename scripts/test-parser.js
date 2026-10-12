/**
 * test-parser.js — 章节目录解析器测试
 *
 * 用法:
 *   node scripts/test-parser.js                    # 使用默认测试文件(如存在)
 *   node scripts/test-parser.js <小说文件.txt>      # 指定任意小说文件做结构校验
 *   NOVEL_TXT=<路径> node scripts/test-parser.js   # 或通过环境变量指定
 *
 * 说明:
 *   - 结构校验(章节序号连续、正文不残留重复标题等)对任意小说文件都执行
 *   - 与具体书籍绑定的断言(总章数、特定标题)仅在测试默认文件时执行
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseNovel, findChapter } = require('../dist/novelParser');

const DEFAULT_BOOK = '吞噬星空2起源大陆.txt';
const file =
    process.argv[2] || process.env.NOVEL_TXT || path.resolve(__dirname, '..', '..', DEFAULT_BOOK);

if (!fs.existsSync(file)) {
    console.log('跳过解析器测试：未找到测试小说文件。');
    console.log(`  期望位置: ${file}`);
    console.log('  指定其它文件: node scripts/test-parser.js <小说文件.txt>');
    process.exit(0);
}

/** 与 extension.ts 中 decodeBuffer 一致的文件解码逻辑 */
function decodeBuffer(buf) {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { text: buf.toString('utf8'), encoding: 'utf8-bom' };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.toString('utf16le'), encoding: 'utf16le' };
    }
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('\uFFFD')) {
        return { text: utf8, encoding: 'utf8' };
    }
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' };
}

const buf = fs.readFileSync(file);
const { text, encoding } = decodeBuffer(buf);
console.log('文件:', path.basename(file), '| 编码:', encoding, '| 字节:', buf.length);

const t0 = Date.now();
const novel = parseNovel(text, file, encoding);
const ms = Date.now() - t0;

console.log('书名:', novel.bookTitle, '| 作者:', novel.author || '(未识别)');
console.log(
    '章节数:',
    novel.chapters.length,
    '| 总字数:',
    novel.totalWords.toLocaleString(),
    `| 解析耗时: ${ms}ms`
);
console.log('前言(前120字):', JSON.stringify(novel.preface.slice(0, 120)));

const empties = novel.chapters.filter((c) => c.wordCount === 0);
console.log('空正文章节数:', empties.length);

console.log('\n--- 前 5 章 ---');
for (const c of novel.chapters.slice(0, 5)) {
    console.log(`  [${c.index}] ${c.title} (${c.wordCount} 字)`);
}
console.log('--- 后 3 章 ---');
for (const c of novel.chapters.slice(-3)) {
    console.log(`  [${c.index}] ${c.title} (${c.wordCount} 字)`);
}

if (novel.chapters.length > 2) {
    const ch3 = novel.chapters[2];
    console.log('\n第3章正文预览:', JSON.stringify(ch3.content.slice(0, 90)));
}

console.log(
    '\n按标题查找章节:',
    findChapter(novel, novel.chapters[0].title.slice(0, 6))?.title ?? '(未找到)'
);

// ---------------------------------------------------------------- 结构校验(通用)
assert(novel.chapters.length > 0, '应至少解析出 1 个章节');
assert(
    novel.chapters.every((c, i) => c.index === i),
    '章节序号必须从 0 连续递增'
);
assert(
    novel.chapters.every((c) => c.title.trim().length > 0),
    '章节标题不能为空'
);
assert(
    novel.chapters.every((c) => !c.content.split('\n').some((l) => l.trim() === c.title.trim())),
    '章节正文中不应残留与标题完全相同的独立行'
);
console.log('\n结构校验通过 ✔');

// ---------------------------------------------------------------- 默认测试书目的专项断言
if (path.basename(file) === DEFAULT_BOOK) {
    const ch3 = novel.chapters[2];
    assert(novel.chapters.length === 454, '章节数应为 454');
    assert(novel.chapters[0].title.includes('第1章'), '第1章标题');
    assert(novel.chapters[0].wordCount > 100, '第1章应有正文');
    assert(
        !ch3.content.split('\n').some((l) => l.trim().startsWith('第3章')),
        '第3章正文不应含重复标题'
    );
    assert(empties.length === 0, '不应有空正文章节');
    // 含逗号的合法标题不应被误杀(作者告示守卫不能误伤)
    assert(
        novel.chapters.some((c) => c.title.startsWith('第113章 一切伟力，归于自身')),
        '第113章(含逗号标题)'
    );
    assert(
        novel.chapters.some((c) => c.title.startsWith('第231章 梦域，黑暗区域')),
        '第231章(含逗号标题)'
    );
    assert(
        novel.chapters.some((c) => c.title.startsWith('第253章 星辰塔，出！')),
        '第253章(含逗号标题)'
    );
    // 作者告示不应成为章节
    assert(
        !novel.chapters.some((c) => c.title.includes('第一篇『初临』结束')),
        '作者告示不应成为章节'
    );
    console.log('默认书目专项断言通过 ✔ (454 章 / 编码 / 去重 / 告示过滤)');
}

console.log('\n全部断言通过 ✔');

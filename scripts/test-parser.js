/* 解析器测试: 直接加载编译产物 dist/novelParser.js 对真实小说文件解析 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parseNovel, findChapter } = require('../dist/novelParser');

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

const file = path.resolve(__dirname, '..', '..', '吞噬星空2起源大陆.txt');
const buf = fs.readFileSync(file);
const { text, encoding } = decodeBuffer(buf);
console.log('文件:', path.basename(file), '| 编码:', encoding, '| 字节:', buf.length);

const t0 = Date.now();
const novel = parseNovel(text, file, encoding);
const ms = Date.now() - t0;

console.log('书名:', novel.bookTitle, '| 作者:', novel.author || '(未识别)');
console.log('章节数:', novel.chapters.length, '| 总字数:', novel.totalWords.toLocaleString(), `| 解析耗时: ${ms}ms`);
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

const ch3 = novel.chapters[2];
console.log('\n第3章正文预览:', JSON.stringify(ch3.content.slice(0, 90)));
console.log('第3章是否残留重复标题行:', ch3.content.split('\n').some((l) => l.includes('第3章')));

const seqOk = novel.chapters.every((c, i) => c.index === i);
console.log('\n章节序号连续:', seqOk);
console.log('查找"初临起源大陆":', findChapter(novel, '初临起源大陆')?.title);

// 结构化断言
const assert = require('assert');
assert(novel.chapters.length === 454, '章节数应为 454');
assert(novel.chapters[0].title.includes('第1章'), '第1章标题');
assert(novel.chapters[0].wordCount > 100, '第1章应有正文');
assert(novel.chapters[2].title.includes('第3章'), '第3章标题');
assert(!ch3.content.split('\n').some((l) => l.trim().startsWith('第3章')), '第3章正文不应含重复标题');
assert(empties.length === 0, '不应有空正文章节');
// 含逗号的合法标题不应被误杀(作者告示守卫不能误伤)
assert(novel.chapters.some((c) => c.title.startsWith('第113章 一切伟力，归于自身')), '第113章(含逗号标题)');
assert(novel.chapters.some((c) => c.title.startsWith('第231章 梦域，黑暗区域')), '第231章(含逗号标题)');
assert(novel.chapters.some((c) => c.title.startsWith('第253章 星辰塔，出！')), '第253章(含逗号标题)');
// 作者告示不应成为章节
assert(!novel.chapters.some((c) => c.title.includes('第一篇『初临』结束')), '作者告示不应成为章节');
console.log('\n全部断言通过 ✔');

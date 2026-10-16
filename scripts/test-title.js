/**
 * test-title.js — 书名/作者解析单测(文件名优先)
 *
 * 背景: 下载站的正文前言常含"内容简介/其他作品推荐",
 *       里面的《...》往往是**别的书** —— 曾把《一念永恒》识别成"仙逆"。
 */
'use strict';
const assert = require('assert');
const { deriveTitleAuthor } = require('../dist/novelParser');

const cases = [
  // 1) 文件名优先: 前言提到别的作品也不能影响
  {
    file: 'D:/lib/《一念永恒》（校对版全本）作者：耳根.txt',
    meta: '内容简介：\n耳根作品《仙逆》《求魔》《我欲封天》之后的第四部长篇',
    title: '一念永恒',
    author: '耳根',
  },
  // 2) 【】/（）等括号干扰
  { file: 'D:/lib/《仙逆》（校对版全本）作者：耳根.txt', meta: '转载须知', title: '仙逆', author: '耳根' },
  // 3) "· 作者：" 分隔形式
  { file: 'D:/lib/《吞噬星空》· 作者：我吃西红柿.txt', meta: '', title: '吞噬星空', author: '我吃西红柿' },
  // 4) 书名带数字后缀
  { file: 'D:/lib/《吞噬星空2起源大陆》· 作者：我吃西红柿.txt', meta: '', title: '吞噬星空2起源大陆', author: '我吃西红柿' },
  // 5) 文件名无《》 -> 回退正文
  { file: 'D:/lib/未知书名.txt', meta: '内容简介\n本书《某某传》很精彩\n作者：张三', title: '某某传', author: '张三' },
  // 6) 都无元信息 -> 文件名兜底
  { file: 'D:/lib/没有元信息的书.txt', meta: '', title: '没有元信息的书', author: '' },
  // 7) 文件名有《》但无作者 -> 作者取正文
  { file: 'D:/lib/《孤本残卷》.txt', meta: '作者：李四', title: '孤本残卷', author: '李四' },
];

for (const c of cases) {
  const got = deriveTitleAuthor(c.file, c.meta);
  assert.strictEqual(got.bookTitle, c.title, `书名应解析为「${c.title}」, 实际「${got.bookTitle}」(file=${c.file})`);
  assert.strictEqual(got.author, c.author, `作者应解析为「${c.author}」, 实际「${got.author}」(file=${c.file})`);
}

console.log('书名解析测试全部通过 ✔');

/**
 * test-notes.js — 阅读笔记数据层 + 锚点解析测试
 * 用法: node scripts/test-notes.js
 */

'use strict';

const assert = require('assert');
const { NotesStore } = require('../dist/notes');
const { normalizeTitle, resolveChapterIndex, findParagraph } = require('../dist/noteAnchor');

/** 内存版 Memento */
function memoryState() {
  const mem = {};
  return {
    mem,
    get: (key, fallback) => (key in mem ? mem[key] : fallback),
    update: async (key, value) => {
      if (value === undefined) { delete mem[key]; } else { mem[key] = value; }
    },
  };
}

const BOOK = { bookPath: 'D:/books/a.txt', bookTitle: '甲书' };
const DRAFT = {
  chapterTitle: '第一章 开端',
  chapterIndex: 0,
  paragraphIndex: 3,
  quote: '这是被引用的整段原文。',
  text: '第一条笔记',
};

(async () => {
  const state = memoryState();
  const notes = new NotesStore(state);

  console.log('[笔记数据层]');

  // --- 空存储 ---
  assert.deepStrictEqual(notes.list(), [], '空存储应返回空数组');
  assert.strictEqual(notes.countFor(BOOK.bookPath), 0, '空存储计数为 0');

  // --- 新增 ---
  const a = await notes.add(DRAFT, BOOK);
  assert(a.id && a.id.length >= 8, '应生成 id');
  assert.strictEqual(a.bookPath, BOOK.bookPath, 'bookPath 应为传入的实际路径');
  assert.strictEqual(a.bookTitle, '甲书', '应写入书名快照');
  assert.strictEqual(a.text, '第一条笔记', '应写入正文');
  assert.strictEqual(a.createdAt, a.updatedAt, '新建时 created/updated 相同');
  assert.strictEqual(state.mem['novelReader.notes'].v, 1, '存储结构应带版本号 v=1');
  assert.strictEqual(state.mem['novelReader.notes'].items.length, 1);

  const b = await notes.add({ ...DRAFT, text: '  第二条  ' }, BOOK);
  assert.strictEqual(b.text, '第二条', '正文应 trim');
  assert.notStrictEqual(a.id, b.id, 'id 不应重复');

  // --- 空正文拒绝 ---
  await assert.rejects(() => notes.add({ ...DRAFT, text: '   ' }, BOOK), /不能为空/);
  await assert.rejects(() => notes.update(a.id, '  '), /不能为空/);

  // --- 更新 ---
  const before = a.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const updated = await notes.update(a.id, '改过的内容');
  assert(updated, '更新应返回条目');
  assert.strictEqual(updated.text, '改过的内容');
  assert.strictEqual(updated.createdAt, a.createdAt, 'createdAt 不应变');
  assert(updated.updatedAt > before, 'updatedAt 应刷新');
  assert.strictEqual(await notes.update('不存在', 'x'), undefined, '未知 id 返回 undefined');

  // --- 按书查询 / 计数 ---
  assert.strictEqual(notes.listFor(BOOK.bookPath).length, 2);
  assert.strictEqual(notes.countFor('D:/books/other.txt'), 0);

  // --- 删除 ---
  assert.strictEqual(await notes.remove(b.id), true);
  assert.strictEqual(await notes.remove(b.id), false, '重复删除应返回 false');
  assert.strictEqual(notes.list().length, 1);

  // --- 并发写入不丢 ---
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => notes.add({ ...DRAFT, text: '并发' + i }, BOOK)));
  assert.strictEqual(new Set(many.map((n) => n.id)).size, 20, 'id 应全部唯一');
  assert.strictEqual(notes.list().length, 21, '20 条并发写入应全部落盘');

  // --- 截断 ---
  const long = await notes.add({ ...DRAFT, text: 'x'.repeat(6000), quote: 'q'.repeat(5000) }, BOOK);
  assert(long.text.length <= 5001, '正文应截断到上限附近');
  assert(long.quote.length <= 4001, '引用应截断到上限附近');
  assert(long.text.endsWith('…') && long.quote.endsWith('…'), '截断应带省略号');

  // --- 损坏数据容错 ---
  const bad1 = memoryState(); bad1.mem['novelReader.notes'] = { v: 0, items: [{ id: 'x' }] };
  assert.deepStrictEqual(new NotesStore(bad1).list(), [], '版本不符应视为空');
  const bad2 = memoryState(); bad2.mem['novelReader.notes'] = [{ id: 'x' }];
  assert.deepStrictEqual(new NotesStore(bad2).list(), [], '非对象应视为空');
  const bad3 = memoryState();
  bad3.mem['novelReader.notes'] = { v: 1, items: [{ id: 'ok', bookPath: 'p', bookTitle: 't', chapterTitle: 'c', chapterIndex: 0, paragraphIndex: 0, quote: 'q', text: 'x', createdAt: 1, updatedAt: 1 }, { id: 'bad' }] };
  assert.strictEqual(new NotesStore(bad3).list().length, 1, '坏条目应被过滤, 好条目保留');

  // --- 按书清空 ---
  const removed = await notes.removeByBook(BOOK.bookPath);
  assert.strictEqual(removed, 22, '应删除该书全部笔记(1 + 20 并发 + 1 超长)');
  assert.strictEqual(notes.list().length, 0);

  // --- 路径迁移 ---
  const n1 = await notes.add(DRAFT, { bookPath: 'D:/src/x.txt', bookTitle: 'X' });
  await notes.add(DRAFT, { bookPath: 'D:/dst/x.txt', bookTitle: 'X' });
  const movedCount = await notes.relink('D:/src/x.txt', 'D:/dst/x.txt', '新书名');
  assert.strictEqual(movedCount, 1, '应迁移 1 条');
  assert.strictEqual(notes.listFor('D:/src/x.txt').length, 0, '旧路径应无残留');
  assert.strictEqual(notes.listFor('D:/dst/x.txt').length, 2, '应与目标路径原有笔记合并');
  assert.strictEqual(notes.list().find((n) => n.id === n1.id).bookTitle, '新书名', '迁移时应更新书名快照');
  assert.strictEqual(await notes.relink('D:/dst/x.txt', 'D:/dst/x.txt'), 0, '同路径应为 no-op');

  console.log('存储: 增删改查/并发/截断/容错/迁移 全部通过 ✔');

  console.log('[锚点解析]');
  assert.strictEqual(normalizeTitle('  第一章\u3000 开端  '), '第一章 开端', '全角空格与多空白应归一');

  const chapters = [
    { index: 0, title: '第一章 开端' },
    { index: 1, title: '第二章 风起' },
    { index: 2, title: '番外 其一' },
    { index: 3, title: '番外 其一' },
  ];
  assert.strictEqual(resolveChapterIndex(chapters, { chapterTitle: '第二章 风起', chapterIndex: 1 }), 1);
  assert.strictEqual(resolveChapterIndex(chapters, { chapterTitle: '第二章\u3000风起', chapterIndex: 0 }), 1, '全角空格应能匹配');
  assert.strictEqual(resolveChapterIndex(chapters, { chapterTitle: '番外 其一', chapterIndex: 3 }), 3, '同名章节应就近');
  assert.strictEqual(resolveChapterIndex(chapters, { chapterTitle: '番外', chapterIndex: 2 }), 2, '应支持包含匹配');
  assert.strictEqual(resolveChapterIndex(chapters, { chapterTitle: '不存在', chapterIndex: 99 }), 3, '找不到应 clamp 到末章');
  assert.strictEqual(resolveChapterIndex([], { chapterTitle: 'x', chapterIndex: 5 }), 0, '空章节表应返回 0');

  const paras = ['第一段', '第二段', '这是被引用的整段原文。', '第四段', '第五段'];
  assert.deepStrictEqual(findParagraph(paras, 2, '这是被引用的整段原文。'), { index: 2, exact: true });
  assert.deepStrictEqual(findParagraph(paras, 0, '第五段'), { index: 4, exact: true }, '应在全章范围回退查找');
  assert.deepStrictEqual(findParagraph(paras, 1, '这是被引用'), { index: 2, exact: false }, '前缀命中应标记非精确');
  assert.deepStrictEqual(findParagraph(paras, 99, '不存在'), { index: 4, exact: false }, '找不到应 clamp 到 hint');
  assert.deepStrictEqual(findParagraph([], 3, 'x'), { index: 0, exact: false }, '空章节不应崩');

  // 段落下移: 前面插入两段后 hint 失效, 但全等仍能命中
  const shifted = ['新增一', '新增二', ...paras];
  assert.deepStrictEqual(findParagraph(shifted, 2, '这是被引用的整段原文。'), { index: 4, exact: true }, '段落漂移应靠全文匹配找回');

  console.log('锚点: 章节标题/同名就近/包含匹配/段落漂移/前缀兜底 全部通过 ✔');
  console.log('\n笔记测试全部通过 ✔');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

/**
 * test-shelf.js — 书架数据层测试(ShelfStore: 增删查 / 进度更新 / 旧数据迁移)
 * 用法: node scripts/test-shelf.js
 */

'use strict';

const assert = require('assert');
const { ShelfStore } = require('../dist/shelf');

/** 内存版 Memento */
function memoryState() {
  const mem = {};
  return {
    mem,
    get: (key, fallback) => (key in mem ? mem[key] : fallback),
    update: async (key, value) => {
      if (value === undefined) {
        delete mem[key];
      } else {
        mem[key] = value;
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const state = memoryState();
  const shelf = new ShelfStore(state);

  console.log('[书架数据层]');

  // --- 新增 ---
  await shelf.upsert({ filePath: 'D:/a.txt', title: '甲书', author: '作者A', totalChapters: 100 });
  assert(shelf.size === 1, '应新增 1 本');
  let a = shelf.get('D:/a.txt');
  assert(a.chapterIndex === -1, '新书应标记为未开始阅读');
  assert(a.totalChapters === 100 && a.title === '甲书', '书目信息应写入');
  console.log('新增书籍: 通过');

  // --- 更新进度 ---
  await sleep(2);
  await shelf.updateProgress('D:/a.txt', 12, 0.5);
  a = shelf.get('D:/a.txt');
  assert(a.chapterIndex === 12 && Math.abs(a.scrollRatio - 0.5) < 1e-6, '进度应写入');

  const updatedAtBefore = a.updatedAt;
  await sleep(2);
  await shelf.updateProgress('D:/a.txt', 12, 0.5); // 无变化
  assert(shelf.get('D:/a.txt').updatedAt === updatedAtBefore, '进度未变化时不应刷新时间戳');

  await shelf.updateProgress('D:/a.txt', 13, 5); // 越界比例
  assert(shelf.get('D:/a.txt').scrollRatio === 1, '滚动比例应被夹到 0~1');
  console.log('进度更新: 通过');

  // --- 再次 upsert 不应丢失进度 ---
  await shelf.upsert({ filePath: 'D:/a.txt', title: '甲书(修订)', author: '作者A', totalChapters: 120 });
  a = shelf.get('D:/a.txt');
  assert(a.chapterIndex === 13, 'upsert 应保留已有阅读进度');
  assert(a.title === '甲书(修订)' && a.totalChapters === 120, 'upsert 应更新书目信息');
  console.log('重复打开保留进度: 通过');

  // --- 多本 + 排序 ---
  await sleep(2);
  await shelf.upsert({ filePath: 'D:/b.txt', title: '乙书', author: '', totalChapters: 50 });
  const list = shelf.list();
  assert(list.length === 2, '应有 2 本');
  assert(list[0].filePath === 'D:/b.txt', '最近打开的书应排在最前');
  assert(shelf.last().filePath === 'D:/b.txt', 'last() 应返回最近阅读的书');
  console.log('多本管理 / 排序: 通过');

  // --- 移除 ---
  await shelf.remove('D:/b.txt');
  assert(shelf.size === 1 && !shelf.get('D:/b.txt'), '移除后不应再存在');
  console.log('移除书籍: 通过');

  // --- 文件移动后重新定位: 进度应迁移到新路径 ---
  await sleep(2);
  await shelf.relink('D:/a.txt', 'D:/书库/甲书.txt', {
    title: '甲书',
    author: '作者A',
    totalChapters: 120,
  });
  const relinked = shelf.get('D:/书库/甲书.txt');
  assert(relinked, '重新定位后应以新路径登记');
  assert(!shelf.get('D:/a.txt'), '旧路径条目应被替换');
  assert(relinked.chapterIndex === 13 && Math.abs(relinked.scrollRatio - 1) < 1e-6, '阅读进度应保留');
  assert(relinked.title === '甲书' && relinked.totalChapters === 120, '书目信息应更新');
  assert(shelf.size === 1, '重新定位不应产生重复条目');
  console.log('文件移动后重新定位(保留进度): 通过');

  // --- 旧 session 迁移 ---
  const state2 = memoryState();
  await state2.update('novelReader.session', {
    filePath: 'D:/old.txt',
    chapterIndex: 77,
    scrollRatio: 0.33,
    updatedAt: 1700000000000,
  });
  const shelf2 = new ShelfStore(state2);
  await shelf2.migrateLegacySession();
  const migrated = shelf2.get('D:/old.txt');
  assert(migrated, '旧 session 应被迁移进书架');
  assert(migrated.chapterIndex === 77 && Math.abs(migrated.scrollRatio - 0.33) < 1e-6, '迁移应保留进度');
  assert(state2.get('novelReader.session') === undefined, '迁移后应清除旧 session 键');
  await shelf2.migrateLegacySession(); // 幂等
  assert(shelf2.size === 1, '重复迁移不应产生重复条目');
  console.log('旧数据迁移: 通过');

  console.log('\n书架测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

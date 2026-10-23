/**
 * test-history.js — 阅读历史: 本地/在线分开、去重、上限 1000、持久化
 */
'use strict';
const assert = require('assert');
const { HistoryStore, HISTORY_MAX_PER_KIND } = require('../dist/history');

function memoryState() {
  const data = {};
  return {
    data,
    get(key, def) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : def; },
    async update(key, value) { data[key] = value; },
  };
}

(async () => {
  const state = memoryState();
  const h = new HistoryStore(state);
  h.load();

  // 本地/在线分开
  h.record({ kind: 'local', filePath: '/a.txt', title: 'A', author: '甲', chapterIndex: 2, totalChapters: 10 });
  h.record({ kind: 'online', filePath: 'online://s/1', title: 'B', author: '乙', chapterIndex: 1, totalChapters: 20,
    sourceId: 's', sourceName: '站', bookUrl: 'https://x/1' });
  let list = h.list();
  assert.strictEqual(list.local.length, 1);
  assert.strictEqual(list.online.length, 1);
  assert.strictEqual(list.online[0].sourceName, '站');

  // 同书去重并置顶 + 更新进度
  h.record({ kind: 'local', filePath: '/a.txt', title: 'A', author: '甲', chapterIndex: 5, totalChapters: 10 });
  list = h.list();
  assert.strictEqual(list.local.length, 1, '同书不应重复');
  assert.strictEqual(list.local[0].chapterIndex, 5, '应更新进度');

  // 持久化/重新加载
  await h.flush();
  const h2 = new HistoryStore(state);
  h2.load();
  assert.strictEqual(h2.list().local[0].filePath, '/a.txt');

  // 各自上限 1000
  for (let i = 0; i < HISTORY_MAX_PER_KIND + 5; i++) {
    h.record({ kind: 'local', filePath: '/l' + i + '.txt', title: 'L' + i, author: '', chapterIndex: 0, totalChapters: 1 });
    h.record({ kind: 'online', filePath: 'online://s/' + i, title: 'O' + i, author: '', chapterIndex: 0, totalChapters: 1,
      sourceId: 's', sourceName: '站', bookUrl: 'https://x/' + i });
  }
  await h.flush();
  list = h.list();
  assert.strictEqual(list.local.length, HISTORY_MAX_PER_KIND, '本地上限 1000');
  assert.strictEqual(list.online.length, HISTORY_MAX_PER_KIND, '在线上限 1000');
  assert.strictEqual(list.local[0].title, 'L' + (HISTORY_MAX_PER_KIND + 4), '最新记录在最前');
  assert.strictEqual(list.online[0].title, 'O' + (HISTORY_MAX_PER_KIND + 4));

  // 加载时也做上限裁剪
  const h3 = new HistoryStore(state);
  h3.load();
  assert.strictEqual(h3.list().local.length, HISTORY_MAX_PER_KIND);

  console.log('阅读历史测试全部通过 ✔ (本地/在线各 ' + HISTORY_MAX_PER_KIND + ')');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

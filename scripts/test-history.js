/**
 * test-history.js — 阅读历史: 本地/在线分开、去重、上限 1000、持久化
 */
'use strict';
const assert = require('assert');
const { HistoryStore, HISTORY_MAX_PER_KIND, buildOpenEntry } = require('../dist/history');

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

  // find / updateProgress / buildOpenEntry(「打开即记」放开书架门禁)
  {
    const s2 = memoryState();
    const hh = new HistoryStore(s2);
    hh.load();
    hh.record({ kind: 'local', filePath: 'D:/a.txt', title: 'A', author: '', chapterIndex: 1, totalChapters: 10 });
    hh.record({ kind: 'online', filePath: 'online://s1/x', title: 'B', author: '', chapterIndex: 0, totalChapters: 5,
      sourceId: 's1', sourceName: '站', bookUrl: 'https://x/1' });

    assert.strictEqual(hh.find('D:/a.txt').title, 'A', 'find 应命中本地');
    assert.strictEqual(hh.find('online://s1/x').sourceName, '站', 'find 应命中在线');
    assert.strictEqual(hh.find('D:/nope.txt'), undefined, 'find 未命中应返回 undefined');

    const before = hh.list().online[0].lastReadAt;
    assert.strictEqual(hh.updateProgress('online://s1/x', 0), false, '同章不应写盘');
    assert.strictEqual(hh.list().online[0].lastReadAt, before, '同章不应刷新时间戳');
    assert.strictEqual(hh.updateProgress('online://s1/x', 3), true, '换章应更新');
    assert.strictEqual(hh.list().online[0].chapterIndex, 3, '章节应更新');
    assert.strictEqual(hh.updateProgress('D:/nope.txt', 1), false, '未知路径不应凭空新建');

    // 门禁放开: 书架里没有、只有 Novel 上的 online 信息(预览书)也要能产出条目
    const previewEntry = buildOpenEntry(
      { filePath: 'online://s1/preview', bookTitle: '预览书', author: '作者', chapters: [{}, {}],
        online: { sourceId: 's1', sourceName: '站', bookUrl: 'https://x/2' } },
      undefined, 4
    );
    assert(previewEntry && previewEntry.kind === 'online', '预览书应记为在线历史(不查书架)');
    assert.strictEqual(previewEntry.chapterIndex, 4);
    assert.strictEqual(previewEntry.totalChapters, 2, '总章数取 Novel 章节数');
    assert.strictEqual(previewEntry.sourceName, '站', '在线书应带书源名');

    assert.strictEqual(buildOpenEntry({ filePath: '', chapters: [] }, undefined, 0), null,
      '空路径(空态占位书)不应记历史');

    const localEntry = buildOpenEntry(
      { filePath: 'D:/x/y.txt', bookTitle: '文件名', author: '', chapters: [] },
      { title: '书架名', author: '乙', totalChapters: 9 }, 2
    );
    assert.strictEqual(localEntry.title, '书架名', '书名优先取书架(用户可能改过)');
    assert.strictEqual(localEntry.totalChapters, 9, '总章数优先取书架');
    assert.strictEqual(localEntry.kind, 'local');
    assert.strictEqual(localEntry.sourceId, undefined, '本地书不应带书源字段');
  }

  // 批量删除: 按 filePath 命中, 本地/在线一起查; 不存在的路径忽略
  {
    const st = memoryState();
    const s = new HistoryStore(st);
    s.load();
    s.record({ kind: 'local', filePath: '/a.txt', title: 'A', author: '', chapterIndex: 0, totalChapters: 1 });
    s.record({ kind: 'local', filePath: '/b.txt', title: 'B', author: '', chapterIndex: 0, totalChapters: 1 });
    s.record({ kind: 'local', filePath: '/c.txt', title: 'C', author: '', chapterIndex: 0, totalChapters: 1 });
    s.record({ kind: 'online', filePath: 'online://s/1', title: 'O', author: '', chapterIndex: 0, totalChapters: 1 });

    assert.strictEqual(s.removeMany([]), 0, '空数组不应改动任何东西');
    assert.strictEqual(s.removeMany(['/nope.txt']), 0, '不存在的路径应返回 0');
    assert.strictEqual(s.removeMany(['/a.txt', 'online://s/1']), 2, '应跨两栏删除 2 条');
    const after = s.list();
    assert.deepStrictEqual(after.local.map((e) => e.filePath), ['/c.txt', '/b.txt'], '其余本地记录应保留');
    assert.strictEqual(after.online.length, 0, '在线记录应被删掉');

    // 删除后要能落盘
    await s.flush();
    const reloaded = new HistoryStore(st);
    reloaded.load();
    assert.strictEqual(reloaded.list().local.length, 2, '删除结果应持久化');
    assert.strictEqual(reloaded.list().online.length, 0);

    // 清空单栏
    assert.strictEqual(s.clearKind('local'), 2, '应清空 2 条本地记录');
    assert.strictEqual(s.list().local.length, 0);
    assert.strictEqual(s.clearKind('local'), 0, '已空的栏再清应是 0');
  }

  console.log('阅读历史测试全部通过 ✔ (本地/在线各 ' + HISTORY_MAX_PER_KIND + ')');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

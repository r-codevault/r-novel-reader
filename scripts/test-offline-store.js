/**
 * test-offline-store.js — 离线下载区(manifest / done.log / 章节落盘)
 *
 * 重点验证: 段距往返、done 的自愈能力(目录扫描兜底)、路径安全。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OfflineStore } = require('../dist/offline/offlineStore');
const { onlineKey } = require('../dist/onlinePath');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r-offline-store-'));
  const store = new OfflineStore(tmp);
  const key = onlineKey('src1', 'https://example.com/book/1');
  const chapters = [
    { index: 0, title: '第1章 开始', url: 'https://example.com/c/1' },
    { index: 1, title: '第2章 继续', url: 'https://example.com/c/2' },
  ];

  // 1) 非法 key 一律返回 null(防目录穿越)
  assert.strictEqual(store.dirFor('online://../../x/abcd'), null, '非法路径应拒绝');
  assert.strictEqual(store.dirFor('not-online'), null, '非 online:// 应拒绝');
  assert.ok(store.dirFor(key), '合法 key 应有目录');

  // 2) manifest 往返 + 原子写不留 .tmp
  const seed = {
    sourceId: 'src1',
    sourceName: '测试源',
    bookUrl: 'https://example.com/book/1',
    bookTitle: '测试书',
    author: '某作者',
    tocUrl: 'https://example.com/book/1/',
    tocFetchedAt: 100,
    chapters,
    totalChapters: chapters.length,
    range: [0, 1],
  };
  const made = await store.ensureManifest(key, seed);
  assert.strictEqual(made.v, 1);
  assert.strictEqual(made.createdAt > 0, true);
  const back = await store.readManifest(key);
  assert.ok(back, 'manifest 应可读回');
  assert.strictEqual(back.bookTitle, '测试书');
  assert.strictEqual(back.chapters.length, 2);
  const dir = store.dirFor(key);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json.tmp')), '不应残留 .tmp');

  // 3) 二次 ensure 不重置 createdAt, 但目录变化时刷新章节
  const again = await store.ensureManifest(key, seed);
  assert.strictEqual(again.createdAt, made.createdAt, 'createdAt 应保留');
  const grown = await store.ensureManifest(key, {
    ...seed,
    chapters: chapters.concat([{ index: 2, title: '第3章 新增', url: 'https://example.com/c/3' }]),
    totalChapters: 3,
    tocFetchedAt: 200,
  });
  assert.strictEqual(grown.chapters.length, 3, '目录更新后应以新目录为准');

  // 4) 段距往返: 落盘是 "a\n\nb", 读回是 ['a','b']
  const bytes = await store.writeChapter(key, 0, ['第一段', '第二段']);
  assert.ok(bytes > 0);
  const raw = fs.readFileSync(path.join(dir, 'ch-000000.txt'), 'utf8');
  assert.strictEqual(raw, '第一段\n\n第二段', '段落间应保留空行(段距)');
  assert.deepStrictEqual(await store.readChapter(key, 0), ['第一段', '第二段']);
  assert.strictEqual(await store.readChapter(key, 99), null, '未下载的章返回 null');

  // 5) markDone 去重 + 校验文件存在
  await store.markDone(key, 0, bytes);
  await store.markDone(key, 0, bytes);
  assert.deepStrictEqual(await store.listDone(key), [0], 'done 应去重');

  // 5b) 直接写文件(不写 done.log)也能被目录扫描发现
  await store.writeChapter(key, 1, ['只有正文']);
  assert.deepStrictEqual(await store.listDone(key), [0, 1], '目录扫描应兜底发现新章');

  // 5c) 删掉正文文件后不再算已下载
  fs.rmSync(path.join(dir, 'ch-000001.txt'));
  assert.deepStrictEqual(await store.listDone(key), [0], '文件被删应不算已下载');

  // 6) loadState / setFailures
  await store.writeChapter(key, 1, ['补回来']);
  const st = await store.loadState(key);
  assert.deepStrictEqual(Array.from(st.done).sort(), [0, 1]);
  assert.deepStrictEqual(st.failed, {});
  await store.setFailures(key, { 1: '超时' });
  const st2 = await store.loadState(key);
  assert.strictEqual(st2.failed[1], '超时', '失败章应可持久化');
  await store.setFailures(key, {});
  assert.deepStrictEqual((await store.readManifest(key)).failed, undefined, '清空失败应移除字段');

  // 7) 大小统计 / 列表 / 删除
  assert.ok((await store.sizeOf(key)) > 0, 'sizeOf 应大于 0');
  const total = await store.totalSize();
  assert.strictEqual(total.books, 1, '应有 1 本书');
  assert.ok(total.bytes > 0);
  const all = await store.listAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].key, key, 'listAll 的 key 应与 onlineKey 一致');
  assert.deepStrictEqual(all[0].done, [0, 1]);

  await store.remove(key);
  assert.strictEqual(await store.readManifest(key), null, '删除后 manifest 应消失');
  assert.strictEqual((await store.totalSize()).books, 0);

  // 8) removeAll
  await store.ensureManifest(key, seed);
  await store.removeAll();
  assert.strictEqual((await store.totalSize()).books, 0, 'removeAll 应清空全部');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('离线存储(manifest/done/段距)测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

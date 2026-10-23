/**
 * test-source-store.js — 书源存储与导入解析测试
 *
 * 覆盖: 规范字段 / 单对象与数组导入 / 注释与拼接容错 / 幂等更新 /
 *       保留本地 enabled / 增删改 / 导出
 */
'use strict';
const assert = require('assert');
const { BookSourceStore, parseSourceText, normalizeSource, sourceIdFor } = require('../dist/bookSource');

/** 内存存储适配器(书源已改为文件存储) */
function memoryStore(initial) {
  const box = { text: initial === undefined ? null : initial };
  return {
    box,
    read: async () => box.text,
    write: async (t) => { box.text = t; },
  };
}

/** 建一个已加载的 store */
async function makeStore(initial) {
  const storage = memoryStore(initial);
  const store = new BookSourceStore(storage);
  await store.load();
  return { store, storage };
}

const SRC_A = {
  bookSourceName: 'A站',
  bookSourceUrl: 'https://a.com',
  bookSourceGroup: '玄幻',
  enabled: false,
  searchUrl: 'https://a.com/search?q={{key}}',
  ruleSearch: { bookList: '.list .item', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleToc: { chapterList: '.chapters a', chapterName: '@text', chapterUrl: '@href' },
  ruleContent: { content: '#content@html' },
  header: '{"User-Agent":"x"}',
};
const SRC_B = {
  bookSourceName: 'B站',
  bookSourceUrl: 'https://b.com/',
  searchUrl: 'https://b.com/s, {"method":"POST","body":"k={{key}}"}',
  ruleSearch: { bookList: 'data.books', name: 'title', author: 'author', bookUrl: 'url' },
};

(async () => {
  // 1) 规范化: 去尾斜杠 / 默认 enabled / 派生稳定 id
  {
    const s = normalizeSource(SRC_A, 111);
    assert.strictEqual(s.id, sourceIdFor('https://a.com'));
    assert.strictEqual(s.enabled, false, '显式 enabled=false 应保留');
    assert.strictEqual(s.addedAt, 111);
    assert.strictEqual(s.searchUrl, SRC_A.searchUrl);
    assert.ok(s.ruleSearch && s.ruleSearch.bookList === '.list .item');
    const b = normalizeSource(SRC_B, 222);
    assert.strictEqual(b.bookSourceUrl, 'https://b.com', '尾斜杠应去掉');
    assert.strictEqual(b.enabled, true, '未声明时应默认启用');
  }

  // 2) 非法条目被丢弃
  {
    assert.strictEqual(normalizeSource({ bookSourceName: 'x' }), null);
    assert.strictEqual(normalizeSource({ bookSourceUrl: 'ftp://a' }), null);
    assert.strictEqual(normalizeSource(null), null);
    assert.strictEqual(normalizeSource([SRC_A]), null);
  }

  // 3) 导入: 数组 / 单对象 / 注释 / 首尾相连
  {
    const arr = parseSourceText(JSON.stringify([SRC_A, SRC_B]));
    assert.strictEqual(arr.raws.length, 2);

    const single = parseSourceText(JSON.stringify(SRC_A));
    assert.strictEqual(single.raws.length, 1);

    const commented = parseSourceText('// 这是注释\n' + JSON.stringify([SRC_A]));
    assert.strictEqual(commented.raws.length, 1);

    const wrapped = parseSourceText(JSON.stringify({ bookSources: [SRC_A, SRC_B] }));
    assert.strictEqual(wrapped.raws.length, 2);

    const broken = JSON.parse(JSON.stringify(SRC_A));
    const concatenated = parseSourceText(JSON.stringify(broken) + '\n' + JSON.stringify(SRC_B));
    assert.strictEqual(concatenated.raws.length, 2, '两个首尾相连的对象应都能解析, 实际 ' + concatenated.raws.length);
  }

  // 4) 空内容 / 垃圾内容
  {
    assert.deepStrictEqual(parseSourceText('').raws, []);
    const junk = parseSourceText('这不是 JSON');
    assert.strictEqual(junk.raws.length, 0);
    assert.ok(junk.errors.length > 0);
  }

  // 5) 存储: 导入统计 + 幂等更新 + 保留本地 enabled
  {
    const { store } = await makeStore();
    const r1 = await store.importText(JSON.stringify([SRC_A, SRC_B, { bookSourceUrl: 'bad' }]));
    assert.strictEqual(r1.added, 2, '应新增 2 条, 实际 ' + r1.added);
    assert.strictEqual(r1.skipped, 1);
    assert.strictEqual(store.size(), 2);

    const a = store.list().find((s) => s.bookSourceName === 'A站');
    assert.strictEqual(a.enabled, false);

    // 用户手动启用后被再次导入: 规则更新, 但 enabled/addedAt 保留
    await store.setEnabled(a.id, true);
    const changed = { ...SRC_A, searchUrl: 'https://a.com/search2?q={{key}}' };
    const r2 = await store.importText(JSON.stringify([changed]));
    assert.strictEqual(r2.updated, 1);
    assert.strictEqual(r2.added, 0);
    const a2 = store.get(a.id);
    assert.strictEqual(a2.searchUrl, changed.searchUrl, '规则应更新');
    assert.strictEqual(a2.enabled, true, '本地启用状态应保留');
    assert.strictEqual(a2.addedAt, a.addedAt, 'addedAt 应保留');
  }

  // 6) enabled() 只返回启用的 + 排序
  {
    const { store } = await makeStore();
    await store.importText(JSON.stringify([
      { bookSourceName: '乙', bookSourceUrl: 'https://b2.com', enabled: true },
      { bookSourceName: '甲', bookSourceUrl: 'https://a2.com', enabled: false },
    ]));
    const enabled = store.enabled();
    assert.strictEqual(enabled.length, 1);
    assert.strictEqual(enabled[0].bookSourceName, '乙');
  }

  // 7) 删除 / 标记检查结果 / 导出
  {
    const { store } = await makeStore();
    await store.importText(JSON.stringify([SRC_A, SRC_B]));
    const first = store.list()[0];
    await store.markCheck(first.id, false, 'HTTP 404');
    const checked = store.get(first.id);
    assert.strictEqual(checked.lastCheckOk, false);
    assert.strictEqual(checked.lastCheckMessage, 'HTTP 404');

    const exported = JSON.parse(store.exportText());
    assert.strictEqual(exported.length, 2);
    assert.ok(exported[0].bookSourceUrl);
    assert.strictEqual(exported[0].lastCheckMessage, undefined, '导出不应带检查结果');

    await store.remove(first.id);
    assert.strictEqual(store.size(), 1);
  }

  // 8) 损坏的存储内容按空处理 + 脏条目过滤
  {
    const { normalizeSource } = require('../dist/bookSource');
    const { store } = await makeStore(JSON.stringify({ v: 1, items: [{ bad: true }, normalizeSource(SRC_A)] }));
    assert.strictEqual(store.size(), 1, '脏条目应被过滤');

    const broken = await makeStore('{not json');
    assert.strictEqual(broken.store.size(), 0, '损坏文件应以空表启动');
  }

  // 9) 落盘: 写入后重新加载能读回; 旧版 globalState 迁移
  {
    const { store, storage } = await makeStore();
    await store.importText(JSON.stringify([SRC_A]));
    const reloaded = new (require('../dist/bookSource').BookSourceStore)(storage);
    await reloaded.load();
    assert.strictEqual(reloaded.size(), 1, '重新加载应读到已保存的书源');

    const empty = await makeStore();
    const legacy = JSON.parse(JSON.stringify({ v: 1, items: [{
      id: 'abc', bookSourceName: '旧', bookSourceUrl: 'https://old.com',
      bookSourceName2: undefined, enabled: true, addedAt: 1,
    }] }));
    const moved = await empty.store.migrateLegacy(legacy);
    assert.strictEqual(moved, 1, '应迁移 1 条旧数据');
    assert.strictEqual(empty.store.size(), 1);
    assert.strictEqual(await empty.store.migrateLegacy(legacy), 0, '已有数据时不应重复迁移');
  }

  console.log('书源存储测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

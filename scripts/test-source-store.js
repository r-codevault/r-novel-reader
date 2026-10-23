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
  const box = { text: initial === undefined ? null : initial, writes: 0 };
  return {
    box,
    read: async () => box.text,
    write: async (t) => { box.text = t; box.writes += 1; },
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

  // 10) 失效判定: 连续 2 次失败才失效, 成功清零并可自动恢复
  {
    const { store } = await makeStore();
    await store.importText(JSON.stringify([{ ...SRC_A, enabled: true }, SRC_B]));
    const a = store.list().find((s) => s.bookSourceName === 'A站');
    const b = store.list().find((s) => s.bookSourceName === 'B站');

    assert.strictEqual(store.searchable().length, 2, '初始应有 2 个可搜源');
    assert.strictEqual(store.deadList().length, 0);

    let out = await store.recordResults([{ id: a.id, ok: false, message: '网络错误: fetch failed' }]);
    assert.deepStrictEqual(out.died, [], '第 1 次失败不应判失效');
    assert.strictEqual(store.get(a.id).failStreak, 1);
    assert.strictEqual(store.get(a.id).deadAt, undefined);
    assert.strictEqual(store.deadList().length, 0);
    assert.strictEqual(store.searchable().length, 2, '单次失败仍参与搜索');

    out = await store.recordResults([{ id: a.id, ok: false, message: 'HTTP 503' }]);
    assert.deepStrictEqual(out.died, [a.id], '连续第 2 次失败应判失效');
    assert.ok(store.get(a.id).deadAt > 0, '应写入失效时间');
    assert.strictEqual(store.get(a.id).deadReason, 'HTTP 503');
    assert.strictEqual(store.deadList().length, 1);
    assert.strictEqual(store.searchable().length, 1, '失效源应退出搜索');

    // 已失效源再次失败: 计数累加、原因更新, 不重复进 died
    out = await store.recordResults([{ id: a.id, ok: false, message: 'HTTP 504' }]);
    assert.deepStrictEqual(out.died, [], '不应重复判定失效');
    assert.strictEqual(store.get(a.id).failStreak, 3, '再次失败应累加次数');
    assert.strictEqual(store.get(a.id).deadReason, 'HTTP 504');

    // 成功清零(未失效的 b)
    await store.recordResults([{ id: b.id, ok: false, message: 'x' }]);
    assert.strictEqual(store.get(b.id).failStreak, 1);
    await store.recordResults([{ id: b.id, ok: true, message: '命中 3 条' }]);
    assert.strictEqual(store.get(b.id).failStreak, 0, '成功应清零失败计数');
    assert.strictEqual(store.get(b.id).deadAt, undefined);

    // 成功自动恢复失效源
    out = await store.recordResults([{ id: a.id, ok: true, message: '命中 1 条' }]);
    assert.deepStrictEqual(out.revived, [a.id], '成功后应自动恢复');
    assert.strictEqual(store.get(a.id).deadAt, undefined);
    assert.strictEqual(store.deadList().length, 0);
  }

  // 11) 批量一次落盘 + 无变化不写盘
  {
    const { store, storage } = await makeStore();
    await store.importText(JSON.stringify([{ ...SRC_A, enabled: true }, SRC_B]));
    const [a, b] = store.list();
    const before = storage.box.writes;
    await store.recordResults([
      { id: a.id, ok: false, message: 'x' },
      { id: b.id, ok: false, message: 'y' },
    ]);
    assert.strictEqual(storage.box.writes, before + 1, '多条结果应只写盘一次');

    // 同样内容再写一次: 时间戳会变, 但 failStreak 已到 2 且已失效 -> 仍会更新 lastCheck
    const pair = [
      { id: a.id, ok: true, message: 'same', at: 111 },
      { id: b.id, ok: true, message: 'same', at: 111 },
    ];
    await store.recordResults(pair);
    const mid = storage.box.writes;
    await store.recordResults(pair);
    assert.strictEqual(storage.box.writes, mid, '内容无变化时不应写盘');
  }

  // 12) searchable / deadList / revive / clearDead / setEnabledMany
  {
    const { store } = await makeStore();
    await store.importText(JSON.stringify([
      { bookSourceName: '甲', bookSourceUrl: 'https://a3.com', enabled: true },
      { bookSourceName: '乙', bookSourceUrl: 'https://b3.com', enabled: false },
      { bookSourceName: '丙', bookSourceUrl: 'https://c3.com', enabled: true },
    ]));
    const byName = (n) => store.list().find((s) => s.bookSourceName === n);
    await store.recordResults([
      { id: byName('丙').id, ok: false, message: 'f1' },
      { id: byName('丙').id, ok: false, message: 'f2' },
    ]);
    assert.deepStrictEqual(store.searchable().map((s) => s.bookSourceName), ['甲'], '停用与失效都不参与搜索');
    assert.deepStrictEqual(store.deadList().map((s) => s.bookSourceName), ['丙']);

    assert.strictEqual(await store.revive(byName('丙').id), true);
    assert.strictEqual(store.deadList().length, 0);
    assert.strictEqual(store.get(byName('丙').id).failStreak, 0);
    assert.strictEqual(store.searchable().length, 2, '恢复后重新参与搜索');

    // 批量启停: 一次写盘
    const cnt = await store.setEnabledMany([
      { id: byName('乙').id, enabled: true },
      { id: byName('甲').id, enabled: false },
      { id: byName('乙').id, enabled: true },
    ]);
    assert.strictEqual(cnt, 2, '只统计实际变化的条目');
    assert.strictEqual(store.get(byName('乙').id).enabled, true);
    assert.strictEqual(store.get(byName('甲').id).enabled, false);

    // 清除失效
    await store.recordResults([
      { id: byName('丙').id, ok: false, message: 'x' },
      { id: byName('丙').id, ok: false, message: 'y' },
    ]);
    assert.strictEqual(store.deadList().length, 1);
    assert.strictEqual(await store.clearDead(), 1);
    assert.strictEqual(store.deadList().length, 0);
    assert.strictEqual(store.size(), 2, '清除只删失效源');
  }

  // 13) upsert 必须保留运行态字段(历史 bug: 只保留 enabled/addedAt)
  {
    const { store } = await makeStore();
    await store.importText(JSON.stringify([SRC_A]));
    const a = store.list()[0];
    await store.recordResults([
      { id: a.id, ok: false, message: 'e1' },
      { id: a.id, ok: false, message: 'e2' },
    ]);
    const dead = store.get(a.id);
    assert.ok(dead.deadAt > 0);

    const next = { ...dead, bookSourceName: '改名后的A站', searchUrl: 'https://a.com/s2?q={{key}}' };
    await store.upsert(next);
    const after = store.get(a.id);
    assert.strictEqual(after.bookSourceName, '改名后的A站', '规则/名称应更新');
    assert.strictEqual(after.lastCheckOk, false, 'upsert 不应丢 lastCheck*');
    assert.strictEqual(after.deadAt, dead.deadAt, 'upsert 不应清掉失效标记');
    assert.strictEqual(after.failStreak, 2);

    // 重新导入同 URL 也应保留失效态
    await store.importText(JSON.stringify([SRC_A]));
    assert.ok(store.get(a.id).deadAt > 0, '导入不应复活失效源');
  }

  // 14) 导出剔除运行态字段
  {
    const { store } = await makeStore();
    await store.importText(JSON.stringify([SRC_A]));
    const a = store.list()[0];
    await store.recordResults([
      { id: a.id, ok: false, message: 'x' },
      { id: a.id, ok: false, message: 'y' },
    ]);
    const exported = JSON.parse(store.exportText())[0];
    for (const k of ['lastCheck', 'lastCheckOk', 'lastCheckMessage', 'failStreak', 'deadAt', 'deadReason']) {
      assert.strictEqual(exported[k], undefined, '导出不应带运行态字段: ' + k);
    }
    assert.ok(exported.bookSourceUrl, '导出仍应包含书源本体');
  }

  // 15) 旧文件兼容: 无新字段时按 0/未失效处理
  {
    const legacy = JSON.stringify({ v: 1, items: [{
      id: 'old1', bookSourceName: '旧源', bookSourceUrl: 'https://old2.com',
      enabled: true, addedAt: 1,
    }] });
    const { store } = await makeStore(legacy);
    const s0 = store.get('old1');
    assert.strictEqual(s0.failStreak, 0, '旧数据 failStreak 应为 0');
    assert.strictEqual(store.deadList().length, 0, '旧数据不应被判失效');
    assert.strictEqual(store.searchable().length, 1);

    // v1.46.2 的「不可用」数据: failStreak=1 在新阈值下不再判死
    const legacyBad = JSON.stringify({ v: 1, items: [{
      id: 'old2', bookSourceName: '旧不可用源', bookSourceUrl: 'https://old3.com',
      enabled: true, addedAt: 1, lastCheck: 1740000000000, lastCheckOk: false,
      lastCheckMessage: 'HTTP 403', failStreak: 1,
    }] });
    const bad = await makeStore(legacyBad);
    const b0 = bad.store.get('old2');
    assert.strictEqual(b0.deadAt, undefined, '只失败 1 次的旧数据不应判死');
    assert.strictEqual(b0.failStreak, 1);
    assert.strictEqual(bad.store.searchable().length, 1);

    // failStreak=2 的旧数据应判死
    const legacyBad2 = JSON.stringify({ v: 1, items: [{
      id: 'old3', bookSourceName: '旧失效源', bookSourceUrl: 'https://old4.com',
      enabled: true, addedAt: 1, lastCheck: 1740000000000, lastCheckOk: false,
      lastCheckMessage: 'HTTP 403', failStreak: 2,
    }] });
    const bad2 = await makeStore(legacyBad2);
    assert.ok(bad2.store.get('old3').deadAt > 0, '连续失败 2 次的旧数据应补 deadAt');
    assert.strictEqual(bad2.store.deadList().length, 1);

    // 已标 dead 但 failStreak=1 的旧数据应一次性恢复
    const legacyDead = JSON.stringify({ v: 1, items: [{
      id: 'old4', bookSourceName: '旧单次失效', bookSourceUrl: 'https://old5.com',
      enabled: true, addedAt: 1, lastCheck: 1740000000000, lastCheckOk: false,
      failStreak: 1, deadAt: 1740000000000, deadReason: '网络错误',
    }] });
    const revived = await makeStore(legacyDead);
    assert.strictEqual(revived.store.get('old4').deadAt, undefined, 'failStreak=1 的旧 dead 应自动恢复');
    assert.strictEqual(revived.store.get('old4').failStreak, 0);
  }

  // 10b) reviveMany: 批量/全部/幂等
  {
    const { store } = await makeStore();
    const mk = (id, dead) => ({
      id, bookSourceName: id, bookSourceUrl: 'https://' + id + '.com', enabled: true,
      failStreak: dead ? 2 : 0, ...(dead ? { deadAt: Date.now(), deadReason: 'x' } : {}),
    });
    await store.importText(JSON.stringify([mk('r1', true), mk('r2', true), mk('r3', true), mk('r4', false)]));
    const ids = store.deadList().map((s) => s.id);
    assert.strictEqual(await store.reviveMany([ids[0], ids[1]]), 2, '应恢复所选 2 个');
    assert.strictEqual(store.deadList().length, 1, '剩余 1 个失效');
    assert.strictEqual(await store.reviveMany(), 1, '全部恢复应返回 1');
    assert.strictEqual(store.deadList().length, 0);
    assert.strictEqual(await store.reviveMany(), 0, '重复恢复应为 0');
  }

  console.log('书源存储测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

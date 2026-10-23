/**
 * test-source-search.js — 搜索链路测试(URL 构建 / 结果映射 / 多源聚合)
 *
 * 用桩掉的全局 fetch 提供 HTML 与 JSON 两种响应, 覆盖:
 *  - {{key}} 插值 / 无占位符追加 ?key= / `URL, {json}` 选项
 *  - HTML 列表逐项提取(相对地址转绝对)
 *  - JSON API 列表(data.books + 相对键)
 *  - 未配置 searchUrl / XPath 规则 -> unsupported
 *  - 多源并发去重 + 相关性排序 + 单源失败/超时不影响其它
 */
'use strict';
const assert = require('assert');
const { BookSourceStore } = require('../dist/bookSource');
const { buildSearchRequest, splitUrlOptions } = require('../dist/online/searchUrl');
const { parseSearchPage, relevanceScore, resultKey } = require('../dist/online/ruleApply');
const { SearchService } = require('../dist/online/searchService');
const fx = require('./fixtures-source');

/** 内存存储适配器(书源存文件) */
function memoryStore() {
  const box = { text: null };
  return { box, read: async () => box.text, write: async (t) => { box.text = t; } };
}

async function makeStore() {
  const store = new BookSourceStore(memoryStore());
  await store.load();
  return store;
}

function makeResponse(status, body, contentType) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return {
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') { return contentType || 'text/html; charset=utf-8'; }
        return null;
      },
      getSetCookie() { return []; },
    },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
}

const HTML_SOURCE = {
  bookSourceName: 'HTML站',
  bookSourceUrl: 'https://www.example.com',
  searchUrl: 'https://www.example.com/search?q={{key}}',
  ruleSearch: {
    bookList: '.book-item',
    name: 'h3.book-name a@text',
    author: '.author span@text',
    bookUrl: 'h3.book-name a@href',
    intro: '.intro@text',
    kind: '.kind@text',
    lastChapter: '.last@text##最新章节：##',
  },
};

const JSON_SOURCE = {
  bookSourceName: 'JSON站',
  bookSourceUrl: 'https://api.example.com',
  searchUrl: 'https://api.example.com/search, {"method":"POST","body":"kw={{key}}"}',
  ruleSearch: {
    bookList: 'data.books',
    name: 'original_title',
    author: 'original_author',
    bookUrl: '@js: "https://api.example.com/book/" + book_id',
    coverUrl: 'image_link',
    intro: 'intro',
    wordCount: 'words_num',
  },
};

const realFetch = globalThis.fetch;

(async () => {
  // 1) URL 构建: 插值 + 编码
  {
    const req = await buildSearchRequest(HTML_SOURCE, '遮 天', 1);
    assert.strictEqual(req.url, 'https://www.example.com/search?q=遮 天', '插值后交给 fetch, 编码由 fetch 负责');
    assert.strictEqual(req.method, 'GET');
  }

  // 2) 无占位符 -> 追加 ?key=
  {
    const req = await buildSearchRequest({ ...HTML_SOURCE, searchUrl: 'https://x.com/s' }, '遮天', 1);
    assert.strictEqual(req.url, 'https://x.com/s?key=' + encodeURIComponent('遮天'));
  }

  // 3) `URL, {json}` 选项 -> POST + body
  {
    const req = await buildSearchRequest(JSON_SOURCE, '遮天', 1);
    assert.strictEqual(req.url, 'https://api.example.com/search');
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.body, 'kw=遮天');
    const split = splitUrlOptions('https://a.com/x, {"method":"GET"}');
    assert.strictEqual(split.url, 'https://a.com/x');
    assert.strictEqual(split.options.method, 'GET');
  }

  // 3b) 相对地址按 bookSourceUrl 补全
  {
    const req = await buildSearchRequest({
      ...HTML_SOURCE,
      searchUrl: '/search/?keyword={{key}}',
    }, '斗', 1);
    // 相对地址经 URL 解析, 中文关键词会被百分号编码
    assert.strictEqual(req.url, 'https://www.example.com/search/?keyword=' + encodeURIComponent('斗'));
  }

  // 3c) `<js>` 标签缺闭合也能跑
  {
    const req = await buildSearchRequest({
      ...HTML_SOURCE,
      searchUrl: '<js>\nvar base = "https://www.example.com/s?q=";\nbase + key\n',
    }, '斗', 1);
    assert.strictEqual(req.url, 'https://www.example.com/s?q=斗');
  }

  // 3d) `[[js表达式]]` 内联求值
  {
    const req = await buildSearchRequest({
      ...HTML_SOURCE,
      searchUrl: '/s/?k=[[java.md5Encode(key)]]&q={{key}}',
    }, '斗', 1);
    assert.ok(req.url.indexOf('/s/?k=') >= 0, '应保留内联脚本生成的参数, 实际: ' + req.url);
    assert.ok(req.url.indexOf(require('crypto').createHash('md5').update('斗').digest('hex')) >= 0,
      '内联表达式应被求值, 实际: ' + req.url);
  }

  // 4) 未配置 searchUrl -> unsupported
  {
    await assert.rejects(
      () => buildSearchRequest({ ...HTML_SOURCE, searchUrl: '' }, 'x', 1),
      (e) => e.name === 'UnsupportedRuleError');
  }

  // 5) HTML 结果映射(相对/协议相对地址)
  {
    const items = await parseSearchPage(HTML_SOURCE, fx.SEARCH_HTML, 'https://www.example.com/search?q=遮天');
    assert.strictEqual(items.length, 3, '应解析出 3 本, 实际 ' + items.length);
    assert.strictEqual(items[0].title, '遮天');
    assert.strictEqual(items[0].author, '辰东');
    assert.strictEqual(items[0].bookUrl, 'https://www.example.com/book/1024/');
    assert.strictEqual(items[1].bookUrl, 'https://m.example.com/book/2048/', '协议相对地址应补全');
    assert.strictEqual(items[0].kind, '玄幻 仙侠', 'nbsp 应折叠为普通空格');
    assert.strictEqual(items[0].lastChapter, '第1888章 完美世界', '## 后处理应生效');
    assert.strictEqual(items[2].author, '', '缺失作者应为空串');
  }

  // 6) JSON 结果映射(@js bookUrl + 数值字段)
  {
    const items = await parseSearchPage(JSON_SOURCE, JSON.stringify(fx.SEARCH_JSON), 'https://api.example.com/search');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].title, '遮天');
    assert.strictEqual(items[0].bookUrl, 'https://api.example.com/book/1024');
    assert.strictEqual(items[0].wordCount, 6350000);
    assert.strictEqual(items[1].coverUrl, undefined, '空封面不应变成空串字段');
  }

  // 7) 缺少 bookList -> unsupported
  {
    await assert.rejects(
      () => parseSearchPage({ ...HTML_SOURCE, ruleSearch: {} }, fx.SEARCH_HTML, 'https://www.example.com'),
      (e) => e.name === 'UnsupportedRuleError');
  }

  // 8) 相关性排序: 完全匹配 > 前缀 > 包含
  {
    assert.strictEqual(relevanceScore('遮天', '遮天'), 0);
    assert.strictEqual(relevanceScore('遮天外传', '遮天'), 1);
    assert.strictEqual(relevanceScore('新遮天', '遮天'), 2);
    assert.strictEqual(relevanceScore('完美世界', '遮天'), 3);
    assert.strictEqual(resultKey({ title: '遮 天', author: '辰 东' }), resultKey({ title: '遮天', author: '辰东' }));
  }

  // 9) 多源聚合: 去重 + 排序 + 错误聚合
  {
    const store = await makeStore();
    await store.importText(JSON.stringify([
      HTML_SOURCE,
      JSON_SOURCE,
      { bookSourceName: '坏源', bookSourceUrl: 'https://bad.example.com', searchUrl: '//div[@class="x"]', ruleSearch: { bookList: '.x' } },
      { bookSourceName: '空源', bookSourceUrl: 'https://empty.example.com', searchUrl: '', ruleSearch: { bookList: '.x' } },
    ]));

    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      const u = String(url);
      if (u.indexOf('www.example.com/search') >= 0) { return makeResponse(200, fx.SEARCH_HTML); }
      if (u.indexOf('api.example.com/search') >= 0) { return makeResponse(200, JSON.stringify(fx.SEARCH_JSON), 'application/json'); }
      return makeResponse(404, 'not found');
    };

    const service = new SearchService(store);
    const out = await service.search('遮天');
    assert.strictEqual(out.sourceCount, 4, '应尝试全部 4 个启用书源');
    // 两份响应里同名同作者的书只留一条
    const titles = out.items.map((i) => i.title + '/' + i.author);
    assert.deepStrictEqual(titles, ['遮天/辰东', '完美世界/辰东', '无作者的书/'], '应按相关性排序并去重, 实际 ' + JSON.stringify(titles));
    assert.strictEqual(out.errors.length, 2, '坏源 + 空源应各产生一条错误, 实际 ' + out.errors.length);
    assert.ok(out.errors.some((e) => e.kind === 'unsupported'));
    assert.ok(calls.some((c) => c.method === 'POST' && c.body === 'kw=遮天'), 'JSON 源应走 POST');
  }

  // 10) 超时不拖垮整轮
  {
    const store = await makeStore();
    await store.importText(JSON.stringify([HTML_SOURCE, { ...JSON_SOURCE, bookSourceUrl: 'https://slow.example.com', searchUrl: 'https://slow.example.com/s?q={{key}}' }]));
    globalThis.fetch = async (url) => {
      if (String(url).indexOf('slow.example.com') >= 0) {
        return new Promise(() => { /* 永不返回, 由超时中断 */ });
      }
      return makeResponse(200, fx.SEARCH_HTML);
    };
    const service = new SearchService(store);
    const out = await service.search('遮天', { perSourceTimeoutMs: 80 });
    assert.strictEqual(out.items.length, 3, '健康源仍应返回结果');
    assert.ok(out.errors.some((e) => e.kind === 'timeout'), '超时源应记录 timeout');
  }

  // 11) 空关键词 -> 不发请求
  {
    const store = await makeStore();
    await store.importText(JSON.stringify([HTML_SOURCE]));
    globalThis.fetch = async () => { throw new Error('不应发请求'); };
    const out = await new SearchService(store).search('   ');
    assert.strictEqual(out.items.length, 0);
    assert.strictEqual(out.sourceCount, 0);
  }

  globalThis.fetch = realFetch;
  // 12) 一次搜索失败即判失效 -> 第二次不再参与搜索
  {
    const store = await makeStore();
    const BAD = {
      bookSourceName: '坏源', bookSourceUrl: 'https://bad.example.com',
      searchUrl: 'https://bad.example.com/s?q={{key}}',
      ruleSearch: { bookList: '.item', name: '.name@text', bookUrl: 'a@href' },
    };
    await store.importText(JSON.stringify([HTML_SOURCE, BAD]));
    const badId = store.list().find((s) => s.bookSourceName === '坏源').id;

    globalThis.fetch = async (url) => {
      if (String(url).indexOf('bad.example.com') >= 0) { return makeResponse(404, 'not found'); }
      return makeResponse(200, fx.SEARCH_HTML);
    };
    const service = new SearchService(store);

    let out = await service.search('遮天');
    assert.strictEqual(out.sourceCount, 2);
    assert.strictEqual(store.get(badId).failStreak, 1, '失败一次');
    assert.strictEqual(store.deadList().length, 1, '一次失败就应移入失效');
    assert.deepStrictEqual(out.deadAdded, [badId], '回包应告知新失效的源');

    out = await service.search('遮天');
    assert.strictEqual(out.sourceCount, 1, '失效源第二次不再参与');
    assert.strictEqual(out.errors.length, 0, '不再为失效源报错');
    assert.strictEqual(store.get(badId).failStreak, 1, '未参与搜索时不应累加');

    // 健康源不受影响
    const okId = store.list().find((s) => s.bookSourceName === 'HTML站').id;
    assert.strictEqual(store.get(okId).failStreak, 0, '健康源失败计数应保持 0');
  }

  // 13) 已取消(signal 预 abort)的搜索不写回任何检查结果
  {
    const store = await makeStore();
    await store.importText(JSON.stringify([HTML_SOURCE]));
    const id = store.list()[0].id;
    globalThis.fetch = async () => { throw new Error('不应发请求'); };
    const controller = new AbortController();
    controller.abort();
    const out = await new SearchService(store).search('遮天', { signal: controller.signal });
    assert.strictEqual(out.sourceCount, 1, '源仍计入本次范围');
    assert.strictEqual(store.get(id).lastCheck, undefined, '取消的搜索不应写回检查结果');
    assert.strictEqual(store.get(id).failStreak, 0);
  }

  // 14) 显式指定 ids 时, 失效/停用源被过滤
  {
    const store = await makeStore();
    await store.importText(JSON.stringify([HTML_SOURCE, JSON_SOURCE, {
      bookSourceName: '停用源', bookSourceUrl: 'https://off.example.com',
      enabled: false, searchUrl: 'https://off.example.com/s?q={{key}}',
      ruleSearch: { bookList: '.x' },
    }]));
    const htmlId = store.list().find((s) => s.bookSourceName === 'HTML站').id;
    const jsonId = store.list().find((s) => s.bookSourceName === 'JSON站').id;
    const offId = store.list().find((s) => s.bookSourceName === '停用源').id;

    // 让 JSON 源连续失败 2 次判失效
    await store.recordResults([
      { id: jsonId, ok: false, message: 'x' },
      { id: jsonId, ok: false, message: 'y' },
    ]);
    assert.strictEqual(store.deadList().length, 1);

    globalThis.fetch = async () => makeResponse(200, fx.SEARCH_HTML);
    const out = await new SearchService(store).search('遮天', { sourceIds: [htmlId, jsonId, offId] });
    assert.strictEqual(out.sourceCount, 1, '失效/停用源不应参与');
  }

  // 15) 搜索结果回写: 健康源记录命中信息, 且只写一次盘
  {
    let file = null;
    let writes = 0;
    const store = new BookSourceStore({
      read: async () => file,
      write: async (t) => { file = t; writes += 1; },
    });
    await store.load();
    await store.importText(JSON.stringify([HTML_SOURCE]));
    const before = writes;
    globalThis.fetch = async () => makeResponse(200, fx.SEARCH_HTML);
    const out = await new SearchService(store).search('遮天');
    assert.strictEqual(out.recorded, 1);
    assert.strictEqual(writes, before + 1, '一轮搜索应只写盘一次');
    const item = store.list()[0];
    assert.strictEqual(item.lastCheckOk, true);
    assert.strictEqual(item.lastCheckMessage, '命中 3 条');
  }

  // 16) legado 语法书源: class./tag./@链 的 bookList 与字段规则
  {
    const LEGADO = {
      bookSourceName: 'legado语法站',
      bookSourceUrl: 'https://www.example.com',
      searchUrl: 'https://www.example.com/search?q={{key}}',
      ruleSearch: {
        bookList: 'class.result-list@class.book-item',
        name: 'class.book-name@tag.a@text',
        author: 'class.author@tag.span@text',
        bookUrl: 'class.book-name@tag.a@href',
        kind: 'class.kind@text##\\[|\\]',
      },
    };
    const items = await parseSearchPage(LEGADO, fx.SEARCH_HTML, 'https://www.example.com/search?q=遮天');
    assert.strictEqual(items.length, 3, 'legado 选择器应能取到 3 本, 实际 ' + items.length);
    assert.strictEqual(items[0].title, '遮天');
    assert.strictEqual(items[0].author, '辰东');
    assert.strictEqual(items[0].bookUrl, 'https://www.example.com/book/1024/');
  }

  // 17) header 里的 {{baseUrl}} 插值
  {
    const { interpolateHeader } = require('../dist/online/sourceHttp');
    const out = interpolateHeader({ Referer: '{{baseUrl}}', 'User-Agent': 'x' }, 'https://a.com');
    assert.strictEqual(out.Referer, 'https://a.com');
    assert.strictEqual(out['User-Agent'], 'x');
  }

  console.log('书源搜索测试全部通过 ✔');
})().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});

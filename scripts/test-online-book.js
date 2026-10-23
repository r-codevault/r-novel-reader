/**
 * test-online-book.js — 在线书目录/正文解析 + 缓存
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./fixtures-source');
const { fetchToc, fetchChapter, contentToParagraphs } = require('../dist/online/onlineBook');
const { OnlineCache } = require('../dist/onlineCache');
const { onlineKey } = require('../dist/onlinePath');
const { SourceHttpPool } = require('../dist/online/sourceHttp');

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

const BASE = 'https://www.example.com';
const CHAPTER_URL = BASE + '/book/1024/1.html';

const source = {
  id: 's1',
  bookSourceName: '测试站',
  bookSourceUrl: BASE,
  searchUrl: BASE + '/search?q={{key}}',
  ruleBookInfo: { tocUrl: '{{baseUrl}}/book/1024/' },
  ruleToc: { chapterList: '.listmain dd a', chapterName: 'text', chapterUrl: '@href' },
  ruleContent: { content: '#content@text' },
};

(async () => {
  const pool = new SourceHttpPool();
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests += 1;
    const u = String(url);
    if (u.indexOf('/book/1024/1.html') >= 0) { return makeResponse(200, fx.CONTENT_HTML); }
    if (u.indexOf('/book/1024/') >= 0) { return makeResponse(200, fx.TOC_HTML); }
    return makeResponse(404, 'not found');
  };

  // 1) 目录: 相对链接补全 + 顺序
  const toc = await fetchToc(source, BASE + '/book/1024/', { pool });
  assert.strictEqual(toc.chapters.length, 3, '应解析出 3 章');
  assert.deepStrictEqual(toc.chapters.map((c) => c.title), ['第1章 星空中的青铜巨棺', '第2章 素问', '第3章 今古']);
  assert.strictEqual(toc.chapters[0].url, CHAPTER_URL, '相对地址应补全');
  assert.strictEqual(toc.tocUrl, BASE + '/book/1024/', '应记录目录地址');

  // 2) 正文: 段落拆分(保留正文行)
  const ch = await fetchChapter(source, CHAPTER_URL, { pool });
  assert.ok(ch.paragraphs.length >= 3, '正文应拆成多段, 实际 ' + ch.paragraphs.length);
  assert.ok(ch.paragraphs.some((p) => p.indexOf('这是一个很长的故事') >= 0), '正文内容应保留');
  assert.ok(ch.paragraphs.some((p) => p.indexOf('握住了那颗星') >= 0), '末尾段落应保留');

  // 3) HTML 正文清洗: 标签去掉, br 变换行
  const paras = contentToParagraphs(fx.CONTENT_HTML.split('<div id="content">')[1].split('</div>')[0]);
  assert.ok(paras.some((p) => p.indexOf('那里有一颗星在闪烁') >= 0), 'br 应转为换行后的文本');
  assert.ok(paras.every((p) => p.indexOf('<p>') < 0 && p.indexOf('<div') < 0), '不应残留标签');

  // 4) nextTocUrl 翻页 + 去重
  const paged = {
    id: 's2',
    bookSourceName: '分页站',
    bookSourceUrl: BASE,
    ruleBookInfo: { tocUrl: BASE + '/toc/1' },
    ruleToc: { chapterList: '.list a', chapterName: 'text', chapterUrl: '@href', nextTocUrl: '.next@href' },
    ruleContent: { content: '#content@text' },
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/toc/1')) {
      return makeResponse(200, '<div class="list"><a href="/c/1">第1章</a><a href="/c/2">第2章</a></div><a class="next" href="/toc/2">下一页</a>');
    }
    if (u.endsWith('/toc/2')) {
      return makeResponse(200, '<div class="list"><a href="/c/2">第2章</a><a href="/c/3">第3章</a></div>');
    }
    return makeResponse(404, 'nope');
  };
  const toc2 = await fetchToc(paged, BASE + '/book/2', { pool: new SourceHttpPool() });
  assert.strictEqual(toc2.chapters.length, 3, '翻页应合并并去重, 实际 ' + toc2.chapters.length);
  assert.deepStrictEqual(toc2.chapters.map((c) => c.url), [BASE + '/c/1', BASE + '/c/2', BASE + '/c/3']);

  // 4b) 目录列表: || 兜底 / !0 排除 / 切片
  {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/book/1024/') >= 0) { return makeResponse(200, fx.TOC_HTML); }
      return makeResponse(404, 'not found');
    };
    const withRule = (rule) => ({ ...source, ruleToc: { ...source.ruleToc, chapterList: rule } });
    const a = await fetchToc(withRule('.nope||.listmain dd a'), BASE + '/book/1024/', { pool: new SourceHttpPool() });
    assert.strictEqual(a.chapters.length, 3, '|| 兜底应命中 3 章');
    const b = await fetchToc(withRule('.listmain dd a!0'), BASE + '/book/1024/', { pool: new SourceHttpPool() });
    assert.strictEqual(b.chapters.length, 2, '!0 应排除第 1 条');
    const c = await fetchToc(withRule('.listmain dd a[0:2]'), BASE + '/book/1024/', { pool: new SourceHttpPool() });
    assert.strictEqual(c.chapters.length, 2, '[0:2] 应取前 2 条');
  }

  // 4c) 空目录错误: 带源名/目录页/规则/命中数, 且 URL 脱敏
  {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/book/1024/') >= 0) { return makeResponse(200, fx.TOC_HTML); }
      return makeResponse(404, 'not found');
    };
    const base = { ...source };
    const noMatch = { ...base, ruleToc: { ...base.ruleToc, chapterList: '.nope' } };
    await assert.rejects(
      fetchToc(noMatch, BASE + '/book/1024/', { pool: new SourceHttpPool() }),
      (err) => /目录解析结果为空/.test(err.message)
        && /测试站/.test(err.message)
        && /\/book\/1024\//.test(err.message)
        && /\.nope/.test(err.message)
        && /未匹配到节点/.test(err.message)
    );

    const noRule = { ...base, ruleToc: { chapterName: 'text' } };
    await assert.rejects(
      fetchToc(noRule, BASE + '/book/1024/', { pool: new SourceHttpPool() }),
      (err) => /未配置 ruleToc\.chapterList/.test(err.message)
    );

    const badUrlRule = {
      ...base,
      ruleBookInfo: { tocUrl: '{{baseUrl}}/book/1024/?token=secret#x' },
      ruleToc: { ...base.ruleToc, chapterUrl: '@data-x' },
    };
    await assert.rejects(
      fetchToc(badUrlRule, BASE + '/book/1024/', { pool: new SourceHttpPool() }),
      (err) => /匹配 3 个节点但/.test(err.message) && !/secret/.test(err.message)
    );
  }

  // 5) 缓存读写/清理
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r-online-cache-'));
  const cache = new OnlineCache(tmp);
  const key = onlineKey('s1', BASE + '/book/1024/');
  await cache.writeToc(key, { v: 1, fetchedAt: Date.now(), tocUrl: BASE + '/book/1024/', chapters: toc.chapters });
  const cachedToc = await cache.readToc(key);
  assert.ok(cachedToc && cachedToc.chapters.length === 3, '目录缓存应可读');
  await cache.writeChapter(key, 0, ['第一段', '第二段']);
  assert.deepStrictEqual(await cache.readChapter(key, 0), ['第一段', '第二段']);
  await cache.clear(key);
  assert.strictEqual(await cache.readToc(key), null, '清理后目录缓存应消失');
  assert.strictEqual(await cache.readChapter(key, 0), null, '清理后正文缓存应消失');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('在线书目录/正文/缓存测试全部通过 ✔ (请求 ' + requests + ' 次)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

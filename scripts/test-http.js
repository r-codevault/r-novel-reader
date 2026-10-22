/**
 * test-http.js — HTTP 客户端单测(桩掉全局 fetch)
 *
 * 覆盖: 重定向 + cookie 透传 / GBK 解码 / 错误分类 / 体积上限 / 超时 / 取消
 */
'use strict';
const assert = require('assert');
const { HttpClient, CookieJar, HttpError } = require('../dist/http');

const realFetch = globalThis.fetch;

function makeResponse(opts) {
  const status = opts.status || 200;
  const headers = opts.headers || {};
  const buf = opts.body || Buffer.alloc(0);
  return {
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'set-cookie' && Array.isArray(headers['set-cookie'])) { return headers['set-cookie'][0]; }
        const v = headers[key];
        return v === undefined ? null : v;
      },
      getSetCookie() {
        return Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [];
      },
    },
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

(async () => {
  // 1) 手工重定向: 保留 Set-Cookie 并在下一跳带上; 相对 Location 正确解析
  {
    const seen = [];
    let hop = 0;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, cookie: init.headers['Cookie'] || '' });
      hop++;
      if (hop === 1) {
        return makeResponse({
          status: 302,
          headers: { location: '/next', 'set-cookie': ['sid=abc; Path=/; HttpOnly'] },
        });
      }
      return makeResponse({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<p>ok</p>') });
    };
    const client = new HttpClient(new CookieJar());
    const res = await client.request('https://a.com/search?q=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, '<p>ok</p>');
    assert.strictEqual(seen.length, 2, '应跟随一次重定向');
    assert.strictEqual(seen[1].url, 'https://a.com/next', 'Location 应解析为绝对地址');
    assert.ok(seen[1].cookie.indexOf('sid=abc') >= 0, '第二跳应带上 cookie, 实际: ' + seen[1].cookie);
  }

  // 2) GBK 解码(书源声明 charset)
  {
    globalThis.fetch = async () => makeResponse({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), // "中文" 的 GBK 字节
    });
    const client = new HttpClient();
    const res = await client.request('https://a.com/x', { charset: 'gbk' });
    assert.strictEqual(res.text, '中文');
  }

  // 3) meta charset 嗅探
  {
    globalThis.fetch = async () => makeResponse({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.concat([
        Buffer.from('<html><head><meta charset="gb2312"></head><body>'),
        Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
        Buffer.from('</body></html>'),
      ]),
    });
    const client = new HttpClient();
    const res = await client.request('https://a.com/x');
    assert.ok(res.text.indexOf('中文') >= 0, 'meta charset 应生效, 实际: ' + res.text);
  }

  // 4) HTTP 错误状态
  {
    globalThis.fetch = async () => makeResponse({ status: 404, headers: {}, body: Buffer.from('nope') });
    const client = new HttpClient();
    await assert.rejects(
      () => client.request('https://a.com/x'),
      (e) => e instanceof HttpError && e.kind === 'http' && e.status === 404);
  }

  // 5) 体积上限
  {
    globalThis.fetch = async () => makeResponse({
      status: 200,
      headers: { 'content-length': '99999999' },
      body: Buffer.alloc(10),
    });
    const client = new HttpClient();
    await assert.rejects(
      () => client.request('https://a.com/big'),
      (e) => e instanceof HttpError && e.kind === 'tooLarge');
  }

  // 6) 非法地址
  {
    const client = new HttpClient();
    await assert.rejects(
      () => client.request('ftp://a.com/x'),
      (e) => e instanceof HttpError && e.kind === 'badUrl');
  }

  // 7) 超时
  {
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const client = new HttpClient();
    await assert.rejects(
      () => client.request('https://a.com/slow', { timeoutMs: 60 }),
      (e) => e instanceof HttpError && e.kind === 'timeout');
  }

  // 8) 外部取消
  {
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const client = new HttpClient();
    await assert.rejects(
      () => client.request('https://a.com/slow', { timeoutMs: 5000, signal: controller.signal }),
      (e) => e instanceof HttpError && e.kind === 'abort');
  }

  // 9) CookieJar 基础行为
  {
    const jar = new CookieJar();
    jar.addFromSetCookie('a.com', ['x=1; Path=/', 'y=2; Path=/']);
    assert.strictEqual(jar.headerFor('a.com'), 'x=1; y=2');
    jar.addFromSetCookie('a.com', ['x=3; Path=/']);
    assert.strictEqual(jar.headerFor('a.com'), 'x=3; y=2', '同名 cookie 应覆盖');
    assert.strictEqual(jar.headerFor('b.com'), '');
  }

  globalThis.fetch = realFetch;
  console.log('HTTP 客户端测试全部通过 ✔');
})().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});

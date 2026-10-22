/**
 * test-js-sandbox.js — @js 沙箱单测
 *
 * 覆盖: 变量绑定 / 常用 java.* polyfill / ajax 占位重放 / 未支持 API 报错 / 超时
 */
'use strict';
const assert = require('assert');
const { runJsScript, JsSandboxError } = require('../dist/rules/jsSandbox');

(async () => {
  // 1) 变量绑定
  {
    const v = await runJsScript('key + "|" + page + "|" + baseUrl', { baseUrl: 'https://a.com', key: '遮天', page: 2 });
    assert.strictEqual(v, '遮天|2|https://a.com');
  }

  // 2) md5 / base64 / hmac
  {
    const v = await runJsScript('java.md5Encode("abc")', { baseUrl: '' });
    assert.strictEqual(v, '900150983cd24fb0d6963f7d28e17f72');
    const b = await runJsScript('java.base64Encode("中文")', { baseUrl: '' });
    assert.strictEqual(b, Buffer.from('中文', 'utf8').toString('base64'));
    const h = await runJsScript('java.HMacHex("HmacSHA1", "data", "key")', { baseUrl: '' });
    assert.strictEqual(h, require('crypto').createHmac('sha1', 'key').update('data').digest('hex'));
  }

  // 3) put/get 变量表
  {
    const v = await runJsScript('java.put("t","v1"); java.get("t")', { baseUrl: '' });
    assert.strictEqual(v, 'v1');
  }

  // 4) 多语句取最后表达式
  {
    const v = await runJsScript('var a = 1; var b = 2; a + b', { baseUrl: '' });
    assert.strictEqual(v, '3');
  }

  // 5) return 语句(自动包 IIFE)
  {
    const v = await runJsScript('if (key) { return "有key"; } return "无key";', { baseUrl: '', key: 'x' });
    assert.strictEqual(v, '有key');
  }

  // 6) java.ajax 占位重放: 第一遍拿空串, 拉取后重跑
  {
    const requested = [];
    const v = await runJsScript('var t = java.ajax(baseUrl + "/token"); "x-" + t', {
      baseUrl: 'https://a.com',
      http: {
        ajax: async (url) => { requested.push(url); return 'T1'; },
      },
    });
    assert.deepStrictEqual(requested, ['https://a.com/token']);
    assert.strictEqual(v, 'x-T1');
  }

  // 7) 多轮依赖: 先取 token, 再用 token 请求正文(重放两轮收敛)
  {
    let round = 0;
    const v = await runJsScript(
      'var t = java.ajax(baseUrl + "/token"); var s = java.ajax(baseUrl + "/x?t=" + t); s',
      {
        baseUrl: 'https://a.com',
        http: {
          ajax: async (url) => {
            round++;
            if (url.indexOf('/token') >= 0) { return 'TK'; }
            if (url.indexOf('/x?t=') >= 0) { return 'body:' + url.split('t=')[1]; }
            return '';
          },
        },
      });
    assert.strictEqual(v, 'body:TK', '最终应拿到 token 拼接后的结果, 实际 ' + JSON.stringify(v));
    // 第一轮: token + 空 token 的正文(占位), 第二轮: 真 token 的正文; 第三轮全命中缓存
    assert.strictEqual(round, 3, '应为 token + 占位正文 + 真正文 三次请求, 实际 ' + round);
  }

  // 8) 未支持 API 明确报错
  {
    await assert.rejects(
      () => runJsScript('java.startBrowser("https://a.com")', { baseUrl: '' }),
      (e) => e instanceof JsSandboxError && /暂不支持/.test(e.message));
  }

  // 9) 脚本异常包装
  {
    await assert.rejects(
      () => runJsScript('throw new Error("boom")', { baseUrl: '' }),
      (e) => e instanceof JsSandboxError && /boom/.test(e.message));
  }

  // 10) 死循环超时
  {
    await assert.rejects(
      () => runJsScript('while(true){}', { baseUrl: '', timeoutMs: 120 }),
      (e) => e instanceof JsSandboxError && /timed out|超时/i.test(e.message));
  }

  // 11) 无 require/process(越权防护的最基本一层)
  {
    await assert.rejects(() => runJsScript('require("fs")', { baseUrl: '' }), JsSandboxError);
    await assert.rejects(() => runJsScript('process.exit(1)', { baseUrl: '' }), JsSandboxError);
  }

  console.log('JS 沙箱测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

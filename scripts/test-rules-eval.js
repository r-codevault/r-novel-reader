/**
 * test-rules-eval.js — 规则求值器单测(CSS / JSON / 前缀 / 提取后缀 / 正则 / 兜底 / 模板)
 */
'use strict';
const assert = require('assert');
const { evalRule, evalRuleOne, interpolate, splitFallback } = require('../dist/rules/evalRule');
const { SEARCH_HTML, SEARCH_JSON, BASE_URL } = require('./fixtures-source');

const html = { html: SEARCH_HTML, baseUrl: BASE_URL };
const json = { json: SEARCH_JSON, baseUrl: BASE_URL };

(async () => {
  // 1) CSS + @text: 书名
  {
    const names = await evalRule('h3.book-name a@text', html);
    assert.deepStrictEqual(names, ['遮天', '完美世界', '无作者的书']);
  }

  // 2) @href 转绝对地址(含协议相对)
  {
    const hrefs = await evalRule('h3.book-name a@href', html);
    assert.deepStrictEqual(hrefs.slice(0, 2), [
      'https://www.example.com/book/1024/',
      'https://m.example.com/book/2048/',
    ]);
  }

  // 3) 取第一个 + 属性
  {
    assert.strictEqual(await evalRuleOne('.author span@text', html), '辰东');
    assert.strictEqual(await evalRuleOne('a[title]@attr=title', html), '遮天');
  }

  // 4) @html 保留标签
  {
    const inner = await evalRuleOne('#content p:eq(1)@html', { html: require('./fixtures-source').CONTENT_HTML, baseUrl: BASE_URL });
    assert.ok(/<br>/.test(inner), '应保留 br 标签, 实际: ' + inner);
  }

  // 5) `||` 兜底: 前一条无结果
  {
    const v = await evalRuleOne('.not-exist@text || h3.book-name a@text', html);
    assert.strictEqual(v, '遮天');
  }

  // 6) ## 正则替换
  {
    const v = await evalRuleOne('.last@text##最新章节：##', html);
    assert.strictEqual(v, '第1888章 完美世界');
  }

  // 7) ## 替换带捕获组
  {
    const v = await evalRuleOne('.last@text##最新章节：(第\\d+章).*##$1', html);
    assert.strictEqual(v, '第1888章');
  }

  // 8) 显式 @json: 前缀
  {
    const names = await evalRule('@json:$.data.books[*].original_title', json);
    assert.deepStrictEqual(names, ['遮天', '完美世界']);
  }

  // 9) 无前缀 + 纯 JSON 上下文按路径解析
  {
    assert.strictEqual(await evalRuleOne('data.books[0].original_author', json), '辰东');
  }

  // 10) @css: 前缀(JSON 内容里想用 CSS 时)
  {
    assert.strictEqual(await evalRuleOne('@css:h3.book-name a@text', html), '遮天');
  }

  // 11) {{}} 插值: key / page / JSON 路径
  {
    assert.strictEqual(interpolate('https://x.com/s?q={{key}}&p={{page}}', { baseUrl: BASE_URL, key: '遮 天', page: 2 }),
      'https://x.com/s?q=遮 天&p=2');
    assert.strictEqual(interpolate('{{$.data.books[0].original_title}}', json), '遮天');
  }

  // 12) splitFallback 尊重括号/引号
  {
    assert.deepStrictEqual(splitFallback('a||b'), ['a', 'b']);
    assert.deepStrictEqual(splitFallback('div[data-x="a||b"]||p'), ['div[data-x="a||b"]', 'p']);
  }

  // 13) 空规则 / 无结果 -> 空数组
  {
    assert.deepStrictEqual(await evalRule('', html), []);
    assert.deepStrictEqual(await evalRule('.not-exist@text', html), []);
  }

  // 14) XPath 明确不支持
  {
    const { UnsupportedRuleError } = require('../dist/rules/evalRule');
    await assert.rejects(() => evalRule('//div[@id="main"]', html), (e) => e instanceof UnsupportedRuleError);
  }

  // 15) @js: 简单表达式(无网络)
  {
    const v = await evalRuleOne('@js: "https://x.com/search?q=" + encodeURI(key)', { baseUrl: BASE_URL, key: '遮天' });
    assert.strictEqual(v, 'https://x.com/search?q=%E9%81%AE%E5%A4%A9');
  }

  // 16) @js: 多语句取最后表达式
  {
    const v = await evalRuleOne('@js: var n = 2; var s = "第" + n + "章"; s', { baseUrl: BASE_URL });
    assert.strictEqual(v, '第2章');
  }

  console.log('规则求值测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

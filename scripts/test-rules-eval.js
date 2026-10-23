/**
 * test-rules-eval.js — 规则求值器单测(CSS / JSON / 前缀 / 提取后缀 / 正则 / 兜底 / 模板)
 */
'use strict';
const assert = require('assert');
const { evalRule, evalRuleOne, evalRuleList, interpolate, splitFallback } = require('../dist/rules/evalRule');
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

  // 17) `##正则` 省略替换段 = 匹配即删除
  {
    const v = await evalRuleOne('.last@text##最新章节：', html);
    assert.strictEqual(v, '第1888章 完美世界', '只有两段 ## 时应删除匹配内容');
  }

  // 18) legado 选择器前缀 + @ 链
  {
    const v = await evalRuleOne('class.book-item@tag.h3@text', html);
    assert.strictEqual(v, '遮天', '@ 链应按逐级向下选取');
    const href = await evalRuleOne('class.book-item@tag.h3@tag.a@href', html);
    assert.ok(href.indexOf('https://www.example.com/book/') === 0, '链末尾 @href 应解析为绝对地址');
  }

  // 19) {{@@规则}} 内嵌模板(legado: 在当前节点上再求值并拼接)
  {
    const doc = '<div class="card-other"><i>12</i></div><div class="card-other"><i>3</i></div>';
    const v = await evalRuleOne('{{@@div.card-other.0@i@text}}个收藏,{{@@div.card-other.1@i@text}}条留言',
      { html: doc, baseUrl: '' });
    assert.strictEqual(v, '12个收藏,3条留言');
    // 内嵌规则为空时保留空串, 不报错
    const empty = await evalRuleOne('{{@@.nope@text}}条', { html: doc, baseUrl: '' });
    assert.strictEqual(empty, '条');
  }

  // 20) 列表规则: `||` 兜底不再进 CSS; 显式 JSON 即使有 html 也走 JSON
  {
    const html = '<div class="a"><ul><li>1</li></ul></div>'
      + '<div class="b"><div class="list"><li>2</li><li>3</li></div></div>';
    const parsed = await evalRuleList('.nope||.b .list li', { html, baseUrl: BASE_URL });
    assert.strictEqual(parsed.kind, 'html');
    assert.strictEqual(parsed.nodes.length, 2, '|| 后面的选择器应生效');

    const json = { data: { books: [{ title: 'A' }, { title: 'B' }] } };
    const vals = await evalRule('$.data.books[*].title', { html: '<div>x</div>', json, baseUrl: BASE_URL });
    assert.deepStrictEqual(vals, ['A', 'B'], '显式 JSONPath 不应被 html 带偏');

    const upper = await evalRule('@JSon:$.data.books[0].title', { json, baseUrl: BASE_URL });
    assert.deepStrictEqual(upper, ['A'], '@JSon: 前缀应大小写不敏感');
  }

  console.log('规则求值测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

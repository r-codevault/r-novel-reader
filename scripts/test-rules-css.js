/**
 * test-rules-css.js — CSS 选择器引擎单测
 *
 * 覆盖: 标签/类/id/属性六种/后代/子/相邻/兄弟/逗号/伪类/结果集伪类/
 *       XPath 明确报错
 */
'use strict';
const assert = require('assert');
const { parseHtml, nodeText } = require('../dist/rules/html');
const { selectAll, selectFirst, parseSelector, normalizeLegadoSelector, CssSyntaxError } = require('../dist/rules/css');
const { SEARCH_HTML, TOC_HTML, CONTENT_HTML } = require('./fixtures-source');

const search = parseHtml(SEARCH_HTML);
const texts = (nodes) => nodes.map((n) => nodeText(n).trim());

// 1) 类选择器 + 后代
{
  const items = selectAll(search, '.result-list .book-item');
  assert.strictEqual(items.length, 3);
  assert.strictEqual(texts(items)[0].indexOf('遮天'), 0);
}

// 2) 标签 + 类
{
  const names = selectAll(search, 'h3.book-name a');
  assert.strictEqual(names.length, 3);
  assert.strictEqual(nodeText(names[0]).trim(), '遮天');
}

// 3) 属性选择器
{
  assert.strictEqual(selectAll(search, 'a[href^="/book/"]').length, 2, '^= 应命中 2 个站内链接');
  assert.strictEqual(selectAll(search, 'a[href$="4096/"]').length, 1);
  assert.strictEqual(selectAll(search, 'a[href*="2048"]').length, 1);
  assert.strictEqual(selectAll(search, 'a[href^="//"]').length, 1, '协议相对链接应可选中');
  assert.strictEqual(selectAll(search, 'a[title]').length, 1);
}

// 4) 子选择器 vs 后代
{
  const direct = selectAll(search, 'div.result-list > div');
  assert.strictEqual(direct.length, 3);
  const deep = selectAll(search, '.result-list p');
  assert.strictEqual(deep.length, 4, '3 本书里前两本各有 2 个 p, 第三本没有 -> 4, 实际 ' + deep.length);
}

// 5) 逗号分组
{
  const mixed = selectAll(search, '.author span, .kind');
  assert.strictEqual(mixed.length, 3, '作者 span 2 个 + kind 1 个 = 3, 实际 ' + mixed.length);
}

// 6) 伪类: first-child / nth-child / contains
{
  const first = selectAll(search, '.book-item:first-child');
  assert.strictEqual(first.length, 1);
  const inner = selectAll(search, '.author span:first-child');
  assert.strictEqual(inner.length, 2, '前两本各有一个 author span, 都是 first-child');
  const second = selectAll(search, '.book-item:nth-child(2)');
  assert.strictEqual(texts(second)[0].indexOf('完美世界') >= 0, true);
}

// 7) 结果集伪类: :eq / :lt / :gt / :first / :last
{
  assert.strictEqual(texts(selectAll(search, '.book-item:eq(1)'))[0].indexOf('完美世界') >= 0, true);
  assert.strictEqual(selectAll(search, '.book-item:lt(2)').length, 2);
  assert.strictEqual(selectAll(search, '.book-item:gt(1)').length, 1);
  assert.strictEqual(selectAll(search, '.book-item:last').length, 1);
}

// 8) not()
{
  assert.strictEqual(selectAll(search, '.book-item:not(.book-item)').length, 0);
  const noIntro = selectAll(search, 'h3.book-name a:not([title])');
  assert.strictEqual(noIntro.length, 2);
}

// 9) 相邻/兄弟
{
  const toc = parseHtml(TOC_HTML);
  const dds = selectAll(toc, 'dt + dd');
  assert.strictEqual(dds.length, 1, 'dt 的相邻兄弟只有第一个 dd');
  assert.strictEqual(selectAll(toc, 'dt ~ dd').length, 3);
}

// 10) 正文页: 忽略广告 div, 只取 content 下 p
{
  const content = parseHtml(CONTENT_HTML);
  const ps = selectAll(content, '#content > p');
  assert.strictEqual(ps.length, 3, '应有 3 段正文, 实际 ' + ps.length);
  assert.ok(texts(ps)[1].indexOf('星空') >= 0);
}

// 11) XPath 明确报错
{
  assert.throws(() => parseSelector('//div[@class="x"]'), (err) => err instanceof CssSyntaxError && /XPath/.test(err.message));
}

// 12) 非法选择器报错
{
  assert.throws(() => parseSelector('div['), CssSyntaxError);
  assert.throws(() => parseSelector(''), CssSyntaxError);
}

// 13) selectFirst
{
  const first = selectFirst(search, '.book-item');
  assert.ok(first && nodeText(first).indexOf('遮天') >= 0);
}

// 14) legado 选择器写法: class./id./tag./text. 与 @ 链
{
  assert.strictEqual(normalizeLegadoSelector('class.list-group-item'), '.list-group-item');
  assert.strictEqual(normalizeLegadoSelector('id.content'), '#content');
  assert.strictEqual(normalizeLegadoSelector('tag.h5'), 'h5');
  assert.strictEqual(normalizeLegadoSelector('class.mb-1@a@text'), '.mb-1 a');
  assert.strictEqual(normalizeLegadoSelector('class.list-group@tag.h5'), '.list-group h5');
  assert.strictEqual(normalizeLegadoSelector('text.分类@text'), '*:contains(分类)');
  // 纯 CSS 不受影响
  assert.strictEqual(normalizeLegadoSelector('h3.book-name a'), 'h3.book-name a');
  assert.strictEqual(normalizeLegadoSelector('.a, .b'), '.a, .b');

  const html = '<div class="list-group"><h5>一</h5><h5>二</h5></div>';
  assert.strictEqual(selectAll(parseHtml(html), 'class.list-group').length, 1);
  assert.strictEqual(selectAll(parseHtml(html), 'class.list-group@tag.h5').length, 2);
  assert.strictEqual(selectAll(parseHtml(html), 'tag.h5').length, 2);
  assert.strictEqual(selectAll(parseHtml(html), 'text.一').length >= 1, true);

  // .N 序号: 取当前匹配集的第 N 个(0 基)
  const list = parseHtml('<div class="c">1</div><div class="c">2</div><div class="c">3</div>');
  assert.strictEqual(nodeText(selectAll(list, 'div.c:index(1)')[0]).trim(), '2');
  assert.strictEqual(nodeText(selectAll(list, 'class.c.2')[0]).trim(), '3');
  assert.strictEqual(selectAll(list, 'class.c.9').length, 0);
}

  // 15) legado 结果集后置操作: !N / 负数 / 切片
  {
    const html = '<div class="c">' + Array.from({ length: 6 }, (_, i) => '<a>' + i + '</a>').join('') + '</div>';
    const root = parseHtml(html);
    const vals = (sel) => selectAll(root, sel).map((n) => nodeText(n).trim());
    assert.deepStrictEqual(vals('.c a!0'), ['1', '2', '3', '4', '5']);
    assert.deepStrictEqual(vals('.c a!0:1:2'), ['3', '4', '5']);
    assert.deepStrictEqual(vals('.c a.-1'), ['5']);
    assert.deepStrictEqual(vals('.c a.-2'), ['4']);
    assert.deepStrictEqual(vals('.c a:index(-2)'), ['4']);
    assert.deepStrictEqual(vals('.c a[1:3]'), ['1', '2']);
    assert.deepStrictEqual(vals('.c a[:2]'), ['0', '1']);
    assert.deepStrictEqual(vals('.c a[4:]'), ['4', '5']);
    assert.deepStrictEqual(vals('.c a[-2:]'), ['4', '5']);
    assert.deepStrictEqual(vals('.c a[9:20]'), []);
    assert.deepStrictEqual(vals('.c a.2'), ['2'], '旧 .N 语义不变');
  }

console.log('CSS 选择器测试全部通过 ✔');

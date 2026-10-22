/**
 * test-rules-html.js — 轻量 HTML 解析器单测
 *
 * 覆盖: 基本结构 / 未闭合标签自愈 / li 隐含闭合 / br 换行 /
 *       script 跳过 / 实体解码 / 属性解析 / innerHtml 往返
 */
'use strict';
const assert = require('assert');
const { parseHtml, childElements, nodeText, innerHtml, outerHtml } = require('../dist/rules/html');
const { SEARCH_HTML, TOC_HTML, CONTENT_HTML } = require('./fixtures-source');

// 1) 基本结构
{
  const root = parseHtml('<div id="a" class="x y"><p>hello</p><p>world</p></div>');
  const div = childElements(root)[0];
  assert.strictEqual(div.tag, 'div');
  assert.strictEqual(div.attrs['id'], 'a');
  assert.strictEqual(div.attrs['class'], 'x y');
  const ps = childElements(div);
  assert.strictEqual(ps.length, 2);
  assert.strictEqual(nodeText(ps[0]).trim(), 'hello');
}

// 2) 未闭合标签自愈: p 未闭合直接遇到 div
{
  const root = parseHtml('<div><p>一<div>二</div>');
  const outer = childElements(root)[0];
  assert.strictEqual(outer.tag, 'div');
  const kids = childElements(outer);
  assert.strictEqual(kids[0].tag, 'p', '第一个子元素应是 p');
  assert.strictEqual(kids[1].tag, 'div', 'div 应把未闭合的 p 顶掉');
}

// 3) li 隐含闭合
{
  const root = parseHtml('<ul><li>甲<li>乙<li>丙</ul>');
  const ul = childElements(root)[0];
  assert.strictEqual(childElements(ul).length, 3, '3 个 li 应互为兄弟');
  assert.strictEqual(childElements(ul)[2].tag, 'li');
}

// 4) br 转换行 + 块级元素补换行
{
  const root = parseHtml(CONTENT_HTML);
  let content = null;
  (function walk(n) {
    if (n.type === 'element' && n.attrs && n.attrs['id'] === 'content') { content = n; }
    n.children.forEach(walk);
  })(root);
  assert.ok(content, '应能按 id 找到 content 容器');
  const text = nodeText(content);
  assert.ok(text.indexOf('少年抬起头，看向星空。\n那里有一颗星在闪烁。') >= 0, 'br 应转为换行, 实际: ' + JSON.stringify(text.slice(0, 80)));
}

// 5) script/style 内容整体跳过
{
  const root = parseHtml(SEARCH_HTML);
  const all = nodeText(root);
  assert.ok(all.indexOf('_hmt') < 0, 'script 内容不应出现在文本里');
  assert.ok(all.indexOf('color:#333') < 0, 'style 内容不应出现在文本里');
}

// 6) 实体解码
{
  const root = parseHtml('<p>a&nbsp;b &amp; c &hellip; &#39;x&#39; &#x4e2d;</p>');
  const text = nodeText(childElements(root)[0]);
  assert.strictEqual(text, 'a\u00a0b & c \u2026 \'x\' 中');
}

// 7) 属性: 单双引号/无引号/布尔属性/大小写
{
  const root = parseHtml('<a HREF=/x/1 Data-Id=7 disabled>t</a>');
  const a = childElements(root)[0];
  assert.strictEqual(a.tag, 'a');
  assert.strictEqual(a.attrs['href'], '/x/1');
  assert.strictEqual(a.attrs['data-id'], '7');
  assert.strictEqual(a.attrs['disabled'], '');
}

// 8) 目录页: dd 未闭合(最后一个缺 </dd>)仍能取到 3 条
{
  const root = parseHtml(TOC_HTML);
  const a = [];
  (function walk(n) {
    if (n.type === 'element' && n.tag === 'a') { a.push(n); }
    n.children.forEach(walk);
  })(root);
  assert.strictEqual(a.length, 3, '应取到 3 个章节链接, 实际 ' + a.length);
  assert.strictEqual(a[2].attrs['href'], '/book/1024/3.html');
}

// 9) innerHtml / outerHtml 往返
{
  const root = parseHtml('<div class="c"><b>x</b> y</div>');
  const div = childElements(root)[0];
  assert.strictEqual(innerHtml(div), '<b>x</b> y');
  assert.strictEqual(outerHtml(div), '<div class="c"><b>x</b> y</div>');
}

// 10) 注释 / doctype / CDATA 不影响结构
{
  const root = parseHtml('<!DOCTYPE html><!-- c --><p>a<!--x-->b</p>');
  const p = childElements(root)[0];
  assert.strictEqual(nodeText(p), 'ab');
}

console.log('HTML 解析测试全部通过 ✔');

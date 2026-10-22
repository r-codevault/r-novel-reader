/**
 * fixtures-source.js — 书源规则单测共用的夹具(HTML/JSON 片段)
 *
 * 尽量贴近真实书源站点: 残缺标签、内联脚本、实体、相对链接、JSON API。
 */
'use strict';

/** 搜索结果页: 列表 + 脚本 + 实体 + 相对链接 + 缺失字段 */
const SEARCH_HTML = `<!DOCTYPE html>
<html><head><title>搜索"遮天" - 示例小说网</title>
<meta charset="utf-8">
<script>var _hmt = _hmt || []; (function(){ var hm=document.createElement("script"); })();</script>
<style>.book{color:#333}</style>
</head>
<body>
  <div id="main">
    <div class="result-list">
      <div class="book-item">
        <h3 class="book-name"><a href="/book/1024/" title="遮天">遮天</a></h3>
        <p class="author">作者：<span>辰东</span></p>
        <p class="intro">冰冷与黑暗并存的宇宙深处&hellip;</p>
        <span class="kind">玄幻&nbsp;仙侠</span>
        <span class="last">最新章节：第1888章 完美世界</span>
      </div>
      <div class="book-item">
        <h3 class="book-name"><a href="//m.example.com/book/2048/">完美世界</a></h3>
        <p class="author">作者：<span>辰东</span></p>
        <p class="intro">&amp; 一切从这里开始</p>
      </div>
      <div class="book-item">
        <h3 class="book-name"><a href="/book/4096/">无作者的书</a></h3>
      </div>
    </div>
    <div class="pager"><a href="/search?q=遮天&page=2">下一页</a></div>
  </div>
  <script src="/static/app.js"></script>
</body></html>`;

/** 目录页: 分卷 + 未闭合 li + 相对链接 */
const TOC_HTML = `<html><body>
<div class="listmain">
  <dl>
    <dt>正文卷</dt>
    <dd><a href="/book/1024/1.html">第1章 星空中的青铜巨棺</a></dd>
    <dd><a href="/book/1024/2.html">第2章 素问</a></dd>
    <dd><a href="/book/1024/3.html">第3章 今古</a>
  </dl>
</div>
</body></html>`;

/** 正文页: 段落 + 广告 + <br> */
const CONTENT_HTML = `<html><body>
<div id="content">
  <p>　　“这是一个很长的故事。”老人说道。</p>
  <p>　　少年抬起头，看向星空。<br>那里有一颗星在闪烁。</p>
  <div class="ads">广告位招租</div>
  <p>　　于是他伸出手，握住了那颗星。</p>
</div>
</body></html>`;

/** JSON API 搜索响应(带嵌套与数组) */
const SEARCH_JSON = {
  code: 0,
  data: {
    books: [
      { original_title: '遮天', original_author: '辰东', image_link: 'https://img.example.com/zt.jpg', intro: '星空彼岸', words_num: '6350000', book_id: 1024 },
      { original_title: '完美世界', original_author: '辰东', image_link: '', intro: '一粒尘可填海', words_num: '5000000', book_id: 2048 },
    ],
  },
};

/** 列表项里带 JSON 字符串字段(书源常见写法 data[*].dataJson) */
const NESTED_JSON = {
  data: [
    { dataJson: { name: '书一', authorName: '作者一', cover: 'c1.jpg' } },
    { dataJson: { name: '书二', authorName: '作者二', cover: 'c2.jpg' } },
  ],
};

module.exports = {
  SEARCH_HTML,
  TOC_HTML,
  CONTENT_HTML,
  SEARCH_JSON,
  NESTED_JSON,
  BASE_URL: 'https://www.example.com',
};

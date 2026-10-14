/**
 * generate-playground.js — 生成主题调色预览页 theme-playground.html
 *
 * 用途: 像 Figma 一样实时调配 THEMES 各主题的颜色,
 *       页面里直接预览 悬浮球 / 设置面板 / 正文 的效果,
 *       调好后点「导出代码」, 把输出粘回 src/settings.ts 的 THEMES。
 *
 * 用法: node scripts/generate-playground.js
 *   产物: theme-playground.html (浏览器直接打开)
 *   重新生成(同步 settings.ts 最新主题): npm run playground
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

// dist/settings.js 顶层 require('vscode'), 独立运行时给个空桩
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: () => undefined, has: () => false }) } };
  }
  return origLoad.call(this, request, parent, isMain);
};

const themes = require(path.join(__dirname, '..', 'dist', 'settings')).THEMES;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>主题调色台 · r-novel-reader</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f0f0f0; color: #333; padding: 16px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 16px; }
  .theme-tab {
    padding: 5px 12px; border-radius: 999px; border: 1px solid #ccc;
    background: #fff; cursor: pointer; font-size: 13px;
  }
  .theme-tab.active { background: #f56c6c; color: #fff; border-color: #f56c6c; }
  .export-btn {
    margin-left: auto; padding: 6px 14px; border: none; border-radius: 6px;
    background: #2c7be5; color: #fff; cursor: pointer; font-size: 13px;
  }
  .reset-btn {
    padding: 6px 14px; border: 1px solid #ccc; border-radius: 6px;
    background: #fff; cursor: pointer; font-size: 13px;
  }
  main { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }

  /* ---- 左: 颜色编辑器 ---- */
  #editor {
    width: 260px; background: #fff; border: 1px solid #ddd; border-radius: 10px;
    padding: 14px; box-shadow: 0 2px 8px rgba(0,0,0,.08);
  }
  #editor h2 { font-size: 14px; margin-bottom: 10px; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .row label { font-size: 13px; }
  .row .val { font-size: 11px; color: #999; margin-left: 6px; }
  .row input[type=color] { width: 52px; height: 26px; border: 1px solid #ddd; border-radius: 4px; padding: 0; background: none; cursor: pointer; }
  #exportOut {
    width: 100%; height: 110px; margin-top: 10px; font-family: Consolas, monospace;
    font-size: 11px; border: 1px solid #ddd; border-radius: 6px; padding: 6px; resize: vertical;
  }
  .hint { font-size: 11px; color: #999; margin-top: 6px; }

  /* ---- 中: 阅读页预览(状态栏+正文+底部进度条+悬浮球) ---- */
  #preview {
    flex: 1; min-width: 520px; height: 560px; position: relative;
    border: 1px solid #ccc; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column;
  }
  .statusbar { padding: 8px 14px; font-size: 12px; display: flex; justify-content: space-between; }
  .content { flex: 1; overflow: auto; padding: 24px 0; }
  .paper { max-width: 640px; margin: 0 auto; padding: 28px 36px; }
  .paper h3 { font-size: 18px; margin-bottom: 14px; }
  .paper p { font-size: 15px; line-height: 1.9; margin-bottom: 12px; }
  .progressbar { height: 3px; }
  .progressbar i { display: block; height: 100%; width: 35%; background: var(--accent); }

  /* ---- 悬浮球(与 readerPanel .fab 同款) ---- */
  .fabs {
    position: absolute; right: 16px; top: 50%; transform: translateY(-50%);
    display: flex; flex-direction: column; gap: 10px; opacity: 1;
  }
  .fab {
    width: 58px; padding: 9px 4px 7px; border-radius: 12px;
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    background: var(--fab-bg); color: var(--fab-fg);
    border: 1px solid var(--fab-border);
    box-shadow: 0 3px 12px rgba(0,0,0,.32);
    font-size: 11px; letter-spacing: .02em; text-align: center;
  }
  .fab svg { width: 20px; height: 20px; }

  /* ---- 右: 设置面板预览(与 readerPanel #settingsPanel 同款) ---- */
  #panel {
    width: 300px; border-radius: 10px; border: 1px solid var(--sp-border);
    background: var(--sp-bg); color: var(--sp-fg);
    box-shadow: 0 8px 28px rgba(0,0,0,.22); padding: 14px 16px;
  }
  .sp-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .sp-head b { font-size: 15px; }
  .sp-head span { cursor: pointer; color: var(--sp-muted); font-size: 14px; }
  .sp-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .sp-label { width: 68px; white-space: nowrap; font-size: 12px; color: var(--sp-muted); }
  .sp-themes { display: flex; gap: 8px; flex: 1; }
  .sp-dot {
    width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--sp-border);
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 11px;
  }
  .sp-dot.active { outline: 2px solid var(--sp-accent); outline-offset: 2px; }
  .sp-seg {
    flex: 1; text-align: center; padding: 5px 0; font-size: 12px;
    border: 1px solid var(--sp-border); border-radius: 6px; background: var(--sp-control-bg); cursor: pointer;
  }
  .sp-seg.active { color: var(--sp-accent); border-color: var(--sp-accent); }
  .sp-step { display: flex; align-items: center; gap: 0; border: 1px solid var(--sp-border); border-radius: 6px; overflow: hidden; flex: 1; }
  .sp-step button { border: none; background: var(--sp-control-bg); color: var(--sp-fg); width: 30px; padding: 5px 0; cursor: pointer; font-size: 12px; }
  .sp-step span { flex: 1; text-align: center; font-size: 12px; background: var(--sp-control-bg); }
  .sp-reset {
    width: 100%; margin-top: 4px; padding: 8px 0; text-align: center; font-size: 13px;
    border: 1px solid var(--sp-border); border-radius: 6px; background: var(--sp-control-bg); cursor: pointer;
  }
  .sp-foot { font-size: 11px; color: var(--sp-muted); margin-top: 10px; line-height: 1.6; }
</style>
</head>
<body>
<header>
  <h1>主题调色台</h1>
  <div id="tabs"></div>
  <button class="reset-btn" id="resetBtn">还原初始值</button>
  <button class="export-btn" id="exportBtn">导出代码</button>
</header>
<main>
  <div id="editor">
    <h2 id="editorTitle"></h2>
    <div id="rows"></div>
    <textarea id="exportOut" readonly placeholder="点「导出代码」生成 THEMES 片段"></textarea>
    <div class="hint">调好后把上面的片段替换 src/settings.ts 里对应主题那一行</div>
  </div>
  <div id="preview">
    <div class="statusbar" id="statusbar"><span>第 1 章 · 引子</span><span>本章 3,240 字 · 35%</span></div>
    <div class="content"><div class="paper">
      <h3>第一章 引子</h3>
      <p>山门之外，古钟长鸣。少年背着一柄断了半截的铁剑，一步一步踏上石阶。晨雾未散，露水打湿了他的裤脚。</p>
      <p>他抬头望了一眼山巅，那里有他此生要追寻的答案。风从林间穿过，卷起几片落叶，也卷起了这段故事的序章。</p>
      <p>「此去经年，山高水长。」他在心里默念着师父临别时的话，握紧了剑柄。</p>
    </div></div>
    <div class="progressbar"><i></i></div>
    <div class="fabs" id="fabs"></div>
  </div>
  <div id="panel">
    <div class="sp-head"><b>设置</b><span>✕</span></div>
    <div class="sp-row"><div class="sp-label">阅读主题</div><div class="sp-themes" id="panelDots"></div></div>
    <div class="sp-row"><div class="sp-label">正文字体</div>
      <div class="sp-seg active">黑体</div><div class="sp-seg">宋体</div><div class="sp-seg">楷体</div>
    </div>
    <div class="sp-row"><div class="sp-label">字号大小</div>
      <div class="sp-step"><button>−</button><span>20</span><button>+</button></div>
    </div>
    <div class="sp-row"><div class="sp-label">行距</div>
      <div class="sp-step"><button>−</button><span>1.9</span><button>+</button></div>
    </div>
    <div class="sp-row"><div class="sp-label">段距</div>
      <div class="sp-step"><button>−</button><span>0.6</span><button>+</button></div>
    </div>
    <div class="sp-row"><div class="sp-label">页面宽度</div>
      <div class="sp-seg">640</div><div class="sp-seg">800</div><div class="sp-seg active">1000</div>
    </div>
    <div class="sp-reset">恢复默认设置</div>
    <div class="sp-foot">Ctrl + 滚轮 缩放字号 · 上一章 alt + ← · 下一章 alt + →</div>
  </div>
</main>

<script>
const THEMES = JSON.parse(document.getElementById('themes-data').textContent);
const FIELDS = ['bg','fg','pageBg','chromeBg','chromeBorder','accent','accentFg','muted','panelAccent','panelHover'];
const FIELD_NAMES = { bg:'正文纸面 bg', fg:'正文文字 fg', pageBg:'两侧留白 pageBg', chromeBg:'面板底 chromeBg', chromeBorder:'面板描边 chromeBorder', accent:'强调色 accent', accentFg:'强调色文字 accentFg', muted:'次要文字 muted', panelAccent:'面板强调 panelAccent', panelHover:'面板悬停 panelHover' };
const LS_KEY = 'rnovel-theme-playground';
let current = THEMES[0].id;
let working = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY));
    if (Array.isArray(saved) && saved.length === THEMES.length) return saved;
  } catch (e) {}
  return JSON.parse(JSON.stringify(THEMES));
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(working)); }
function t() { return working.find(x => x.id === current); }

function applyTheme() {
  const d = t();
  const root = document.documentElement.style;
  root.setProperty('--bg', d.bg);
  root.setProperty('--fg', d.fg);
  root.setProperty('--page-bg', d.pageBg);
  root.setProperty('--chrome-bg', d.chromeBg);
  root.setProperty('--chrome-fg', d.fg);
  root.setProperty('--chrome-border', d.chromeBorder);
  root.setProperty('--accent', d.accent);
  root.setProperty('--accent-fg', d.accentFg);
  // 设置面板配色: 全部来自 THEMES 主题字段(与 readerPanel 同规则)
  root.setProperty('--sp-bg', d.chromeBg);
  root.setProperty('--sp-fg', d.fg);
  root.setProperty('--sp-border', d.chromeBorder);
  root.setProperty('--sp-muted', d.muted);
  root.setProperty('--sp-hover', d.panelHover);
  root.setProperty('--sp-control-bg', d.bg);
  root.setProperty('--sp-accent', d.panelAccent);
  // 悬浮球(与 readerPanel 同规则: 面板同色底 + 主题色图标/描边)
  root.setProperty('--fab-bg', d.chromeBg);
  root.setProperty('--fab-fg', d.accent);
  root.setProperty('--fab-border', d.chromeBorder);

  document.getElementById('preview').style.background = 'var(--page-bg)';
  document.getElementById('statusbar').style.background = 'var(--chrome-bg)';
  document.getElementById('statusbar').style.color = 'var(--chrome-fg)';
  document.getElementById('statusbar').style.borderBottom = '1px solid var(--chrome-border)';
  document.querySelector('.paper').style.background = 'var(--bg)';
  document.querySelector('.paper').style.color = 'var(--fg)';
  document.querySelector('.progressbar').style.background = 'var(--chrome-border)';
  renderFabs();
  renderDots();
}

function renderFabs() {
  const icons = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
    font: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>'
  };
  document.getElementById('fabs').innerHTML = [
    ['up','上一章'],['list','目录'],['down','下一章'],['font','阅读设置']
  ].map(([k, label]) =>
    '<div class="fab">' + icons[k] + '<div>' + label + '</div></div>'
  ).join('');
}

function renderTabs() {
  document.getElementById('tabs').innerHTML = working.map(d =>
    '<button class="theme-tab' + (d.id === current ? ' active' : '') + '" data-id="' + d.id + '">' + d.name + '</button>'
  ).join('');
  document.querySelectorAll('.theme-tab').forEach(b => b.onclick = () => { current = b.dataset.id; renderTabs(); renderEditor(); applyTheme(); });
}

function renderDots() {
  document.getElementById('panelDots').innerHTML = working.map(d =>
    '<span class="sp-dot' + (d.id === current ? ' active' : '') + '" data-id="' + d.id + '" style="background:' + (d.id === 'dark' ? '#1c1c1c' : d.bg) + '" title="' + d.name + '">' + (d.id === current ? '✓' : '') + '</span>'
  ).join('');
  document.querySelectorAll('.sp-dot').forEach(s => s.onclick = () => { current = s.dataset.id; renderTabs(); renderEditor(); applyTheme(); });
}

function renderEditor() {
  const d = t();
  document.getElementById('editorTitle').textContent = '编辑主题: ' + d.name + ' (' + d.id + ')';
  document.getElementById('rows').innerHTML = FIELDS.map(f =>
    '<div class="row"><label>' + FIELD_NAMES[f] + '</label>' +
    '<span><input type="color" data-field="' + f + '" value="' + d[f] + '">' +
    '<span class="val">' + d[f] + '</span></span></div>'
  ).join('');
  document.querySelectorAll('#rows input[type=color]').forEach(inp => inp.oninput = () => {
    t()[inp.dataset.field] = inp.value;
    inp.parentElement.querySelector('.val').textContent = inp.value;
    save(); applyTheme();
  });
}

document.getElementById('exportBtn').onclick = () => {
  const lines = working.map(d =>
    "    { id: '" + d.id + "', name: '" + d.name + "', bg: '" + d.bg + "', fg: '" + d.fg +
    "', pageBg: '" + d.pageBg + "', chromeBg: '" + d.chromeBg + "', chromeBorder: '" + d.chromeBorder +
    "', accent: '" + d.accent + "', accentFg: '" + d.accentFg + "', muted: '" + d.muted +
    "', panelAccent: '" + d.panelAccent + "', panelHover: '" + d.panelHover + "' },"
  ).join('\\n');
  document.getElementById('exportOut').value = 'export const THEMES: ThemeDef[] = [\\n' + lines + '\\n];';
  document.getElementById('exportOut').select();
};

document.getElementById('resetBtn').onclick = () => {
  working = JSON.parse(JSON.stringify(THEMES));
  save(); renderEditor(); applyTheme();
};

renderTabs();
renderEditor();
applyTheme();
</script>
<script type="application/json" id="themes-data">${JSON.stringify(themes).replace(/</g, '\\u003c')}</script>
</body>
</html>`;

const out = path.join(__dirname, '..', 'theme-playground.html');
fs.writeFileSync(out, html, 'utf8');
console.log('✓ 已生成: ' + out);
console.log('  浏览器打开即可实时调色, 调好后点「导出代码」粘回 src/settings.ts');

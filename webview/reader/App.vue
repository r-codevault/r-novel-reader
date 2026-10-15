<script setup>
/**
 * App.vue — 阅读面板根组件(功能与旧内嵌脚本一一等价)
 * 结构: 目录面板 / 设置面板 / 正文阅读区(含宽度手柄) / 悬浮球工具栏 / 底部状态栏
 */
import { computed, onMounted, reactive, ref, watch, nextTick } from 'vue';
import {
  store, persistSettings, stepFontSize, stepSetting, resetSettings,
  applyThemeVars, themeOf, DEFAULT_SETTINGS,
} from './store.js';
import { vscode, post } from './composables/vscode.js';
import { parseShortcut, matchShortcut, shortcutLabel } from './composables/shortcut.js';
import { chapterParts, buildCatalogGroups, thousand } from './composables/catalog.js';
import './reader.css';

// ---------------------------------------------------------------- 模板状态
const chapter = computed(() => store.chapter);
const settings = computed(() => store.settings);
const paras = computed(() => (store.chapter && store.chapter.paragraphs) || []);

const bookInfoText = ref('');
const widthSteps = [640, 800, 1000, 1200];
const THEMES = __THEMES__;
const fontOptions = [
  { id: 'heiti', name: '黑体' },
  { id: 'songti', name: '宋体' },
  { id: 'kaiti', name: '楷体' },
];

function fmtWords(words) {
  words = words || 0;
  return words > 0 ? '本章 ' + thousand(words) + ' 字' : '';
}

function fmtProgress() {
  var total = store.novel ? store.novel.totalChapters : 0;
  var idx = (store.chapter ? store.chapter.index : 0) + 1;
  return total > 0 ? '第 ' + idx + ' 章 / 共 ' + total + ' 章' : '';
}

const progressPct = computed(function () {
  var total = store.novel ? store.novel.totalChapters : 0;
  var idx = (store.chapter ? store.chapter.index : 0) + 1;
  return total > 0 ? (idx / total) * 100 : 0;
});

// ---------------------------------------------------------------- 目录
const catalogGroups = computed(function () {
  var groups = buildCatalogGroups(store.chapters);
  if (store.catReverse) {
    groups = groups
      .slice()
      .reverse()
      .map(function (g) { return { name: g.name, entry: g.entry, items: g.items.slice().reverse() }; });
  }
  return groups.map(function (g) {
    return {
      name: g.name,
      entry: g.entry,
      collapsed: (store.catCollapsed || []).indexOf(g.name) >= 0,
      total: g.items.length + (g.entry >= 0 ? 1 : 0),
      items: g.items.map(function (c) {
        var p = chapterParts(c.title);
        return { index: c.index, no: p.no, name: p.name || c.title, title: c.title };
      }),
      entryNo: g.entry >= 0 ? chapterParts(g.name).no : '',
      entryName: g.entry >= 0 ? chapterParts(g.name).name || g.name : '',
    };
  });
});

const catSubText = computed(function () {
  return store.chapters.length > 0 ? '共 ' + store.chapters.length + ' 章' : '';
});

const catPosText = computed(function () {
  return store.chapters.length > 0
    ? '第 ' + (store.chapter.index + 1) + ' / ' + store.chapters.length + ' 章'
    : '';
});

function toggleGroup(g) {
  var list = store.catCollapsed || [];
  var at = list.indexOf(g.name);
  if (g.collapsed) {
    if (at >= 0) { list.splice(at, 1); }
  } else {
    if (at < 0) { list.push(g.name); }
  }
  store.catCollapsed = list.slice();
}

const catBodyRef = ref(null);

/** 当前章变化: 面板开着时滚到当前章(高亮/展开由响应式 class 驱动) */
watch(function () { return store.chapter && store.chapter.index; }, function () {
  if (!catBodyRef.value) { return; }
  var cur = catBodyRef.value.querySelector('.cat-item.cur');
  if (cur) {
    var group = cur.closest('.cat-group');
    if (group && group.classList.contains('collapsed')) {
      var name = group.dataset.g;
      var list = store.catCollapsed || [];
      var at = list.indexOf(name);
      if (at >= 0) { list.splice(at, 1); store.catCollapsed = list.slice(); }
    }
  }
});

watch(function () { return store.catalogOpen; }, function (open) {
  if (open && store.chapters.length > 0) {
    nextTick(function () {
      var el = catBodyRef.value && catBodyRef.value.querySelector('.cat-item.cur');
      if (el) { el.scrollIntoView({ block: 'center' }); }
    });
  }
});

function gotoChapter(index) {
  post('getChapter', { index: index });
}

function onCatalogItemClick(item) {
  gotoChapter(item.index);
  store.catalogOpen = false;
}

// ---------------------------------------------------------------- 设置面板
const settingsPanelRef = ref(null);
const fabsRef = ref(null);
const statusbarRef = ref(null);

function positionSettingsPanel() {
  var panel = settingsPanelRef.value;
  if (!panel || !panel.$el) { return; }
  var el = panel.$el || panel;
  var margin = 12;
  var gap = 10;
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var maxH = Math.max(200, vh - margin * 2);
  el.style.maxHeight = maxH + 'px';
  var pw = el.offsetWidth || 520;
  var ph = Math.min(el.offsetHeight || 420, maxH);
  var anchor = fabsRef.value ? fabsRef.value.getBoundingClientRect() : null;
  var hasAnchor = !!(anchor && (anchor.width || anchor.height));
  var left;
  var top;
  if (hasAnchor) {
    left = anchor.left + anchor.width / 2 > vw / 2 ? anchor.left - gap - pw : anchor.right + gap;
    top = anchor.top;
  } else {
    left = (vw - pw) / 2;
    top = margin;
  }
  if (left + pw > vw - margin) { left = vw - margin - pw; }
  if (left < margin) { left = margin; }
  if (!isFinite(left)) { left = margin; }
  if (top + ph > vh - margin) { top = vh - margin - ph; }
  if (top < margin) { top = margin; }
  if (!isFinite(top)) { top = margin; }
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
}

function openSettings() {
  store.catalogOpen = false;
  store.settingsOpen = true;
  nextTick(positionSettingsPanel);
}

const shortcutHintText = computed(function () {
  var s = store.settings;
  return 'Ctrl + 滚轮 缩放字号 · 上一章 ' + shortcutLabel(s.shortcutPrev) +
    ' · 下一章 ' + shortcutLabel(s.shortcutNext) +
    '（可在 VS Code 设置中自定义）';
});

// ---------------------------------------------------------------- 悬浮球
var IDLE_MS = 3000;
var idleTimer = null;
var lastPointerActivate = 0;
var lastFabPressAt = 0;
var fabDragged = false;
var fabPress = null; // { pressId, dragging, startX, startY, originLeft, originTop }
var fabStyle = reactive({ right: '16px', left: 'auto', top: '50%', transform: 'translateY(-50%)' });

function wakeFabs() {
  store.fabAwake = true;
  if (idleTimer) { clearTimeout(idleTimer); }
  idleTimer = setTimeout(function () { store.fabAwake = false; }, IDLE_MS);
}

function fabMaxTop() {
  var h = fabsRef.value ? fabsRef.value.offsetHeight || 0 : 240;
  var statusH = statusbarRef.value ? statusbarRef.value.offsetHeight : 30;
  return Math.max(8, window.innerHeight - h - statusH - 8);
}

function applyFabPosition(pos) {
  if (!pos) { return; }
  var maxX = Math.max(0, window.innerWidth - 60);
  fabStyle.left = Math.min(Math.max(0, pos.left), maxX) + 'px';
  fabStyle.top = Math.min(Math.max(0, pos.top), fabMaxTop()) + 'px';
  fabStyle.right = 'auto';
  fabStyle.transform = 'none';
}

function fabLayoutMetrics() {
  var BALL_W = 58;
  var GAP = 12;
  var vw = window.innerWidth;
  var cssW =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-width')) ||
    720;
  var contentW = Math.min(cssW, Math.max(0, vw - 40));
  var gutter = (vw - contentW) / 2;
  return { BALL_W: BALL_W, GAP: GAP, vw: vw, contentW: contentW, gutter: gutter };
}

function snapFabPosition(side, top) {
  var m = fabLayoutMetrics();
  var hasRoom = m.gutter >= m.GAP + m.BALL_W + 12;
  var left;
  if (side === 'left') {
    left = hasRoom ? m.gutter - m.GAP - m.BALL_W : 16;
  } else {
    left = hasRoom ? m.vw - m.gutter + m.GAP : m.vw - m.BALL_W - 16;
  }
  var maxY = fabMaxTop();
  return {
    left: Math.round(Math.min(Math.max(16, left), m.vw - m.BALL_W - 16)),
    top: Math.round(Math.min(Math.max(8, top), maxY)),
  };
}

function syncFabAnchor() {
  if (fabDragged) { return; }
  var m = fabLayoutMetrics();
  var right = m.gutter - m.BALL_W - m.GAP;
  if (!isFinite(right) || right < 12) { right = 12; }
  fabStyle.right = right + 'px';
  fabStyle.left = 'auto';
  var h = fabsRef.value ? fabsRef.value.offsetHeight || 0 : 240;
  var avail = window.innerHeight - (statusbarRef.value ? statusbarRef.value.offsetHeight : 30) - 16;
  if (h > avail) {
    fabStyle.top = '8px';
    fabStyle.transform = 'none';
  } else {
    fabStyle.top = '50%';
    fabStyle.transform = 'translateY(-50%)';
  }
}

function onFabPointerdown(e) {
  var btn = e.target.closest ? e.target.closest('.fab') : null;
  fabPress = {
    pressId: btn ? btn.id : null,
    dragging: false,
    startX: e.clientX,
    startY: e.clientY,
    originLeft: fabsRef.value.getBoundingClientRect().left,
    originTop: fabsRef.value.getBoundingClientRect().top,
  };
  store.fabAwake = true;
  wakeFabs();
}

function onFabPointermove(e) {
  if (!fabPress) { return; }
  var dx = e.clientX - fabPress.startX;
  var dy = e.clientY - fabPress.startY;
  if (!fabPress.dragging) {
    if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) { return; }
    fabPress.dragging = true;
    store.fabDragging = true;
    if (fabsRef.value.setPointerCapture) { try { fabsRef.value.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
  }
  e.preventDefault();
  applyFabPosition({ left: fabPress.originLeft + dx, top: fabPress.originTop + dy });
}

function onFabPointerup(e) {
  if (!fabPress) { return; }
  if (fabPress.dragging) {
    var rect = fabsRef.value.getBoundingClientRect();
    var side = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
    var pos = snapFabPosition(side, rect.top);
    applyFabPosition(pos);
    fabDragged = true;
    persistSettings({ fabLeft: pos.left, fabTop: pos.top });
  } else if (fabPress.pressId) {
    lastPointerActivate = Date.now();
    if (lastPointerActivate - lastFabPressAt < 350) {
      lastFabPressAt = 0;
      resetFabPosition();
    } else {
      lastFabPressAt = lastPointerActivate;
      activateFab(fabPress.pressId);
    }
  }
  fabPress = null;
  store.fabDragging = false;
}

function resetFabPosition() {
  fabDragged = false;
  fabStyle.left = 'auto';
  fabStyle.transform = 'translateY(-50%)';
  syncFabAnchor();
  persistSettings({ fabLeft: -1, fabTop: -1 });
}

function activateFab(id) {
  if (id === 'fabPrev') {
    gotoChapter(store.chapter.index - 1);
  } else if (id === 'fabNext') {
    gotoChapter(store.chapter.index + 1);
  } else if (id === 'fabCatalog') {
    store.catalogOpen = !store.catalogOpen;
  } else if (id === 'fabSettings') {
    if (store.settingsOpen) { store.settingsOpen = false; } else { openSettings(); }
  }
}

function onFabClick(e) {
  // 兜底: 键盘回车/空格触发的 click(指针路径已由 pointerup 处理, 避免重复)
  var btn = e.target.closest ? e.target.closest('.fab') : null;
  if (!btn) { return; }
  if (Date.now() - lastPointerActivate < 600) { return; }
  activateFab(btn.id);
}

// ---------------------------------------------------------------- 正文宽度拖拽
var WIDTH_MIN = 480; // 与 settings.ts 的 contentWidth 下限一致
var WIDTH_MAX = 1200; // 与 settings.ts 的 contentWidth 上限一致
var widthDrag = null;
var readerRef = ref(null);
var contentRef = ref(null);
var handleLeftRef = ref(null);
var handleRightRef = ref(null);
var handleLeftStyle = reactive({ left: 'auto', right: 'auto' });
var handleRightStyle = reactive({ left: 'auto', right: 'auto' });
var resizingWidth = ref(false);

function positionWidthHandles() {
  if (!contentRef.value) { return; }
  var rect = contentRef.value.getBoundingClientRect();
  var readerRect = readerRef.value ? readerRef.value.getBoundingClientRect() : { left: 0, right: window.innerWidth };
  handleLeftStyle.left = rect.left - readerRect.left + 'px';
  handleLeftStyle.right = 'auto';
  handleRightStyle.right = readerRect.right - rect.right + 'px';
  handleRightStyle.left = 'auto';
}

function beginWidthDrag(side, e) {
  if (e.button !== 0) { return; }
  e.preventDefault();
  var handle = side === 'left' ? handleLeftRef.value : handleRightRef.value;
  widthDrag = {
    side: side,
    startX: e.clientX,
    startW: contentRef.value.getBoundingClientRect().width,
    handle: handle,
  };
  widthDrag.dragging = true;
  resizingWidth.value = true;
  if (handle.setPointerCapture && e.pointerId !== undefined) {
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  }
  document.body.style.userSelect = 'none';
  positionWidthHandles();
}

function moveWidthDrag(e) {
  if (!widthDrag) { return; }
  var delta = e.clientX - widthDrag.startX;
  var factor = widthDrag.side === 'left' ? -1 : 1;
  var next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(widthDrag.startW + factor * delta)));
  document.documentElement.style.setProperty('--content-width', next + 'px');
  positionWidthHandles();
}

function endWidthDrag(e) {
  if (!widthDrag) { return; }
  if (e && widthDrag.handle.releasePointerCapture && e.pointerId !== undefined) {
    try { widthDrag.handle.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  }
  resizingWidth.value = false;
  document.body.style.userSelect = '';
  var finalW = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--content-width')
  );
  if (isFinite(finalW) && finalW > 0) {
    persistSettings({ contentWidth: Math.round(finalW) });
  }
  widthDrag = null;
}

// ---------------------------------------------------------------- 进度
var progressTimer = null;

function sendProgress(immediate) {
  var send = function () {
    var max = document.body.scrollHeight - window.innerHeight;
    var ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    vscode.postMessage({ type: 'saveProgress', chapterIndex: store.chapter.index, scrollRatio: ratio });
  };
  if (immediate) { send(); } else { if (progressTimer) { clearTimeout(progressTimer); } progressTimer = setTimeout(send, 600); }
}

/** 章节变化后渲染并恢复滚动位置 */
watch(function () { return store.chapter; }, function (ch, old) {
  if (!ch) { return; }
  nextTick(function () {
    var max = document.body.scrollHeight - window.innerHeight;
    window.scrollTo(0, max > 0 ? (ch.scrollRatio || 0) * max : 0);
    positionWidthHandles();
  });
  sendProgress(true);
});

// ---------------------------------------------------------------- 全局事件
function onGlobalPointermove(e) { moveWidthDrag(e); }
function onGlobalPointerup(e) {
  endWidthDrag(e);
  onFabPointerup(e);
}
function onGlobalPointercancel(e) {
  endWidthDrag(e);
  onFabPointerup(e);
}

function onDocMouseDown(e) {
  // 点击面板外部关闭(用 mousedown: 拖动滑块时鼠标可能在面板外松开, 不应误关)
  var inSettings = settingsPanelRef.value && (settingsPanelRef.value.$el || settingsPanelRef.value).contains(e.target);
  var inFabs = fabsRef.value && fabsRef.value.contains(e.target);
  if (store.settingsOpen && !inSettings && !inFabs) { store.settingsOpen = false; }
  var inCatalog = catPanelRef.value && catPanelRef.value.contains(e.target);
  if (store.catalogOpen && !inCatalog && !inFabs) { store.catalogOpen = false; }
}

var catPanelRef = ref(null);

function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (store.catalogOpen) { e.preventDefault(); store.catalogOpen = false; return; }
    if (store.settingsOpen) { e.preventDefault(); store.settingsOpen = false; return; }
  }
  var tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') { return; }
  if (matchShortcut(store.prevCombo, e)) {
    e.preventDefault();
    gotoChapter(store.chapter.index - 1);
    return;
  }
  if (matchShortcut(store.nextCombo, e)) {
    e.preventDefault();
    gotoChapter(store.chapter.index + 1);
  }
}

// Ctrl(或 Cmd) + 滚轮: 放大 / 缩小字号(capture 尽早拦截, 阻止页面缩放)
function onWheel(e) {
  if (!e.ctrlKey && !e.metaKey) { return; }
  e.preventDefault();
  var cur = store.settings.fontSize || DEFAULT_SETTINGS.fontSize;
  var next = Math.min(32, Math.max(12, cur + (e.deltaY < 0 ? 1 : -1)));
  if (next !== cur) { persistSettings({ fontSize: next }); }
}

function syncFabOnResize() {
  if (store.settingsOpen) { positionSettingsPanel(); }
  if (!fabDragged) { syncFabAnchor(); return; }
  var left = parseFloat(fabsRef.value.style.left);
  var top = parseFloat(fabsRef.value.style.top);
  if (isNaN(left) || isNaN(top)) { return; }
  var mid = left + (fabsRef.value.offsetWidth || 58) / 2;
  var side = mid < window.innerWidth / 2 ? 'left' : 'right';
  var pos = snapFabPosition(side, top);
  applyFabPosition(pos);
  persistSettings({ fabLeft: pos.left, fabTop: pos.top });
}

// ---------------------------------------------------------------- 扩展消息
function handleExtensionMessage(msg) {
  if (!msg || !msg.type) { return; }
  switch (msg.type) {
    case 'init': {
      var p = msg.payload;
      store.novel = { totalChapters: p.totalChapters, totalWords: p.totalWords, bookTitle: p.bookTitle, author: p.author };
      document.title = p.bookTitle + ' - 小说阅读';
      store.chapters = p.chapters || [];
      store.catReverse = false;
      store.catCollapsed = [];
      applySettings(p.settings);
      store.chapter = {
        index: p.chapterIndex, title: p.chapterTitle,
        paragraphs: p.paragraphs, totalChapters: p.totalChapters,
        chapterWords: p.chapterWords || 0,
        scrollRatio: p.scrollRatio || 0,
      };
      var words = p.totalWords >= 10000 ? (p.totalWords / 10000).toFixed(1) + ' 万字' : p.totalWords + ' 字';
      bookInfoText.value = p.bookTitle + (p.author ? ' · ' + p.author : '') + ' · 共 ' + p.totalChapters + ' 章 · 约 ' + words;
      if (p.openSettings) { openSettings(); }
      break;
    }
    case 'chapter':
      store.chapter = msg.payload;
      break;
    case 'settings':
      applySettings(msg.payload);
      break;
    case 'openSettings':
      openSettings();
      break;
  }
}

function applySettings(s) {
  store.settings = s;
  applyThemeVars(s);
  store.prevCombo = parseShortcut(s.shortcutPrev);
  store.nextCombo = parseShortcut(s.shortcutNext);
  fabDragged =
    typeof s.fabLeft === 'number' && s.fabLeft >= 0 &&
    typeof s.fabTop === 'number' && s.fabTop >= 0;
  if (fabDragged) {
    nextTick(function () { applyFabPosition({ left: s.fabLeft, top: s.fabTop }); });
  } else {
    nextTick(syncFabAnchor);
  }
  nextTick(positionWidthHandles);
}

// ---------------------------------------------------------------- 生命周期
onMounted(function () {
  window.addEventListener('message', function (e) { handleExtensionMessage(e.data); });
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointermove', onGlobalPointermove);
  document.addEventListener('pointerup', onGlobalPointerup);
  document.addEventListener('pointercancel', onGlobalPointercancel);
  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  document.addEventListener('mousemove', wakeFabs, { passive: true });
  document.addEventListener('scroll', function () { sendProgress(false); wakeFabs(); }, { passive: true });
  window.addEventListener('resize', function () { syncFabOnResize(); positionWidthHandles(); });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () { syncFabOnResize(); positionWidthHandles(); }).observe(document.body);
  }
  applySettings(store.settings);
  vscode.postMessage({ type: 'ready' });
});
</script>

<template>
  <!-- 目录面板(参考起点中文网目录) -->
  <section id="catalogPanel" ref="catPanelRef" :class="{ open: store.catalogOpen }">
    <div class="cat-head">
      <span class="cat-title">目录</span>
      <span class="cat-sub">{{ catSubText }}</span>
      <span class="spacer"></span>
      <button id="catReverse" class="cat-btn" :class="{ on: store.catReverse }" @click="store.catReverse = !store.catReverse">
        {{ store.catReverse ? '正序' : '倒序' }}
      </button>
      <button id="catPrev" class="cat-btn" :disabled="!chapter || chapter.index <= 0" @click="gotoChapter(chapter.index - 1)">上一章</button>
      <button id="catNext" class="cat-btn" :disabled="!chapter || !store.novel || chapter.index >= store.novel.totalChapters - 1" @click="gotoChapter(chapter.index + 1)">下一章</button>
      <button id="catClose" class="cat-btn" @click="store.catalogOpen = false">关闭</button>
    </div>
    <div ref="catBodyRef" class="cat-body">
      <div v-if="store.chapters.length === 0" class="empty-tip">尚未打开小说</div>
      <template v-else>
        <div v-for="g in catalogGroups" :key="g.name" class="cat-group" :class="{ collapsed: g.collapsed }" :data-g="g.name">
          <div class="cat-group-head" title="展开 / 收起本卷" @click="toggleGroup(g)">
            <span class="cat-group-name">{{ g.name }}</span>
            <span class="cat-group-count">共 {{ g.total }} 章</span>
            <span class="cat-group-toggle" title="展开 / 收起本卷">⌃</span>
          </div>
          <div class="cat-items" ref="catItemsRef">
            <div v-if="g.entry >= 0" class="cat-item" :data-i="g.entry" :title="g.name"
              :class="{ cur: chapter && chapter.index === g.entry }" @click="onCatalogItemClick({ index: g.entry })">
              <span v-if="g.entryNo" class="cat-no">{{ g.entryNo }}</span>
              <span class="cat-name">{{ g.entryName }}</span>
            </div>
            <div v-for="c in g.items" :key="c.index" class="cat-item" :data-i="c.index" :title="c.title"
              :class="{ cur: chapter && chapter.index === c.index }" @click="onCatalogItemClick(c)">
              <span v-if="c.no" class="cat-no">{{ c.no }}</span>
              <span class="cat-name">{{ c.name }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
    <div class="cat-foot"><span>{{ catPosText }}</span></div>
  </section>

  <!-- 设置面板(起点风格) -->
  <section id="settingsPanel" ref="settingsPanelRef" :class="{ open: store.settingsOpen }">
    <div class="sp-head">
      <b class="sp-title">设置</b>
      <button class="sp-close" @click.stop="store.settingsOpen = false">✕</button>
    </div>
    <div class="sp-row">
      <span class="sp-label">阅读主题</span>
      <div class="sp-themes">
        <span v-for="t in THEMES" :key="t.id" class="sp-dot" :data-theme="t.id" :title="t.name"
          :style="{ background: t.id === 'dark' ? '#1c1c1c' : t.bg, color: t.fg, '--sp-check': t.fg }"
          :class="{ active: settings.theme === t.id }" @click="persistSettings({ theme: t.id })">✓</span>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">正文字体</span>
      <div class="sp-seg">
        <button v-for="f in fontOptions" :key="f.id" class="sp-seg-btn" :class="{ active: settings.fontFamily === f.id }"
          @click="persistSettings({ fontFamily: f.id })">{{ f.name }}</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">字号大小</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepFontSize(-1)">−</button>
        <span class="sp-step-val">{{ settings.fontSize }}</span>
        <button class="sp-step-btn" @click="stepFontSize(1)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">行距</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepSetting('lineHeight', -0.1, 1.2, 2.8)">−</button>
        <span class="sp-step-val">{{ Number(settings.lineHeight).toFixed(1) }}</span>
        <button class="sp-step-btn" @click="stepSetting('lineHeight', 0.1, 1.2, 2.8)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">段距</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepSetting('paragraphSpacing', -0.1, 0, 2)">−</button>
        <span class="sp-step-val">{{ Number(settings.paragraphSpacing).toFixed(1) }}</span>
        <button class="sp-step-btn" @click="stepSetting('paragraphSpacing', 0.1, 0, 2)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">页面宽度</span>
      <div class="sp-seg">
        <button v-for="w in widthSteps" :key="w" class="sp-seg-btn" :class="{ active: Number(settings.contentWidth) === w }"
          @click="persistSettings({ contentWidth: w })">{{ w }}</button>
      </div>
    </div>
    <button class="sp-reset" @click="resetSettings">恢复默认设置</button>
    <div class="settings-hint">{{ shortcutHintText }}</div>
  </section>

  <!-- 正文阅读区(留白底色 + 正文"纸面" + 宽度手柄) -->
  <main id="reader" ref="readerRef" :class="{ 'resizing-width': resizingWidth }">
    <article id="content" ref="contentRef">
      <h2 class="chapter-title">{{ chapter ? chapter.title : '' }}</h2>
      <p v-if="paras.length === 0" class="empty-tip">(本章无内容)</p>
      <p v-for="(p, i) in paras" :key="i">{{ p }}</p>
    </article>
    <div ref="handleLeftRef" class="width-handle" :style="handleLeftStyle" aria-hidden="true"
      @pointerdown="beginWidthDrag('left', $event)"></div>
    <div ref="handleRightRef" class="width-handle" :style="handleRightStyle" aria-hidden="true"
      @pointerdown="beginWidthDrag('right', $event)"></div>
  </main>

  <!-- 悬浮球工具栏(上一章 / 目录 / 下一章 / 阅读设置) -->
  <div id="fabs" ref="fabsRef" :class="{ awake: store.fabAwake, dragging: store.fabDragging }" :style="fabStyle"
    @pointerdown="onFabPointerdown" @pointermove="onFabPointermove" @click="onFabClick">
    <button id="fabPrev" class="fab" title="上一章" :class="{ off: !chapter || chapter.index <= 0 }">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      <span class="fab-label">上一章</span>
    </button>
    <button id="fabCatalog" class="fab" title="目录">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
      <span class="fab-label">目录</span>
    </button>
    <button id="fabNext" class="fab" title="下一章" :class="{ off: !chapter || !store.novel || chapter.index >= store.novel.totalChapters - 1 }">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
      <span class="fab-label">下一章</span>
    </button>
    <button id="fabSettings" class="fab" title="阅读设置">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
      <span class="fab-label fab-label-sm">阅读设置</span>
    </button>
  </div>

  <!-- 底部状态栏(含整书进度条) -->
  <footer class="statusbar" ref="statusbarRef">
    <div class="progress-track"><div class="progress-fill" :style="{ width: progressPct + '%' }"></div></div>
    <div class="status-row">
      <span id="bookInfo">{{ bookInfoText }}</span>
      <span class="spacer"></span>
      <span id="chapterWords">{{ chapter ? fmtWords(chapter.chapterWords) : '' }}</span>
      <span id="chapterInfo">{{ fmtProgress() }}</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
/**
 * ReaderArea.vue — 正文阅读区(留白 + 纸面 + 左右宽度拖拽手柄)
 * 宽度拖拽与手柄定位自包含; resize 对齐由 App 调用 positionHandles()
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { previewAddLayout, layoutViewportWidth } from '../../../src/overlayLayout';
import { send, state, gotoChapter, type NoteItem } from '../composables/vscode';
import { findParagraph } from '../../../src/noteAnchor';
import { persistSettings, CONTENT_WIDTH, peekSuppressParaClick, setSuppressParaClick } from '../store';

// 与 settings.ts 的 CONTENT_WIDTH 一致: 上限放宽到 4000, 允许拖出窗口宽度(横向滚动)
const WIDTH_MIN = CONTENT_WIDTH.min;
const WIDTH_MAX = CONTENT_WIDTH.max;

/** 读 :root 上的 px 令牌(A3): 拿不到或不是 px 时回落到调用方给的默认值 */
function readCssPx(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const v = parseFloat(raw);
  return isFinite(v) && v > 0 ? v : fallback;
}

const readerRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const handleLeftRef = ref<HTMLElement | null>(null);
const handleRightRef = ref<HTMLElement | null>(null);
const handleLeftStyle = reactive({ left: 'auto', right: 'auto' });
const handleRightStyle = reactive({ left: 'auto', right: 'auto' });
/** 只显示当前章的错误/加载态(切章后旧状态不残留) */
const chapterError = computed(function () {
  const err = state.chapterError;
  const idx = state.chapter ? state.chapter.index : -1;
  return err && err.index === idx ? err : null;
});
const chapterLoading = computed(function () {
  const loading = state.chapterLoading;
  const idx = state.chapter ? state.chapter.index : -1;
  return !!loading && loading.index === idx;
});

/** 预览中的书: 一键转为正式书架 */
const previewing = computed(function () {
  return !!(state.novel && state.novel.online && state.novel.online.preview);
});

function savePreview(): void {
  // 防重复点击: 等扩展回 previewSaved / previewAddFailed 再解除
  if (state.previewAddPending) { return; }
  state.previewAddPending = true;
  send({ type: 'previewAddToShelf' });
}

/**
 * 视口右边到纸面右缘的实测距离(px)。
 *
 * 早先用 CSS `100vw - 纸面宽` 推算过, 但 webview 左侧还有 48px 导航栏、
 * 可能还有滚动条, 100vw 与纸面的真实位置对不上 —— 图标会算到正文里去。
 * 这里直接读 #content 的 getBoundingClientRect(), 与布局永远一致。
 */
const paperEdgePx = ref(0);
/**
 * 切章骨架屏。
 *
 * chapterLoading 到达时不能立刻显示 —— 缓存命中只要几十毫秒, 闪一下更难受;
 * 所以压 400ms: 超过 400ms 还没拿到正文才把旧内容换成骨架。
 */
const SKELETON_DELAY = 400;
const skeletonVisible = ref(false);
let skeletonTimer: ReturnType<typeof setTimeout> | null = null;
/** 骨架高度: 铺满纸面(min-height: calc(100vh - 120px))减去 padding 与标题占位 */
const skeletonStyle = ref<Record<string, string>>({});

function fitSkeleton(): void {
  const el = contentRef.value;
  if (!el) { return; }
  const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
  const padTop = cs ? parseFloat(cs.paddingTop) || 0 : 0;
  const padBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
  const titleEl = el.querySelector('.chapter-title') as HTMLElement | null;
  let titleBlock = 0;
  if (titleEl) {
    const tRect = titleEl.getBoundingClientRect();
    const tCs = window.getComputedStyle ? window.getComputedStyle(titleEl) : null;
    titleBlock = tRect.height + (tCs ? (parseFloat(tCs.marginTop) || 0) + (parseFloat(tCs.marginBottom) || 0) : 0);
  }
  const avail = el.getBoundingClientRect().height - padTop - padBottom - titleBlock;
  // 兜底 120px: 量不到高度(测试环境/首帧)时也至少给一条可读的骨架
  skeletonStyle.value = { height: Math.max(120, Math.round(avail)) + 'px' };
}

watch(function () { return state.chapterLoading; }, function (loading) {
  if (skeletonTimer) { clearTimeout(skeletonTimer); skeletonTimer = null; }
  if (!loading) {
    skeletonVisible.value = false;
    skeletonStyle.value = {};   // 复位: 否则下次会沿用它上次量到的高度(窗口缩小后偏大)
    return;
  }
  if (skeletonVisible.value) { return; }   // 连续切章: 不要回到旧内容再闪一次
  skeletonTimer = setTimeout(function () {
    skeletonTimer = null;
    if (state.chapterLoading) {
      // 先清空高度(配合 CSS height:0), 让这一帧的纸面仍是 min-height,
      // 量到的"可用高度"才准; 下一帧再撑满, 不会闪一屏超高内容
      skeletonStyle.value = {};
      skeletonVisible.value = true;
      void nextTick(function () { fitSkeleton(); });
    }
  }, SKELETON_DELAY);
}, { immediate: true });

/** 标题: 加载中先切到目标章名, 让"点了有反应"立刻成立 */
const displayTitle = computed(function () {
  const loading = state.chapterLoading;
  if (skeletonVisible.value && loading && loading.title) { return loading.title; }
  return chapter.value ? chapter.value.title : '';
});

/** 观察 #reader 尺寸变化(侧栏展开/收起动画) */
let rootObserver: ResizeObserver | null = null;

/**
 * 「加入书架」的水平位置(相对视口右边)。按钮固定 32px 见方, 只显示「+」, hover 出文字提示。
 *  - 留白够: 整颗落在纸面外侧(与纸边留 12px)
 *  - 留白不足(窄窗): 放进纸面内侧 2px —— 正好是 34px 的内边距, 不压正文
 * 垂直方向固定在距底 64px(= 两个自身高度), 见 .preview-add 的 bottom。
 */
const previewAddStyle = computed(function () {
  return { right: previewAddLayout(paperEdgePx.value).right + 'px' };
});

function retryChapter(): void {
  const idx = state.chapter ? state.chapter.index : -1;
  if (idx >= 0) { send({ type: 'retryChapter', index: idx }); }
}
/** 两侧章节箭头: 跟随正文(纸面)左右边缘, 而非窗口边缘 */
const sidePrevStyle = reactive({ left: 'auto', right: 'auto' });
const sideNextStyle = reactive({ left: 'auto', right: 'auto' });
const resizingWidth = ref(false);

const chapter = computed(() => state.chapter);
const paras = computed(() => (state.chapter && state.chapter.paragraphs) || []);

const isFirst = computed(() => !state.chapter || state.chapter.index <= 0);
const isLast = computed(() =>
  !state.chapter || !state.novel || state.chapter.index >= state.novel.totalChapters - 1
);

/** 两侧箭头显示模式: always 常驻(默认) / hover 鼠标移到箭头区域才显示 */
const sideNavHoverOnly = computed(() => state.settings?.sideNavMode === 'hover');
/** 彻底不渲染(纯键盘党): 连透明热区都不要, 避免误触 */
const sideNavHidden = computed(() => state.settings?.sideNavMode === 'hidden');

// ---------------------------------------------------------------- 笔记: 段落下划线标记
/**
 * 当前章节每个段落锚定的笔记(引文精确命中才收录)。
 * 持久下划线与悬浮预览共用这一份数据。
 */
const paraNotes = computed<Map<number, NoteItem[]>>(function () {
  const ch = state.chapter;
  const out = new Map<number, NoteItem[]>();
  if (!ch) { return out; }
  const filePath = (state.novel as { filePath?: string } | null)?.filePath || '';
  for (const n of state.notes) {
    if (n.bookPath !== filePath || n.chapterTitle !== ch.title) { continue; }
    const found = findParagraph(ch.paragraphs, n.paragraphIndex, n.quote);
    if (!found.exact) { continue; }
    const list = out.get(found.index);
    if (list) { list.push(n); } else { out.set(found.index, [n]); }
  }
  return out;
});

/** 正在新建笔记(卡片打开)的段落 → 高亮虚线下划线 */
const composerPara = computed<number>(function () {
  const c = state.noteComposer;
  const ch = state.chapter;
  if (!c || !ch || c.chapterTitle !== ch.title) { return -1; }
  return c.paragraphIndex;
});

/** mousedown 时是否已有文本选区(拖选复制/查词时不应弹卡片) */
let hadSelection = false;

function selectionActive(): boolean {
  const sel = window.getSelection();
  return !!(sel && !sel.isCollapsed && sel.toString().trim());
}

function onParaMouseDown(): void {
  hadSelection = selectionActive();
}

function onParaClick(index: number, e: MouseEvent): void {
  // 卡片开着时点其他段落的第一次点击只负责"关卡片"(App 在 mousedown 已关),
  // 这里吞掉该 click; 再点一次才选中新段落
  if (peekSuppressParaClick()) {
    setSuppressParaClick(false);
    return;
  }
  if (hadSelection) { hadSelection = false; return; }
  if (selectionActive()) { return; }
  const ch = state.chapter;
  if (!ch) { return; }
  const text = (ch.paragraphs[index] || '').trim();
  if (!text) { return; }
  if (resizingWidth.value) { return; }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // 该段落已有笔记 → 带入最近编辑的一条: 有内容先「查看」, 点编辑再改; 空内容直接进入编辑
  const existing = paraNotes.value.get(index);
  let latest: NoteItem | null = null;
  if (existing && existing.length) {
    latest = existing.reduce(function (a, b) { return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a; });
  }
  const hasContent = !!(latest && latest.text && latest.text.trim());
  state.noteComposer = {
    phase: hasContent ? 'viewing' : 'composing',
    chapterTitle: ch.title,
    chapterIndex: ch.index,
    paragraphIndex: index,
    quote: text,
    text: latest ? latest.text : '',
    editId: latest ? latest.id : undefined,
    anchorTop: rect.top,
    anchorBottom: rect.bottom,
    anchorLeft: rect.left,
  };
}

/** 滚动到指定段落并短暂高亮; 引文找不到时落到 hint 附近 */
function scrollToParagraph(target: { paragraphIndex: number; quote: string }): { index: number; exact: boolean } {
  const ch = state.chapter;
  const found = ch
    ? findParagraph(ch.paragraphs, target.paragraphIndex, target.quote)
    : { index: target.paragraphIndex, exact: false };
  const el = document.querySelector('#content p[data-p="' + found.index + '"]') as HTMLElement | null;
  if (!el) { return found; }
  el.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  // 重复跳转先清掉旧高亮, 避免多处同时闪
  document.querySelectorAll('#content p.note-focus').forEach(function (n) { n.classList.remove('note-focus'); });
  el.classList.add('note-focus');
  window.setTimeout(function () { el.classList.remove('note-focus'); }, 3600);
  return found;
}

function prevChapter(): void {
  if (state.chapter && !isFirst.value) { gotoChapter(state.chapter.index - 1, 'prev'); }
}
function nextChapter(): void {
  if (state.chapter && !isLast.value) { gotoChapter(state.chapter.index + 1, 'next'); }
}

function positionHandles(): void {
  if (!contentRef.value) { return; }
  const rect = contentRef.value.getBoundingClientRect();
  // 视口宽必须用 clientWidth(不含滚动条), 否则"纸面右缘"会系统性偏右 8px
  const viewW = layoutViewportWidth();
  const readerRect = readerRef.value
    ? readerRef.value.getBoundingClientRect()
    : { left: 0, right: viewW };
  handleLeftStyle.left = rect.left - readerRect.left + 'px';
  handleLeftStyle.right = 'auto';
  handleRightStyle.right = readerRect.right - rect.right + 'px';
  handleRightStyle.left = 'auto';
  // 两侧章节箭头: 锚在纸面左右边缘外侧(而非窗口边缘); 内容宽过窗口时贴边
  // 尺寸从 CSS 令牌读(A3): 以前这里写死 56/12, 与 .side-nav 的 width 各存一份,
  // 改按钮宽度后箭头会压到正文或飞出视口
  const NAV_W = readCssPx('--side-nav-w', 56);
  const NAV_GAP = readCssPx('--side-nav-gap', 12);
  sidePrevStyle.left = Math.max(4, rect.left - NAV_W - NAV_GAP) + 'px';
  sidePrevStyle.right = 'auto';
  // 与「+」按钮共用同一个 gap, 顺带修掉两侧箭头同款的 8px 偏差
  const gap = Math.max(0, viewW - rect.right);
  const navRight = Math.max(4, gap - NAV_W - NAV_GAP);
  sideNextStyle.right = navRight + 'px';
  sideNextStyle.left = 'auto';
  paperEdgePx.value = gap;
  if (skeletonVisible.value) { fitSkeleton(); }
}

let widthDrag: { side: 'left' | 'right'; startX: number; startW: number; handle: HTMLElement } | null = null;

function beginWidthDrag(side: 'left' | 'right', e: PointerEvent): void {
  if (e.button !== 0 || !contentRef.value) { return; }
  e.preventDefault();
  const handle = side === 'left' ? handleLeftRef.value : handleRightRef.value;
  if (!handle) { return; }
  widthDrag = { side: side, startX: e.clientX, startW: contentRef.value.getBoundingClientRect().width, handle: handle };
  resizingWidth.value = true;
  // 拖拽期间一律按「自定义」处理: 允许拖过窗口宽度, 由文档横向滚动承载
  document.documentElement.dataset.widthMode = 'custom';
  // 命中窄窗口时实际渲染宽度可能小于设定值, 先把变量钉到当前渲染宽度, 避免按下瞬间跳宽
  document.documentElement.style.setProperty('--content-width', Math.round(widthDrag.startW) + 'px');
  // 捕获指针: 保证松手(手指抬起)即结束拖拽
  if (handle.setPointerCapture && e.pointerId !== undefined) {
    try { handle.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }
  document.body.style.userSelect = 'none';
  positionHandles();
}

function moveWidthDrag(e: PointerEvent): void {
  if (!widthDrag) { return; }
  const delta = e.clientX - widthDrag.startX;
  // 左缘向右拖 → 变窄; 右缘向右拖 → 变宽; 上限放开到 CONTENT_WIDTH.max, 超出窗口即横向滚动
  const factor = widthDrag.side === 'left' ? -1 : 1;
  const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(widthDrag.startW + factor * delta)));
  document.documentElement.style.setProperty('--content-width', next + 'px');
  positionHandles();
}

function endWidthDrag(e: PointerEvent): void {
  if (!widthDrag) { return; }
  if (widthDrag.handle.releasePointerCapture && e.pointerId !== undefined) {
    try { widthDrag.handle.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }
  resizingWidth.value = false;
  document.body.style.userSelect = '';
  const finalW = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--content-width')
  );
  if (isFinite(finalW) && finalW > 0) {
    // 拖拽 = 自定义像素宽度: 同时关掉比例档, 否则会被比例覆盖
    persistSettings({ contentWidth: Math.round(finalW), widthRatio: 0 });
  }
  widthDrag = null;
}

onMounted(function () {
  document.addEventListener('pointermove', function (e: PointerEvent) { moveWidthDrag(e); });
  document.addEventListener('pointerup', function (e: PointerEvent) { endWidthDrag(e); });
  document.addEventListener('pointercancel', function (e: PointerEvent) { endWidthDrag(e); });
  window.addEventListener('resize', positionHandles);
  // 侧栏 48<->176px 展开动画只改 --menu-w, 不改 body 尺寸(ResizeObserver(body) 收不到),
  // 但会改变 #reader 宽度 -> 观察自身根节点, 动画每帧重算, 按钮与箭头不会滞留旧位置
  if (typeof ResizeObserver !== 'undefined' && readerRef.value) {
    rootObserver = new ResizeObserver(function () { positionHandles(); });
    rootObserver.observe(readerRef.value);
  }
  requestAnimationFrame(positionHandles);
});

onUnmounted(function () {
  if (rootObserver) { rootObserver.disconnect(); rootObserver = null; }
  if (skeletonTimer) { clearTimeout(skeletonTimer); skeletonTimer = null; }
  window.removeEventListener('resize', positionHandles);
});

defineExpose({ positionHandles, scrollToParagraph });
</script>

<template>
  <main id="reader" ref="readerRef" :class="{ 'resizing-width': resizingWidth }">
    <!-- 预览书专属动作: 固定悬浮在纸面右上角(不随滚动消失), 水平位置由 CSS 对齐纸面右缘 -->
    <button v-if="previewing" class="preview-add" :style="previewAddStyle" data-preview-add
      :disabled="state.previewAddPending"
      :data-tip="state.previewAddPending ? '正在加入书架…' : '加入书架'"
      aria-label="加入书架" @click.stop="savePreview">+</button>
    <article id="content" ref="contentRef">
      <h2 class="chapter-title">{{ displayTitle }}</h2>
      <div v-if="chapterError" class="empty-tip reader-error" data-chapter-error>
        <span>章节加载失败：{{ chapterError.message }}</span>
        <button class="popup-primary" data-chapter-retry @click="retryChapter">重试</button>
      </div>
      <!-- 慢网: 超过 400ms 仍未拿到正文 -> 旧内容换成骨架条(而不是整屏卡住) -->
      <div v-else-if="skeletonVisible" class="chapter-skeleton" data-chapter-loading
        data-chapter-skeleton aria-busy="true" :style="skeletonStyle">
        <span class="sr-only">正在加载章节…</span>
        <span v-for="n in 30" :key="n" class="sk-line"></span>
      </div>
      <!-- 加载中即使正文为空也不能说"本章无内容"(要等这一轮出结果) -->
      <p v-else-if="paras.length === 0 && !state.chapterLoading" class="empty-tip">(本章无内容)</p>
      <template v-else>
        <!-- 建/看笔记的唯一入口: 单击段落本体(v1.48.18 起不再有段落级徽章) -->
        <p v-for="(p, i) in paras" :key="i" class="rd-para" :data-p="i"
          :class="{ 'rd-para-noted': paraNotes.has(i), 'rd-para-active': composerPara === i }"
          @mousedown="onParaMouseDown" @click="onParaClick(i, $event)">
          {{ p }}
        </p>
      </template>
    </article>

    <!-- 正文两侧: 上/下一章箭头(垂直居中, 跟随正文左右边缘; 阅读设置可切 常驻/悬浮/隐藏) -->
    <button v-if="!sideNavHidden" class="side-nav side-nav-prev" :class="{ 'hover-only': sideNavHoverOnly }" :style="sidePrevStyle"
      :disabled="isFirst || skeletonVisible" title="上一章 (Alt+←)" aria-label="上一章" @click="prevChapter">
      <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
        <path d="M213.752501 517.216385a90.360598 90.360598 0 0 0 2.336192 12.265012 60.490705 60.490705 0 0 0 15.185253 27.366829l3.504289 3.504289L695.759123 1003.895393A65.16309 65.16309 0 0 0 747.071928 1023.753031a63.911558 63.911558 0 0 0 61.825672-66.748364 65.413397 65.413397 0 0 0-20.441686-41.717727L373.197655 516.632336c-1.168096-1.168096-2.336193-1.752145-4.672386-4.088337a20.942299 20.942299 0 0 0 5.256434-2.920241Q581.786292 310.296457 789.62401 110.301671a66.748364 66.748364 0 0 0 21.025735-39.047793c0-0.584048 0.584048-0.584048 0.584048-1.168096l0-13.099366c0-0.584048-0.584048-1.168096-0.584048-2.336193a62.826898 62.826898 0 0 0-47.808516-51.312805l-9.928819-2.336193-14.017157-1e-8c0 0.584048-0.584048 0.584048-1.168096 0.58404901a64.745913 64.745913 0 0 0-40.799937 20.942299c-29.703022 29.118974-60.073527 57.737335-90.360598 86.856308l-369.53563 355.601909a55.317707 55.317707 0 0 0-15.769301 22.694444c-2.920241 8.34354499-5.256434 16.687091-7.592626 24.446588z" />
      </svg>
    </button>
    <button v-if="!sideNavHidden" class="side-nav side-nav-next" :class="{ 'hover-only': sideNavHoverOnly }" :style="sideNextStyle"
      :disabled="isLast || skeletonVisible" title="下一章 (Alt+→)" aria-label="下一章" @click="nextChapter">
      <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
        <path d="M810.247499 506.783615a90.360598 90.360598 0 0 0-2.336192-12.265012 60.490705 60.490705 0 0 0-15.185253-27.366829l-3.504289-3.504289L328.240877 20.104607A65.16309 65.16309 0 0 0 276.928072 0.246969a63.911558 63.911558 0 0 0-61.825672 66.748364 65.413397 65.413397 0 0 0 20.441686 41.717727L650.802345 507.367664c1.168096 1.168096 2.336193 1.752145 4.672386 4.088337a20.942299 20.942299 0 0 0-5.256434 2.920241Q442.213708 713.703543 234.37599 913.698329a66.748364 66.748364 0 0 0-21.025735 39.047793c0 0.584048-0.584048 0.584048-0.584048 1.168096v13.099366c0 0.584048 0.584048 1.168096 0.584048 2.336193a62.826898 62.826898 0 0 0 47.808516 51.312805l9.928819 2.336193h14.017157c0-0.584048 0.584048-0.584048 1.168096-0.584049a64.745913 64.745913 0 0 0 40.799937-20.942299c29.703022-29.118974 60.073527-57.737335 90.360598-86.856308l369.53563-355.601909a55.317707 55.317707 0 0 0 15.769301-22.694444c2.920241-8.343545 5.256434-16.687091 7.592626-24.446588z" />
      </svg>
    </button>

    <!-- 章节底部导航(纸面外侧, 跟随页面滚动) -->
    <div class="ch-nav" v-if="chapter">
      <button class="ch-nav-btn" :disabled="isFirst || skeletonVisible" @click="prevChapter">← 上一章</button>
      <button class="ch-nav-btn" :disabled="isLast || skeletonVisible" @click="nextChapter">下一章 →</button>
    </div>
    <div ref="handleLeftRef" class="width-handle" :style="handleLeftStyle" aria-hidden="true"
      @pointerdown="beginWidthDrag('left', $event)"></div>
    <div ref="handleRightRef" class="width-handle" :style="handleRightStyle" aria-hidden="true"
      @pointerdown="beginWidthDrag('right', $event)"></div>
  </main>
</template>

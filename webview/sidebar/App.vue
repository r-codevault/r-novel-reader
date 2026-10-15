<script setup lang="ts">
/**
 * App.vue — 侧边栏根组件: 书架 / 目录 / 设置 三面板 + 扩展消息
 * 行为与旧内嵌脚本一一等价:
 *  - 「当前阅读」条 sticky 悬浮, 点击回到当前章节( scrollIntoView block:center )
 *  - 切回目录模式时重新定位到当前章(隐藏期间 scrollIntoView 不生效)
 *  - 换书后重定位, 避免沿用上一本书的滚动位置
 */
import { computed, nextTick, ref, watch } from 'vue';
import { state, send, novelKey, type NovelPayload, type ShelfItemView, type ViewMode } from './store';
import { ICON_BOOK, ICON_PLAY, ICON_SHELF_BOOK, ICON_CLOSE } from './icons';
import './sidebar.css';

// ---------------------------------------------------------------- 目录
const chapterListRef = ref<HTMLElement | null>(null);
const renderedKey = ref('');

const hasNovelBooks = computed(function () {
  return state.hasNovel && state.chapters.length > 0;
});

const currentTitle = computed(function () {
  const ch = state.chapters[state.currentIndex];
  return ch ? ch.title : '尚未选择章节';
});

/** 点击/命令设置当前章; center=true 滚动定位到列表中间 */
function setCurrent(index: number, center: boolean): void {
  state.currentIndex = index;
  if (center) {
    nextTick(function () {
      const el = chapterListRef.value
        ? chapterListRef.value.querySelector('.ch.cur')
        : null;
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    });
  }
}

function onChapterClick(c: { index: number; title: string }): void {
  setCurrent(c.index, false);
  send({ type: 'openChapter', index: c.index });
}

// ---------------------------------------------------------------- 书架
const shelfHas = computed(function () {
  return state.shelf.length > 0;
});

function shelfProgress(b: ShelfItemView): string {
  return b.chapterIndex >= 0
    ? '读至 第 ' + (b.chapterIndex + 1) + ' 章' + (b.totalChapters ? ' / 共 ' + b.totalChapters + ' 章' : '')
    : b.totalChapters
      ? '共 ' + b.totalChapters + ' 章 · 未开始'
      : '未开始阅读';
}

function onShelfClick(b: ShelfItemView, ev: MouseEvent): void {
  const target = ev.target as HTMLElement;
  if (target.closest && target.closest('.bk-del')) {
    ev.stopPropagation();
    send({ type: 'removeBook', filePath: b.filePath });
    return;
  }
  send({ type: 'openBook', filePath: b.filePath });
}

// ---------------------------------------------------------------- 模式切换
watch(function () { return state.mode; }, function (mode: ViewMode) {
  // 切回目录模式时重新定位到当前章(书架模式下列表隐藏, scrollIntoView 不生效)
  if (mode === 'chapters' && state.currentIndex >= 0) {
    setCurrent(state.currentIndex, true);
  }
});

// ---------------------------------------------------------------- 扩展消息
function handleExtensionMessage(msg: { type?: string } & Record<string, unknown>): void {
  if (!msg || !msg.type) { return; }
  switch (msg.type) {
    case 'mode':
      state.mode = msg.mode as ViewMode;
      break;
    case 'shelf':
      state.shelf = (msg.items as ShelfItemView[]) || [];
      break;
    case 'library':
      state.libraryPath = (msg.path as string) || '';
      break;
    case 'novel': {
      const p = msg.payload as NovelPayload;
      state.hasNovel = p.hasNovel;
      state.bookTitle = p.bookTitle;
      state.chapters = p.chapters || [];
      const key = novelKey();
      const bookChanged = key !== renderedKey.value;
      if (bookChanged) {
        renderedKey.value = key;
        state.currentIndex = -1;
      }
      const idx = typeof p.currentIndex === 'number' ? p.currentIndex : -1;
      state.hasNovel = p.hasNovel;
      // 换书/重建列表后滚动定位到当前章
      if (hasNovelBooks.value) {
        setCurrent(idx, bookChanged && idx >= 0);
      } else {
        state.currentIndex = -1;
      }
      break;
    }
    case 'current':
      setCurrent(msg.index as number, !!msg.center);
      break;
  }
}

// ---------------------------------------------------------------- 生命周期
import { onMounted } from 'vue';
onMounted(function () {
  window.addEventListener('message', function (e: MessageEvent) {
    handleExtensionMessage(e.data as { type?: string } & Record<string, unknown>);
  });
  // 通知扩展: webview 就绪(扩展会回推全量状态)
  send({ type: 'ready' });
});
</script>

<template>
  <!-- 书架 -->
  <div class="pane" :class="{ active: state.mode === 'shelf' }">
    <div class="list" id="shelfList">
      <div v-for="b in state.shelf" :key="b.filePath" class="bk" :class="{ cur: b.current }"
        :data-p="b.filePath" :title="b.title" @click="onShelfClick(b, $event)">
        <span class="ico" v-html="b.current ? ICON_PLAY : ICON_SHELF_BOOK"></span>
        <span class="bk-main">
          <span class="bk-title">{{ b.title }}</span>
          <span class="bk-sub">{{ shelfProgress(b) }}{{ b.author ? ' · ' + b.author : '' }}</span>
        </span>
        <span class="bk-del" :data-del="b.filePath" title="从书架移除" v-html="ICON_CLOSE"></span>
      </div>
    </div>
    <div class="empty" v-show="!shelfHas">
      <p>书架空空如也。</p>
      <button @click="send({ type: 'openFile' })">添加书籍</button>
    </div>
    <div class="shelf-foot" v-show="shelfHas">
      <button class="shelf-add" title="添加本地 txt 小说" @click="send({ type: 'openFile' })">＋ 添加书籍</button>
      <div class="shelf-count">共 {{ state.shelf.length }} 本 · 阅读进度自动记录</div>
    </div>
  </div>

  <!-- 目录 -->
  <div class="pane" :class="{ active: state.mode === 'chapters' }">
    <div id="currentWrap" :class="{ visible: hasNovelBooks }">
      <div id="currentCard" role="button" tabindex="0" title="点击回到当前章节"
        @click="send({ type: 'resumeCurrent' })"
        @keydown="function onKey(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); send({ type: 'resumeCurrent' }); } }">
        <span class="ico ico-reading" v-html="ICON_PLAY"></span>
        <span class="k">当前阅读</span>
        <span class="t">{{ currentTitle }}</span>
        <span class="hint">回到本章</span>
      </div>
    </div>
    <div class="list" ref="chapterListRef" role="listbox" aria-label="章节目录" v-show="hasNovelBooks">
      <div v-for="c in state.chapters" :key="c.index" class="ch" :data-i="c.index" :title="c.title"
        :class="{ cur: c.index === state.currentIndex }" @click="onChapterClick(c)">
        <span class="ico" v-html="c.index === state.currentIndex ? ICON_PLAY : ICON_BOOK"></span>
        <span class="tt">{{ c.title }}</span>
      </div>
    </div>
    <div class="empty" v-show="!hasNovelBooks">
      <p>尚未打开小说。</p>
      <button @click="send({ type: 'openFile' })">添加书籍</button>
      <button @click="send({ type: 'showShelf' })">查看我的书架</button>
    </div>
  </div>

  <!-- 设置 -->
  <div class="pane" :class="{ active: state.mode === 'settings' }">
    <div class="set-sec">
      <div class="set-h">存储位置</div>
      <div class="set-row">
        <span class="set-label">书库目录</span>
        <span class="set-val" :class="{ empty: !state.libraryPath }"
          :title="state.libraryPath">{{ state.libraryPath || '未设置 · 读取文件原路径' }}</span>
      </div>
      <div class="set-actions">
        <button class="set-btn" @click="send({ type: 'pickLibrary' })">选择书库目录…</button>
        <button class="set-btn" :class="{ hidden: !state.libraryPath }" @click="send({ type: 'openLibraryFolder' })">在文件管理器中打开</button>
        <button class="set-btn" :class="{ hidden: !state.libraryPath }" @click="send({ type: 'clearLibrary' })">使用原路径（不拷贝）</button>
      </div>
      <p class="set-tip">默认不设置：直接读取你选择的文件原路径。设置书库目录后，<b>导入时会把小说复制到该目录</b>并从副本读取，原文件之后可以自行移动或删除；同名文件会自动改名，不会覆盖。</p>
    </div>
    <div class="set-sec" style="border-bottom:none">
      <p class="set-tip">阅读设置（字号 / 字体 / 主题）在阅读页右侧工具栏的「阅读设置」按钮里调整。</p>
    </div>
  </div>
</template>

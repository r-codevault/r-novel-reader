/**
 * noteMode.ts — 笔记本模式 + 段落笔记按钮的 roving tabindex。
 *
 * 为什么需要：正文里每段都放一个「添加笔记」按钮，一章 100+ 段就是 100+ 个
 * Tab 停靠点，键盘用户根本走不完正文。roving tabindex 让整组只占 **1 个**
 * 停靠点：只有"游标那一段"的按钮 `tabindex=0`，其余 `-1`，方向键移动游标。
 *
 * 开关入口（PRD Q2 / D8）：侧栏菜单开关 + `Alt+N`。刻意不做正文浮动工具条，
 * 那会改变"左侧导航—居中纸面—底部状态栏"的布局。
 */
import { nextTick } from 'vue';
import { state } from './vscode';

/** 开启时记住焦点元素，关闭时回位（模块级变量，不必进响应式 state） */
let returnFocusEl: HTMLElement | null = null;

/** 段落按钮的选择器 */
function paraBtn(index: number): HTMLElement | null {
  return document.querySelector('[data-para-btn="' + index + '"]') as HTMLElement | null;
}

/** 当前章段落是否"非空"（空白段落不给停靠点，否则方向键每次都停在空行上） */
function isNonEmptyPara(index: number): boolean {
  const ch = state.chapter;
  if (!ch || !ch.paragraphs) { return false; }
  const text = ch.paragraphs[index];
  return typeof text === 'string' && text.trim().length > 0;
}

/** 首个非空段落（没有则 0） */
export function firstNonEmptyPara(): number {
  const ch = state.chapter;
  if (!ch || !ch.paragraphs) { return 0; }
  for (let i = 0; i < ch.paragraphs.length; i += 1) {
    if (isNonEmptyPara(i)) { return i; }
  }
  return 0;
}

/** 最后一个非空段落 */
export function lastNonEmptyPara(): number {
  const ch = state.chapter;
  if (!ch || !ch.paragraphs) { return 0; }
  for (let i = ch.paragraphs.length - 1; i >= 0; i -= 1) {
    if (isNonEmptyPara(i)) { return i; }
  }
  return 0;
}

/** 从 from 出发按 delta 找下一个非空段落；到边界就停住（不循环） */
function nextNonEmptyPara(from: number, delta: 1 | -1): number {
  const ch = state.chapter;
  if (!ch || !ch.paragraphs) { return from; }
  let i = from + delta;
  while (i >= 0 && i < ch.paragraphs.length) {
    if (isNonEmptyPara(i)) { return i; }
    i += delta;
  }
  return from;
}

/**
 * 该段按钮是否参与 Tab 序列。
 * 默认 `-1`（不进 Tab 序列）；只有笔记模式开启且是游标段时才是 0。
 */
export function paraTabIndex(index: number): number {
  return state.noteMode && index === state.noteParaCursor ? 0 : -1;
}

/** 切换笔记模式。关闭时把焦点还给入口开关（PRD R1-06） */
export function toggleNoteMode(): void {
  state.noteMode = !state.noteMode;
  if (state.noteMode) {
    returnFocusEl = (document.activeElement as HTMLElement | null) || null;
    state.noteParaCursor = firstNonEmptyPara();
    nextTick(function () {
      const btn = paraBtn(state.noteParaCursor);
      if (btn) { btn.focus(); }
    });
    return;
  }
  state.noteParaCursor = 0;
  const target = returnFocusEl && document.body.contains(returnFocusEl)
    ? returnFocusEl
    : (document.querySelector('[data-menu="note-mode"]') as HTMLElement | null);
  returnFocusEl = null;
  nextTick(function () {
    if (target && typeof target.focus === 'function') { target.focus(); }
  });
}

/** 游标移动（方向键）；移动后把焦点同步到新按钮 */
export function moveParaCursor(delta: 1 | -1): void {
  const next = nextNonEmptyPara(state.noteParaCursor, delta);
  if (next === state.noteParaCursor) { return; }
  state.noteParaCursor = next;
  nextTick(function () {
    const btn = paraBtn(next);
    if (btn) { btn.focus(); }
  });
}

/** 跳到首/末非空段落（Home / End） */
export function moveParaCursorTo(edge: 'first' | 'last'): void {
  const next = edge === 'first' ? firstNonEmptyPara() : lastNonEmptyPara();
  if (next === state.noteParaCursor) { return; }
  state.noteParaCursor = next;
  nextTick(function () {
    const btn = paraBtn(next);
    if (btn) { btn.focus(); }
  });
}

/** 切章后重置游标（段落数变了，旧下标没有意义） */
export function resetCursorForChapter(): void {
  state.noteParaCursor = firstNonEmptyPara();
}

/** 段落按钮上的键盘绑定（由 ReaderArea 调用） */
export function onParaBtnKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    moveParaCursor(1);
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    moveParaCursor(-1);
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    moveParaCursorTo('first');
    return;
  }
  if (e.key === 'End') {
    e.preventDefault();
    moveParaCursorTo('last');
  }
}

/** 段落按钮的可访问名称：已笔记 => 查看笔记；否则 => 添加笔记（带段落序号便于定位） */
export function paraBtnLabel(index: number, hasNote: boolean): string {
  const head = hasNote ? '查看笔记' : '添加笔记';
  return head + '：第 ' + (index + 1) + ' 段';
}

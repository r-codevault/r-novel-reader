<script setup lang="ts">
/**
 * NoteComposer.vue — 新建笔记卡片
 *
 * 由正文段落单击触发(state.noteComposer 非空即显示):
 *  - 默认引用整段原文, textarea 自动聚焦
 *  - Esc / 取消 → 丢弃草稿(不发消息); Ctrl/Cmd+Enter 或「保存」→ 发 addNote
 *  - 保存成功后由 App 关闭(收到 noteUpserted); 失败保留草稿并提示
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { state, send } from '../composables/vscode';

const textRef = ref<HTMLTextAreaElement | null>(null);

const comp = computed(function () { return state.noteComposer; });

/** 卡片定位: 段落下方优先, 空间不足翻到上方; 水平夹取 */
const cardStyle = computed(function () {
  const c = state.noteComposer;
  if (!c) { return {}; }
  const margin = 8;
  const w = Math.min(420, window.innerWidth - 32);
  const estH = 214;
  let top = c.anchorBottom + margin;
  if (top + estH > window.innerHeight - margin) {
    top = Math.max(margin, c.anchorTop - estH - margin);
  }
  const left = Math.max(margin, Math.min(c.anchorLeft, window.innerWidth - w - margin));
  return { top: top + 'px', left: left + 'px', width: w + 'px' };
});

function focusInput(): void {
  nextTick(function () {
    const el = textRef.value;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
}
onMounted(focusInput);
watch(function () { return state.noteComposer && state.noteComposer.paragraphIndex; }, focusInput);

function cancel(): void {
  state.noteComposer = null;
}

function save(): void {
  const c = state.noteComposer;
  if (!c || c.phase === 'saving') { return; }
  // 允许空正文: 只引用原文、不写想法也能存下来
  const text = (c.text || '').trim();
  c.phase = 'saving';
  c.error = '';
  send({
    type: 'addNote',
    chapterTitle: c.chapterTitle,
    chapterIndex: c.chapterIndex,
    paragraphIndex: c.paragraphIndex,
    quote: c.quote,
    text,
  });
}

function onKeydown(e: KeyboardEvent): void {
  // 卡片内的按键不再冒泡到 App(否则 Esc 会顺手关掉整个抽屉/菜单)
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
    e.preventDefault();
    save();
  }
}
</script>

<template>
  <div v-if="comp" class="note-composer" :style="cardStyle" @click.stop @keydown="onKeydown">
    <div class="nc-head">
      <span class="nc-title">新建笔记</span>
      <span class="spacer"></span>
      <span class="nc-chap" :title="comp.chapterTitle">{{ comp.chapterTitle }}</span>
    </div>
    <div class="nc-quote" :title="comp.quote">{{ comp.quote }}</div>
    <textarea ref="textRef" class="nc-text" v-model="comp.text" rows="3"
      placeholder="写点什么…" @input="comp.error = ''"></textarea>
    <div class="nc-foot">
      <span class="nc-err">{{ comp.error || '' }}</span>
      <span class="spacer"></span>
      <span class="nc-hint">Esc 取消 · Ctrl+Enter 保存</span>
      <button class="nc-btn" @click="cancel()">取消</button>
      <button class="nc-btn nc-btn-primary" :disabled="comp.phase === 'saving'"
        @click="save()">{{ comp.phase === 'saving' ? '保存中…' : '保存' }}</button>
    </div>
  </div>
</template>

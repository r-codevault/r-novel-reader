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
  const estH = c.phase === 'viewing' ? 150 : 214;
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

/** 查看卡片 → 编辑: 进入编辑态(textarea 带入内容) */
function startEdit(): void {
  const c = state.noteComposer;
  if (!c || c.phase !== 'viewing') { return; }
  c.phase = 'composing';
  pendingDelete.value = false;
  focusInput();
}

/** 查看卡片 → 删除: 两步确认, 确认态常驻(点「确认删除」才移除; 「取消」或点卡片外回退) */
const pendingDelete = ref(false);
function requestDelete(): void {
  const c = state.noteComposer;
  if (!c || !c.editId) { return; }
  if (pendingDelete.value) {
    pendingDelete.value = false;
    send({ type: 'removeNote', id: c.editId });
    state.noteComposer = null;
    return;
  }
  pendingDelete.value = true;
}
function cancelDelete(): void {
  pendingDelete.value = false;
}
// 卡片关闭/换笔记时回退删除确认态
watch(function () { return state.noteComposer; }, function (c) {
  if (!c) { pendingDelete.value = false; }
});

function save(): void {
  const c = state.noteComposer;
  if (!c || c.phase !== 'composing') { return; }
  // 保存前回退删除确认态, 避免确认残留
  pendingDelete.value = false;
  // 允许空正文: 只引用原文、不写想法也能存下来
  const text = (c.text || '').trim();
  c.phase = 'saving';
  c.error = '';
  if (c.editId) {
    // 带入了已有笔记: 保存即更新该条
    send({ type: 'updateNote', id: c.editId, text });
    return;
  }
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
      <span class="nc-title">{{ comp.phase === 'viewing' ? '笔记' : (comp.editId ? '编辑笔记' : '新建笔记') }}</span>
      <span class="spacer"></span>
      <span class="nc-chap" :title="comp.chapterTitle">{{ comp.chapterTitle }}</span>
    </div>
    <template v-if="comp.phase === 'viewing'">
      <div class="nc-view-text">{{ comp.text && comp.text.trim() ? comp.text : '（未填写内容）' }}</div>
      <div class="nc-foot">
        <button class="nc-btn nc-btn-primary" @click="startEdit()">编辑</button>
        <button class="nc-btn" :class="{ 'nc-btn-danger': pendingDelete }" @click="requestDelete()">
          {{ pendingDelete ? '确认删除' : '删除' }}</button>
        <button v-if="pendingDelete" class="nc-btn" data-cancel @click="cancelDelete()">取消</button>
      </div>
    </template>
    <template v-else>
      <textarea ref="textRef" class="nc-text" v-model="comp.text" rows="3"
        aria-label="笔记内容" placeholder="写点什么…" @input="comp.error = ''"></textarea>
      <div class="nc-foot nc-foot-stack">
        <!-- 两行布局: 按钮行在上, 提示/错误行在下 -->
        <div class="nc-foot-line">
          <button v-if="comp.editId" class="nc-btn" :class="{ 'nc-btn-danger': pendingDelete }"
            @click="requestDelete()">{{ pendingDelete ? '确认删除' : '删除' }}</button>
          <button v-if="pendingDelete" class="nc-btn" data-cancel @click="cancelDelete()">取消</button>
          <span class="spacer"></span>
          <button class="nc-btn" @click="cancel()">取消</button>
          <button class="nc-btn nc-btn-primary" :disabled="comp.phase === 'saving'"
            @click="save()">{{ comp.phase === 'saving' ? '保存中…' : '保存' }}</button>
        </div>
        <div class="nc-foot-line">
          <span v-if="comp.error" class="nc-err" role="alert">{{ comp.error }}</span>
          <span class="nc-hint">Esc 取消 · Ctrl+Enter 保存</span>
        </div>
      </div>
    </template>
  </div>
</template>

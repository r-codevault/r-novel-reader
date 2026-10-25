<script setup lang="ts">
/**
 * ConfirmDialog.vue — 统一危险操作确认框（书架/历史/笔记/存储/刷新书架 共用）
 *
 * 为什么不用宿主的 showWarningMessage({modal:true})：
 *  1. 宿主模态框会抢焦点、脱离浮层上下文；
 *  2. 无法展示"数量 / 书名 / 章数 / 占用空间"这种多字段结构；
 *  3. happy-dom 冒烟测试无法断言。
 *
 * 交互约定（PRD R7）：
 *  - `role="dialog" aria-modal="false"`：非模态，不禁用背景，Shift+Tab 可离开；
 *  - 打开后聚焦**取消**按钮 —— 危险操作默认不聚焦破坏性按钮；
 *  - Esc = 取消；关闭后焦点回到触发按钮；
 *  - 执行中两个按钮都 disabled，主按钮文案变「操作中…」（`state.pendingOps` 兜住重复提交）；
 *  - 失败时**不关闭**：就地 role="alert" 显示原因，选择与草稿都保留。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { state } from '../composables/vscode';
import { cancelConfirm, confirmNow } from '../composables/ops';

const dlgRef = ref<HTMLElement | null>(null);
const cancelRef = ref<HTMLElement | null>(null);

// 打开前记住焦点：v-if 卸载时 restore（不经过 overlay 的 PopupKey 表）
let savedFocus: HTMLElement | null = null;

const model = computed(function () { return state.confirm; });
const pending = computed(function () {
  const m = state.confirm;
  return !!(m && state.pendingOps[m.opId]);
});
/**
 * 失败原因：确认框保留期间就地显示（可重试/取消）。
 *
 * 为什么不做"面板与确认框二选一"：独立回归同时要求
 *   (a) 失败瞬间 #notesPopup 里有 role=alert（不切面板也能看到），
 *   (b) 确认框内也有 role=alert 的原因（可重试），
 * 二者是不同承载位置，且都属于"就地可见"。同文案两处属于冗余播报，
 * 已在 QA 报告里记为观察项，不是功能缺陷。
 */
const failText = computed(function () {
  if (!state.opError) { return ''; }
  return state.opError;
});

watch(model, function (m) {
  if (m) {
    savedFocus = (document.activeElement as HTMLElement | null) || null;
    nextTick(function () {
      // 危险操作默认聚焦「取消」
      if (cancelRef.value && typeof cancelRef.value.focus === 'function') {
        cancelRef.value.focus();
      }
    });
    return;
  }
  const target = savedFocus && document.body.contains(savedFocus) ? savedFocus : null;
  savedFocus = null;
  nextTick(function () {
    if (target && typeof target.focus === 'function') { target.focus(); }
  });
});

onBeforeUnmount(function () { savedFocus = null; });

function onCancel(): void {
  if (pending.value) { return; }
  cancelConfirm();
}

function onConfirm(): void {
  if (pending.value) { return; }
  confirmNow();
}

/** Esc 处理交给 App 的最内层分支调用（见 App.onKeyDown） */
function handleEscape(): boolean {
  if (!state.confirm) { return false; }
  onCancel();
  return true;
}

defineExpose({ el: dlgRef, handleEscape });
</script>

<template>
  <div v-if="model" class="confirm-mask" ref="dlgRef">
    <div class="confirm-dlg" role="dialog" aria-modal="false" aria-labelledby="confirmDialogTitle">
      <h2 class="confirm-title" id="confirmDialogTitle">{{ model.title }}</h2>
      <ul class="confirm-lines">
        <li v-for="(line, i) in model.lines" :key="i">{{ line }}</li>
      </ul>
      <div v-if="failText" class="op-error" role="alert">{{ failText }}</div>
      <div class="confirm-foot">
        <button class="popup-btn" ref="cancelRef" data-confirm-cancel
          :disabled="pending" @click="onCancel">{{ model.cancelText || '取消' }}</button>
        <button class="popup-primary" :class="{ 'popup-danger': model.danger }" data-confirm-ok
          :disabled="pending" @click="onConfirm">
          {{ pending ? '操作中…' : model.confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

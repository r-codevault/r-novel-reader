/**
 * composables/offline.ts — 离线下载的 webview 侧动作
 *
 * 约定:
 *  - 所有章节序号在**这里统一 0/1 基换算**。界面显示 1 基(第 1 章),
 *    协议与扩展侧全程 0 基(含端点)。
 *  - 暂停/继续/取消一律**带 `filePath`**：任务表里可以对"非当前书"的下载动手，
 *    依赖"当前书"的隐式语义在切书后会打错目标（R9-06 / 架构 §4.a.3）。
 */
import { currentBookKey, markOpPending, newOpId, send } from './vscode';

/** 开始下载; 不传范围 = 整本。start/end 为 0 基, 含端点 */
export function startDownload(start?: number, end?: number, filePath?: string): void {
  send({ type: 'downloadStart', start, end, filePath: filePath || currentBookKey() });
}

export function pauseDownload(filePath?: string): void {
  send({ type: 'downloadPause', filePath: filePath || currentBookKey() });
}

export function resumeDownload(filePath?: string): void {
  send({ type: 'downloadResume', filePath: filePath || currentBookKey() });
}

export function cancelDownload(filePath?: string): void {
  send({ type: 'downloadCancel', filePath: filePath || currentBookKey() });
}

export function requestOfflineStatus(): void {
  send({ type: 'offlineStatus' });
}

/**
 * 导出当前书的离线内容为 txt。
 * 走写操作通道(带 opId)：导出是"有终态的写操作"，失败要保留上下文并就地报错。
 */
export function exportOfflineTxt(): string {
  const opId = newOpId();
  markOpPending(opId, 'offline:export');
  send({ type: 'offlineExportTxt', opId });
  return opId;
}

/** 清除本书离线内容（危险操作，必须先过 ConfirmDialog） */
export function clearCurrentOfflineOp(opId: string): void {
  send({ type: 'offlineClearCurrent', opId });
}

/** 清理全部离线缓存（危险操作，必须先过 ConfirmDialog） */
export function clearAllOfflineOp(opId: string): void {
  send({ type: 'offlineClearAll', opId });
}

/** 字节数 → 人类可读 */
export function formatBytes(n: number): string {
  const v = Number(n) || 0;
  if (v < 1024) { return v + ' B'; }
  if (v < 1024 * 1024) { return (v / 1024).toFixed(1) + ' KB'; }
  if (v < 1024 * 1024 * 1024) { return (v / 1024 / 1024).toFixed(1) + ' MB'; }
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

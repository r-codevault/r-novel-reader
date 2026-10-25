/**
 * ops.ts — 写操作的统一入口（webview 侧）。
 *
 * 为什么集中：危险操作的"确认 → 执行 → 终态"三段在三处（书架/历史/笔记）都要用，
 * 分散实现必然出现"某处忘记清 pending 导致按钮永久禁用"或"某处失败后把选择清掉"。
 *
 * 终态回包由 App 统一处理（`opResult` → `state.lastOp` 广播），各面板只 watch 广播。
 */
import { newOpId, markOpPending, send, state, type ConfirmModel } from './vscode';

export interface ConfirmOptions {
  title: string;
  /** 结构化明细：数量 + 对象名（清离线额外含章数与占用空间） */
  lines: string[];
  /** 主按钮是否危险态 */
  danger?: boolean;
  confirmText: string;
  cancelText?: string;
  op: string;
  payload: Record<string, unknown>;
  keepContextOnFail?: boolean;
}

/**
 * 打开统一确认框（同一时刻只允许一个）。
 * 返回生成的 opId —— 调用方一般不需要，测试里用于断言 pending。
 */
export function askConfirm(opts: ConfirmOptions): string {
  const opId = newOpId();
  const model: ConfirmModel = {
    title: opts.title,
    lines: opts.lines,
    danger: opts.danger !== false,
    confirmText: opts.confirmText,
    cancelText: opts.cancelText || '取消',
    op: opts.op,
    opId,
    payload: opts.payload,
    keepContextOnFail: opts.keepContextOnFail !== false,
  };
  state.confirm = model;
  state.opError = '';
  return opId;
}

/** 关闭确认框（取消；不产生任何写入） */
export function cancelConfirm(): void {
  state.confirm = null;
}

/**
 * 把刷新书架的预演计划压成确认框文案。
 *
 * 与宿主 `src/shelfRefresh.ts` 的 `summarizePlan()` 一一对应 —— webview 不能直接
 * import 那个模块（它带 node 侧类型），所以文案在两端各写一份，但格式与口径必须一致：
 * 至少含"数量 + 对象名"，清理/不可访问必须写清"会不会删东西"。
 */
export function summarizeShelfPlan(plan: {
  dir: string;
  scanned: number;
  add: unknown[];
  skipDuplicate: unknown[];
  merge: unknown[];
  retitle: unknown[];
  prune: { filePath: string; title: string }[];
  inaccessible: { filePath: string; reason: string }[];
  warnings: string[];
}): string[] {
  const lines: string[] = [];
  const merged = plan.merge.reduce(function (n, m) {
    const removals = (m as { removals?: unknown[] }).removals;
    return n + (Array.isArray(removals) ? removals.length : 0);
  }, 0);
  lines.push('书库：' + (plan.dir || '（未设置）') + '（扫描到 ' + plan.scanned + ' 个 txt）');
  lines.push(
    '将新增 ' + plan.add.length + ' 本 / 跳过重复副本 ' + plan.skipDuplicate.length +
    ' 个 / 合并重复记录 ' + merged + ' 条 / 修正书名 ' + plan.retitle.length +
    ' 条 / 清理失效记录 ' + plan.prune.length + ' 条'
  );
  if (plan.inaccessible.length > 0) {
    lines.push('⚠ ' + plan.inaccessible.length + ' 个文件暂时无法访问，本次不做清理（不会删任何东西）');
  }
  if (plan.prune.length > 0) {
    const names = plan.prune.slice(0, 3).map(function (p) { return p.title; }).join('、');
    lines.push('将被清理的书架记录：' + names + (plan.prune.length > 3 ? ' 等 ' + plan.prune.length + ' 条' : ''));
  }
  lines.push('只改动书架记录，不会删除书库里的 txt 文件。');
  for (const w of plan.warnings) { lines.push('注意：' + w); }
  return lines;
}

/**
 * 按 op 种类发对应消息。
 * 消息里一定带 `opId`：宿主原样回传，webview 才能把终态对上是哪一次操作。
 */
function dispatchOp(op: string, opId: string, rawPayload: Record<string, unknown>): void {
  // 结构化克隆前的必要一步: `state.confirm.payload` 是 Vue reactive 的 Proxy,
  // 直接 postMessage 会抛 DataCloneError。这里的 payload 只有字符串/数字/字符串数组,
  // JSON 往返即可拿到纯对象（比手写深拷贝更不容易漏字段）。
  const payload = JSON.parse(JSON.stringify(rawPayload || {})) as Record<string, unknown>;
  switch (op) {
    case 'notes:remove':
      send({ type: 'removeNotes', ids: (payload.ids as string[]) || [], opId });
      return;
    case 'notes:removeGroup':
      send({
        type: 'removeNoteGroup',
        bookPath: (payload.bookPath as string) || '',
        chapterTitle: payload.chapterTitle as string | undefined,
        opId,
      });
      return;
    case 'books:remove':
      send({ type: 'removeBook', filePath: (payload.filePath as string) || '', opId });
      return;
    case 'books:removeMany':
      send({ type: 'removeBooks', filePaths: (payload.filePaths as string[]) || [], opId });
      return;
    case 'history:remove':
      send({ type: 'removeHistory', filePaths: (payload.filePaths as string[]) || [], opId });
      return;
    case 'history:clear':
      send({ type: 'clearHistory', kind: (payload.kind as 'local' | 'online') || 'local', opId });
      return;
    case 'offline:clearCurrent':
      send({ type: 'offlineClearCurrent', opId });
      return;
    case 'offline:clearAll':
      send({ type: 'offlineClearAll', opId });
      return;
    case 'offline:export':
      send({ type: 'offlineExportTxt', opId });
      return;
    case 'shelf:refresh':
      send({ type: 'refreshLibraryApply', planId: Number(payload.planId) || 0, opId });
      return;
    default:
      // 未知 op：不发消息，但必须清掉 pending，否则 UI 卡在"操作中…"
      return;
  }
}

/**
 * 执行确认框里的操作。
 *
 * 执行后**不清空 state.confirm** —— 确认框保持打开并显示「操作中…」，
 * 等 opResult 回包再关闭（成功）或就地报错（失败保留上下文）。
 */
export function confirmNow(): void {
  const model = state.confirm;
  if (!model) { return; }
  if (state.pendingOps[model.opId]) { return; }   // 防重复提交
  markOpPending(model.opId, model.op);
  dispatchOp(model.op, model.opId, model.payload || {});
}

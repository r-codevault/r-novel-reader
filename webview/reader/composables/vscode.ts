/**
 * webview/reader/composables/vscode.ts — VS Code webview 消息桥
 * 扩展 <-> webview 的 postMessage 协议封装(与扩展侧保持同一协议)
 */
import { reactive } from 'vue';
import type { ReadingSettings } from '../../src/settings';
import type { ShortcutCombo } from './shortcut';

export const vscode = acquireVsCodeApi();

/** 章节载荷(扩展 -> webview) */
export interface ChapterPayload {
  index: number;
  title: string;
  paragraphs: string[];
  totalChapters: number;
  chapterWords: number;
  scrollRatio: number;
  /**
   * 归属标识(= 书架 filePath)。在线书为 `online://<sourceId>/<hash>`。
   * 老宿主可能不带此字段 -> 宽松模式下仍按旧行为应用。
   */
  filePath?: string;
  /** 宿主单调递增的请求号(区分同书重试产生的两轮) */
  reqId?: number;
}

/** 下载任务(任务表一行) */
export interface DownloadTaskView {
  filePath: string;
  bookTitle: string;
  done: number;
  total: number;
  failed: number;
  running: boolean;
  paused: boolean;
  updatedAt: number;
}

/** 写操作终态回包 */
export interface OpResultPayload {
  opId: string;
  op: string;
  ok: boolean;
  message?: string;
  detail?: Record<string, number>;
}

/** 确认框模型(同一时刻只允许一个) */
export interface ConfirmModel {
  title: string;
  /** 结构化明细: 数量 / 对象名 / 章节范围 / 占用空间 / 是否可恢复 */
  lines: string[];
  danger: boolean;
  confirmText: string;
  cancelText?: string;
  op: string;
  opId: string;
  /** 执行时原样回传给宿主的参数(filePaths / ids / planId…) */
  payload: Record<string, unknown>;
  /** 失败时是否保留选择与草稿(危险批量操作 = true) */
  keepContextOnFail?: boolean;
}

export interface NovelInfo {
    /** 在线书来源(本地书为空) */
    online?: { sourceName: string; bookUrl: string; preview?: boolean };
  /** 实际读取路径(笔记分组键与"当前书"判定都用它) */
  filePath?: string;
  totalChapters: number;
  totalWords: number;
  bookTitle: string;
  author?: string;
}

/** 书架条目(左抽屉「书架」页) */
export interface ShelfItemView {
  filePath: string;
  title: string;
  author: string;
  chapterIndex: number;
  totalChapters: number;
  current: boolean;
  /** 是否在线书 */
  online?: boolean;
  /** 在线书来源名 */
  sourceName?: string;
  /** 在线书原始 bookUrl(搜索结果的"已加入/移出"靠它对上书架记录) */
  onlineBookUrl?: string;
  /** 离线下载进度(有下载内容时才有) */
  offline?: { done: number; total: number };
}

/** 离线下载状态(与扩展侧 OfflineStatusView 一一对应) */
export interface OfflineStatusView {
  filePath: string;
  total: number;
  done: number;
  failed: number;
  running: boolean;
  paused: boolean;
  /** 已下载章号(升序) */
  downloaded: number[];
  bytes: number;
  totalBytes: number;
  bookCount: number;
}

/** 目录每章标记(与扩展侧 ChapterMarksView 一一对应) */
export interface ChapterMarksView {
  /** 临时读缓存里已有的章号(断网可读, 但删书架/清缓存会没) */
  cached: number[];
  /** 读过并留有位置记忆的章号 */
  read: number[];
  /** 读到的最大章号; -1 = 还没开始 */
  readUpTo: number;
}

/** 阅读笔记(与扩展端 NoteItem 一一对应) */
export interface NoteItem {
  id: string;
  bookPath: string;
  bookTitle: string;
  chapterTitle: string;
  chapterIndex: number;
  paragraphIndex: number;
  quote: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建笔记卡片的状态(仅内存, 取消即丢弃) */
export interface NoteComposerState {
  /** composing=编辑(新建/编辑) viewing=只读查看(点「编辑」进入编辑) saving=保存中 */
  phase: 'composing' | 'saving' | 'viewing';
  chapterTitle: string;
  chapterIndex: number;
  paragraphIndex: number;
  quote: string;
  text: string;
  /** 带入的已有笔记 id: 有值时保存走 updateNote(编辑), 无值走 addNote(新建) */
  editId?: string;
  /** 段落锚点(视口坐标), 卡片据此定位 */
  anchorTop: number;
  anchorBottom: number;
  anchorLeft: number;
  error?: string;
}

/** 跳转前的阅读位置(供「返回阅读位置」用) */
export interface NoteReturnPos {
  chapterIndex: number;
  scrollRatio: number;
  chapterTitle: string;
}

/** 待落位的笔记跳转(跨章时等 chapter 到达) */
export interface NoteJumpTarget {
  id: string;
  chapterTitle: string;
  chapterIndex: number;
  paragraphIndex: number;
  quote: string;
}

/** 笔记分组展开态: 只记录用户显式选择(bookPath -> 是否展开), 缺省值由"是否在读"推导 */
export type NoteGroupOpenMap = Record<string, boolean>;

/** 左抽屉页签 */
export type DrawerTab = 'shelf' | 'catalog' | 'notes' | 'storage' | 'source';

/**
 * 写入"窗口重开恢复信息"(VS Code 的 webview state)。
 * VS Code 会在重开窗口时把它作为 deserializeWebviewPanel 的 state 参数回传;
 * 扩展侧据此决定是否恢复阅读页(见 novelReader.restoreOnStartup)。
 */
export function saveRestoreState(s: { filePath: string; chapterIndex: number; scrollRatio: number }): void {
  try {
    vscode.setState(s);
  } catch {
    // 非 webview 环境(单测/浏览器预览)忽略
  }
}

/** 书源(扩展下发的精简视图, 不含规则体) */
export interface BookSourceView {
  id: string;
  name: string;
  url: string;
  group: string;
  enabled: boolean;
  searchUrl: string;
  lastCheck?: number;
  lastCheckOk?: boolean;
  lastCheckMessage?: string;
  /** 连续失败次数(检查/搜索), 成功清零 */
  failStreak: number;
  /** >0 = 失效(不参与搜索, 只在「失效」Tab 出现) */
  deadAt?: number;
  deadReason?: string;
}

/** 搜索结果条目 */
export interface SearchBookItem {
  sourceId: string;
  sourceName: string;
  title: string;
  author: string;
  bookUrl: string;
  coverUrl?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
  wordCount?: number;
}

/** 单源搜索错误 */
/** 搜索结果去掉 Vue 响应式代理, 变成可结构化克隆的纯对象 */
export function plainSearchBook(i: SearchBookItem): SearchBookItem {
  return {
    sourceId: i.sourceId,
    sourceName: i.sourceName,
    title: i.title,
    author: i.author,
    bookUrl: i.bookUrl,
    coverUrl: i.coverUrl,
    intro: i.intro,
    kind: i.kind,
    lastChapter: i.lastChapter,
    wordCount: i.wordCount,
  };
}

export interface HistoryItemView {
  kind: 'local' | 'online';
  filePath: string;
  title: string;
  author: string;
  chapterIndex: number;
  totalChapters: number;
  lastReadAt: number;
  sourceName?: string;
}

export interface SourceSearchError {
  sourceId: string;
  sourceName: string;
  kind: string;
  message: string;
}

/** 全局共享状态(与扩展侧消息协议字段一一对应) */
export const state = reactive({
  novel: null as NovelInfo | null,
  settings: null as ReadingSettings | null,
  chapter: null as ChapterPayload | null,
  chapters: [] as { index: number; title: string }[],
  shelf: [] as ShelfItemView[],
  libraryPath: '',
  /** 全部笔记(按书分组在 webview 完成) */
  notes: [] as NoteItem[],
  catReverse: false,
  catCollapsed: [] as string[],
  prevCombo: null as ShortcutCombo | null,
  nextCombo: null as ShortcutCombo | null,
  // UI 状态: 侧边菜单(占位式) + 互斥弹窗
  menuExpanded: true,
  catalogOpen: false,
  settingsOpen: false,
  shelfOpen: false,
  storageOpen: false,
  notesOpen: false,
  /** 笔记分组展开态(仅内存, 只记用户显式操作过的书) */
  noteGroupOpen: {} as NoteGroupOpenMap,
  /** 章分组展开态(键含书路径; 换书/重发 init 不清空, 与书折叠态同策略) */
  noteChapterOpen: {} as NoteGroupOpenMap,
  /** 新建笔记卡片 */
  noteComposer: null as NoteComposerState | null,
  /** 跳转前位置 */
  noteReturn: null as NoteReturnPos | null,
  /** 待落位跳转 */
  noteJump: null as NoteJumpTarget | null,
  /** 摸鱼会话开启中(侧边栏「摸鱼模式」高亮) */
  slackerActive: false,
  /** 跨书跳转: 待目标书 init 落地后再按笔记定位 */
  pendingNoteJump: null as NoteItem | null,
  // ---- 网络书源
  sourceOpen: false,
  /** 书源弹窗内的视图: 搜索 / 书源管理 / 失效书源 */
  sourceView: 'search' as 'search' | 'manage' | 'dead',
  sources: [] as BookSourceView[],
  searchKeyword: '',
  searching: false,
  /** 搜索序号: 扩展回包时比对, 丢弃过期结果 */
  searchToken: 0,
  searchResults: [] as SearchBookItem[],
  searchErrors: [] as SourceSearchError[],
  searchDone: false,
  /** 因源上限未参与搜索的书源数(已无上限, 保留兼容) */
  searchSkipped: 0,
  /** 本次搜索新移入失效的书源数 */
  searchDeadAdded: 0,
  /** 搜索进度(每完成一个源更新) */
  searchProgress: null as null | { done: number; total: number; sourceName: string; ok: boolean; failed: number },
  /** 用户暂停中的搜索 */
  searchPaused: false,
  /** 本轮已确认的关键词(输入框可能已被改写) */
  searchKey: '',
  /** 本轮是否被取消 */
  searchCancelled: false,
  /** 拖动分隔条后的当前区行数; null = 自动分配 */
  splitCurrentRows: null as null | number,
  /** 预览书「加入书架」请求进行中(按钮置灰 + 文案变「加入中…」) */
  previewAddPending: false,
  /** 已加入在线书架的 bookUrl(搜索结果按钮状态) */
  onlineAdded: [] as string[],
  /** 正在加入书架的 bookUrl */
  onlineAddPending: [] as string[],
  /** 加入书架/预览失败原因(搜索结果顶部提示) */
  onlineError: '',
  /** 当前打开/预览中的在线书地址(搜索结果高亮用) */
  previewBookUrl: '',
  /** 历史记录弹窗 */
  historyOpen: false,
  historyTab: 'local' as 'local' | 'online',
  history: { local: [] as HistoryItemView[], online: [] as HistoryItemView[] },
  /** 预览解析中(全局: 切 Tab/关闭弹窗都保留) */
  previewPending: null as null | {
    bookUrl: string;
    title: string;
    sourceName: string;
    at: number;
    dismissed: boolean;
  },
  /** 在线章节加载中 */
  chapterLoading: null as null | { index: number; title: string },
  /** 在线章节加载失败 */
  chapterError: null as null | { index: number; message: string },
  /** 上一次搜索的结果(只保留一份) */
  searchHistory: null as null | {
    key: string;
    items: SearchBookItem[];
    errors: SourceSearchError[];
  },
  // ---- 批量检查: 两个 Tab 各自独立(检查全部 / 全部重查互不影响)
  checkStates: {
    active: { running: false, paused: false, done: 0, total: 0, sourceName: '', runId: 0 },
    dead: { running: false, paused: false, done: 0, total: 0, sourceName: '', runId: 0 },
  },
  /** 书源管理: 正在编辑的 sourceId(空 = 无) */
  sourceEditingId: '',
  // ---- 离线下载
  /** 当前书的离线状态(没有下载过 = null) */
  offline: null as OfflineStatusView | null,
  /** 全部离线缓存汇总 */
  offlineStats: { bytes: 0, books: 0 },
  /** 目录面板的下载范围行是否展开 */
  dlRowOpen: false,
  /** 本轮下载进度(范围内的 done/total; 与 offline.total=全书章数 区分) */
  dlRun: null as null | { done: number; total: number; failed: number; running: boolean; paused: boolean },
  /** 上次导出结果提示(短暂展示) */
  dlNotice: '',
  /** 目录每章标记(临时缓存 / 已读); readUpTo 随阅读推进在本地更新 */
  marks: { cached: [] as number[], read: [] as number[], readUpTo: -1 } as ChapterMarksView,
  /** 目录筛选: all=全部 / offline=已下载 / cache=仅缓存 / none=需联网 */
  catFilter: 'all' as 'all' | 'offline' | 'cache' | 'none',
  // ---- 归属协议(见 src/protocol.ts)
  /** 宿主在 init 里声明 protocolVersion>=2 时置 true: 缺 filePath 的回包一律拒绝 */
  ownershipStrict: false,
  /** 已接受的最大章节请求号(reqId 回退即丢弃, 兜底防串书) */
  chapterReqSeq: 0,
  /** 下载任务表: 按 filePath 键的全局视图(与"当前书"无关) */
  downloadTasks: {} as Record<string, DownloadTaskView>,
  /** 进行中的写操作(opId -> 元数据): 存在即禁用按钮, 防重复提交 */
  pendingOps: {} as Record<string, { op: string; at: number }>,
  /** webview 侧自增的写操作序号 */
  opSeq: 0,
  /** 写操作失败的就地提示(role=alert) */
  opError: '',
  /**
   * 最近一次写操作终态广播。
   * 各面板 watch 它来决定"退出管理态/清空选择"还是"保留选择 + 就地报错"——
   * 面板的 managing/selected 是组件局部状态, App 不能直接改, 只能广播。
   */
  lastOp: null as null | { opId: string; op: string; ok: boolean; message: string; at: number },
  // ---- 键盘与笔记模式
  /** 笔记本模式: 开启后全量段落笔记按钮可见且可聚焦 */
  noteMode: false,
  /** roving tabindex 停靠段落下标 */
  noteParaCursor: 0,
  // ---- 搜索终态
  /** 失败明细区是否展开 */
  searchErrorOpen: false,
  /** 单源重试状态(sourceId 键) */
  sourceRetries: {} as Record<string, { running: boolean; ok?: boolean; message?: string }>,
  /** sr-only live region 的节流播报文案 */
  searchAnnounce: '',
  /** 统一确认框(浮层内的确认层, 不参与弹窗互斥) */
  confirm: null as ConfirmModel | null,
  // ---- 刷新书架(预演 -> 确认 -> 执行)
  /** 宿主下发的预演计划(确认框要展示它, 执行时要回传 planId) */
  shelfPlan: null as null | {
    planId: number;
    dir: string;
    scanned: number;
    add: unknown[];
    skipDuplicate: unknown[];
    merge: unknown[];
    retitle: unknown[];
    prune: { filePath: string; title: string }[];
    inaccessible: { filePath: string; reason: string }[];
    warnings: string[];
  },
  /** 刷新书架的终态提示(计数摘要 + 差异说明) */
  shelfNotice: '',
});

/** 发消息给扩展(自由格式, 字段与协议一一对应) */
export function send(msg: Record<string, unknown>): void {
  try {
    vscode.postMessage(msg);
  } catch (err) {
    // 常见原因: 把 Vue reactive Proxy 直接发了出去(结构化克隆会抛 DataCloneError)
    console.error('[reader] postMessage 失败(含不可克隆对象?)', msg && (msg as { type?: string }).type, err);
    throw err;
  }
}

/** 章节跳转请求(dir: 按钮方向; curRatio: 离开时的章内位置, 供扩展记住本章进度) */
export function gotoChapter(index: number, dir?: 'prev' | 'next' | 'jump', exactRatio?: number): void {
  send({
    type: 'getChapter',
    index,
    dir,
    curRatio: currentScrollRatio(),
    // 笔记「返回阅读位置」要求精确落点, 优先于扩展侧的记忆比例
    exactRatio: typeof exactRatio === 'number' ? exactRatio : undefined,
    // 归属: 让宿主能核对"这条跳转属于哪本书"(切书瞬间的在途请求)
    curBook: currentBookKey(),
  });
}

/** 当前书的归属键(= 书架 filePath)。空态占位书为空字符串。 */
export function currentBookKey(): string {
  return (state.novel && state.novel.filePath) || '';
}

/**
 * 归属校验: 一条异步回包是否属于当前这本书。
 *
 * 严格模式(宿主声明 protocolVersion>=2)下**缺归属字段即拒绝**:
 * 这样"宿主发了但漏填 filePath"的回归会在开发期立刻暴露, 而不是变成串书。
 * 宽松模式(老宿主)下缺字段照旧应用, 只 warn —— 避免"宿主更新 / dist-webview
 * 未重建"时整页白屏。
 */
export function ownedBy(msg: { filePath?: string }, tag: string): boolean {
  const cur = currentBookKey();
  if (!msg.filePath) {
    if (state.ownershipStrict) {
      console.warn('[reader] 拒绝无归属回包', tag);
      return false;
    }
    return true;
  }
  if (msg.filePath !== cur) {
    console.warn('[reader] 丢弃异书回包', tag, msg.filePath, cur);
    return false;
  }
  return true;
}

/** 生成本次写操作的 opId(webview 侧唯一编号, 宿主原样回传) */
export function newOpId(): string {
  state.opSeq += 1;
  return 'op' + state.opSeq + '-' + Date.now().toString(36);
}

/** 标记写操作进行中(按钮据此禁用, 防重复提交) */
export function markOpPending(opId: string, op: string): void {
  state.pendingOps[opId] = { op, at: Date.now() };
  state.opError = '';
}

/** 结束写操作(成功/失败都要清, 否则按钮永久禁用) */
export function clearOpPending(opId: string): void {
  const next: Record<string, { op: string; at: number }> = {};
  for (const key of Object.keys(state.pendingOps)) {
    if (key !== opId) { next[key] = state.pendingOps[key]; }
  }
  state.pendingOps = next;
}

/** 是否有该 op 的写操作在进行中(用于批量按钮 disabled) */
export function opRunning(prefix: string): boolean {
  for (const key of Object.keys(state.pendingOps)) {
    if (state.pendingOps[key].op === prefix) { return true; }
  }
  return false;
}

/** 打开笔记浮层(与其它抽屉互斥由 App 统一处理) */
export function openNotes(): void {
  send({ type: 'requestNotes' });
  state.notesOpen = true;
}

/** 当前章内滚动位置 0~1(与上报进度同一算法, 章不足一屏时为 0) */
export function currentScrollRatio(): number {
  const max = document.body.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

/**
 * protocol.ts — 宿主 <-> webview 消息载荷类型与协议版本的**单一来源**。
 *
 * 为什么单独一个文件：
 *  - 两端各自定义接口时，"宿主多发了字段 / webview 少接了字段"这种哑字段
 *    只能靠人肉比对；放到这里两边 import 同一份声明，编译期就能对上。
 *  - 本文件**纯类型 + 常量**，不 import vscode、不 import 任何运行时代码，
 *    因此 webview 侧可以安全地用相对路径引入（类型在构建期被擦除）。
 *
 * 兼容原则（见架构文档 §3.2）：
 *  1. 新增字段一律**可选**，老 webview 收到多余属性直接忽略；
 *  2. 严格模式由宿主声明（`init.protocolVersion >= PROTOCOL_VERSION`），
 *     webview 未重建时仍走宽松模式，避免"宿主更新 / dist-webview 未重建"白屏；
 *  3. 命令参数保持双形态（`string[]` 旧 / 对象新），旧调用行为不变。
 */

/** 当前协议版本。宿主在 init 里声明，webview 据此决定归属校验严格程度。 */
export const PROTOCOL_VERSION = 2;

/** 所有宿主 -> webview 异步回包的可选归属字段 */
export interface Owned {
    /**
     * 归属书标识。取值与书架 `filePath` 完全一致：
     * 本地书 = 绝对路径；在线书 = `online://<sourceId>/<hash>`。
     * 缺省 = 老宿主（宽松模式下仍按旧行为应用）。
     */
    filePath?: string;
    /** 宿主单调递增的请求号；用于区分"同一本书内重试产生的两轮请求" */
    reqId?: number;
}

/** 章节载荷（字段与历史协议保持一致，不得改名） */
export interface ChapterPayload extends Owned {
    index: number;
    title: string;
    paragraphs: string[];
    totalChapters: number;
    /** 本章字数 */
    chapterWords: number;
    /** 章内滚动位置 0~1 */
    scrollRatio: number;
}

export interface ChapterLoadingPayload extends Owned {
    index: number;
    title?: string;
}

export interface ChapterErrorPayload extends Owned {
    index: number;
    message: string;
}

export interface ChapterCachedPayload extends Owned {
    index: number;
}

/** 预览成功：保留 bookUrl 过滤（既有语义），补 reqId 供"超时后迟到成功"判定 */
export interface PreviewReadyPayload extends Owned {
    bookUrl: string;
}

export interface PreviewErrorPayload extends Owned {
    message: string;
    bookUrl?: string;
}

/**
 * 下载任务视图（webview 任务表一行）。
 * `filePath` 就是下载任务 key —— 在线书的 `online://` 伪路径，
 * 与书架 `filePath` 是同一个字符串，不需要再做映射。
 */
export interface DownloadTaskView {
    filePath: string;
    bookTitle: string;
    done: number;
    total: number;
    failed: number;
    running: boolean;
    paused: boolean;
    /** 最后一次进度时间戳（webview 用来排序/展示"多久前"） */
    updatedAt: number;
}

export interface DownloadProgressPayload extends Owned {
    done: number;
    total: number;
    failed: number;
    running: boolean;
    paused: boolean;
    index?: number;
    title?: string;
    added?: number[];
    bookTitle?: string;
}

export interface DownloadDonePayload extends Owned {
    ok: boolean;
    cancelled: boolean;
    done: number;
    total: number;
    failed: number;
    message?: string;
}

/** 宿主 -> webview 的下载任务表全量快照 */
export interface DownloadTasksPayload {
    tasks: DownloadTaskView[];
}

/** 写操作种类（每个种类都必须有明确的成功/失败终态） */
export type OpKind =
    | 'notes:remove'
    | 'notes:removeGroup'
    | 'books:remove'
    | 'books:removeMany'
    | 'history:remove'
    | 'history:clear'
    | 'offline:clearCurrent'
    | 'offline:clearAll'
    | 'offline:export'
    | 'sources:removeMany'
    | 'sources:clearDead'
    | 'shelf:refresh';

/** 写操作统一终态回包。`opId` 由 webview 生成，宿主原样回传。 */
export interface OpResultPayload {
    opId: string;
    op: OpKind;
    ok: boolean;
    message?: string;
    /** 部分成功时的细节（如刷新书架各项计数） */
    detail?: Record<string, number>;
}

/** 单个书源的失败明细（webview 直出中文标签） */
export interface SourceErrorDetail {
    sourceId: string;
    sourceName: string;
    /** 归一化后的类别，UI 只做展示映射 */
    category: 'timeout' | 'network' | 'http' | 'parse' | 'rule' | 'unsupported' | 'abort' | 'fatal';
    message: string;
}

/** 单源重试结果 */
export interface SourceRetryResultPayload {
    reqId: number;
    sourceId: string;
    sourceName: string;
    ok: boolean;
    message?: string;
    /** 成功时该源的命中；webview 按 bookUrl 去重后追加进当前结果 */
    items?: SearchBookItemView[];
}

/**
 * 搜索结果条目（协议镜像）。
 * 与宿主 `src/online/ruleApply.ts` 的 `SearchBookItem` 字段一一对应；
 * 这里再声明一份是为了让 protocol.ts 保持"零运行时依赖"。
 */
export interface SearchBookItemView {
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

/** 刷新书架预演计划（实现见 src/shelfRefresh.ts） */
export interface ShelfRefreshPlan {
    planId: number;
    dir: string;
    /** 本次扫描到的 txt 文件数 */
    scanned: number;
    add: { filePath: string; title: string; author: string; totalChapters: number }[];
    skipDuplicate: string[];
    merge: { keep: string; removals: string[] }[];
    /**
     * 书名纠偏。`author` / `totalChapters` 是 apply 时的兜底值
     * （预演之后书架记录可能被别处改过，执行时优先用 live 快照）。
     */
    retitle: {
        filePath: string;
        from: string;
        to: string;
        author?: string;
        totalChapters?: number;
    }[];
    /** 仅"目录可枚举且 access() 报 ENOENT"的条目 */
    prune: { filePath: string; title: string }[];
    /** 暂时不可访问（EACCES/EPERM/EBUSY/EMFILE/未知）：一律不清理 */
    inaccessible: { filePath: string; reason: string }[];
    warnings: string[];
}

/** 刷新书架执行结果 */
export interface ShelfRefreshResult {
    planId: number;
    added: number;
    skippedDup: number;
    merged: number;
    retitled: number;
    pruned: number;
    failed: { filePath: string; error: string }[];
    /** 与预演不一致时给出的差异说明 */
    driftNote?: string;
}

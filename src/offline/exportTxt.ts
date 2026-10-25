/**
 * offline/exportTxt.ts — 把离线章节拼成一本本地 txt
 *
 * 关键点:
 *  - 从**段落数组**重建正文, 不读缓存原文 —— OfflineStore.readChapter 会去空行,
 *    直接拼接会丢掉段距。
 *  - 章节标题沿用书源目录里的原标题(通常就是 "第1章 xxx"), 这样导出的书
 *    跟在线阅读时章节一一对应; 标题不合规导致解析不出章节时, 回退为按序号编号。
 *  - 只导出已下载的章; 未下载的记为 missing, 由调用方提示用户。
 *
 * 本模块只依赖 fs/path 与解析器, 不依赖 vscode, 便于单元测试。
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseNovel } from '../novelParser';
import type { OfflineManifest, OfflineStore } from './offlineStore';

const MAX_BASE_LEN = 80;
/** Windows 文件名非法字符(含控制符) */
const ILLEGAL_RE = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 生成安全的文件名主干(不含扩展名) */
export function safeFileName(name: string): string {
    let s = String(name || '').replace(ILLEGAL_RE, '_');
    // Windows 不允许结尾是点或空格
    s = s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
    if (s.length > MAX_BASE_LEN) { s = s.slice(0, MAX_BASE_LEN).replace(/[\s.]+$/, ''); }
    if (!s) { s = '未命名'; }
    if (RESERVED.test(s)) { s = s + '_'; }
    return s;
}

/** 目录内不重名的路径: 名称.txt → 名称 (1).txt … (最多 99 次) */
export async function uniquePath(dir: string, fileName: string): Promise<string> {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let target = path.join(dir, fileName);
    for (let n = 1; n <= 99; n++) {
        if (!fs.existsSync(target)) { return target; }
        target = path.join(dir, base + ' (' + n + ')' + ext);
    }
    throw new Error('目录中同名文件过多: ' + fileName);
}

export interface BuildResult {
    text: string;
    /** 实际写入的章数 */
    chapters: number;
    /** 目录里有但没有正文的章数 */
    missing: number;
}

/**
 * 拼装全文(纯函数)。
 * @param bodies index → 段落数组
 * @param opts.numberFallback 是否把标题改写成 "第N章 <原标题>"(解析失败时兜底)
 */
export function buildNovelText(
    manifest: OfflineManifest,
    bodies: Map<number, string[]>,
    opts: { numberFallback?: boolean } = {}
): BuildResult {
    const ordered = manifest.chapters.slice().sort((a, b) => a.index - b.index);

    const headerLines: string[] = [];
    const title = (manifest.bookTitle || '').trim();
    if (title) { headerLines.push('《' + title + '》'); }
    const author = (manifest.author || '').trim();
    if (author) { headerLines.push('作者：' + author); }

    const parts: string[] = [];
    let chapters = 0;
    let missing = 0;
    let seq = 0;

    for (const ch of ordered) {
        const paragraphs = bodies.get(ch.index);
        if (!paragraphs || !paragraphs.length) { missing += 1; continue; }
        seq += 1;
        chapters += 1;
        const heading = opts.numberFallback
            ? '第' + seq + '章 ' + (ch.title || '')
            : (ch.title || ('第' + seq + '章'));
        parts.push(heading + '\n\n' + paragraphs.join('\n\n'));
    }

    const header = headerLines.join('\n');
    const body = parts.join('\n\n');
    const text = (header ? header + '\n\n' : '') + body + '\n';
    return { text, chapters, missing };
}

export interface ExportOptions {
    store: OfflineStore;
    key: string;
    /** 目标目录(与 targetFile 二选一) */
    targetDir?: string;
    /** 完整目标路径(已含文件名); 提供时直接覆盖写 */
    targetFile?: string;
    /** 文件名主干(不含 .txt) */
    baseName: string;
}

export interface ExportResult {
    ok: boolean;
    filePath?: string;
    chapters: number;
    missing: number;
    message?: string;
}

export async function exportOfflineTxt(opts: ExportOptions): Promise<ExportResult> {
    const manifest = await opts.store.readManifest(opts.key);
    if (!manifest) {
        return { ok: false, chapters: 0, missing: 0, message: '这本书还没有离线内容，请先下载' };
    }

    const bodies = new Map<number, string[]>();
    for (const ch of manifest.chapters) {
        const paragraphs = await opts.store.readChapter(opts.key, ch.index);
        if (paragraphs && paragraphs.length) { bodies.set(ch.index, paragraphs); }
    }
    if (!bodies.size) {
        return { ok: false, chapters: 0, missing: manifest.chapters.length, message: '离线内容为空，请重新下载' };
    }

    // 先用原标题; 解析不出章节就按序号重编(部分书源的标题是"开始""结束"这种)
    let built = buildNovelText(manifest, bodies);
    let parsed = parseNovel(built.text, 'offline-export.txt');
    if (parsed.chapters.length === 0) {
        const fallback = buildNovelText(manifest, bodies, { numberFallback: true });
        const parsedFallback = parseNovel(fallback.text, 'offline-export.txt');
        if (parsedFallback.chapters.length > 0) {
            built = fallback;
            parsed = parsedFallback;
        }
    }

    const dir = opts.targetDir || (opts.targetFile ? path.dirname(opts.targetFile) : '');
    const filePath = opts.targetFile || await uniquePath(dir, safeFileName(opts.baseName) + '.txt');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, built.text, 'utf8');

    if (parsed.chapters.length === 0) {
        return {
            ok: false,
            filePath,
            chapters: built.chapters,
            missing: built.missing,
            message: '文本已写出，但未能解析出章节，可能是章节标题格式特殊',
        };
    }

    return { ok: true, filePath, chapters: built.chapters, missing: built.missing };
}

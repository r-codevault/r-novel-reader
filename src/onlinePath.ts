/**
 * onlinePath.ts — 在线书在书架里的"虚拟路径"
 *
 * 书架以 filePath 为唯一键, 在线书不能指向真实文件, 用一个固定格式的
 * 伪 URL 表示: `online://<sourceId>/<sha1(bookUrl) 前 16 位>`。
 *  - 定长、只含 url 安全字符, 可安全存进 globalState / webview 消息
 *  - 不需要反解(书源与书地址都存在 ShelfBook.online 里), hash 只负责唯一性
 */
import * as crypto from 'crypto';

export const ONLINE_SCHEME = 'online';

/** 在线书需要的元信息(与 ShelfBook 一起持久化) */
export interface OnlineRef {
    sourceId: string;
    sourceName: string;
    bookUrl: string;
    tocUrl?: string;
    coverUrl?: string;
    intro?: string;
    kind?: string;
    lastChapter?: string;
    wordCount?: number;
    /** 目录最近一次抓取时间(毫秒), 用于 TTL 判断 */
    tocFetchedAt?: number;
}

/** 书地址 hash(唯一性即可, 不做安全校验) */
export function bookHash(bookUrl: string): string {
    return crypto.createHash('sha1').update(String(bookUrl || '').trim()).digest('hex').slice(0, 16);
}

export function onlineKey(sourceId: string, bookUrl: string): string {
    return ONLINE_SCHEME + '://' + sourceId + '/' + bookHash(bookUrl);
}

export function isOnlinePath(filePath: string | undefined | null): boolean {
    return typeof filePath === 'string' && filePath.startsWith(ONLINE_SCHEME + '://');
}

export function parseOnlinePath(filePath: string): { sourceId: string; hash: string } | null {
    if (!isOnlinePath(filePath)) { return null; }
    const m = /^online:\/\/([^/]+)\/([0-9a-f]+)$/.exec(String(filePath));
    if (!m) { return null; }
    return { sourceId: m[1], hash: m[2] };
}

/** 书架展示用: 在线书没有真实扩展名, 给个占位名 */
export function displayPathForOnline(ref: OnlineRef): string {
    return ref.sourceName + ' · ' + (ref.lastChapter || '在线书');
}

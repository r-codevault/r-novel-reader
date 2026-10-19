/**
 * encoding.ts — 小说文本编码识别
 *
 * 站点下载的 txt 常见为 GB18030, 直接按 UTF-8 读会乱码;
 * 这里按 BOM -> 严格 UTF-8 校验 -> 回退 GB18030 的顺序识别。
 * extension.ts(打开文件) 与 readerPanel.ts(窗口恢复) 共用, 避免恢复后乱码。
 */

export interface DecodedText {
    text: string;
    /** 识别结果标识, 仅用于日志与解析器的容错判断 */
    encoding: string;
}

/** 读取文件字节并识别编码 */
export function decodeBuffer(buf: Buffer): DecodedText {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { text: buf.toString('utf8'), encoding: 'utf8-bom' };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.toString('utf16le'), encoding: 'utf16le' };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.from(buf);
        swapped.swap16();
        return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
    }
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('\uFFFD')) {
        return { text: utf8, encoding: 'utf8' };
    }
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' };
}
/**
 * novelParser.ts — 小说文本解析器
 *
 * 职责:
 *  1. 识别常见章节标题格式:
 *     - 中文: 第X章 / 第X节 / 第X回 / 第X卷 / 第X部 / 第X篇 (X 支持阿拉伯数字与中文数字)
 *     - 特殊: 序章、楔子、引子、尾声、终章、后记、番外篇
 *     - 英文: Chapter 12 / chapter 12 / Vol.3
 *  2. 区分"真标题"与"正文中重复出现的标题行":
 *     - 站点导出的正文常在标题后紧跟一行缩进重复标题, 且编号可能与真标题不一致(源站错位)
 *     - 因此采用 缩进层级 > 同编号 > 同标题文字 的综合去重, 而非单纯比对章节号
 *  3. 过滤作者告示(含句读标点的长句, 如 "第一篇…结束, 明天更新…")
 *  4. 剔除疑似目录页(连续多个无正文章节的行块)
 */

export interface NovelChapter {
    /** 0 起始章节序号 */
    index: number;
    /** 章节标题, 如 "第3章 初临起源大陆" */
    title: string;
    /** 章节正文(段落以 \n 分隔); 在线书未加载时为空串 */
    content: string;
    /** 在线章节地址(本地书为空) */
    url?: string;
    /** 正文净字数(不含空白) */
    wordCount: number;
}

export interface Novel {
    /** 在线书元信息(本地书为空) */
    online?: {
        sourceId: string;
        sourceName: string;
        bookUrl: string;
        tocUrl?: string;
        /** 临时预览: 尚未加入书架 */
        preview?: boolean;
    };
    /** 来源文件绝对路径(在线书为 online:// 伪路径) */
    filePath: string;
    /** 书名(优先从正文元信息《...》识别, 否则取文件名) */
    bookTitle: string;
    /** 作者(可能为空) */
    author: string;
    chapters: NovelChapter[];
    /** 第一个章节之前的杂项内容(如书籍信息、来源声明) */
    preface: string;
    /** 检测到的文件编码 */
    encoding: string;
    /** 全书净字数 */
    totalWords: number;
}

const CN_NUM_CHARS = '零一二三四五六七八九十百千两';

/** 第X章/节/回/卷/部/篇, X 可为阿拉伯数字或中文数字 */
const CN_MARKER_RE = new RegExp(`第[\\s\\d${CN_NUM_CHARS}]+[章回卷节部篇]`);

/** 序章、楔子、引子、尾声、终章、后记、番外篇 */
const SPECIAL_MARKER_RE = /^(?:序章|楔子|引子|尾声|终章|后记|番外篇?)(?=$|\s|《|「|【)/;

/** Chapter 12 / chapter 12 / VOL.3 / Vol 3 */
const EN_MARKER_RE = /^(?:chapter|vol|volume)\s*\.?\s*[\divxlc]+/i;

/**
 * 正文行判定为"告示/正文引用"而非标题的特征:
 *  - 章节号后紧跟"的是在…"等虚词(如 "第202章的内容很有趣")
 */
const PROSE_TAIL_RE = /^第[\s\d零一二三四五六七八九十百千两]+[章回卷节部篇][的是在和与里中被把向从到这其该]/;

const MAX_TITLE_LEN = 60;

/** 行首空白宽度(半角空格与全角空格均计 1) */
function rawIndent(line: string): number {
    const m = line.match(/^[\s\u3000]*/);
    return m ? m[0].length : 0;
}

/** 提取行首章节标记(第X章 / 序章 / Chapter 12), 非标题行返回 null */
function matchMarker(line: string): { marker: string; strict: boolean } | null {
    const cn = line.match(CN_MARKER_RE);
    if (cn) {
        // "第202章的内容…" 这类正文引用不算标题
        if (PROSE_TAIL_RE.test(line)) {
            return null;
        }
        // 篇/部/卷 常出现在作者告示中(如 "第一篇『初临』结束, 明天更新第二篇。"), 从严判定
        const unit = cn[0].slice(-1);
        return { marker: cn[0], strict: unit === '篇' || unit === '部' || unit === '卷' };
    }
    const sp = line.match(SPECIAL_MARKER_RE);
    if (sp) {
        return { marker: sp[0], strict: true };
    }
    const en = line.match(EN_MARKER_RE);
    if (en) {
        return { marker: en[0], strict: false };
    }
    return null;
}

function looksLikeTitle(line: string): boolean {
    if (line.length > MAX_TITLE_LEN) {
        return false;
    }
    const info = matchMarker(line);
    if (!info) {
        return false;
    }
    if (info.strict) {
        // 从严组: 长度受限且不含逗号/句号(排除作者告示长句)
        return line.length <= 24 && !/[，。]/.test(line);
    }
    // 从宽组(章/回/节/英文): 仅排除以句号结尾的告示长句
    // 合法标题允许含逗号, 如 "第231章 梦域，黑暗区域"
    return !line.endsWith('。');
}

/** 章节归一化键, 用于同编号去重 */
function chapterKey(marker: string): string {
    const cn = marker.match(new RegExp(`第[\\s\\d${CN_NUM_CHARS}]+[章回卷节部篇]`));
    if (cn) {
        return cn[0].replace(/\s+/g, '');
    }
    return marker.toLowerCase().replace(/\s+/g, '');
}

/** 结尾标记行, 如 "(本章完)"、"（本章完）" */
const CHAPTER_END_RE = /^[（(【\[]\s*(?:本章完|本章结束|本章已完|未完待续|本篇终|本集终|全书完)\s*[）)】\]]$/;

function countWords(text: string): number {
    return text.replace(/\s/g, '').length;
}

interface RawChapter {
    key: string;
    title: string;
    /** 去掉章节标记后的标题文字, 用于编号错位时的去重 */
    titleText: string;
    /** 标题行的原始缩进宽度 */
    indent: number;
    body: string[];
}

/**
 * 解析小说全文。
 * @param text      已解码的小说文本
 * @param filePath  来源文件路径(用于兜底书名)
 * @param encoding  检测到的编码(仅作记录)
 */
/**
 * 解析书名 / 作者(纯函数, 便于单测)。
 *
 * 优先级: **文件名 > 正文前言 > 文件名兜底**
 * 原因: 下载站的正文前言常含"内容简介/其他作品推荐", 里面的《...》往往是别的书
 * (例: 一通《一念永恒》的文件前言先提到《仙逆》, 曾被误判成"仙逆")
 */
export function deriveTitleAuthor(
    filePath: string,
    prefaceText: string
): { bookTitle: string; author: string } {
    const base = filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    const fnTitle = base.match(/《([^》]{1,60})》/);
    const fnAuthor = base.match(/作者\s*[:：]?\s*([^\s,，。;；|·）)】\]]{1,20})/);
    const metaTitle = prefaceText.match(/《([^》]{1,60})》/);
    const metaAuthor = prefaceText.match(/作者\s*[:：]?\s*([^\s,，。;；|]{1,20})/);

    const bookTitle = fnTitle
        ? fnTitle[1].trim()
        : metaTitle
          ? metaTitle[1].trim()
          : base.trim();
    const author = fnAuthor
        ? fnAuthor[1].trim()
        : metaAuthor
          ? metaAuthor[1].trim()
          : '';
    return { bookTitle, author };
}

export function parseNovel(text: string, filePath: string, encoding = 'utf-8'): Novel {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');

    const raws: RawChapter[] = [];
    const prefaceLines: string[] = [];
    let current: RawChapter | null = null;

    for (const rawLine of lines) {
        // 去掉行首半角/全角空白, 站点导出的正文常有 "    　　正文" 这类缩进
        const line = rawLine.replace(/^[\s\u3000]+/, '').trim();

        if (!line) {
            if (current) {
                current.body.push('');
            }
            continue;
        }

        if (looksLikeTitle(line)) {
            const marker = (matchMarker(line) as { marker: string }).marker;
            const key = chapterKey(marker);
            const titleText = line.slice(marker.length).trim();
            const indent = rawIndent(rawLine);

            if (current) {
                const isDuplicate =
                    // 1. 缩进更深: 正文中重复出现的标题行(最常见)
                    indent > current.indent ||
                    // 2. 同一章节编号重复出现
                    key === current.key ||
                    // 3. 编号错位但标题文字相同(源站编号错位, 如 真标题"第82章"对应重复行"第80章")
                    (titleText.length > 0 && titleText === current.titleText);
                if (isDuplicate) {
                    continue;
                }
                raws.push(current);
            }
            current = { key, title: line, titleText, indent, body: [] };
            continue;
        }

        if (CHAPTER_END_RE.test(line)) {
            continue;
        }

        if (current) {
            current.body.push(line);
        } else {
            prefaceLines.push(line);
        }
    }
    if (current) {
        raws.push(current);
    }

    // 剔除疑似目录块: 连续 >= 5 个无正文章节(正常书籍极少出现)
    const chapters: NovelChapter[] = [];
    let i = 0;
    while (i < raws.length) {
        if (raws[i].body.length === 0) {
            let j = i;
            while (j < raws.length && raws[j].body.length === 0) {
                j++;
            }
            if (j - i >= 5) {
                i = j;
                continue;
            }
        }
        chapters.push({
            index: chapters.length,
            title: raws[i].title,
            content: raws[i].body.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
            wordCount: countWords(raws[i].body.join('')),
        });
        i++;
    }

    const meta = prefaceLines.join('\n');
    const { bookTitle, author } = deriveTitleAuthor(filePath, meta);

    return {
        filePath,
        bookTitle,
        author,
        chapters,
        preface: meta.trim(),
        encoding,
        totalWords: chapters.reduce((sum, c) => sum + c.wordCount, 0),
    };
}

/** 按标题/正文关键字模糊查找章节 */
export function findChapter(novel: Novel, keyword: string): NovelChapter | undefined {
    const kw = keyword.trim().toLowerCase();
    if (!kw) {
        return undefined;
    }
    return (
        novel.chapters.find((c) => c.title.toLowerCase().includes(kw)) ??
        novel.chapters.find((c) => c.content.toLowerCase().includes(kw))
    );
}

/**
 * 书架为空时的占位"空书"。
 *
 * 目的: 让阅读面板在没书的情况下也能正常打开, 正文显示引导文案。
 * 否则「书源搜索」「笔记」「阅读设置」这些**只存在于面板内**的入口,
 * 一本没导入时等于完全不可用 —— 用户想联网搜书都找不到门。
 *
 * 判定方式: `filePath === ''`。凡是把进度写回书架/阅读历史的地方都要跳过空路径。
 */
export function createEmptyNovel(shelfEmpty = true): Novel {
    const content = [
        shelfEmpty ? '书架里还没有小说。' : '书架上暂时没有可读的书。',
        '',
        '可以这样开始：',
        '· 点左侧「书源」搜索在线书籍（需先导入书源）',
        '· 按 Ctrl+Shift+P 执行「小说阅读器: 打开小说文件」，导入本地 txt',
        '· 或在资源管理器里右键任意 .txt 文件 →「打开小说文件」',
        '',
        shelfEmpty
            ? '导入后会自动登记进书架，阅读进度也会自动记录。'
            : '若书架里有书但打不开，可能是原文件被移动或删除，重新导入即可。',
    ].join('\n');
    return {
        filePath: '',
        bookTitle: '小说阅读器',
        author: '',
        chapters: [
            {
                index: 0,
                title: '还没有打开任何书',
                content,
                wordCount: content.replace(/\s/g, '').length,
            },
        ],
        preface: '',
        encoding: 'utf8',
        totalWords: 0,
    };
}

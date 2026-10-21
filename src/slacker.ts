/**
 * slacker.ts — 摸鱼模式（伪装成写代码的阅读）
 *
 * 思路:
 *  - 不共用阅读 webview，而是把当前章节渲染成一份「伪代码」虚拟文档
 *    (自定义 scheme `novelfish:`，只读)，用 VS Code 原生编辑器展示 ——
 *    语法高亮 / 行号 / minimap / 标签页与平常写代码完全一致。
 *  - 小说段落以注释形式穿插在真实感的业务代码之间（默认 JavaScript，
 *    可切换 python / go / java / rust / sql 等）。
 *  - 老板键: 一键关闭所有摸鱼文档，立刻回到"正经工作"界面。
 *  - 翻章时把章节进度写回书架，与阅读页互通。
 */

import * as vscode from 'vscode';
import { Novel } from './novelParser';

export const SLACKER_SCHEME = 'novelfish';

/** 行宽上限: 注释超过此宽度折行, 更像手写代码 */
const COMMENT_WIDTH = 46;

type Rand = () => number;

/** 可复现的伪随机(同章节同 seed 生成结果一致, 避免刷新后内容漂移) */
function mulberry32(seed: number): Rand {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 字符串 -> 32 位种子 */
export function hashSeed(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** 注释折行: 中文按字符、英文按单词, 超宽即断行 */
export function wrapText(text: string, width = COMMENT_WIDTH): string[] {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) {
        return [];
    }
    if (clean.length <= width) {
        return [clean];
    }
    const out: string[] = [];
    let line = '';
    for (const ch of clean) {
        if (line.length + 1 > width) {
            out.push(line);
            line = '';
        }
        line += ch;
    }
    if (line) {
        out.push(line);
    }
    return out;
}

// ---------------------------------------------------------------- 语言定义

export interface SlackerLang {
    /** VS Code language id */
    id: string;
    /** 虚拟文件扩展名(决定语法高亮) */
    ext: string;
    /** QuickPick 展示名 */
    label: string;
    /** 行注释包裹(块注释语言内部已做闭合转义) */
    comment: (line: string) => string;
    /** 文件头注释块 */
    header: (r: Rand) => string[];
    /** import / using / 前置声明 */
    imports: (r: Rand) => string[];
    /** 真实感代码片段池(随机抽取穿插) */
    snippets: ((r: Rand) => string[])[];
    /** 收尾 */
    footer: (r: Rand) => string[];
}

/** 随机整数 [min, max] */
const num = (r: Rand, min: number, max: number): number => min + Math.floor(r() * (max - min + 1));
const pick = <T>(r: Rand, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const today = (): string => new Date().toISOString().slice(0, 10);

/** 块注释语言的安全转义: 段落里出现闭合符会截断注释 */
const safeBlock = (text: string, close: string): string => text.split(close).join(close === '*/' ? '*／' : '—>');

// -- C 系注释 (js/ts/java/go/csharp/cpp/rust/php) ----------------------------

const cComment = (line: string): string => `// ${line}`;

const cHeader = (file: string, desc: string) => (r: Rand): string[] => [
    '/**',
    ` * ${file} — ${desc}`,
    ' * 维护: backend 组',
    ` * 最近更新: ${today()}`,
    ' */',
];

function cLang(
    id: string,
    ext: string,
    label: string,
    imports: (r: Rand) => string[],
    snippets: ((r: Rand) => string[])[],
    footer: (r: Rand) => string[]
): SlackerLang {
    return {
        id, ext, label,
        comment: cComment,
        header: cHeader(`content-sync.${ext}`, '内容分发与审核调度服务'),
        imports,
        snippets,
        footer,
    };
}

const JS_IMPORTS = (r: Rand): string[] => [
    "'use strict';",
    '',
    "const { createClient } = require('./client');",
    "const { getConfig, logger } = require('./utils');",
    '',
    `const API_BASE = getConfig('content.apiBase') || 'https://svc.internal/api/v${num(r, 1, 3)}';`,
];

const JS_SNIPPETS: ((r: Rand) => string[])[] = [
    (r) => [`const READ_TIMEOUT = Number(getConfig('sync.readTimeout')) || ${num(r, 10, 60)};`],
    (r) => [`const BATCH_SIZE = Number(getConfig('sync.batchSize')) || ${num(r, 20, 200)};`],
    () => [
        'async function fetchChapterList(bookId) {',
        '    const res = await client.get(`/books/${bookId}/chapters`);',
        '    if (res.code !== 0) {',
        "        throw new Error(res.message || 'upstream error');",
        '    }',
        '    return res.data.list;',
        '}',
    ],
    () => [
        'function dedupe(list) {',
        '    const seen = new Set();',
        '    return list.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));',
        '}',
    ],
    () => ["const normalize = (raw) => String(raw || '').replace(/\\s+/g, ' ').trim();"],
    (r) => [
        'function withRetry(fn, times) {',
        '    return async (...args) => {',
        `        for (let i = 0; i < times; i++) {`,
        '            try {',
        '                return await fn(...args);',
        '            } catch (err) {',
        `                if (i === times - 1) throw err;`,
        `                await sleep(${num(r, 200, 2000)} * (i + 1));`,
        '            }',
        '        }',
        '    };',
        '}',
    ],
    (r) => [
        'exports.syncContent = async function syncContent(payload) {',
        `    const traceId = logger.begin('syncContent');`,
        '    try {',
        '        const list = await fetchChapterList(payload.bookId);',
        `        logger.info('sync done, total=%d', list.length);`,
        `        return { ok: true, count: list.length, tookMs: ${num(r, 20, 900)} };`,
        '    } finally {',
        '        logger.end(traceId);',
        '    }',
        '};',
    ],
    () => [
        "process.on('unhandledRejection', (err) => {",
        "    logger.error('unhandled rejection: %o', err);",
        '});',
    ],
    (r) => [
        'const metrics = {',
        `    qps: ${num(r, 40, 900)},`,
        `    p99: ${num(r, 12, 240)},`,
        "    unit: 'ms',",
        '};',
    ],
    () => [
        'if (!API_BASE) {',
        "    throw new Error('[config] content.apiBase is required');",
        '}',
    ],
    (r) => [
        'const limiter = new Semaphore(' + num(r, 3, 16) + ');',
        '',
        'async function bounded(task) {',
        '    return limiter.acquire(() => task());',
        '}',
    ],
];

const JS_FOOTER = (r: Rand): string[] => [
    '',
    'if (require.main === module) {',
    "    syncContent({ bookId: process.env.BOOK_ID || 'demo' }).catch((err) => {",
    "        logger.error('sync failed: %o', err);",
        '        process.exitCode = 1;',
    '    });',
    `} // eslint-disable-line ${pick(r, ['no-console', 'unicorn/prefer-top-level-await'])}`,
];

// 语言注册表: 默认 JavaScript 置顶
export const LANGS: SlackerLang[] = [
    cLang('javascript', 'js', 'JavaScript（默认）', JS_IMPORTS, JS_SNIPPETS, JS_FOOTER),
    cLang('typescript', 'ts', 'TypeScript',
        (r) => [
            "import { createClient, ApiResponse } from './client';",
            "import { getConfig, logger } from './utils';",
            '',
            `const API_BASE: string = getConfig('content.apiBase') ?? 'https://svc.internal/api/v${num(r, 1, 3)}';`,
        ],
        [
            (r) => [`const READ_TIMEOUT: number = Number(getConfig('sync.readTimeout')) || ${num(r, 10, 60)};`],
            () => [
                'interface ChapterMeta {',
                '    id: string;',
                '    title: string;',
                '    wordCount: number;',
                '}',
            ],
            () => [
                'async function fetchChapterList(bookId: string): Promise<ChapterMeta[]> {',
                '    const res: ApiResponse<ChapterMeta[]> = await client.get(`/books/${bookId}/chapters`);',
                "    if (res.code !== 0) throw new Error(res.message ?? 'upstream error');",
                '    return res.data;',
                '}',
            ],
            () => [
                'const normalize = (raw?: string | null): string =>',
                "    (raw ?? '').replace(/\\s+/g, ' ').trim();",
            ],
            (r) => [
                'export async function syncContent(payload: { bookId: string }): Promise<{ ok: boolean; count: number }> {',
                `    using _ = logger.span('syncContent');`,
                `    const list = await fetchChapterList(payload.bookId);`,
                `    return { ok: true, count: list.length, tookMs: ${num(r, 20, 900)} };`,
                '}',
            ],
            (r) => [
                'const enum SyncState {',
                '    Idle,',
                '    Running,',
                `    Backoff = ${num(r, 1, 9)},`,
                '}',
            ],
            (r) => [`const config = { retries: ${num(r, 2, 6)}, parallel: ${num(r, 2, 12)} } as const;`],
        ],
        (r) => [
            '',
            'void (async () => {',
            "    await syncContent({ bookId: 'demo' });",
            `})(); // ${pick(r, ['entrypoint', 'bootstrap'])}`,
        ]),
    {
        id: 'python', ext: 'py', label: 'Python',
        comment: (line) => `# ${line}`,
        header: (r) => [
            '# -*- coding: utf-8 -*-',
            '"""content_sync — 内容分发与审核调度服务."""',
            '',
            `# 维护: backend 组 | 最近更新: ${today()}`,
        ],
        imports: (r) => [
            'import os',
            'import time',
            'import logging',
            'import requests',
            '',
            'logger = logging.getLogger(__name__)',
            '',
            `API_BASE = os.getenv('CONTENT_API', 'https://svc.internal/api/v${num(r, 1, 3)}')`,
            `READ_TIMEOUT = int(os.getenv('SYNC_TIMEOUT', '${num(r, 10, 60)}'))`,
        ],
        snippets: [
            () => [
                'def fetch_chapter_list(book_id):',
                '    resp = requests.get(f"{API_BASE}/books/{book_id}/chapters", timeout=READ_TIMEOUT)',
                '    resp.raise_for_status()',
                "    return resp.json()['data']['list']",
            ],
            () => [
                'def dedupe(items):',
                '    seen = set()',
                '    result = []',
                '    for it in items:',
                '        if it["id"] not in seen:',
                '            seen.add(it["id"])',
                '            result.append(it)',
                '    return result',
            ],
            () => ["normalize = lambda raw: ' '.join((raw or '').split())"],
            (r) => [
                'def with_retry(fn, times=None):',
                `    times = times or ${num(r, 2, 6)}`,
                '    for attempt in range(times):',
                '        try:',
                '            return fn()',
                '        except requests.RequestException:',
                '            if attempt == times - 1:',
                '                raise',
                `            time.sleep(0.5 * (attempt + 1))`,
            ],
            (r) => [
                '@dataclass',
                'class SyncTask:',
                '    book_id: str',
                `    batch_size: int = ${num(r, 20, 200)}`,
                '    dry_run: bool = False',
            ],
            (r) => [
                'async def sync_content(payload):',
                `    logger.info('sync start, book=%s', payload['book_id'])`,
                `    await asyncio.sleep(${num(r, 1, 4) * 0.1})`,
                "    return {'ok': True, 'count': 0}",
            ],
        ],
        footer: () => [
            '',
            "if __name__ == '__main__':",
            '    logging.basicConfig(level=logging.INFO)',
            "    sync_content({'book_id': 'demo'})",
        ],
    },
    cLang('java', 'java', 'Java',
        () => [
            'package com.internal.content;',
            '',
            'import java.net.http.HttpClient;',
            'import java.util.*;',
            'import java.time.Duration;',
        ],
        [
            () => [
                '/** 内容同步调度器 */',
                'public class ContentSync {',
                '',
                '    private static final Duration READ_TIMEOUT = Duration.ofSeconds(30);',
                '    private final HttpClient client = HttpClient.newHttpClient();',
            ],
            (r) => [`    private static final int BATCH_SIZE = ${num(r, 20, 200)};`],
            () => [
                '    public List<ChapterMeta> fetchChapterList(String bookId) throws Exception {',
                '        var req = HttpRequest.newBuilder(URI.create(API_BASE + "/books/" + bookId))',
                '            .timeout(READ_TIMEOUT)',
                '            .build();',
                '        var resp = client.send(req, HttpResponse.BodyHandlers.ofString());',
                '        return parse(resp.body());',
                '    }',
            ],
            () => [
                '    private static <T> List<T> dedupe(List<T> items) {',
                '        return new ArrayList<>(new LinkedHashSet<>(items));',
                '    }',
            ],
        ],
        () => ['}']),
    cLang('go', 'go', 'Go',
        () => [
            'package contentsync',
            '',
            'import (',
            '\t"context"',
            '\t"net/http"',
            '\t"time"',
            ')',
        ],
        [
            (r) => [
                `const (`,
                `\treadTimeout = ${num(r, 10, 60)} * time.Second`,
                `\tbatchSize   = ${num(r, 20, 200)}`,
                `)`,
            ],
            () => [
                'func FetchChapterList(ctx context.Context, bookID string) ([]ChapterMeta, error) {',
                '\treq, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+"/books/"+bookID, nil)',
                '\tif err != nil {',
                '\t\treturn nil, err',
                '\t}',
                '\tresp, err := http.DefaultClient.Do(req)',
                '\tif err != nil {',
                '\t\treturn nil, err',
                '\t}',
                '\tdefer resp.Body.Close()',
                '\treturn decodeList(resp.Body)',
                '}',
            ],
            (r) => [
                'var sem = make(chan struct{}, ' + num(r, 3, 16) + ')',
                '',
                'func bounded(ctx context.Context, fn func() error) error {',
                '\tselect {',
                '\tcase sem <- struct{}{}:',
                '\t\tdefer func() { <-sem }()',
                '\t\treturn fn()',
                '\tcase <-ctx.Done():',
                '\t\treturn ctx.Err()',
                '\t}',
                '}',
            ],
        ],
        () => ['']),
    cLang('csharp', 'cs', 'C#',
        () => [
            'using System;',
            'using System.Collections.Generic;',
            'using System.Net.Http;',
            'using System.Threading.Tasks;',
            '',
            'namespace Internal.Content;',
        ],
        [
            () => [
                '/// <summary>内容同步调度器</summary>',
                'public sealed class ContentSync',
                '{',
                '    private static readonly HttpClient Http = new();',
                '    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);',
            ],
            (r) => [`    private const int BatchSize = ${num(r, 20, 200)};`],
            () => [
                '    public async Task<IReadOnlyList<ChapterMeta>> FetchChapterListAsync(string bookId)',
                '    {',
                '        using var resp = await Http.GetAsync($"{ApiBase}/books/{bookId}");',
                '        resp.EnsureSuccessStatusCode();',
                '        return await ReadListAsync(resp);',
                '    }',
            ],
        ],
        () => ['}']),
    cLang('cpp', 'cpp', 'C++',
        () => [
            '#include <algorithm>',
            '#include <string>',
            '#include <vector>',
            '',
            'namespace content {',
        ],
        [
            (r) => [`constexpr int kBatchSize = ${num(r, 20, 200)};`],
            () => [
                'struct ChapterMeta {',
                '    std::string id;',
                '    std::string title;',
                '    std::size_t word_count = 0;',
                '};',
            ],
            () => [
                'std::vector<ChapterMeta> FetchChapterList(const std::string& book_id) {',
                '    auto resp = http_get("/books/" + book_id + "/chapters");',
                '    if (resp.status != 200) {',
                '        throw std::runtime_error("upstream error");',
                '    }',
                '    return ParseList(resp.body);',
                '}',
            ],
        ],
        () => [
            '',
            '}  // namespace content',
        ]),
    cLang('rust', 'rs', 'Rust',
        () => [
            'use std::time::Duration;',
            '',
            "const READ_TIMEOUT: Duration = Duration::from_secs(30);",
        ],
        [
            (r) => [`const BATCH_SIZE: usize = ${num(r, 20, 200)};`],
            () => [
                '#[derive(Debug, Clone)]',
                'pub struct ChapterMeta {',
                '    pub id: String,',
                '    pub title: String,',
                '    pub word_count: usize,',
                '}',
            ],
            () => [
                'pub async fn fetch_chapter_list(book_id: &str) -> anyhow::Result<Vec<ChapterMeta>> {',
                '    let url = format!("{api_base}/books/{book_id}/chapters");',
                '    let resp = client.get(url).timeout(READ_TIMEOUT).send().await?;',
                '    if !resp.status().is_success() {',
                '        anyhow::bail!("upstream error: {}", resp.status());',
                '    }',
                '    Ok(resp.json().await?)',
                '}',
            ],
        ],
        () => ['']),
    cLang('php', 'php', 'PHP',
        () => [
            '<?php',
            '',
            'declare(strict_types=1);',
            '',
            'namespace Internal\\Content;',
        ],
        [
            (r) => [`final class ContentSync`, `{`, `    private const BATCH_SIZE = ${num(r, 20, 200)};`],
            () => [
                '    public function fetchChapterList(string $bookId): array',
                '    {',
                '        $resp = $this->client->get("/books/{$bookId}/chapters");',
                '        if ($resp->code !== 0) {',
                '            throw new \\RuntimeException($resp->message ?? \'upstream error\');',
                '        }',
                '        return $resp->data[\'list\'];',
                '    }',
            ],
        ],
        () => ['}']),
    {
        id: 'ruby', ext: 'rb', label: 'Ruby',
        comment: (line) => `# ${line}`,
        header: (r) => [
            '# frozen_string_literal: true',
            '',
            '# 内容分发与审核调度服务',
            `# 维护: backend 组 | 最近更新: ${today()}`,
        ],
        imports: (r) => [
            'require "net/http"',
            'require "json"',
            '',
            'module Content',
            `  API_BASE = ENV.fetch('CONTENT_API', 'https://svc.internal/api/v${num(r, 1, 3)}')`,
            '',
        ],
        snippets: [
            (r) => [`  READ_TIMEOUT = ${num(r, 10, 60)}`],
            () => [
                '  def fetch_chapter_list(book_id)',
                '    uri = URI("#{API_BASE}/books/#{book_id}/chapters")',
                '    resp = Net::HTTP.get(uri)',
                '    JSON.parse(resp).dig("data", "list")',
                '  end',
            ],
            () => [
                '  def dedupe(items)',
                '    items.uniq { |it| it["id"] }',
                '  end',
            ],
        ],
        footer: () => ['  module_function :fetch_chapter_list', 'end'],
    },
    {
        id: 'sql', ext: 'sql', label: 'SQL',
        comment: (line) => `-- ${line}`,
        header: (r) => [
            '-- content_sync.sql — 内容分发统计与对账',
            `-- 维护: backend 组 | 最近更新: ${today()}`,
        ],
        imports: () => [],
        snippets: [
            (r) => [
                'SELECT book_id, COUNT(*) AS chapter_cnt',
                'FROM chapter_meta',
                `WHERE status = 'published'`,
                `  AND updated_at > NOW() - INTERVAL '${num(r, 1, 24)} hours'`,
                'GROUP BY book_id',
                `ORDER BY chapter_cnt DESC`,
                `LIMIT ${num(r, 10, 100)};`,
            ],
            (r) => [
                'UPDATE sync_task',
                `SET state = 'running', retry = retry + ${num(r, 1, 3)}`,
                'WHERE book_id = :book_id',
                '  AND state IN (\'pending\', \'failed\');',
            ],
            () => [
                'CREATE INDEX idx_chapter_book_status',
                '    ON chapter_meta (book_id, status, updated_at DESC);',
            ],
            (r) => [
                `ANALYZE chapter_meta;`,
                `VACUUM (VERBOSE, ANALYZE) sync_task; -- ${num(r, 1, 9)}0${num(r, 1, 9)}ms`,
            ],
        ],
        footer: () => [],
    },
    {
        id: 'html', ext: 'html', label: 'HTML',
        comment: (line) => `<!-- ${safeBlock(line, '-->')} -->`,
        header: () => ['<!DOCTYPE html>', '<html lang="zh-CN">'],
        imports: (r) => [
            '<head>',
            '  <meta charset="utf-8" />',
            `  <title>内容管理后台 v${num(r, 1, 4)}.${num(r, 0, 9)}</title>`,
            '  <link rel="stylesheet" href="/static/app.css" />',
            '</head>',
            '<body class="admin-layout">',
        ],
        snippets: [
            (r) => [
                `  <div class="panel" data-batch="${num(r, 100, 999)}">`,
                '    <header class="panel-head">',
                '      <h3>内容同步</h3>',
                '      <button class="btn" type="button">刷新</button>',
                '    </header>',
                '    <table class="table">',
                '      <thead><tr><th>书名</th><th>章节数</th><th>状态</th></tr></thead>',
                '      <tbody><!-- rows injected by app.js --></tbody>',
                '    </table>',
                '  </div>',
            ],
            () => [
                '  <script src="/static/vendor/axios.min.js" defer></script>',
                '  <script src="/static/app.js" defer></script>',
            ],
        ],
        footer: () => ['</body>', '</html>'],
    },
    {
        id: 'css', ext: 'css', label: 'CSS',
        comment: (line) => `/* ${safeBlock(line, '*/')} */`,
        header: (r) => [
            '/* content-admin.css — 内容管理后台样式',
            ` * 维护: web 组 | 最近更新: ${today()}`,
            ' */',
            '',
            ':root {',
            `  --panel-radius: ${num(r, 4, 12)}px;`,
            '  --brand: #3f6ad8;',
            '}',
        ],
        imports: () => [],
        snippets: [
            () => [
                '.admin-layout {',
                '    display: grid;',
                '    grid-template-columns: 220px 1fr;',
                '    min-height: 100vh;',
                '}',
            ],
            (r) => [
                '.panel {',
                '    border: 1px solid #e2e6ee;',
                `    border-radius: var(--panel-radius);`,
                `    padding: ${num(r, 8, 24)}px;`,
                '    background: #fff;',
                '}',
            ],
            (r) => [
                '.table tr:hover {',
                `    background: rgba(63, 106, 216, 0.${num(r, 4, 9)});`,
                '}',
            ],
        ],
        footer: () => [],
    },
    {
        id: 'shellscript', ext: 'sh', label: 'Shell',
        comment: (line) => `# ${line}`,
        header: (r) => [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            '',
            '# content_sync.sh — 内容分发同步脚本',
            `# 维护: backend 组 | 最近更新: ${today()}`,
        ],
        imports: (r) => [
            `API_BASE="\${CONTENT_API:-https://svc.internal/api/v${num(r, 1, 3)}}"`,
            `RETRY=\${RETRY:-${num(r, 2, 6)}}`,
            '',
        ],
        snippets: [
            () => [
                'fetch_chapter_list() {',
                '    local book_id="$1"',
                '    curl -fsS --max-time 30 "${API_BASE}/books/${book_id}/chapters"',
                '}',
            ],
            (r) => [
                'wait_with_backoff() {',
                `    local delay=$${num(r, 1, 5)}`,
                '    for _ in $(seq 1 "$RETRY"); do',
                '        "$@" && return 0 || true',
                '        sleep "$delay"',
                '        delay=$((delay * 2))',
                '    done',
                '    return 1',
                '}',
            ],
            () => [
                'main() {',
                '    local book_id="${1:-demo}"',
                '    fetch_chapter_list "$book_id" | jq -r \'.data.list[].id\'',
                '}',
            ],
        ],
        footer: () => ['main "$@"'],
    },
];

/** 按 id 取语言(未知 id 回退 JavaScript) */
export function getLang(id: string | undefined): SlackerLang {
    return LANGS.find((l) => l.id === id) ?? LANGS[0];
}

// ---------------------------------------------------------------- 代码生成

export interface SlackerSource {
    chapterTitle: string;
    paragraphs: string[];
}

/**
 * 把章节渲染成伪代码:
 * 段落 -> 折行注释, 与真实感代码片段交替穿插。
 * 同一 (章节, 语言, seed) 生成结果稳定。
 */
export function buildFakeCode(src: SlackerSource, langId: string, seed: number): string {
    const lang = getLang(langId);
    const r = mulberry32(seed);

    const lines: string[] = [];
    lines.push(...lang.header(r));
    lines.push('');
    const imports = lang.imports(r);
    if (imports.length) {
        lines.push(...imports);
        lines.push('');
    }

    const paras = src.paragraphs.map((p) => p.trim()).filter(Boolean);
    paras.forEach((para, i) => {
        // 章节开头放一条批次注释(伪装成任务说明, 也提示当前位置)
        if (i === 0) {
            lines.push(...wrapText(`[batch ${i + 1}] ${src.chapterTitle}`).map(lang.comment));
            lines.push('');
        }
        for (const wl of wrapText(para)) {
            lines.push(lang.comment(wl));
        }
        // 1-2 段代码片段
        const count = 1 + (r() < 0.35 ? 1 : 0);
        for (let k = 0; k < count; k++) {
            lines.push('');
            lines.push(...pick(r, lang.snippets)(r));
        }
        lines.push('');
    });

    const footer = lang.footer(r);
    if (footer.length) {
        lines.push(...footer);
    }
    return lines.join('\n') + '\n';
}

/** 虚拟文档 URI: novelfish://slacker/<章节名>.<ext>?book=&idx=&lang= */
export function slackerUri(novel: Novel, index: number, lang: SlackerLang): vscode.Uri {
    const safeTitle =
        (novel.chapters[index]?.title || `chapter-${index + 1}`)
            .replace(/[\\/:*?"<>|\s]+/g, '_')
            .slice(0, 48) || 'chapter';
    const query = new URLSearchParams({
        book: novel.filePath,
        idx: String(index),
        lang: lang.id,
    }).toString();
    return vscode.Uri.parse(`${SLACKER_SCHEME}://slacker/${encodeURIComponent(safeTitle)}.${lang.ext}?${query}`);
}

// ---------------------------------------------------------------- 会话控制

export interface SlackerDeps {
    /** 取当前书(书架最近一本, 由 extension 注入 ensureNovel) */
    getNovel: () => Promise<Novel | null>;
    /** 读当前伪装语言配置 */
    getLanguage: () => string;
    /** 持久化语言配置 */
    setLanguage: (id: string) => Thenable<void>;
    /** 章节进度写回书架 */
    onProgress: (filePath: string, chapterIndex: number) => void;
}

export class SlackerController implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();
    private readonly novels = new Map<string, Novel>();
    private cur?: { novel: Novel; index: number };
    private lastColumn?: vscode.ViewColumn;
    private readonly onDidChangeEvent = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.onDidChangeEvent.event;

    constructor(private readonly deps: SlackerDeps) {}

    register(): vscode.Disposable {
        return vscode.workspace.registerTextDocumentContentProvider(SLACKER_SCHEME, this);
    }

    /** provider 回调: 生成(或取缓存)文档内容 */
    provideTextDocumentContent(uri: vscode.Uri): string {
        const cached = this.contents.get(uri.toString());
        if (typeof cached === 'string') {
            return cached;
        }
        const params = new URLSearchParams(uri.query);
        const novel = this.novels.get(params.get('book') ?? '');
        const idx = Number(params.get('idx') ?? '-1');
        if (!novel || !novel.chapters[idx]) {
            return '// [摸鱼模式] 内容已过期, 请重新执行「摸鱼模式: 开始摸鱼阅读」。';
        }
        const chapter = novel.chapters[idx];
        const text = buildFakeCode(
            { chapterTitle: chapter.title, paragraphs: chapter.content.split('\n') },
            params.get('lang') ?? 'javascript',
            hashSeed(`${novel.filePath}#${idx}`)
        );
        this.contents.set(uri.toString(), text);
        return text;
    }

    /** 进入摸鱼模式: 打开指定章节的伪装文档 */
    async open(novel: Novel, index: number): Promise<void> {
        const idx = Math.min(Math.max(0, index), novel.chapters.length - 1);
        const lang = getLang(this.deps.getLanguage());
        this.novels.set(novel.filePath, novel);
        const uri = slackerUri(novel, idx, lang);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
            preview: true,
            viewColumn: this.lastColumn ?? vscode.ViewColumn.One,
            preserveFocus: false,
        });
        this.lastColumn = editor.viewColumn;
        this.cur = { novel, index: idx };
        this.deps.onProgress(novel.filePath, idx);
    }

    /** 上/下一章 */
    async step(dir: 1 | -1): Promise<void> {
        if (!this.cur) {
            const novel = await this.deps.getNovel();
            if (!novel) {
                void vscode.window.showInformationMessage('书架里还没有小说，先添加一本吧。');
                return;
            }
            await this.open(novel, 0);
            return;
        }
        const { novel, index } = this.cur;
        const next = index + dir;
        if (next < 0 || next >= novel.chapters.length) {
            vscode.window.setStatusBarMessage(
                dir > 0 ? '摸鱼模式: 已是最后一章' : '摸鱼模式: 已是第一章',
                3000
            );
            return;
        }
        await this.open(novel, next);
    }

    /** 切换伪装语言(QuickPick, 选择后记住并重开当前章) */
    async pickLanguage(): Promise<void> {
        const current = this.deps.getLanguage();
        const picked = await vscode.window.showQuickPick(
            LANGS.map((l) => ({
                label: l.label,
                description: `.${l.ext}`,
                lang: l,
                picked: l.id === current,
            })),
            { title: '摸鱼模式 · 选择伪装的编程语言', matchOnDescription: true }
        );
        if (!picked) {
            return;
        }
        await this.deps.setLanguage(picked.lang.id);
        if (this.cur) {
            await this.open(this.cur.novel, this.cur.index);
        } else {
            vscode.window.setStatusBarMessage(`伪装语言已切换为 ${picked.lang.label}`, 3000);
        }
    }

    /** 老板键: 立即关闭所有摸鱼文档 */
    async boss(): Promise<void> {
        const tabs = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .filter((t) => {
                const uri = (t.input as { uri?: vscode.Uri } | undefined)?.uri;
                return uri instanceof vscode.Uri && uri.scheme === SLACKER_SCHEME;
            });
        if (tabs.length) {
            await vscode.window.tabGroups.close(tabs, true);
        }
        this.cur = undefined;
    }
}

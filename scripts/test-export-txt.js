/**
 * test-export-txt.js — 离线内容导出为本地 txt
 *
 * 重点: 段距不丢、文件名安全/去重、标题不合规时回退编号。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OfflineStore } = require('../dist/offline/offlineStore');
const { safeFileName, uniquePath, buildNovelText, exportOfflineTxt } = require('../dist/offline/exportTxt');
const { parseNovel } = require('../dist/novelParser');
const { onlineKey } = require('../dist/onlinePath');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r-export-txt-'));
let seq = 0;

function makeEnv(titles) {
  seq += 1;
  const store = new OfflineStore(path.join(ROOT, 'case' + seq));
  const bookUrl = 'https://example.com/book/' + seq;
  const key = onlineKey('src1', bookUrl);
  const chapters = titles.map((t, i) => ({ index: i, title: t, url: bookUrl + '/c/' + i }));
  return { store, key, bookUrl, chapters };
}

(async () => {
  // ---------------------------------------------------------------- 1) 文件名安全
  {
    const name = safeFileName('a/b:c*?"<>| d.');
    assert.ok(!/[\\/:*?"<>|]/.test(name), '不应残留非法字符: ' + name);
    assert.ok(!/[. ]$/.test(name), '不应以点或空格结尾: ' + name);
    assert.strictEqual(safeFileName('  ...  '), '未命名', '全非法应回退占位名');
    assert.ok(safeFileName('长'.repeat(200)).length <= 80, '长度应被截断');
    assert.strictEqual(safeFileName('CON'), 'CON_', 'Windows 保留名应加后缀');
  }

  // ---------------------------------------------------------------- 2) 目录内去重
  {
    const dir = path.join(ROOT, 'dedupe');
    fs.mkdirSync(dir, { recursive: true });
    const first = await uniquePath(dir, '书.txt');
    assert.strictEqual(path.basename(first), '书.txt');
    fs.writeFileSync(first, 'x');
    const second = await uniquePath(dir, '书.txt');
    assert.strictEqual(path.basename(second), '书 (1).txt');
    fs.writeFileSync(second, 'x');
    const third = await uniquePath(dir, '书.txt');
    assert.strictEqual(path.basename(third), '书 (2).txt');
  }

  // ---------------------------------------------------------------- 3) 纯函数拼装
  {
    const manifest = {
      v: 1,
      sourceId: 'src1', sourceName: '源', bookUrl: 'https://x/1', bookTitle: '测试书', author: '作者',
      tocUrl: '', tocFetchedAt: 1,
      chapters: [
        { index: 0, title: '第1章 甲', url: 'u0' },
        { index: 1, title: '第2章 乙', url: 'u1' },
      ],
      totalChapters: 2, createdAt: 1, updatedAt: 1,
    };
    const bodies = new Map([[0, ['甲段一', '甲段二']]]);
    const built = buildNovelText(manifest, bodies);
    assert.strictEqual(built.chapters, 1, '只应写入有正文的章');
    assert.strictEqual(built.missing, 1, '缺章应计数');
    assert.ok(built.text.indexOf('《测试书》') === 0, '首行应是书名');
    assert.ok(built.text.indexOf('作者：作者') > 0, '应带作者');
    assert.ok(built.text.indexOf('甲段一\n\n甲段二') > 0, '段落间应保留空行');
  }

  // ---------------------------------------------------------------- 4) 完整导出 + 可被解析器还原
  {
    const env = makeEnv(['第1章 甲', '第2章 乙', '第3章 丙']);
    await env.store.ensureManifest(env.key, {
      sourceId: 'src1', sourceName: '源', bookUrl: env.bookUrl,
      bookTitle: '测试书', author: '作者',
      tocUrl: '', tocFetchedAt: 1,
      chapters: env.chapters, totalChapters: 3,
    });
    await env.store.writeChapter(env.key, 0, ['甲一', '甲二']);
    await env.store.writeChapter(env.key, 1, ['乙一', '乙二']);
    await env.store.writeChapter(env.key, 2, ['丙一']);

    const target = path.join(ROOT, 'out', '测试书.txt');
    const res = await exportOfflineTxt({ store: env.store, key: env.key, targetFile: target, baseName: '测试书' });
    assert.strictEqual(res.ok, true, '导出应成功' + (res.message ? ': ' + res.message : ''));
    assert.strictEqual(res.chapters, 3);
    assert.strictEqual(res.missing, 0);
    assert.strictEqual(res.filePath, target);

    const text = fs.readFileSync(target, 'utf8');
    const parsed = parseNovel(text, target, 'utf8');
    assert.strictEqual(parsed.chapters.length, 3, '导出文本应能解析出 3 章');
    assert.deepStrictEqual(parsed.chapters.map((c) => c.title), ['第1章 甲', '第2章 乙', '第3章 丙']);
    assert.ok(parsed.chapters[0].content.indexOf('甲一') >= 0);
    assert.ok(parsed.chapters[0].content.indexOf('甲二') > parsed.chapters[0].content.indexOf('甲一'),
      '段落顺序应保持');
    assert.ok(/\n\s*\n/.test(parsed.chapters[0].content), '段距应保留(段落之间有空行)');
    assert.strictEqual(parsed.bookTitle, '测试书', '书名应可还原');
    assert.strictEqual(parsed.author, '作者');
  }

  // ---------------------------------------------------------------- 5) 部分未下载 → missing 计数
  {
    const env = makeEnv(['第1章 甲', '第2章 乙', '第3章 丙']);
    await env.store.ensureManifest(env.key, {
      sourceId: 'src1', sourceName: '源', bookUrl: env.bookUrl,
      bookTitle: '测试书', author: '作者',
      tocUrl: '', tocFetchedAt: 1,
      chapters: env.chapters, totalChapters: 3,
    });
    await env.store.writeChapter(env.key, 0, ['甲一']);
    await env.store.writeChapter(env.key, 2, ['丙一']);

    const target = path.join(ROOT, 'out2', '部分.txt');
    const res = await exportOfflineTxt({ store: env.store, key: env.key, targetFile: target, baseName: '部分' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.chapters, 2);
    assert.strictEqual(res.missing, 1, '应有 1 章未下载');
    const parsed = parseNovel(fs.readFileSync(target, 'utf8'), target, 'utf8');
    assert.strictEqual(parsed.chapters.length, 2, '只导出已下载的 2 章');
  }

  // ---------------------------------------------------------------- 6) 标题不合规 → 回退编号
  {
    const env = makeEnv(['开始', '中间', '结束']);
    await env.store.ensureManifest(env.key, {
      sourceId: 'src1', sourceName: '源', bookUrl: env.bookUrl,
      bookTitle: '测试书', author: '',
      tocUrl: '', tocFetchedAt: 1,
      chapters: env.chapters, totalChapters: 3,
    });
    await env.store.writeChapter(env.key, 0, ['一']);
    await env.store.writeChapter(env.key, 1, ['二']);
    await env.store.writeChapter(env.key, 2, ['三']);

    const target = path.join(ROOT, 'out3', '非标准.txt');
    const res = await exportOfflineTxt({ store: env.store, key: env.key, targetFile: target, baseName: '非标准' });
    assert.strictEqual(res.ok, true);
    const parsed = parseNovel(fs.readFileSync(target, 'utf8'), target, 'utf8');
    assert.strictEqual(parsed.chapters.length, 3, '回退编号后应能解析出 3 章');
    assert.ok(/第1章\s*开始/.test(parsed.chapters[0].title), '回退标题应带章节号: ' + parsed.chapters[0].title);
  }

  // ---------------------------------------------------------------- 7) 没有离线内容 → 明确失败
  {
    const env = makeEnv(['第1章 甲']);
    const res = await exportOfflineTxt({
      store: env.store, key: env.key,
      targetFile: path.join(ROOT, 'out4', '空.txt'), baseName: '空',
    });
    assert.strictEqual(res.ok, false);
    assert.ok(/没有离线内容/.test(res.message || ''), '应提示先下载: ' + res.message);
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('离线导出 txt(文件名/段距/解析还原/回退编号)测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * test-shelf-refresh.js — 刷新书架预演/执行的纯函数回归（src/shelfRefresh.ts）
 *
 * 覆盖 PRD R7-05 / Q9 / Q10：
 *  1. 预演只读盘、不产生任何写入；
 *  2. 五类计数（add / skipDuplicate / merge / retitle / prune）与旧语义逐条一致；
 *  3. `ENOENT` 才进 prune；`EACCES/EPERM/EBUSY/EMFILE/UNKNOWN` 一律进 inaccessible 且不清理；
 *  4. 目录整体读失败时一切为空 + 给出"只能重试"的警告；
 *  5. planId 过期由宿主校验（这里断言 plan/result 都原样带回 planId，
 *     执行阶段不篡改编号 —— 过期判断在 extension 侧比对 lastPlan.planId）；
 *  6. 执行结果与预演一致；单项失败不影响其余项。
 *
 * 运行: node scripts/test-shelf-refresh.js（需先 npm run compile）
 */
'use strict';
const assert = require('assert');

const {
  planShelfRefresh,
  applyShelfRefresh,
  summarizePlan,
} = require('../dist/shelfRefresh.js');
const { shelfBookKey } = require('../dist/shelfMaintenance.js');

const DIR = '/lib';

function isInsideDir(p, dir) {
  return (p || '').toLowerCase().indexOf((dir || '').toLowerCase() + '/') === 0;
}
function base(p) {
  return (p || '').replace(/^.*[\\/]/, '');
}

/**
 * 构造一个可控的 fs 桩。
 * @param files  name -> { text } | { missing: true } | { code: 'EACCES' }
 */
function makeFs(files, opts) {
  const o = opts || {};
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    async readdir(dir) {
      if (o.readdirError) { throw new Error('EACCES: readdir'); }
      return Object.keys(files).map((name) => ({
        name,
        isFile: () => name.toLowerCase().endsWith('.txt'),
      }));
    },
    async readFile(p) {
      reads.push(p);
      const entry = files[base(p)];
      if (!entry || entry.missing || entry.code) { throw new Error('ENOENT'); }
      return Buffer.from(entry.text || '', 'utf8');
    },
    async probe(p) {
      const entry = files[base(p)];
      if (!entry || entry.missing) { return 'ENOENT'; }
      if (entry.code) { return entry.code; }
      return null;
    },
    exists(p) {
      const entry = files[base(p)];
      return !!entry && !entry.missing && !entry.code;
    },
  };
}

/** 解析桩: 书名取文件名去掉 " (n)" 后缀(模拟真实的副本命名), 作者取 "作者:xxx" 行 */
function bookTitleOf(p) {
  return base(p).replace(/\.txt$/i, '').replace(/\s*\(\d+\)$/, '');
}
function parse(text, p) {
  const lines = String(text).split('\n').filter(Boolean);
  const authorLine = lines.find((l) => l.indexOf('作者:') === 0);
  const chapters = lines.filter((l) => l.indexOf('章节') === 0);
  return {
    bookTitle: bookTitleOf(p),
    author: authorLine ? authorLine.slice(3) : '',
    chapters: chapters.length ? chapters : [1],
  };
}
function decode(buf) {
  return { text: buf.toString('utf8'), encoding: 'utf-8' };
}
function deriveTitleAuthor(filePath) {
  const m = /《([^》]{1,60})》/.exec(base(filePath));
  return { bookTitle: m ? m[1] : base(filePath).replace(/\.txt$/i, ''), author: '' };
}

function planInput(files, shelf, planId, opts) {
  return {
    dir: DIR,
    shelf,
    fs: makeFs(files, opts),
    isInsideDir,
    decode,
    parse,
    deriveTitleAuthor,
    planId: planId === undefined ? 7 : planId,
  };
}

(async function main() {
    // ============================================================ 1. 五种分类
    const shelf = [
        // 已在书架且文件在 -> 不计入任何分类
        { filePath: '/lib/已存在.txt', title: '已存在', author: '', totalChapters: 2, chapterIndex: 0 },
        // 文件已删除(ENOENT) -> prune
        { filePath: '/lib/已删除.txt', title: '已删除', author: '', totalChapters: 3, chapterIndex: -1 },
        // 暂时不可访问(EACCES) -> inaccessible, 绝不清理
        { filePath: '/lib/无权限.txt', title: '无权限', author: '', totalChapters: 3, chapterIndex: -1 },
        // 已不存在但文件仍在 -> 不改
        { filePath: '/lib/临时.txt', title: '临时', author: '', totalChapters: 3, chapterIndex: -1 },
        // 重复记录: 与「书籍甲」同书键（两条同名同作者同章数 -> merge）
        { filePath: '/lib/书籍甲 (1).txt', title: '书籍甲', author: '张三', totalChapters: 5, chapterIndex: 2 },
        { filePath: '/lib/书籍甲 (2).txt', title: '书籍甲', author: '张三', totalChapters: 5, chapterIndex: -1 },
    ];
    const files = {
        '已存在.txt': { text: '作者:\n章节1\n章节2' },
        // ENOENT
        '已删除.txt': { missing: true },
        '无权限.txt': { code: 'EACCES' },
        '临时.txt': { text: '作者:\n章节1\n章节2\n章节3' },
        '书籍甲.txt': { text: '作者:张三\n章节1\n章节2\n章节3\n章节4\n章节5' },
        '书籍甲 (1).txt': { text: '作者:张三\n章节1\n章节2\n章节3\n章节4\n章节5' },
        '书籍甲 (2).txt': { text: '作者:张三\n章节1\n章节2\n章节3\n章节4\n章节5' },
        // 新书 -> add
        '新书.txt': { text: '作者:李四\n章节1\n章节2' },
        // 同书键已在书架 -> skipDuplicate
        '已存在 (1).txt': { text: '作者:\n章节1\n章节2' },
        // 解析失败 -> warning, 不 add
        '坏文件.txt': { text: '' },
        // 书名纠偏: 文件存在, 记录标题与文件名不符
        '《正确书名》.txt': { text: '作者:\n章节1\n章节2' },
        // 非 txt 应被忽略
        'note.md': { text: 'x' },
    };
    // 让「坏文件」解析抛错
    const input = planInput(files, shelf, 42);
    input.parse = function (text, p) {
        if (base(p) === '坏文件.txt') { throw new Error('无法解析'); }
        if (base(p) === '《正确书名》.txt') { return { bookTitle: '正确书名', author: '', chapters: [1, 2] }; }
        return parse(text, p);
    };
    // 书名纠偏用的记录
    input.shelf = shelf.concat([
        { filePath: '/lib/《正确书名》.txt', title: '旧书名', author: '', totalChapters: 2, chapterIndex: -1 },
    ]);

    const fsStub = input.fs;
    const plan = await planShelfRefresh(input);

    assert.strictEqual(plan.planId, 42, 'plan 必须带回 planId');
    assert.strictEqual(plan.dir, DIR, 'plan 必须带回书库目录');
    assert.strictEqual(plan.scanned, 11, 'scanned 应只统计 .txt（note.md 不算）, 实际 ' + plan.scanned);

    const addedNames = plan.add.map((a) => base(a.filePath));
    assert(addedNames.indexOf('新书.txt') >= 0, '新文件应进入 add');
    assert(addedNames.indexOf('已存在.txt') < 0, '已在书架的路径不应进入 add');
    assert(addedNames.indexOf('坏文件.txt') < 0, '解析失败的文件不应进入 add');

    const dupNames = plan.skipDuplicate.map(base);
    assert(dupNames.indexOf('已存在 (1).txt') >= 0, '同书键的文件应进入 skipDuplicate');
    assert(dupNames.indexOf('书籍甲.txt') >= 0 || dupNames.indexOf('书籍甲 (1).txt') >= 0,
        '同书的两份副本应有一个被跳过');

    assert.strictEqual(plan.prune.length, 1, '只有 ENOENT 的条目允许清理, 实际 ' + plan.prune.length);
    assert.strictEqual(base(plan.prune[0].filePath), '已删除.txt', 'prune 应只含 ENOENT 的那一条');

    const badNames = plan.inaccessible.map((x) => base(x.filePath));
    assert.deepStrictEqual(badNames, ['无权限.txt'], 'EACCES 必须进 inaccessible 而不是 prune');
    assert.strictEqual(plan.inaccessible[0].reason, 'EACCES', 'inaccessible 应带错误码');

    assert(plan.retitle.length >= 1, '文件名含《》且记录标题不同时应计划纠偏');
    const rt = plan.retitle.find((r) => base(r.filePath) === '《正确书名》.txt');
    assert(rt, '应命中《正确书名》.txt 的纠偏');
    assert.strictEqual(rt.from, '旧书名', 'retitle.from 应为原书名');
    assert.strictEqual(rt.to, '正确书名', 'retitle.to 应为推导出的书名');

    assert(plan.merge.length >= 1, '同书重复记录应产生合并计划');
    // 预演阶段绝不能写盘
    assert.deepStrictEqual(fsStub.writes, [], '预演阶段不允许产生任何写入');

    // warnings: 解析失败 + 不可访问
    assert(plan.warnings.some((w) => w.indexOf('坏文件.txt') >= 0), '解析失败应记入 warnings');
    assert(plan.warnings.some((w) => w.indexOf('无法访问') >= 0), '不可访问应记入 warnings');

    // 确认框文案: 数量 + 对象名 + 不删文件
    const lines = summarizePlan(plan);
    assert(lines.length >= 3, '确认框至少要有"书库/计数/不会删文件"三行');
    assert(lines[0].indexOf('扫描到 11 个 txt') >= 0, '第一行应含扫描数量');
    assert(lines.some((l) => l.indexOf('将新增') === 0), '应有一行汇总各项计数');
    assert(lines.some((l) => l.indexOf('不会删除书库里的 txt 文件') >= 0), '必须明确"不删文件"');
    assert(lines.some((l) => l.indexOf('暂时无法访问') >= 0), '有不可访问项时必须提示');

    // ============================================================ 2. 执行
    const applied = [];
    const removed = [];
    const liveShelf = input.shelf.map((b) => Object.assign({}, b));
    const api = {
        list: () => liveShelf,
        async upsert(b) { applied.push(b); },
        async remove(p) { removed.push(p); const i = liveShelf.findIndex((x) => x.filePath === p); if (i >= 0) { liveShelf.splice(i, 1); } },
    };
    const result = await applyShelfRefresh(plan, api);
    assert.strictEqual(result.planId, plan.planId, '执行结果必须带回同一个 planId');
    assert.strictEqual(result.added, plan.add.length, 'added 应与预演一致');
    assert.strictEqual(result.skippedDup, plan.skipDuplicate.length, 'skippedDup 应与预演一致');
    assert.strictEqual(result.merged, plan.merge.reduce((n, m) => n + m.removals.length, 0),
        'merged 应与预演的 removals 总数一致');
    assert.strictEqual(result.retitled, plan.retitle.length, 'retitled 应与预演一致');
    assert.strictEqual(result.pruned, plan.prune.length, 'pruned 应与预演一致');
    assert.deepStrictEqual(result.failed, [], '正常路径不应有失败项');
    assert.strictEqual(result.driftNote, undefined, '没有差异时不应给 driftNote');

    // 不可访问的文件绝不能出现在 remove 列表里
    const removedNames = removed.map(base);
    assert(removedNames.indexOf('无权限.txt') < 0, '暂时不可访问的记录绝不能被清理');
    assert(removedNames.indexOf('已删除.txt') >= 0, 'ENOENT 的记录应被清理');

    // ============================================================ 3. 单项失败隔离
    const api2 = {
        list: () => liveShelf,
        async upsert(b) {
            if (base(b.filePath) === '新书.txt') { throw new Error('磁盘只读'); }
        },
        async remove() { throw new Error('写盘失败'); },
    };
    const result2 = await applyShelfRefresh(plan, api2);
    assert(result2.failed.length > 0, '失败项必须被记录');
    assert(result2.driftNote, '有失败项时应给出差异说明');
    assert.strictEqual(result2.added, result.added - 1, '单本失败不应影响其余新增');

    // ============================================================ 4. 目录整体不可读
    const broken = planInput(files, shelf, 9, { readdirError: true });
    const brokenPlan = await planShelfRefresh(broken);
    assert.strictEqual(brokenPlan.scanned, 0, '读目录失败时 scanned=0');
    assert.deepStrictEqual(
        [brokenPlan.add.length, brokenPlan.skipDuplicate.length, brokenPlan.merge.length,
         brokenPlan.retitle.length, brokenPlan.prune.length, brokenPlan.inaccessible.length],
        [0, 0, 0, 0, 0, 0],
        '读目录失败时所有分类都应为空（不做任何改动）'
    );
    assert(brokenPlan.warnings.some((w) => w.indexOf('读取书库目录失败') >= 0), '应提示读目录失败');

    // ============================================================ 5. 只读盘, 不改书架
    assert.strictEqual(applied.length, plan.add.length + plan.retitle.length,
        'upsert 次数应为 add + retitle');
    // 同书键工具函数仍可用（预演依赖它, 别被改坏）
    assert.strictEqual(shelfBookKey('A', 'B', 3), 'A|B|3', 'shelfBookKey 不应被改动');

    console.log('刷新书架预演/执行(五类计数/ENOENT vs 不可访问/planId/失败隔离/读目录失败): 全部通过 ✔');
})().catch((e) => {
    console.error('FAIL:', e && e.message ? e.message : e);
    if (e && e.stack) { console.error(e.stack); }
    process.exit(1);
});

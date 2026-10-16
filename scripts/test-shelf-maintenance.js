/**
 * test-shelf-maintenance.js — 书架维护纯逻辑单测(同书去重)
 */
'use strict';
const assert = require('assert');
const { shelfBookKey, planDuplicateRemoval } = require('../dist/shelfMaintenance');

const LIB = 'D:/lib';

function book(filePath, opts = {}) {
  return Object.assign({
    filePath,
    title: '仙逆',
    author: '耳根',
    totalChapters: 2067,
    chapterIndex: -1,
    addedAt: 1,
  }, opts);
}

// 1) 键: 书名+作者+章节数
assert.strictEqual(shelfBookKey('仙逆', '耳根', 2067), '仙逆|耳根|2067');
assert.notStrictEqual(shelfBookKey('仙逆', '耳根', 2067), shelfBookKey('仙逆', '', 2067), '作者不同应视为不同书');

// 2) 无重复: 不产生计划
{
  const plans = planDuplicateRemoval(
    [book('D:/lib/a.txt')],
    LIB,
    () => true,
    (p, d) => p.startsWith(d)
  );
  assert.strictEqual(plans.length, 0, '单条不应产生去重计划');
}

// 3) 书库副本重复: 保留书库内且已读的那条
{
  const dup = book('D:/lib/a (1).txt');
  const kept = book('D:/lib/a.txt', { chapterIndex: 5 });
  const plans = planDuplicateRemoval([dup, kept], LIB, () => true, (p, d) => p.startsWith(d));
  assert.strictEqual(plans.length, 1);
  assert.strictEqual(plans[0].keep.filePath, 'D:/lib/a.txt', '应保留已读/书库内的那条');
  assert.deepStrictEqual(plans[0].removals.map((b) => b.filePath), ['D:/lib/a (1).txt']);
}

// 4) 老路径 + 书库路径并存: 优先保留书库内(文件存在)的记录
{
  const oldPath = book('D:/downloads/a.txt');   // 书库外
  const libPath = book('D:/lib/a.txt');
  const plans = planDuplicateRemoval([oldPath, libPath], LIB, (p) => p === 'D:/lib/a.txt', (p, d) => p.startsWith(d));
  assert.strictEqual(plans[0].keep.filePath, 'D:/lib/a.txt', '应保留书库内那条');
  assert.deepStrictEqual(plans[0].removals.map((b) => b.filePath), ['D:/downloads/a.txt']);
}

// 5) 文件都不存在(未设置书库): 保底保留一条, 不产生"全删"
{
  const a = book('D:/x/a.txt');
  const b = book('D:/y/a.txt');
  const plans = planDuplicateRemoval([a, b], '', () => false, () => false);
  assert.strictEqual(plans.length, 1);
  assert.strictEqual(plans[0].removals.length, 1, '两条重复只删一条');
}

// 6) 不同书不合并
{
  const a = book('D:/lib/a.txt');
  const b = book('D:/lib/b.txt', { title: '斗破苍穹', author: '天蚕土豆', totalChapters: 1645 });
  assert.strictEqual(planDuplicateRemoval([a, b], LIB, () => true, (p, d) => p.startsWith(d)).length, 0);
}

console.log('书架维护测试全部通过 ✔');

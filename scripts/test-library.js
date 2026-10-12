/**
 * test-library.js — 书库目录拷贝逻辑测试(ensureInLibrary)
 * 用法: node scripts/test-library.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureInLibrary } = require('../dist/library');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-lib-test-'));
const srcDir = path.join(tmpRoot, 'src');
const libDir = path.join(tmpRoot, 'library');
fs.mkdirSync(srcDir, { recursive: true });

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

(async () => {
  console.log('[书库拷贝逻辑]');

  // --- 未设置书库: 原样返回 ---
  const a = path.join(srcDir, '甲书.txt');
  write(a, '第一章 内容');
  let r = await ensureInLibrary(a, '');
  assert(r.path === a && r.copied === false && r.reason === 'disabled', '未设置书库时应直接使用原路径');
  assert(!fs.existsSync(libDir), '未设置书库时不应创建目录');
  console.log('未设置书库(原路径读取): 通过');

  // --- 首次导入: 拷贝入库 ---
  r = await ensureInLibrary(a, libDir);
  assert(r.copied === true && r.reason === 'copied', '首次导入应拷贝');
  assert(r.path === path.join(libDir, '甲书.txt'), '应指向书库中的副本');
  assert(fs.readFileSync(r.path, 'utf8') === '第一章 内容', '副本内容应与源文件一致');
  assert(fs.existsSync(a), '原文件应保留不动');
  console.log('首次导入拷贝入库: 通过');

  // --- 再次导入同一源文件: 复用副本, 不重复拷贝 ---
  r = await ensureInLibrary(a, libDir);
  assert(r.copied === false && r.reason === 'same-file-exists', '同名同大小应复用副本');
  assert(r.path === path.join(libDir, '甲书.txt'), '复用时应指向已有副本');
  assert(fs.readdirSync(libDir).length === 1, '不应产生多余文件');
  console.log('重复导入复用副本: 通过');

  // --- 同名但内容不同: 自动改名 ---
  const src2dir = path.join(tmpRoot, 'other');
  const b = path.join(src2dir, '甲书.txt');
  write(b, '完全不同的另一本书的内容, 长度也不一样');
  r = await ensureInLibrary(b, libDir);
  assert(r.copied === true && r.reason === 'renamed', '同名不同内容应改名拷贝');
  assert(path.basename(r.path) === '甲书 (1).txt', '应改名为「甲书 (1).txt」, 实际: ' + path.basename(r.path));
  assert(fs.existsSync(path.join(libDir, '甲书.txt')), '原有副本不应被覆盖');
  console.log('同名冲突自动改名: 通过');

  // --- 源文件已在书库内: 不拷贝 ---
  const inLib = path.join(libDir, '丙书.txt');
  write(inLib, '丙书内容');
  r = await ensureInLibrary(inLib, libDir);
  assert(r.copied === false && r.reason === 'already-in-library' && r.path === inLib, '已在书库内的文件不应再拷贝');
  console.log('源文件已在书库: 通过');

  // --- 书库目录不存在时自动创建(递归) ---
  const deepLib = path.join(tmpRoot, 'a', 'b', '书库');
  const c = path.join(srcDir, '丁书.txt');
  write(c, '丁书内容');
  r = await ensureInLibrary(c, deepLib);
  assert(r.copied === true && fs.existsSync(r.path), '应自动创建多级书库目录并拷贝');
  console.log('自动创建书库目录: 通过');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\n书库拷贝测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});

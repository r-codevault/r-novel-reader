/**
 * test-source-view.js — 书源面板纯函数回归（容量分配 / 文案分流 / 错误分类）
 *
 * `webview/reader/composables/sourceView.ts` 是 Vue 源码, 不参与 `tsc -p ./`
 * （tsconfig 的 rootDir 是 src）。这里用 devDependency 里已有的 typescript
 * 就地转译再加载 —— 不落任何临时文件, 也不给测试增加构建步骤。
 *
 * 覆盖 PRD R4-04（容量实测）、R9-01（错误类别）、R9-02（空结果 vs 失败分流）。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function loadSourceView() {
  const file = path.join(__dirname, '..', 'webview', 'reader', 'composables', 'sourceView.ts');
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  // 只暴露 exports/module; 该文件除了 `import type` 没有运行时依赖
  const fn = new Function('exports', 'module', 'require', js);
  fn(mod.exports, mod, require);
  return mod.exports;
}

const sv = loadSourceView();

// ---------------------------------------------------------------- 1. 容量分配
const { allocResultRows, RESULT_ROW_CAP } = sv;
assert.strictEqual(RESULT_ROW_CAP, 10, '默认容量常量应为 10（旧行为不变）');

// 4 参调用(旧调用形态)必须与历史结果一致
assert.deepStrictEqual(
  allocResultRows(3, 20, true, null),
  { curRender: 3, histRender: 7, curAlloc: 3, histAlloc: 7 },
  '当前 3 条时应分成 3/7'
);
assert.deepStrictEqual(
  allocResultRows(20, 3, true, null),
  { curRender: 7, histRender: 3, curAlloc: 7, histAlloc: 3 },
  '历史 3 条时应分成 7/3'
);
assert.deepStrictEqual(
  allocResultRows(20, 20, true, null),
  { curRender: 5, histRender: 5, curAlloc: 5, histAlloc: 5 },
  '两边都够时应分成 5/5'
);
assert.deepStrictEqual(
  allocResultRows(20, 20, false, null),
  { curRender: 10, histRender: 0, curAlloc: 10, histAlloc: 0 },
  '无历史分栏时应占满整容量'
);

// 容量实测: 窗口很矮时(实测只能放 4 行)不再渲染 10 行
const small = allocResultRows(20, 20, true, null, 4);
assert.strictEqual(small.curRender + small.histRender, 4, '实测容量 4 时应只渲染 4 行');
assert.deepStrictEqual(
  allocResultRows(20, 0, false, null, 3),
  { curRender: 3, histRender: 0, curAlloc: 3, histAlloc: 0 },
  '无历史 + 容量 3 时应只渲染 3 行'
);
// 容量变大时同理
const big = allocResultRows(40, 40, true, null, 20);
assert.strictEqual(big.curRender + big.histRender, 20, '实测容量 20 时应渲染 20 行');
// 非法容量必须被夹到合法范围, 不能出现 0 行或负数
assert.ok(allocResultRows(5, 5, true, null, 0).curRender >= 0, '容量 0 不应产生负行数');
assert.ok(allocResultRows(5, 5, true, null, NaN).curRender >= 0, '容量 NaN 不应产生负行数');
// 拖拽值仍然优先, 但会被夹到合法区间
assert.strictEqual(allocResultRows(20, 20, true, 3, 10).curAlloc, 3, '拖拽值应被采用');
assert.strictEqual(allocResultRows(2, 20, true, 9, 10).curAlloc, 2, '拖拽值不得超过当前条数');

// ---------------------------------------------------------------- 2. 文案分流
const { resultSummary } = sv;
assert.strictEqual(
  resultSummary([], 0),
  '没有找到这本书：换个关键词，或在「书源」里调整启用范围',
  '空结果 + 无错误 应提示换关键词'
);
assert.strictEqual(
  resultSummary([], 3),
  '所有书源都失败了：展开明细查看原因，或对单个书源重试',
  '空结果 + 有错误 应提示看明细/重试'
);
assert.strictEqual(resultSummary([{ bookUrl: 'u1' }], 2), '找到 1 本 · 2 个书源出错',
  '有结果 + 有错误 应同时给出两个数字');
assert.strictEqual(resultSummary([{ bookUrl: 'u1' }, { bookUrl: 'u2' }], 0), '找到 2 本',
  '有结果 + 无错误 只报数量');
assert.notStrictEqual(resultSummary([], 0), resultSummary([], 2),
  '"真的没有" 与 "全部失败" 必须是两种文案');

// ---------------------------------------------------------------- 3. 错误类别
const { errorCategory, shortReason } = sv;
const MAP = {
  timeout: '超时',
  network: '网络',
  http: '状态码',
  parse: '解析',
  rule: '规则',
  unsupported: '不支持',
  abort: '已取消',
  fatal: '致命',
};
for (const kind of Object.keys(MAP)) {
  assert.strictEqual(errorCategory(kind), MAP[kind], `错误类别 ${kind} 应显示为 ${MAP[kind]}`);
}
assert.strictEqual(errorCategory('something-else'), '未知', '未知 kind 应回退「未知」');
assert.strictEqual(errorCategory(undefined), '未知', '缺 kind 应回退「未知」');

// 原因精简: ≤40 字原样, 超过则截断加省略号
assert.strictEqual(shortReason('  网络  错误  '), '网络 错误', '空白应被归一化');
const long = 'x'.repeat(80);
assert.strictEqual(shortReason(long).length, 41, '超长原因应截断到 40 字 + 省略号');
assert.ok(shortReason(long).endsWith('…'), '截断后应有省略号');

console.log('书源面板纯函数(容量分配/文案分流/错误类别/原因精简): 全部通过 ✔');

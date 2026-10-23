/**
 * test-rules-jsonpath.js — JSONPath 子集单测
 */
'use strict';
const assert = require('assert');
const { queryJson, firstScalar, parseJsonPath, JsonPathError } = require('../dist/rules/jsonPath');
const { SEARCH_JSON, NESTED_JSON } = require('./fixtures-source');

// 1) 基本路径(带 $ 与不带 $)
{
  const a = queryJson(SEARCH_JSON, '$.data.books');
  const b = queryJson(SEARCH_JSON, 'data.books');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(Array.isArray(a[0]), true);
  assert.strictEqual(b.length, 1);
}

// 2) 通配 + 字段
{
  const names = queryJson(SEARCH_JSON, '$.data.books[*].original_title');
  assert.deepStrictEqual(names, ['遮天', '完美世界']);
}

// 3) 下标(含负下标)
{
  assert.strictEqual(firstScalar(queryJson(SEARCH_JSON, '$.data.books[0].original_author')), '辰东');
  assert.strictEqual(firstScalar(queryJson(SEARCH_JSON, '$.data.books[-1].original_title')), '完美世界');
}

// 4) 数字字段转字符串
{
  assert.strictEqual(firstScalar(queryJson(SEARCH_JSON, '$.data.books[0].words_num')), '6350000');
}

// 5) 嵌套 JSON 字符串字段(data[*].dataJson.name) —— 需要调用方先解析, 这里验证路径本身
{
  const names = queryJson(NESTED_JSON, '$.data[*].dataJson.name');
  assert.deepStrictEqual(names, ['书一', '书二']);
}

// 6) 递归取值
{
  const found = queryJson(NESTED_JSON, '$..name');
  assert.deepStrictEqual(found, ['书一', '书二']);
}

// 7) 中括号字符串键
{
  const obj = { 'a-b': { 'c d': 1 } };
  assert.deepStrictEqual(queryJson(obj, "$['a-b']['c d']"), [1]);
}

// 8) 不存在的键 -> 空数组
{
  assert.deepStrictEqual(queryJson(SEARCH_JSON, '$.nope.nothing'), []);
}

// 9) 过滤表达式明确报错
{
  assert.throws(() => parseJsonPath('$.data[?(@.x==1)]'), (e) => e instanceof JsonPathError && /过滤/.test(e.message));
}

// 10) 空路径报错
{
  assert.throws(() => parseJsonPath(''), JsonPathError);
}

// 11) 数组切片
{
  const data = { a: [0, 1, 2, 3, 4, 5] };
  assert.deepStrictEqual(queryJson(data, '$.a[1:3]'), [1, 2]);
  assert.deepStrictEqual(queryJson(data, '$.a[:2]'), [0, 1]);
  assert.deepStrictEqual(queryJson(data, '$.a[4:]'), [4, 5]);
  assert.deepStrictEqual(queryJson(data, '$.a[-2:]'), [4, 5]);
  assert.deepStrictEqual(queryJson(data, '$.a[1:-1]'), [1, 2, 3, 4]);
  assert.deepStrictEqual(queryJson(data, '$.a[3:1]'), []);
}

console.log('JSONPath 测试全部通过 ✔');

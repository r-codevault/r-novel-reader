/**
 * test-download-service.js — 下载队列(并发/重试/续传/暂停/取消)
 *
 * 全程注入假 fetchChapter, 不触网。
 * 每个用例用独立的临时目录 + 独立书址(=> 独立 key), 互不干扰。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OfflineStore } = require('../dist/offline/offlineStore');
const { DownloadService, DOWNLOAD_CONCURRENCY, SourcePacer } = require('../dist/offline/downloadService');
const { HttpError } = require('../dist/http');
const { onlineKey } = require('../dist/onlinePath');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r-download-'));
let envSeq = 0;

function makeEnv() {
  envSeq += 1;
  const store = new OfflineStore(path.join(ROOT, 'case' + envSeq));
  const ref = {
    sourceId: 'src1',
    sourceName: '测试源',
    bookUrl: 'https://example.com/book/' + envSeq,
    tocUrl: 'https://example.com/book/' + envSeq + '/',
    tocFetchedAt: 1,
  };
  return { store, ref, key: onlineKey(ref.sourceId, ref.bookUrl) };
}

function makeChapters(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ index: i, title: '第' + (i + 1) + '章', url: 'https://example.com/c/' + i });
  }
  return out;
}

/** 可中断的 delay */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) { return; }
    if (signal.aborted) { clearTimeout(timer); return reject(abortErr()); }
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortErr()); }, { once: true });
  });
}

function abortErr() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function taskOf(env, chapters, range) {
  return {
    key: env.key,
    ref: env.ref,
    chapters,
    bookTitle: '测试书',
    author: '作者',
    range,
  };
}

(async () => {
  // ---------------------------------------------------------------- 1) 区间下载 + 并发上限
  {
    const env = makeEnv();
    const chapters = makeChapters(10);
    const requests = [];
    let active = 0;
    let peak = 0;

    const service = new DownloadService({
      store: env.store,
      timeoutMs: 5000,
      retry: 2,
      retryDelayMs: 10,
      fetchChapter: async (chapter, ref, signal) => {
        active += 1;
        if (active > peak) { peak = active; }
        requests.push(chapter.index);
        try {
          await delay(8, signal);
          return ['正文' + chapter.index + '段1', '正文' + chapter.index + '段2'];
        } finally {
          active -= 1;
        }
      },
    });

    const result = await service.start(taskOf(env, chapters, { start: 2, end: 7 })).done;

    assert.strictEqual(result.total, 6, '区间 [2,7] 应为 6 章, 实际 ' + result.total);
    assert.strictEqual(result.done, 6);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(requests.slice().sort((a, b) => a - b), [2, 3, 4, 5, 6, 7], '只应请求区间内的章');
    assert.ok(peak <= DOWNLOAD_CONCURRENCY, '并发峰值应 <= ' + DOWNLOAD_CONCURRENCY + ', 实际 ' + peak);
    assert.strictEqual(await env.store.readChapter(env.key, 8), null, '区间外不应下载');
    assert.deepStrictEqual(await env.store.readChapter(env.key, 2), ['正文2段1', '正文2段2'], '段距应保住');
  }

  // ---------------------------------------------------------------- 2) 续传跳过已下载
  {
    const env = makeEnv();
    const chapters = makeChapters(10);

    // 先下 2..7
    const first = new DownloadService({
      store: env.store,
      retry: 0,
      fetchChapter: async (chapter) => ['first' + chapter.index],
    });
    await first.start(taskOf(env, chapters, { start: 2, end: 7 })).done;

    const requests = [];
    const second = new DownloadService({
      store: env.store,
      retry: 1,
      retryDelayMs: 5,
      fetchChapter: async (chapter, ref, signal) => {
        requests.push(chapter.index);
        await delay(2, signal);
        return ['second' + chapter.index];
      },
    });
    const result = await second.start(taskOf(env, chapters, { start: 0, end: 9 })).done;

    assert.deepStrictEqual(requests.slice().sort((a, b) => a - b), [0, 1, 8, 9],
      '应只补下未下载的章, 实际 ' + requests.join(','));
    assert.strictEqual(result.done, 10, '总数应是整个范围(含此前已下的)');
    assert.strictEqual(result.added.length, 4, 'added 只应含本次新增');
    // 已下载的章不应被覆盖
    assert.deepStrictEqual(await env.store.readChapter(env.key, 3), ['first3']);
  }

  // ---------------------------------------------------------------- 3) 可恢复错误 → 重试后成功
  {
    const env = makeEnv();
    const chapters = makeChapters(6);
    const attempts = {};
    const service = new DownloadService({
      store: env.store,
      timeoutMs: 5000,
      retry: 2,
      retryDelayMs: 5,
      fetchChapter: async (chapter, ref, signal) => {
        attempts[chapter.index] = (attempts[chapter.index] || 0) + 1;
        await delay(2, signal);
        if (chapter.index === 4 && attempts[chapter.index] <= 2) {
          throw new HttpError('network', '连接被重置');
        }
        return ['ok' + chapter.index];
      },
    });
    const result = await service.start(taskOf(env, chapters, { start: 0, end: 5 })).done;
    assert.strictEqual(attempts[4], 3, '第 4 章应尝试 3 次(首次 + 2 重试), 实际 ' + attempts[4]);
    assert.strictEqual(result.failed, 0, '重试成功后不应记失败');
    assert.ok(await env.store.readChapter(env.key, 4), '第 4 章应有正文');
  }

  // ---------------------------------------------------------------- 4) 不可恢复错误 → 不重试
  {
    const env = makeEnv();
    const chapters = makeChapters(6);
    const attempts = {};
    const service = new DownloadService({
      store: env.store,
      timeoutMs: 5000,
      retry: 2,
      retryDelayMs: 5,
      fetchChapter: async (chapter, ref, signal) => {
        attempts[chapter.index] = (attempts[chapter.index] || 0) + 1;
        await delay(2, signal);
        if (chapter.index === 5) { throw new HttpError('http', 'HTTP 404', 404); }
        return ['ok' + chapter.index];
      },
    });
    const result = await service.start(taskOf(env, chapters, { start: 0, end: 5 })).done;
    assert.strictEqual(attempts[5], 1, '404 不应重试, 实际 ' + attempts[5]);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failures[0].index, 5);
    assert.strictEqual(result.failures[0].message, 'HTTP 404');
    assert.strictEqual(result.done, 5, '其它章应照常完成');
    assert.deepStrictEqual((await env.store.readManifest(env.key)).failed, { 5: 'HTTP 404' }, '失败章应落盘');
  }

  // ---------------------------------------------------------------- 5) 暂停 → 继续
  {
    const env = makeEnv();
    const chapters = makeChapters(24);
    const requests = [];
    let active = 0;
    const service = new DownloadService({
      store: env.store,
      timeoutMs: 5000,
      retry: 0,
      retryDelayMs: 5,
      fetchChapter: async (chapter, ref, signal) => {
        active += 1;
        requests.push(chapter.index);
        try {
          await delay(12, signal);
          return ['p' + chapter.index];
        } finally {
          active -= 1;
        }
      },
    });

    const run = service.start(taskOf(env, chapters, { start: 0, end: 23 }));
    await delay(30);
    assert.ok(requests.length > 0, '应已开始请求');

    assert.strictEqual(service.pause(env.key), true);
    const atPause = requests.length;
    await delay(120);
    assert.ok(requests.length - atPause <= DOWNLOAD_CONCURRENCY,
      '暂停后最多只应再有在途请求完成, 实际新增 ' + (requests.length - atPause));
    assert.strictEqual(service.statusOf(env.key).paused, true, '状态应为暂停中');

    assert.strictEqual(service.resume(env.key), true);
    const result = await run.done;
    assert.strictEqual(result.cancelled, false, '暂停继续不应算取消');
    assert.strictEqual(result.done, 24, '恢复后应补齐, 实际 ' + result.done);
    assert.strictEqual(result.failed, 0, '暂停打断的章不应计失败');
  }

  // ---------------------------------------------------------------- 6) 取消
  {
    const env = makeEnv();
    const chapters = makeChapters(60);
    const service = new DownloadService({
      store: env.store,
      timeoutMs: 5000,
      retry: 0,
      retryDelayMs: 5,
      fetchChapter: async (chapter, ref, signal) => {
        await delay(12, signal);
        return ['c' + chapter.index];
      },
    });
    const run = service.start(taskOf(env, chapters, { start: 0, end: 59 }));
    await delay(35);
    service.cancel(env.key);
    const result = await run.done;
    assert.strictEqual(result.cancelled, true, '应标记为已取消');
    assert.ok(result.done < 60, '取消后不应下完, 实际 ' + result.done);
    assert.strictEqual(service.isRunning(env.key), false, '结束后不应仍在运行');
  }

  // ---------------------------------------------------------------- 7) 同一本重复 start 不叠加
  {
    const env = makeEnv();
    const chapters = makeChapters(4);
    const service = new DownloadService({
      store: env.store,
      timeoutMs: 5000,
      retry: 0,
      fetchChapter: async (chapter, ref, signal) => {
        await delay(15, signal);
        return ['d' + chapter.index];
      },
    });
    const a = service.start(taskOf(env, chapters, { start: 0, end: 3 }));
    const b = service.start(taskOf(env, chapters, { start: 0, end: 3 }));
    assert.strictEqual(a.control, b.control, '同一本应复用同一个 controller');
    await a.done;
  }

  // ---------------------------------------------------------------- 8) onDone 时队列已清空
  {
    const env = makeEnv();
    const chapters = makeChapters(3);
    let statusAtDone = 'unset';
    let doneResult = null;
    const service = new DownloadService({
      store: env.store,
      retry: 0,
      fetchChapter: async (chapter) => ['e' + chapter.index],
    });
    await service.start(taskOf(env, chapters, { start: 0, end: 2 }), {
      onDone: (r) => { statusAtDone = service.statusOf(env.key); doneResult = r; },
    }).done;
    // 宿主在 onDone 里会同步查状态/推快照; 若此时条目还在, 前端会错报「下载中」
    assert.strictEqual(statusAtDone, undefined, 'onDone 触发时应已移出 running 表');
    assert.strictEqual(service.isRunning(env.key), false, 'onDone 时 isRunning 应为 false');
    assert.ok(doneResult && doneResult.done === 3, 'onDone 应拿到完整结果');
  }

  // ---------------------------------------------------------------- 9) 503 限流 → 学慢后仍要下全
  //
  // 实测站点: 连抓 12 章后全量 503, 1s/请求才通。旧实现把 503 当普通 5xx
  // (只重试 2 次、间隔 500ms), 整本书一半章节直接被判失败。
  {
    const env = makeEnv();
    const chapters = makeChapters(8);
    const attempts = {};
    const service = new DownloadService({
      store: env.store,
      timeoutMs: 5000,
      retry: 0,                 // 普通重试预算给 0: 限流必须走自己的预算
      retryDelayMs: 5,
      pacing: { baseInterval: 0, minInterval: 10, maxInterval: 40, cooldownMs: 5, rateRetry: 4 },
      fetchChapter: async (chapter, ref, signal) => {
        attempts[chapter.index] = (attempts[chapter.index] || 0) + 1;
        await delay(1, signal);
        if (attempts[chapter.index] <= 2) { throw new HttpError('http', 'HTTP 503', 503); }
        return ['r' + chapter.index];
      },
    });
    const result = await service.start(taskOf(env, chapters, { start: 0, end: 7 })).done;
    assert.strictEqual(result.failed, 0, '503 应走限流重试并最终全部成功, 实际失败 ' + result.failed);
    assert.strictEqual(result.done, 8, '应下全 8 章, 实际 ' + result.done);
    assert.ok(service.intervalOf(env.ref.sourceId) > 0, '被限流后应学到节流间隔');
  }

  // ---------------------------------------------------------------- 10) 持续 503 → 整本早停(不刷成 5000 章失败)
  {
    const env = makeEnv();
    const chapters = makeChapters(30);
    let calls = 0;
    const service = new DownloadService({
      store: env.store,
      concurrency: 1,
      retry: 0,
      pacing: { baseInterval: 0, minInterval: 5, maxInterval: 10, cooldownMs: 1, rateRetry: 2, rateGiveUp: 2 },
      fetchChapter: async () => { calls += 1; throw new HttpError('http', 'HTTP 503', 503); },
    });
    const result = await service.start(taskOf(env, chapters, { start: 0, end: 29 })).done;
    assert.ok(result.abortedReason, '持续限流应带提前结束原因');
    assert.strictEqual(result.cancelled, false, '早停不是"用户取消"');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failed, 2, '只应记触发早停的那 2 章, 实际 ' + result.failed);
    assert.strictEqual(calls, 6, '每章 1+2 次尝试后就该停, 实际请求 ' + calls);
    assert.strictEqual(result.done, 0);
    const m = await env.store.readManifest(env.key);
    assert.ok(m && m.failed && Object.keys(m.failed).length === 2, '失败章应落盘供续传');
  }

  // ---------------------------------------------------------------- 11) 暂停立即中断在途请求
  //
  // 不能让人点了暂停还干等 20s 超时; 被中断的章放回队首, 恢复后重抓且不算失败。
  {
    const env = makeEnv();
    const chapters = makeChapters(12);
    const started = [];
    let aborted = 0;
    const service = new DownloadService({
      store: env.store,
      retry: 0,
      fetchChapter: (chapter, ref, signal) => new Promise((resolve, reject) => {
        started.push(chapter.index);
        const timer = setTimeout(() => resolve(['s' + chapter.index]), 200);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted += 1;
            reject(abortErr());
          }, { once: true });
        }
      }),
    });
    const run = service.start(taskOf(env, chapters, { start: 0, end: 11 }));
    // 起来要先写 manifest / 读 done.log, 别用固定 sleep 赌时序
    for (let i = 0; i < 50 && started.length === 0; i++) { await delay(10); }
    assert.ok(started.length > 0, '应已开始请求');
    service.pause(env.key);
    await delay(60);
    assert.ok(aborted > 0, '暂停应立即中断在途请求, 实际中断 ' + aborted);
    assert.strictEqual(service.statusOf(env.key).paused, true);
    service.resume(env.key);
    const result = await run.done;
    assert.strictEqual(result.failed, 0, '暂停打断的章不应记失败, 实际 ' + result.failed);
    assert.strictEqual(result.done, 12, '恢复后应补齐, 实际 ' + result.done);
  }

  // ---------------------------------------------------------------- 12) 节流器: 同一次拦截不连翻倍 + 反复被拦抬下限
  {
    const pacer = new SourcePacer({
      baseInterval: 0, minInterval: 100, maxInterval: 400,
      cooldownMs: 1, rateRetry: 3, rateGiveUp: 3,
    });
    assert.strictEqual(pacer.currentFloor, 100, '下限初值应等于 minInterval');
    pacer.penalize();
    assert.strictEqual(pacer.currentInterval, 100, '首次被拦应落到下限');
    pacer.penalize();
    assert.strictEqual(pacer.currentInterval, 100, '冷却期内的 503 属同一次拦截, 不应连翻倍');
    await delay(10);
    pacer.penalize();
    assert.ok(pacer.currentInterval >= 200, '独立拦截应翻倍, 实际 ' + pacer.currentInterval);
    await delay(10); pacer.penalize();
    await delay(10); pacer.penalize();
    assert.ok(pacer.currentFloor > 100, '反复被拦应抬可持续下限, 实际 ' + pacer.currentFloor);
    const before = pacer.currentInterval;
    for (let i = 0; i < 8; i++) { pacer.reward(); }
    assert.ok(pacer.currentInterval < before, '连续成功后应逐步提速, 实际 ' + pacer.currentInterval);
    assert.ok(pacer.currentInterval >= pacer.currentFloor, '提速不得低于学到的下限');
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('离线下载队列(并发/重试/续传/暂停/取消/限流)测试全部通过 ✔');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

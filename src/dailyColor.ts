/**
 * dailyColor.ts — 「每日一色」取色(官网优先 / 本地兜底)
 *
 * 官网 https://cncolor.art/daily 没有公开 JSON API(任意 /api/* 都返回 SPA 的 HTML),
 * 但该页是服务端渲染的, 今日色的色值直接写在卡片容器的 inline style 里:
 *   <a href="/color/法翠" style="background-color:#108B96;aspect-ratio:1 / 1;">…今日之色…</a>
 * 因此这里做两件事:
 *   1) 抓 HTML 并用"今日之色 之前最近的一个 background-color"定位色值;
 *   2) 任何失败(断网/超时/改版)都返回 null, 由调用方回退本地按日期轮换的颜色。
 *
 * 设计取舍: 不引入正则依赖以外的解析库, 也不用无头浏览器 —— 页面结构一旦变化,
 * 最坏结果只是"用回本地色", 不会影响阅读功能。
 */

import * as https from 'https';

export interface DailyColorHit {
  name: string;
  hex: string;
}

/** 从 SSR HTML 中解析今日色; 解析不到返回 null */
export function parseDailyColor(html: string): DailyColorHit | null {
  const marker = html.indexOf('今日之色');
  if (marker < 0) {
    return null;
  }
  // 色值写在卡片容器上, 位置在「今日之色」之前(通常 200~600 字符内)
  const before = html.slice(Math.max(0, marker - 3000), marker);
  const colorRe = /background-color:\s*(#[0-9a-fA-F]{6})/g;
  let hex: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = colorRe.exec(before)) !== null) {
    hex = m[1];
  }
  if (!hex) {
    return null;
  }
  // 色名紧跟在「今日之色」标签之后
  const nameMatch = /今日之色<\/p>\s*<p[^>]*>([^<]+)<\/p>/.exec(html.slice(marker, marker + 400));
  if (!nameMatch) {
    return null;
  }
  const name = nameMatch[1].trim();
  if (!name || name.length > 12) {
    return null;
  }
  return { name, hex: hex.toUpperCase() };
}

/** 拉取官网今日色; 失败返回 null(不抛异常, 调用方回退本地) */
export function fetchDailyColor(timeoutMs = 8000): Promise<DailyColorHit | null> {
  return new Promise(function (resolve) {
    const req = https.get(
      'https://cncolor.art/daily',
      {
        timeout: timeoutMs,
        headers: {
          // 要求不压缩, 免去 gzip 解压依赖
          'Accept-Encoding': 'identity',
          'User-Agent': 'vscode-novel-reader',
          Accept: 'text/html',
        },
      },
      function (res) {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', function (chunk: Buffer) {
          size += chunk.length;
          if (size > 3 * 1024 * 1024) {
            // 防御: 页面异常膨胀时放弃
            res.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', function () {
          try {
            resolve(parseDailyColor(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
        res.on('error', function () {
          resolve(null);
        });
      }
    );
    req.on('timeout', function () {
      req.destroy();
      resolve(null);
    });
    req.on('error', function () {
      resolve(null);
    });
  });
}

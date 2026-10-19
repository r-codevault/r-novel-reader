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
import * as crypto from 'crypto';

export interface DailyColorHit {
  name: string;
  hex: string;
  /** 页面内容哈希: 用于识别 CDN 缓存未更新(连续多日同哈希) */
  hash?: string;
}

/** 从 SSR HTML 中解析今日色; 解析不到返回 null */
export function parseDailyColor(html: string): DailyColorHit | null {
  const marker = html.indexOf('今日之色');
  if (marker < 0) {
    return null;
  }
  // 1) 色名紧跟在「今日之色」之后
  const nameMatch = /今日之色<\/p>\s*<p[^>]*>([^<]+)<\/p>/.exec(html.slice(marker, marker + 400));
  if (!nameMatch) {
    return null;
  }
  const name = nameMatch[1].trim();
  if (!name || name.length > 12) {
    return null;
  }

  // 2) 色值: 优先定位"该色名的详情链接"(卡片容器), 再读它 style 里的 background-color。
  //    站点改版/缓存版本不同会导致卡片与「今日之色」的距离变化, 用色名做锚点最稳。
  const anchor = html.indexOf('/color/' + name);
  if (anchor >= 0) {
    const tagStart = html.lastIndexOf('<', anchor);
    const tagEnd = html.indexOf('>', anchor);
    if (tagStart >= 0 && tagEnd > anchor) {
      const tag = html.slice(tagStart, tagEnd + 1);
      const inTag = /background-color:\s*(#[0-9a-fA-F]{6})/.exec(tag);
      if (inTag) {
        return { name, hex: inTag[1].toUpperCase() };
      }
      // 少数情况下颜色写在紧随其后的子元素上
      const after = /background-color:\s*(#[0-9a-fA-F]{6})/.exec(html.slice(tagEnd, tagEnd + 400));
      if (after) {
        return { name, hex: after[1].toUpperCase() };
      }
    }
  }

  // 3) 兜底: 「今日之色」之前最近的一个 background-color(旧版页面结构)
  const before = html.slice(Math.max(0, marker - 3000), marker);
  const colorRe = /background-color:\s*(#[0-9a-fA-F]{6})/g;
  let hex: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = colorRe.exec(before)) !== null) {
    hex = m[1];
  }
  return hex ? { name, hex: hex.toUpperCase() } : null;
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
          // 尽量绕过 CDN 缓存(部分站点无效, 仍然要配合哈希校验)
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
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
            const html = Buffer.concat(chunks).toString('utf8');
            const hit = parseDailyColor(html);
            if (hit) {
              // 页面哈希: 用于识别 CDN 缓存多日未更新
              hit.hash = crypto.createHash('sha1').update(html).digest('hex').slice(0, 16);
            }
            resolve(hit);
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

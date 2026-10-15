/**
 * webviewAssets.ts — 读取 Vue 打包产物(dist-webview/*), 带缓存
 * (reader 与 sidebar 两个 webview 共用)
 */
import * as fs from 'fs';
import * as path from 'path';

const cache: Record<string, string> = {};

export function readWebviewAsset(name: string): string {
    if (!cache[name]) {
        const file = path.join(__dirname, '..', 'dist-webview', name);
        cache[name] = fs.readFileSync(file, 'utf8');
    }
    return cache[name];
}

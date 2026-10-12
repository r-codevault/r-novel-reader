/**
 * library.ts — 书库目录(可选)的导入拷贝逻辑
 *
 * 规则:
 *  - 未设置书库目录: 直接使用原文件路径(不做任何拷贝)
 *  - 已设置: 导入时把文件拷贝进书库, 之后引用副本(原文件可自行移动/删除)
 *  - 源文件已在书库目录内: 不再拷贝
 *  - 书库内已有同名文件: 若大小一致视为同一份直接复用; 否则自动改名为 "名称 (n).txt"
 *
 * 本模块只依赖 fs/path, 不依赖 vscode, 便于单元测试。
 */

import * as fs from 'fs';
import * as path from 'path';

export type CopyReason = 'disabled' | 'already-in-library' | 'same-file-exists' | 'copied' | 'renamed';

export interface CopyResult {
    /** 实际应该读取的文件路径 */
    path: string;
    /** 是否发生了拷贝 */
    copied: boolean;
    reason: CopyReason;
}

/** 路径是否相同(Windows 下大小写不敏感) */
function samePath(a: string, b: string): boolean {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * 确保文件位于书库目录中, 返回最终应读取的路径。
 * @param srcPath     用户选择的原始文件
 * @param libraryPath 书库目录(空字符串表示未设置)
 */
export async function ensureInLibrary(srcPath: string, libraryPath: string): Promise<CopyResult> {
    const dir = (libraryPath || '').trim();
    if (!dir) {
        return { path: srcPath, copied: false, reason: 'disabled' };
    }
    if (samePath(path.dirname(srcPath), dir)) {
        return { path: srcPath, copied: false, reason: 'already-in-library' };
    }

    await fs.promises.mkdir(dir, { recursive: true });

    const ext = path.extname(srcPath);
    const base = path.basename(srcPath, ext);
    const srcSize = (await fs.promises.stat(srcPath)).size;

    let target = path.join(dir, path.basename(srcPath));
    let renamed = false;
    for (let n = 1; ; n++) {
        if (!fs.existsSync(target)) {
            break;
        }
        const stat = await fs.promises.stat(target).catch(() => null);
        if (stat && stat.size === srcSize) {
            // 同名同大小, 认为是同一份文件, 直接复用
            return { path: target, copied: false, reason: 'same-file-exists' };
        }
        target = path.join(dir, `${base} (${n})${ext}`);
        renamed = true;
        if (n > 99) {
            throw new Error(`书库目录中同名文件过多: ${path.basename(srcPath)}`);
        }
    }

    await fs.promises.copyFile(srcPath, target);
    return { path: target, copied: true, reason: renamed ? 'renamed' : 'copied' };
}

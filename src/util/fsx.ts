/**
 * util/fsx.ts — 小文件工具(JSON 原子写 / 追加行 / 目录大小)
 *
 * 在线缓存与离线下载区共用。只依赖 fs/path, 不依赖 vscode, 便于单元测试。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 读 JSON; 文件不存在 / 内容损坏 / 为 null 时返回 null, 不抛错 */
export async function readJson<T>(file: string): Promise<T | null> {
    try {
        const text = await fs.promises.readFile(file, 'utf8');
        const parsed = JSON.parse(text) as T;
        return parsed ?? null;
    } catch {
        return null;
    }
}

/**
 * 原子写 JSON: 先写 .tmp 再 rename。
 * 直接 writeFile 在断电/进程被杀时会留下半截文件, 下次读取整份失效。
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.promises.rename(tmp, file);
}

/** 追加一行(自动补 \n, 自动建目录); 用于 done.log 这类只增不改的日志 */
export async function appendLine(file: string, line: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, line + '\n', 'utf8');
}

/** 读全部行(去掉空行); 文件不存在返回空数组 */
export async function readLines(file: string): Promise<string[]> {
    try {
        const text = await fs.promises.readFile(file, 'utf8');
        return text.split('\n').map((l) => l.trim()).filter((l) => !!l);
    } catch {
        return [];
    }
}

/** 递归统计目录字节数; 单个文件失败忽略(权限/删除竞态) */
export async function dirSize(dir: string): Promise<number> {
    let total = 0;
    const walk = async (current: string): Promise<void> => {
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) { await walk(full); continue; }
            try { total += (await fs.promises.stat(full)).size; } catch { /* 忽略 */ }
        }
    };
    await walk(dir);
    return total;
}

/** 目录是否存在 */
export async function exists(target: string): Promise<boolean> {
    try {
        await fs.promises.access(target);
        return true;
    } catch {
        return false;
    }
}

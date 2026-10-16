/**
 * trash.ts — 把文件移入系统回收站(跨平台, 不依赖第三方包)
 *
 *  - Windows: PowerShell + VisualBasic.FileIO.FileSystem.SendToRecycleBin
 *  - macOS:   移动到 ~/.Trash(文件名冲突时自动加时间戳)
 *  - Linux:   优先 `gio trash`; 不可用时退回 XDG 回收站目录(尽力而为)
 *
 * 本模块只依赖 fs/path/child_process, 不依赖 vscode, 便于单独验证。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** 在目标目录下生成不冲突的文件名 */
function uniqueName(dir: string, fileName: string): string {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let candidate = path.join(dir, fileName);
    let n = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base} (${n})${ext}`);
        n += 1;
    }
    return candidate;
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { env: env ?? process.env, windowsHide: true }, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

/** Windows: 经 PowerShell 调用 Shell 回收站 API */
async function trashWindows(filePath: string): Promise<void> {
    // 用真实长路径(避免 8.3 短路径) + base64 传参(兼容中文路径/引号)
    let full = filePath;
    try {
        full = fs.realpathSync.native ? fs.realpathSync.native(filePath) : path.resolve(filePath);
    } catch {
        full = path.resolve(filePath);
    }
    const targetB64 = Buffer.from(full, 'utf8').toString('base64');
    const script =
        '$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:NOVEL_TRASH_TARGET_B64));' +
        'Add-Type -AssemblyName Microsoft.VisualBasic;' +
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        ...process.env,
        NOVEL_TRASH_TARGET_B64: targetB64,
    });
}

/** macOS / Linux 兜底: 移动到回收站目录 */
async function trashByMove(filePath: string, trashDir: string): Promise<void> {
    await fs.promises.mkdir(trashDir, { recursive: true });
    await fs.promises.rename(filePath, uniqueName(trashDir, path.basename(filePath)));
}

/**
 * 把文件移入系统回收站。
 * 失败会 reject(调用方决定是提示还是忽略)。
 */
export async function moveToTrash(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
        return;
    }
    if (process.platform === 'win32') {
        await trashWindows(filePath);
        return;
    }
    if (process.platform === 'darwin') {
        await trashByMove(filePath, path.join(os.homedir(), '.Trash'));
        return;
    }
    try {
        await run('gio', ['trash', filePath]);
    } catch {
        // 无 gio(GNOME)时的兜底: XDG 回收站目录
        await trashByMove(filePath, path.join(os.homedir(), '.local', 'share', 'Trash', 'files'));
    }
}

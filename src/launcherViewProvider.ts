/**
 * launcherViewProvider.ts — 活动栏「小说阅读」图标(动作型入口)
 *
 * 设计说明:
 *  - 用户点活动栏图标 -> VS Code 必然先展开侧边栏容器(平台限制), 因此这里把视图做成**动作触发器**:
 *    视图一显示就立刻 closeSidebar 并执行激活动作(打开阅读面板), 视觉上侧边栏只闪一下不驻留
 *  - 启动时若该视图恰好是展开状态(窗口恢复), 只收起侧边栏、不触发动作, 避免意外弹面板
 *  - 视图内容仅为占位提示(会一闪而过), 不做任何 UI
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';

export class LauncherViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'novelReaderHome';

    /** 图标点击后的动作(由扩展注入: 打开阅读面板) */
    onActivate?: () => void;

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        view.webview.html = this._getHtml();

        // 启动恢复时视图就是可见的: 首次可见只收起侧边栏, 不触发动作
        let suppressNext = view.visible;

        view.onDidChangeVisibility(() => {
            if (!view.visible) { return; }
            void vscode.commands.executeCommand('workbench.action.closeSidebar');
            if (suppressNext) {
                suppressNext = false;
                return;
            }
            this.onActivate?.();
        });
    }

    private _getHtml(): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    margin: 0; padding: 14px 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
    opacity: .75;
  }
</style>
</head>
<body>正在打开阅读界面…</body>
</html>`;
    }
}

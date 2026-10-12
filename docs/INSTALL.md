# 安装教程

本文档覆盖小说阅读器（`local.novel-reader`）的**全部安装方式**、升级卸载与故障排查。

- [前置准备](#前置准备)
- [方式一：源码打包安装（推荐）](#方式一源码打包安装推荐)
- [方式二：安装现成的 vsix](#方式二安装现成的-vsix)
- [方式三：开发调试（F5，免安装）](#方式三开发调试f5免安装)
- [方式四：离线解包安装（无 code 命令行时）](#方式四离线解包安装无-code-命令行时)
- [验证是否安装成功](#验证是否安装成功)
- [升级到新版本](#升级到新版本)
- [卸载](#卸载)
- [故障排查](#故障排查)
- [附录：目录与文件位置速查](#附录目录与文件位置速查)

---

## 前置准备

| 依赖 | 版本要求 | 检查命令 |
| --- | --- | --- |
| VS Code | 1.85.0 及以上 | 帮助 → 关于（或 `code --version`） |
| Node.js | 18 及以上 | `node -v` |
| npm | 随 Node 附带 | `npm -v` |
| Git | 任意较新版本 | `git --version` |

> 只有「方式一」需要 Node.js 与 Git；「方式二/四」只要有 VS Code 和 vsix 文件即可。

---

## 方式一：源码打包安装（推荐）

适合想自己编译、或需要固定某个版本的场景。

### 1. 获取源码

```bash
git clone https://gitee.com/rich-woman-hugs-me-to-sleep/r-novel-reader.git
cd r-novel-reader
```

也可以直接在 Gitee 仓库页点击「克隆/下载」→「下载 ZIP」后解压。

### 2. 安装依赖并编译

```bash
npm install        # 安装 TypeScript 等开发依赖
npm run compile    # 编译 src/*.ts → dist/*.js
```

编译成功后会生成 `dist/` 目录（内含 `extension.js` 等 5 个文件）。

> 网络较慢时可先切换镜像：`npm config set registry https://registry.npmmirror.com`

### 3. 打包成 vsix

```bash
npm run package
```

成功后当前目录会出现 `novel-reader-<版本号>.vsix`，例如 `novel-reader-1.0.2.vsix`。

> **为什么不用 `npx @vscode/vsce package`？** vsce 只能自动识别 GitHub/GitLab 仓库，本项目托管在 Gitee，README 中的相对链接会让打包报错。`npm run package` 已在脚本中固化所需参数：
>
> ```bash
> vsce package \
>   --baseContentUrl https://gitee.com/rich-woman-hugs-me-to-sleep/r-novel-reader/blob/master \
>   --baseImagesUrl  https://gitee.com/rich-woman-hugs-me-to-sleep/r-novel-reader/raw/master
> ```
>
> 如需全局命令可先安装：`npm i -g @vscode/vsce`。若提示 `Missing publisher name`，请在 `package.json` 中补上 `"publisher"` 字段。

### 4. 安装

```bash
code --install-extension novel-reader-1.0.2.vsix
```

Windows 上若 `code` 不在 PATH，请用 VS Code 安装目录下的命令：

```powershell
& "D:\Program Files (x86)\Microsoft VS Code\bin\code.cmd" --install-extension novel-reader-1.0.2.vsix
```

或直接用图形界面（见方式二）。

### 5. 重启 VS Code

安装完成后**重启** VS Code（或 `Ctrl+Shift+P` → `Developer: Reload Window`）。

---

## 方式二：安装现成的 vsix

### 命令行安装

```bash
code --install-extension novel-reader-1.0.2.vsix
# 覆盖安装时加 --force：
code --install-extension novel-reader-1.0.2.vsix --force
```

### 图形界面安装

1. 打开 VS Code → 左侧「扩展」面板（`Ctrl+Shift+X`）
2. 点击面板右上角 `···`（更多操作）
3. 选择「**从 VSIX 安装…**」（Install from VSIX…）
4. 选择 `novel-reader-x.y.z.vsix` 文件
5. 右下角提示安装成功后，**重启 VS Code**

---

## 方式三：开发调试（F5，免安装）

适合改代码、二次开发。

```bash
npm install
npm run compile
npm test        # 可选：跑一遍解析器与界面冒烟测试
```

1. 用 VS Code 打开本项目文件夹
2. 按 `F5`（已内置 `.vscode/launch.json`，会启动「扩展开发宿主」窗口）
3. 在**新弹出的窗口**里使用插件（活动栏会出现「小说阅读」图标）
4. 修改代码后，在新窗口里执行 `Developer: Reload Window` 生效；或先运行 `npm run watch` 开启增量编译，改完直接重载窗口

> 调试宿主中的插件与正式安装的版本互不影响，关闭调试窗口即结束。

---

## 方式四：离线解包安装（无 `code` 命令行时）

适用于受限终端（`code` 命令被拦截、无法执行 Code.exe 等）或纯手工部署。

> **原理**：`.vsix` 本质是一个 ZIP 压缩包，内部为 `extension.vsixmanifest` + `extension/` 目录。把它解包放进 VS Code 的扩展目录即可生效。

### 步骤

1. **确定扩展目录**

   | 系统 | 路径 |
   | --- | --- |
   | Windows | `C:\Users\<用户名>\.vscode\extensions` |
   | macOS / Linux | `~/.vscode/extensions` |

2. **解包 vsix**

   将 `novel-reader-1.0.2.vsix` 改名为 `.zip` 后解压（或直接解压 vsix），取出内层 `extension/` 目录的内容。

3. **放入正确的目录名**

   目录名必须是 `<publisher>.<name>-<version>`，本插件为：

   ```
   <扩展目录>/local.novel-reader-1.0.2/
       ├── package.json
       ├── README.md
       ├── dist/
       └── media/
   ```

   > ⚠️ 目录名（尤其是**版本号**）必须与 `package.json` 中的 `version` 严格一致，否则会出现「无效的扩展 ⚠️」。

4. **登记扩展清单（关键步骤）**

   手动放入的扩展不在 VS Code 的 `extensions.json` 清单里，可能导致：
   - 扩展面板显示「**检测到无效的扩展 ⚠️**」
   - 卸载其他扩展时被当成孤儿目录写入 `.obsolete`，**下次重启被删除**

   项目自带修复脚本，在源码目录执行：

   ```bash
   node scripts/register-local-extension.js
   ```

   它会：
   - 把 `extensions.json` 中的条目对齐到当前目录（版本、路径、必要元数据）
   - 从 `.obsolete` 中移除误标
   - 自动备份原文件为 `extensions.json.bak` / `.obsolete.bak`

   > 升级版本号后可重复运行，脚本是幂等的。

5. **重启 VS Code** 生效。

---

## 验证是否安装成功

1. **活动栏图标**：左侧活动栏出现书本图标，悬停显示「小说阅读」
2. **命令面板**：`Ctrl+Shift+P` 输入「小说阅读器」，应能看到 5 条命令
3. **扩展面板**：`Ctrl+Shift+X` 搜索 `@id:local.novel-reader`，显示「小说阅读器 · local」，且**没有黄色警告三角**
4. **实际使用**：点击图标 → 侧边栏标题栏 `＋` → 选择 txt → 出现章节目录与阅读页

---

## 升级到新版本

**方式二/三（vsix 安装）**：直接安装新 vsix 即可覆盖

```bash
code --install-extension novel-reader-1.0.3.vsix
```

**方式四（离线解包）**：

1. 删除旧目录 `local.novel-reader-<旧版本>`，放入新目录 `local.novel-reader-<新版本>`
2. 再次运行 `node scripts/register-local-extension.js` 对齐清单
3. 重启 VS Code

> 忘记第 2 步是「无效扩展」和「插件突然消失」最常见的原因。

---

## 卸载

- **图形界面**：扩展面板 → 找到「小说阅读器」→ 右键「卸载」
- **命令行**：`code --uninstall-extension local.novel-reader`
- **离线安装的**：直接删除 `local.novel-reader-<版本>` 目录，并删除 `extensions.json` 中对应条目

卸载后阅读偏好与进度仍保留在 VS Code 的全局存储中（属于该扩展的数据），如需彻底清理可同时删除 VS Code 用户数据里的对应项。

---

## 故障排查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 扩展面板出现「检测到无效的扩展 ⚠️」 | 离线安装时目录名/版本与 `extensions.json` 不一致 | 运行 `node scripts/register-local-extension.js`，重启 VS Code |
| 插件装了但重启后消失 | 被 `.obsolete` 标记为待删除 | 同上：先跑登记脚本，再重启（脚本会清除误标） |
| 活动栏没有「小说阅读」图标 | ① 未重启 VS Code；② 与其他小说插件的视图容器 ID 冲突 | ① 先 `Developer: Reload Window`；② 在扩展面板禁用其他小说插件后重启 |
| 命令面板搜不到命令 | 扩展未激活或版本不兼容 | 检查 VS Code 版本是否 ≥ 1.85；查看 `帮助 → 切换开发人员工具 → 控制台` 有无报错 |
| 中文正文全是乱码 | 罕见混合编码 | 用编辑器将文件另存为 UTF-8 后重新打开 |
| 阅读页一直显示「加载中…」 | Webview 脚本被安全策略拦截或扩展激活失败 | 打开 `输出` 面板选择「小说阅读器」查看日志；重启 VS Code |
| 找不到 `code` 命令 | 安装 VS Code 时未勾选「添加到 PATH」 | 用 `bin\code.cmd` 的完整路径，或使用「从 VSIX 安装…」图形界面 |
| `npm install` 卡住/超时 | 网络问题 | 切换镜像：`npm config set registry https://registry.npmmirror.com` |
| `vsce package` 报 `Couldn't detect the repository where this extension is published` | 仓库托管在 Gitee，vsce 只认 GitHub/GitLab | 改用 `npm run package`（已固化 baseUrl 参数），或手动加 `--baseContentUrl` / `--baseImagesUrl` |
| `vsce package` 报 `Missing publisher` | `package.json` 缺字段 | 补上 `"publisher": "local"` |
| 打开小说提示「未能解析出章节」 | 文件不是标准排版的小说文本 | 确认文件为纯文本小说；非「第X章」格式的排版会退化为单章 |

### 查看日志定位问题

1. VS Code → `查看` → `输出`，右上角下拉选择「小说阅读器」
2. 或 `帮助` → `切换开发人员工具` → Console
3. 日志文件位于：
   - Windows：`%APPDATA%\Code\logs\<最新时间戳>\`
   - macOS：`~/Library/Application Support/Code/logs/`
   - Linux：`~/.config/Code/logs/`

---

## 附录：目录与文件位置速查

| 内容 | 位置（Windows） |
| --- | --- |
| 扩展安装目录 | `C:\Users\<用户名>\.vscode\extensions\` |
| 扩展清单 | `...\.vscode\extensions\extensions.json` |
| 待删除标记 | `...\.vscode\extensions\.obsolete` |
| 运行日志 | `%APPDATA%\Code\logs\` |
| 偏好与进度数据 | VS Code `globalState`（扩展数据目录内），键名前缀 `novelReader.` |

> macOS / Linux 把 `C:\Users\<用户名>` 换成 `~`、`%APPDATA%` 换成对应平台配置目录即可。

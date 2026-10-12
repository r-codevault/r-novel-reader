# 小说阅读器 · Novel Reader

在 VS Code 里读小说：导入本地 `.txt` 文件，自动解析章节目录，提供沉浸式阅读界面与个性化阅读设置。

**全部本地运行**——不联网、不上传文件、不内置任何小说内容，只读取你自己选择的文本文件。

| 项目 | 说明 |
| --- | --- |
| 插件 ID | `local.novel-reader` |
| 显示名称 | 小说阅读器 |
| 当前版本 | 1.0.2 |
| 要求 | VS Code 1.85.0+（实测 1.128.0），Node.js 18+（仅打包时需要） |
| 开源协议 | MIT |

---

## 界面一览

```
┌─ 活动栏 ──┬────────── 侧边栏 ──────────┬─────────── 阅读界面 ───────────┐
│  资源管理器 │  小说阅读: 章节目录    ＋ ⟳ ⋯ │  ‹ 上一章 [第275章 ▾] 下一章 › │
│  搜索      │ ┌────────────────────────┐│   3 / 454        A-  A+ [Aa 设置]│
│  源代码管理 │ │ ▶ 继续阅读: 第275章 …   ││ ────────────────────────────── │
│  运行和调试 │ └────────────────────────┘│        第 275 章 九河圣界 抵达   │
│ ▶ 小说阅读  │ ──────── 分 割 线 ─────── │                                │
│  扩展      │   📖 第272章 大陆影响       │   正文区域：字号、字体、行距、    │
│            │   📖 第273章 我叫元         │   段距、宽度、主题均可实时调整    │
│            │ ▶ 第275章 九河圣界 抵达 在读│                                │
└────────────┴────────────────────────────┴────────────────────────────────┘
```

---

## 特性

### 导入与解析

- 三种打开方式：侧边栏按钮、命令面板、资源管理器右键 `.txt` 文件
- **自动识别编码**：UTF-8（含 BOM）、UTF-16LE/BE、GB18030（中文小说站点下载的文件多为 GBK 编码）
- **章节格式识别**
  - `第X章` / `第X节` / `第X回` / `第X卷` / `第X部` / `第X篇`（阿拉伯数字与中文数字均可）
  - `序章`、`楔子`、`引子`、`尾声`、`终章`、`后记`、`番外篇`
  - 英文 `Chapter 12` / `Vol.3`
- **健壮的去重与过滤**（针对盗版站点导出文本的常见问题）
  - 剔除正文中缩进重复出现的章节标题，且兼容**源站编号错位**（真标题“第82章”对应重复行“第80章”的情况）
  - 过滤作者告示（如“第一篇『初临』结束，明天更新第二篇……”）
  - 剔除目录页（连续多个无正文的章节行块）
  - 保留含标点的合法标题（如“第231章 梦域，黑暗区域”）

### 侧边栏章节目录

- 「继续阅读」**悬浮固定条**：列表滚动时始终钉在顶部，下方带分割线
- 点击「继续阅读」后，当前章节**自动滚动定位到列表垂直中间**
- 「在读」章节使用醒目的绿色播放图标，普通章节为半透明书本图标
- **侧边栏收起时，切换章节不会把它撑开**（只更新高亮，不打扰你的布局）

### 阅读界面

- 编辑器区域内的阅读页：章节下拉框跳转、上一章/下一章按钮、`Alt+←` / `Alt+→` 快捷键
- 顶部整书进度条与章节计数
- 阅读设置实时生效：字号、字体族、行距、段距、阅读宽度、主题配色
- 六套主题：米黄纸、护眼绿、纯净白、简约灰、暗夜、墨黑

### 偏好与进度持久化

- 阅读偏好与阅读进度（最近文件 + 当前章节 + 章内滚动位置）自动保存
- 重启 VS Code 后，侧边栏「继续阅读」一键回到上次位置
- 也可在 VS Code 设置页搜索 `novelReader` 修改默认值，与阅读界面实时同步

---

## 安装

### 方式一：源码打包安装（推荐）

```bash
# 1. 克隆仓库
git clone https://gitee.com/rich-woman-hugs-me-to-sleep/r-novel-reader.git
cd r-novel-reader

# 2. 安装依赖并编译
npm install
npm run compile

# 3. 打包成 vsix
npm run package
# 生成 novel-reader-1.0.2.vsix

# 4. 安装到 VS Code
code --install-extension novel-reader-1.0.2.vsix
```

安装后**重启 VS Code**（或 `Ctrl+Shift+P` → `Developer: Reload Window`）。

### 方式二：打包好的 vsix 直接安装

若已拿到 `novel-reader-x.y.z.vsix`：

- **命令行**：`code --install-extension novel-reader-x.y.z.vsix`
- **图形界面**：VS Code 扩展面板右上角 `···` → 「从 VSIX 安装…」→ 选择文件

### 方式三：开发调试（F5 免安装）

```bash
npm install
npm run compile
```

用 VS Code 打开项目目录 → 按 `F5` → 在弹出的「扩展开发宿主」窗口中使用插件。改代码后按 `Ctrl+Shift+P` → `Developer: Reload Window` 生效；或运行 `npm run watch` 自动增量编译。

> 无法使用 `code` 命令行的环境（如受限终端），请参考 **[docs/INSTALL.md](docs/INSTALL.md)** 的「离线解包安装」章节。

📖 **逐步骤的详细安装教程（含升级、卸载、故障排查）：[docs/INSTALL.md](docs/INSTALL.md)**

---

## 使用

1. 点击左侧活动栏的 **📖 小说阅读** 图标
2. 点击侧边栏顶部标题栏的 **＋** 按钮（或命令面板执行 `小说阅读器: 打开小说文件`）
3. 选择你的 `.txt` 小说文件 → 自动解析出章节目录并打开阅读页
4. 点击侧边栏任意章节即可跳转阅读

### 命令列表

在命令面板（`Ctrl+Shift+P`）中搜索「小说阅读器」：

| 命令 | 说明 |
| --- | --- |
| `小说阅读器: 打开小说文件` | 打开本地 txt 小说 |
| `小说阅读器: 继续阅读` | 回到上次阅读位置 |
| `小说阅读器: 阅读设置` | 打开阅读页并展开设置面板 |
| `小说阅读器: 上一章` / `下一章` | 章节切换 |
| `小说阅读器: 刷新目录` | 重新解析当前文件（文件内容更新后使用） |

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Alt` + `←` | 上一章 |
| `Alt` + `→` | 下一章 |

### 阅读设置项

阅读页右上角「Aa 设置」可实时调节；也可写入 VS Code 设置（`settings.json`）：

| 配置项 | 类型 | 默认值 | 可选范围 |
| --- | --- | --- | --- |
| `novelReader.fontSize` | number | `16` | 12–32（像素） |
| `novelReader.fontFamily` | string | `system` | `system` / `songti` / `heiti` / `kaiti` / `fangsong` / `yahei` |
| `novelReader.lineHeight` | number | `1.8` | 1.2–2.8 |
| `novelReader.paragraphSpacing` | number | `0.8` | 0–2（em） |
| `novelReader.contentWidth` | number | `720` | 480–1200（像素） |
| `novelReader.theme` | string | `sepia` | `sepia` / `green` / `white` / `gray` / `dark` / `ink` |

> 调整记录保存在 VS Code 的 `globalState` 中，优先级高于 `settings.json` 的默认值；在设置页修改会立即同步到阅读界面。

---

## 项目结构

```
novel-reader/
├── package.json                # 插件清单（命令 / 视图 / 配置贡献点）
├── tsconfig.json
├── src/
│   ├── extension.ts            # 入口：命令注册、文件加载、编码识别、进度恢复
│   ├── novelParser.ts          # 章节目录解析器（编码/标题识别/去重/告示过滤）
│   ├── chapterViewProvider.ts  # 侧边栏章节目录（WebviewView：悬浮条 + 列表）
│   ├── readerPanel.ts          # 阅读界面 Webview（正文渲染 + 设置面板）
│   └── settings.ts             # 阅读偏好（主题/字体定义 + globalState 持久化）
├── scripts/
│   ├── make-icon.js            # 生成插件图标 PNG（无第三方依赖）
│   ├── test-parser.js          # 解析器全量断言测试
│   ├── smoke-webview.js        # 两个 Webview 的 HTML/脚本冒烟测试
│   └── register-local-extension.js  # 离线安装时登记 VS Code 扩展清单
├── media/                      # 图标资源
└── docs/INSTALL.md             # 详细安装教程
```

---

## 本地开发

```bash
npm install          # 安装开发依赖
npm run compile      # 编译 TypeScript → dist/
npm run watch        # 监听模式增量编译

npm test                                  # 运行全部测试（解析器结构校验 + Webview 冒烟测试）
node scripts/test-parser.js <小说.txt>     # 对指定小说文件做解析校验
node scripts/smoke-webview.js             # 两个界面视图的 HTML/脚本冒烟测试

npm run package      # 打包 vsix（脚本内已固化 Gitee 相对链接所需的 baseUrl 参数）
```

> `npm run package` 而不是裸 `vsce package`：vsce 只能自动识别 GitHub/GitLab 仓库，本项目托管在 Gitee，README 的相对链接会让打包报错，因此脚本里固化了 `--baseContentUrl` / `--baseImagesUrl`。

---

## 常见问题

**Q：打开小说后正文显示乱码？**
A：插件已自动尝试 UTF-8 / UTF-16 / GB18030。若仍乱码，通常是罕见的混合编码文件，请先用编辑器「另存为 UTF-8」后再打开。

**Q：活动栏看不到「小说阅读」图标？**
A：①确认已**重启 VS Code**；②若同时装了其他小说插件，可能出现视图容器 ID 冲突导致图标被合并，可在扩展面板禁用其他小说插件后重启。

**Q：扩展面板提示「检测到无效的扩展 ⚠️」？**
A：这是**手动离线安装**时的清单未对齐问题。运行 `node scripts/register-local-extension.js` 即可修复（会自动对齐版本目录并清理误标记），详见 [docs/INSTALL.md](docs/INSTALL.md#故障排查)。

**Q：收起侧边栏后切换章节，侧边栏不会自己打开了？**
A：这是刻意的设计——切换章节只更新侧边栏里的「在读」高亮，不改变你的布局。需要定位时点击「继续阅读」，会把当前章节滚动到列表中间。

**Q：几百章的大文件会卡吗？**
A：实测 3.6 MB / 454 章的文件解析约 60 ms，目录列表只在换书时重建 DOM，切换章节仅更新样式，滚动流畅。

**Q：支持 epub / mobi / pdf 吗？**
A：暂不支持，目前仅处理纯文本 `.txt`。

---

## 已知限制

- 仅支持纯文本 `.txt`（不支持 epub/mobi 等二进制格式）
- 编码识别基于 BOM 与 UTF-8 校验启发式，极端混合编码文件可能需另存为 UTF-8
- 章节解析基于排版特征识别，非标准排版（如全书无章节标题）会退化为单章

## 免责声明

本插件仅提供本地文本的解析与阅读功能，**不提供、不内置、不传播任何小说内容**，也不访问网络。请确保你阅读的文本来源合法。

## 开源协议

[MIT](LICENSE)

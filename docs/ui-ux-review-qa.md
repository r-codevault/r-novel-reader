# r-novel-reader UI/UX 增量改造 · 独立 QA 最终验收报告

- **验证人**：QA（严过关），完全独立于实现方
- **验证对象**：T01–T05 全部改动 + 第 1 轮 A–E 修复 + I1 / P3 收口 + 冻结后两处收尾（smoke 弱断言强化、`ops.ts`/`vscode.ts` 冗余字段清理）
- **依据**：`docs/ui-ux-review.md`（12 项）、`docs/ui-ux-review-prd.md`（R1–R12 / 72 条）、`docs/ui-ux-review-architecture.md`（T01–T05、§8）
- **最终判定：PASS** —— 无 P0/P1/P2 未闭环；**仅 1 个 P3 观察项**（P3-1 双 alert），9 项真机手工项明确未执行

---

## 1. 冻结后的最终串行验收

执行前核查：`find src webview scripts -newermt '-5 minutes'` 只命中两份测试脚本（我上一轮的 `test-ui-ux-qa.js` 13:16:33、工程师的 `smoke-reader-vue.js` 13:17:48）；**产品代码最后修改 13:07:08，早于本轮机跑**，确认无并发写入。

| # | 命令 | 退出码 | 实际输出 |
| --- | --- | --- | --- |
| a | `npx tsc -p ./ --noEmit` | **0** | 无类型错误 |
| b | `npx vite build` | **0** | `reader.css 65.91 kB` / `reader.js 290.88 kB` |
| c | `npm test` | **0** | **31 条脚本**全绿，`✘` 计数 **0**；含 `独立 QA 回归全部通过 ✔` 与 `阅读面板 Vue 冒烟测试全部通过 ✔` |
| d | `node scripts/test-ui-ux-qa.js` | **0** | **85 条断言**全通过（本轮未改动 QA 脚本，结论与前一轮逐字节一致） |

产物核查：`dist-webview/reader.js|reader.css` 由 `pretest` 重建；再单独 `vite build` 后 sha256 完全一致（`DIST_REPRODUCIBLE=YES`）→ 构建产物、无手改。

纪律：未 `commit/checkout/reset/stash`；未改产品代码；未新增依赖；未扩大测试范围。

---

## 2. 冻结后两处收尾的核对结论

### 2.1 `smoke-reader-vue.js`：弱断言已强化（不是放宽）

- **旧写法**：`fontSizeUses.length <= 2`（阈值判断 → 少一条也能过，例如正文 `font-size` 被误删仍绿）。
- **新写法**（`scripts/smoke-reader-vue.js:3657-3684`）：解析"谁在使用 `font-size: var(--font-size)`"（从声明行往回找最近的选择器行），断言
  1. 条数 **恰好等于 2**；
  2. 集合必须包含 `#content` 与 `.chapter-skeleton`（缺一个 → 报"正文/骨架必须跟随阅读字号"）；
  3. **多出任何其它选择器** → 报"只允许正文纸面与切章骨架"。
- **判定**：**双向收紧，可接受**。它现在既能抓"漏删"也能抓"多写"，比原来的阈值判断强；实测解析结果 `["#content", ".chapter-skeleton"]`，与实现一致。顺带纠正了原注释（跟随阅读字号的是 `#content` 与切章骨架 `.chapter-skeleton`，不是 `.chapter-title`）。
- 注：QA 的 A 段另有规则级断言（允许 `html/body/#content/.chapter-title/.chapter-skeleton`），比 smoke 的这条**更宽**；两条并存时以 smoke 的更严口径为准，不冲突。

### 2.2 `ops.ts` / `vscode.ts` 的字段清理：**无功能回归**

逐项核对当前代码：

| 关注点 | 现状 | 结论 |
| --- | --- | --- |
| `state.opError` | `vscode.ts:380` 仍声明；`ops.ts:42`（askConfirm）、`vscode.ts:482`（markOpPending）仍清空；`App.vue:761` 失败时写入 | 保留，链路完整 |
| `state.lastOp` | `vscode.ts:386` 仍声明；`App.vue:760` 每次 `opResult` 写入；Shelf/History/Notes 三个面板 `watch` 它 | 保留 |
| `state.confirm` / `pendingOps` | `vscode.ts:400 / 376` 仍声明；`ops.ts` 的 `askConfirm/confirmNow` 与 `vscode.ts` 的 `newOpId/markOpPending/clearOpPending/opRunning` 五个导出都在 | 保留 |
| ConfirmDialog 失败承载 | `ConfirmDialog.vue:93` `<div v-if="failText" class="op-error" role="alert">`，`failText` 读 `state.opError`；取消/确认按钮仍在 | 失败就地可见 + 可重试，未退化 |
| 行为回归 | `tsc` 0；QA 85 条（含"失败保留确认框 + role=alert 含原文 + 重试成功收尾"）；smoke 全绿 | **无回归** |

→ 所谓"回退 P3-1 相关多余字段"清理的是**未被消费的冗余字段/别名**，四个关键状态（`opError / lastOp / confirm / pendingOps`）与失败提示链路均完整。

---

## 3. 第 1 轮 5 个缺陷 + I1：全部关闭

| 编号 | 缺陷 | 修复位置 | QA 独立复核 | 状态 |
| --- | --- | --- | --- | --- |
| A | `#notesPopup` 340px / `#sourcePopup` 360px 固定 min-width 顶破窄屏 | `reader.css:926-939` → `min-width: 0`；≤576px 组显式 `min-width: 0` | 15 组 320/400/576px「右缘 ≤ 视口」静态求值全过；宽屏 `min(460/560px)` 未被误砍 | **关闭** |
| B | 关闭设置面板不 `restoreTheme()` | `SettingsPanel.vue:67-76` `watch(settingsOpen)` + `onBeforeUnmount` | 聚焦预览→Esc→`--bg` 归位；重开后 `data-theme` == `aria-checked` 项；watcher 顺序无回弹 | **关闭** |
| C | 批量删笔记无确认框/无 `opId`/立即清选择 | `NotesPopup.vue:139-166` `askConfirm`；仅成功才清空 | 六段：文案（2 条 / 2 本书 / 2 章 / 不可恢复 / 书名）、取消、失败、成功、pending 只发一次、重试沿用同一 `opId` | **关闭** |
| D | `opResult(ok:false)` 无条件关确认框，失败静默 | `App.vue:750-763` 仅 `r.ok` 才关；面板级 `role=alert` | 笔记/书架/历史三类失败：确认框保留 + 选择保留 + 仍管理模式 + `role=alert` 含原文 + 可重试 | **关闭** |
| E | 条目选择框 `span[role=checkbox]` 不可聚焦无名称 | `NotesPopup.vue:513-517` 原生 `input`+`label`+`aria-label` | `INPUT`/`checkbox`/`tabIndex=0`/`:checked`；三条 `aria-label` 唯一含正文 | **关闭** |
| I1 | 24×24 label 环死区（行 click 与 label 激活各切一次 → 净零） | `NotesPopup.vue:513` `<label @click.stop>` | 点 16px 框 → +1；点 24×24 环 → +1（精确 `已选3条`）；再点环 → −1 复原；行文字 → +1 | **关闭** |

> I1 是**硬断言**：脚本内 `grep KNOWN_ISSUE` **0 命中**，两条 `assert.strictEqual` 精确比对状态，第二次点击互为复原，不污染后续期望。

---

## 4. P3-1 / P3-2 / P3-3 最终状态（以当前代码为准）

| 项 | 当前代码事实 | 最终判定 |
| --- | --- | --- |
| **P3-3 旧错误滞留** | `NotesPopup.vue:180-190` `watch(state.lastOp)` 首行 `if (op.ok) { opFailText.value = ''; }` —— **任意类型**成功都先清，再按 `op.op` 分支；`:96-101` `toggleManaging()` 进出管理模式都清 `opFailText` | **已关闭（已修复）** |
| **P3-2 组删除 pending** | `NotesPopup.vue:238-250`：入口 `if (opRunning('notes:removeGroup')) return;` 早退；第二次点击 `newOpId()` + `markOpPending(opId,'notes:removeGroup')` + `send({...,opId})`；按钮 `:disabled="opRunning('notes:removeGroup')"`；`opResult` → `clearOpPending` 恢复 | **已关闭**，4 条断言锁定（入口不灰 / 首次点击不发请求 / 二次带 `opId` 且 disabled / 回包恢复）；选择器限定 `.nt-book-head` 作用域 |
| **P3-1 失败提示双份** | `NotesPopup.vue:407` 面板级 `role=alert` 与 `ConfirmDialog.vue:93` 框内 `role=alert` **同时存在**；实测失败瞬间页面 **2 个** `role="alert"`（同文案）；书架/历史只有 1 个 | **唯一保留的 P3 观察项（非缺陷）**。理由：R9-03 约束的是"进度刷新不得逐次播报"，未禁止"同一最终失败在两处呈现"；R7-03 要求错误就地可见，两处属超额满足且文案一致，不会给出矛盾结论；两侧交互作用不同（框内可重试、取消后仍可见）。代价仅是部分读屏可能念两遍。**不为它解冻代码**（如日后降噪：面板级加 `v-if="opFailText && !state.confirm"`，1 行） |

---

## 5. 12 类需求最终状态

| 类 | 状态 | 关键依据 |
| --- | --- | --- |
| R1 键盘主链路 | **PASS** | 目录章节/卷头原生 `button` + `aria-current/expanded/controls`；书架/历史行主按钮+独立删除按钮、无嵌套、名称含书名；笔记组头三件套 + 原生 `indeterminate`；段落徽章与笔记模式已下线（v1.48.18），建笔记改由单击段落承担；条目复选框三处点击均净切换一次 |
| R2 异步归属 | **PASS** | 异书/无归属/回退 `reqId` 全部丢弃、合法回包不误杀；下载进度按 `filePath` 路由（异书只进任务表、当前书正常驱动）；`test-ownership` 覆盖迟到回包/缓存写入/换书清锁/同章两轮锁/按 key 控制/I1 静态守卫 |
| R3 响应式 | **PASS** | 15 组窄屏几何全过；侧栏 `overflow-y:auto`；`.src-results` 保留 `display:flex`/`overflow:hidden` + `flex:1 1 auto`/`min-height:0`；`--src-alloc-h`；长名称省略/双行 |
| R4 字号解耦 | **PASS** | 规则级审计 + smoke 新白名单断言（恰好 `['#content','.chapter-skeleton']`）；`--ui-font:14px`/`--ui-font-sub:12px`；行高用 `min-height`；容量实测 |
| R5 浮层语义与焦点 | **PASS** | 7 浮层 `role=dialog`/`aria-modal=false`/`labelledby`→真实 `<h2>`；无 `inert`、无 Tab 拦截；打开聚焦、Esc 回触发点；Esc 分层实测两层 |
| R6 入口修正 | **PASS（代码审阅）** | `showSourcesPanel()` → `openEmptyReader('source')`；`resumeCurrent` 无记录回第 1 章 |
| R7 危险操作 | **PASS** | 四类危险操作统一确认框 + `opId` + 成功才退出 + 失败保留 + 就地 alert；组删除两步 + pending；刷新书架 plan/apply + `planId` + `ENOENT` vs 不可访问降级；禁用态 + `aria-describedby` |
| R8 设置控件与预览 | **PASS** | radiogroup + 7 radio + `aria-checked` + roving + 可见名称；方向键→实时应用→`updateSettings` 三者一致；预览三层收尾无回弹；档位名 + `data-ratio`；自定义宽度 `label[for]` |
| R9 加载/失败/保存终态 | **PASS（含唯一 P3-1 观察）** | 失败明细展开 + 类别映射 + 单源重试去重/保留；`progressbar` 数值；`role=status` 节流 + 可见区 `aria-live=off`；写操作 `opId` + pending + 失败保留 + 可重试；笔记保存失败 `role=alert` 保留草稿 |
| R10 状态色令牌 | **PASS** | 88 套主题独立复算全 ≥4.5（最差 4.53）；黑夜 `dangerFg=#191919`；4 处 CSS 接令牌；产物无 `#2ea043`/`charts-green` |
| R11 层级与 hover | **PASS** | 书源三层工具 + 键盘子菜单；批量条仅管理模式；危险区；笔记操作组常显（定位原文/编辑/删除，无「更多/收起」）；状态双通道 |
| R12 小控件与名称 | **PASS** | `.src-check`/`.src-ico` 24×24、粗指针 40×40；书源 `label` 扩大命中区；输入/图标按钮名称含对象；笔记条目复选框原生 + 有名 + 24×24 命中区整块可用 |

**12 类：全部 PASS，无 FAIL。**

---

## 6. 测试代码改动清单（QA 侧 4 个文件，均无放宽）

| 文件 | 改动 |
| --- | --- |
| `scripts/test-ui-ux-qa.js`（新增 → 85 条断言） | A 段自带 CSS 解析器（选择器级 / `@media` 区分 / 去注释）；B 段自实现 WCAG；C/D 段跑真实产物做反向断言（几何 15 组、预览三层、笔记删除六段、组删除 4 条、命中区 3 条、失败/重试/终态） |
| `scripts/smoke-reader-vue.js` | ①（QA 收紧）`:3525` 全文 `width:24px` → `.src-check` 选择器级；`:3530` 全文 `min-width: 0;` → 逐浮层解析规则体（**这是缺陷 A 漏网的直接原因**）。②（工程师后续强化）字号归属改为**双向白名单**断言，替换原"行数 ≤2"阈值（见 §2.1，已核对为收紧） |
| `package.json` | `scripts.test` 追加 `node scripts/test-ui-ux-qa.js`，现共 **31** 条命令 |
| `docs/ui-ux-review-qa.md` | 本报告 |

> 最终验收阶段 QA 只做了一处测试改动（组删除断言选择器收紧到 `.nt-book-head`），未新增/删除/放宽断言，未改产品代码。

---

## 7. 遗留风险

1. **P3-1（唯一保留）**：笔记失败瞬间两份同文案 `role="alert"`，部分读屏可能念两遍；不违反 R9-03/R7-03，属降噪优化，方案见 §4。
2. **并发构建约束**：`pretest` 会 `rm -rf dist`，另一路 `vite build` 会重写 `dist-webview` → 同一时刻只允许一人执行构建/测试；本轮冻结后串行零失败，前几轮的 `Cannot find module '../dist/shelf'` / `ENOENT …reader.css` 均为此因。
3. **结论边界**：happy-dom 无布局引擎、不实现真实 Tab/Space 激活与媒体查询；尺寸类结论来自静态求值 + CSS 级断言，不替代真机截图。

---

## 8. 仍仅能人工验收（9 项，未执行、不列为通过）

1. 真机 320/400/576/768/1200px 宽 × 360/480px 高，逐浮层 `rect.right <= innerWidth`、`scrollWidth <= clientWidth`（静态几何已过，仍需确认边框/滚动条 1–2px 误差）。
2. 真键盘全链路（R1-08）：打开书 → 目录跳章 → 搜索预览 → 新建笔记 → 编辑保存，全程 `activeElement !== body`；Shift+Tab 可离开非模态浮层。
3. 真实 Space 激活复选框（happy-dom 不实现；已验证原生 `input` + `tabIndex=0`）。
4. 粗指针（`pointer:coarse`）40×40 目标与间距。
5. 正文 12/32px × 侧栏开合四组合无重叠、`scrollHeight <= clientHeight`（60 字符长书名）。
6. 灰度截图下"当前/半选/失败/下载"四类状态可辨识。
7. 节日/地域主题重开面板首帧不闪（`--danger-fg`/`--success`）。
8. 真机弱网 R2-07：预览 >45s 超时 → 打开另一本 → 旧预览回包：不切书、不重开面板、无弹窗。
9. R6 真机：清空书架后命令面板「书源搜索」直达空阅读页 + 抽屉；新加入未读的书「小说阅读」进第 1 章且滚动在顶部。

---

## 9. 最终判定

**PASS**

- 四条命令串行退出码全 0：`tsc` 0 / `vite build` 0 / `npm test` 0（31 条脚本，`✘` 计数 0）/ `test-ui-ux-qa` 0（v1.48.8 为 85 条断言；v1.48.9 增补后为 91 条）。
- `dist-webview` 为构建产物（sha256 可复现），无手改。
- 第 1 轮 5 个缺陷 + I1 全部关闭；P3-2、P3-3 已关闭；**仅 P3-1 作为观察项保留**（判定理由见 §4）。
- 冻结后两处收尾已核对：smoke 弱断言是**收紧**（双向白名单）；`ops.ts`/`vscode.ts` 字段清理**无功能回归**（四个关键状态与失败提示链路完整，测试全绿）。
- 无 P0/P1/P2 未闭环；9 项真机手工验收明确未执行，未列入通过。

---

## 10. v1.48.9 修复回归补充（2026-10-25）

本轮针对实际使用截图修复 6 组问题：笔记复选框状态不同步、确认框 mousedown 提前关浮窗、移除笔记“更多/收起”、目录左右留白丢失、书源下拉菜单挤压/重叠、书源全停用时批量按钮改为“全部启用”，以及书源关闭按钮改为文字。

自动化结果：

- `npm test` 通过（31 条脚本，含本次扩充后的 smoke 与 QA）。
- `node scripts/test-ui-ux-qa.js` 通过，共 **91** 条断言。
- 新增覆盖：checkbox `click` 不得 `preventDefault`；确认按钮先 `mousedown` 再 `click` 时笔记/历史浮窗仍打开；点确认遮罩只关确认框；笔记操作组常显；目录 padding/卷头底色；书源菜单 absolute + nowrap；书源全库启用排除失效源。

仍需真实 VS Code 手工确认：鼠标/Space 操作真实原生 checkbox；确认按钮按下不关面板；0/1 个书源时下拉菜单完整可见；目录留白；筛选状态下“全部启用”的范围与当前列表全选。

### v1.48.10 目录视觉与动画

- 分卷头改为圆角卡片、圆形描边箭头与章数徽标；目录正文左右 14px 留白，章节行增加分隔线与行距。
- 折叠实现由 `display:none` 改为 `grid-template-rows: 0fr/1fr` 过渡；收起后 `visibility:hidden`，内部章节退出 Tab/读屏顺序；支持 `prefers-reduced-motion`。
- 冒烟测试验证 `.cat-group-body.open` 与 `aria-expanded` 同步、CSS transition 包含 `grid-template-rows`；QA 静态审计覆盖留白、卡片 padding 与动画声明。`npm test` 全量通过。

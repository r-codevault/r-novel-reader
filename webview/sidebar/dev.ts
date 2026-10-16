/**
 * webview/sidebar/dev.ts — 浏览器调试入口(仅 dev, 不进产物)
 * 启动: npm run dev:sidebar
 */
import { installDevHarness, mockSidebarBoot } from '../dev/harness';

installDevHarness({ bootMessages: mockSidebarBoot() });

// 必须在 harness 之后加载(store 模块加载时就会调用 acquireVsCodeApi)
import('./main');

/**
 * overlayLayout.ts — 阅读页浮层元素(「+ 加入书架」)的横向定位
 *
 * 单独抽成纯函数的原因: webview 里的 Vue 组件没法在 node 测试里直接 require,
 * 而这段几何最容易算错(历史上错过两次: 8px 滚动条、窄窗把内边距当间隙),
 * 所以把它做成无副作用的可测函数。
 *
 * 坐标系约定(全部以「距视口右缘的像素数」表示, 越小越靠右):
 *   gap        视口右缘 -> 纸面右缘
 *   right      视口右缘 -> 按钮右缘(直接写进 CSS right)
 *   PAPER_INSET 纸面右缘 -> 正文右缘 = 1px border + 34px padding
 *   gapToText  按钮左缘 -> 正文右缘, 即"肉眼看到的空白"
 */

/** 按钮边长(与 reader.css 的 .preview-add width/height 保持一致) */
export const PREVIEW_BTN = 32;
/** 纸面右缘到正文右缘: 1px 边框 + 34px 内边距 */
export const PAPER_INSET = 35;
/** 与正文之间至少保留的空白(用户拍板: 优先保间隙) */
export const MIN_TEXT_GAP = 16;
/** 空间充足时, 按钮与纸面边缘之间的间隙 */
export const PAPER_GAP = 16;
/** 正常情况下的最小距视口右缘 */
export const EDGE_MIN = 8;
/** 极窄时的硬下限: 宁可再往右挪 4px, 也不压字 */
export const EDGE_HARD = 4;

export interface PreviewAddLayout {
    /** 写进 style.right 的值(整数 px) */
    right: number;
    /** 按钮左缘到正文右缘的空白, 负数表示压字 */
    gapToText: number;
    /** 按钮探进纸面右缘的像素(≤19 时必然仍在内边距里, 不会压字) */
    protrude: number;
    overlapsText: boolean;
}

/**
 * 计算「+」按钮的水平位置。
 *
 * 两档策略:
 *  1. 留白充足 → 整颗落在纸面外侧, 与纸边留 PAPER_GAP;
 *  2. 留白不足(窄窗) → 保正文间隙: 允许探进纸面最多 19px
 *     (19 + 16 = 35 = 内边距 + 边框, 所以永远压不到文字)。
 */
export function previewAddLayout(gapPx: number): PreviewAddLayout {
    const gap = Number.isFinite(gapPx) ? Math.max(0, gapPx) : 0;

    // 首选: 整颗在纸面外
    let right = Math.max(EDGE_MIN, gap - PREVIEW_BTN - PAPER_GAP);
    const clearance = (r: number): number => gap + PAPER_INSET - (r + PREVIEW_BTN);

    // 次选: 正文间隙优先, 按钮往右靠(视口边距可退到 EDGE_HARD)
    if (clearance(right) < MIN_TEXT_GAP) {
        right = Math.max(EDGE_HARD, gap + PAPER_INSET - MIN_TEXT_GAP - PREVIEW_BTN);
    }
    right = Math.round(right);

    const gapToText = gap + PAPER_INSET - (right + PREVIEW_BTN);
    return {
        right,
        gapToText,
        protrude: Math.max(0, right + PREVIEW_BTN - gap),
        overlapsText: gapToText < 0,
    };
}

/**
 * 布局视口宽度。
 *
 * 必须用 documentElement.clientWidth: window.innerWidth 含竖向滚动条(本项目 8px),
 * 而 getBoundingClientRect() 与 position:fixed 的 right 基准都不含滚动条 ——
 * 混用会让"纸面右缘"系统性偏右 8px(这是历史 bug 的根因)。
 */
export function layoutViewportWidth(): number {
    if (typeof document !== 'undefined') {
        const de = document.documentElement;
        const cw = de ? de.clientWidth : 0;
        if (cw && cw > 0) { return cw; }
    }
    if (typeof window !== 'undefined' && typeof window.innerWidth === 'number') {
        return window.innerWidth;
    }
    return 0;
}

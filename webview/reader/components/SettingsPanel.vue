<script setup lang="ts">
/**
 * SettingsPanel.vue — 设置面板(起点风格)
 * 面板定位(贴合悬浮球)由 App 协调, 本组件暴露根元素
 */
import { computed, ref, watch } from 'vue';
import { state, THEMES, PROVINCES, SOLAR_TERMS, CONTENT_WIDTH, persistSettings, previewTheme, restoreTheme, stepFontSize, stepSetting, resetSettings } from '../store';
import { normalizeHex } from '../../../src/themePaint';
import { shortcutLabel } from '../composables/shortcut';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

/** 当前选中省份(未启用地域主题时也回退到已选省, 便于预览) */
const provinceCode = computed(function () {
  const s = state.settings;
  return s ? s.province : '110000';
});

/** 省份/节气列表展开状态(自绘下拉, 避免原生 select 的粗滚动条) */
const provinceOpen = ref(false);
const termOpen = ref(false);

/** 按钮文案: 只有正在使用地域主题时才显示省份名, 否则显示占位「地域色彩」 */
const provinceName = computed(function () {
  if (!state.settings || state.settings.theme !== 'province') { return '地域色彩'; }
  const found = PROVINCES.find(function (p) { return p.code === provinceCode.value; });
  return found ? found.name : '地域色彩';
});

/** 点击面板其他位置时收起省份列表 */
function closeProvinceMenu(e: MouseEvent): void {
  const picker = rootRef.value ? rootRef.value.querySelector('.sp-province-picker') : null;
  if (!picker || !picker.contains(e.target as Node)) { provinceOpen.value = false; }
}

watch(provinceOpen, function (open) {
  if (open) {
    document.addEventListener('mousedown', closeProvinceMenu, true);
  } else {
    document.removeEventListener('mousedown', closeProvinceMenu, true);
    restoreTheme(); // 关闭列表时结束任何预览
  }
});

/** 悬浮预览预设主题(不落盘) */
function previewPreset(themeId: string): void {
  previewTheme({ theme: themeId });
}

/** 选中预设主题: 先清预览, 再持久化 */
function choosePreset(themeId: string): void {
  restoreTheme();
  persistSettings({ theme: themeId });
}

/** 悬浮预览: 不落盘, 只看色板效果 */
function previewProvince(code: string): void {
  previewTheme({ theme: 'province', province: code });
}

/** 节气按钮文案: 仅在正在使用节气主题时显示节气名, 否则为占位「廿四节气」 */
const termName = computed(function () {
  if (!state.settings || state.settings.theme !== 'term') { return '廿四节气'; }
  const found = SOLAR_TERMS.find(function (t) { return t.id === state.settings!.term; });
  return found ? found.name : '廿四节气';
});

/** 悬浮预览节气 */
function previewTerm(id: string): void {
  previewTheme({ theme: 'term', term: id });
}

/** 选择节气 */
function chooseTerm(id: string): void {
  termOpen.value = false;
  restoreTheme();
  if (!id) { return; }
  persistSettings({ term: id, theme: 'term' });
}

/** 结束预览, 还原当前真实主题 */
function endPreview(): void {
  restoreTheme();
}

/** 选择省份: 同时切到「地域色彩」主题 */
function chooseProvince(code: string): void {
  provinceOpen.value = false;
  // 先还原预览态, 再交给持久化后的正式设置接管, 避免预览变量残留
  restoreTheme();
  if (!code) { return; }
  persistSettings({ province: code, theme: 'province' });
}

/* ---------- 自定义主题色(与地域色彩/廿四节气互斥, 共用同一套色板推导) ---------- */

/** 当前已保存的代表色(归一化后; 非法值回退默认灰) */
const savedHex = computed(function () {
  return normalizeHex(state.settings ? state.settings.customHex : '') || '#8A8A8A';
});

/** 输入框显示值: 正在使用时显示真实色值, 未使用/非法时给占位提示 */
const hexInput = computed(function () {
  if (!state.settings || state.settings.theme !== 'custom') { return ''; }
  return normalizeHex(state.settings.customHex) || '';
});

/** 输入框的实时文本(允许用户输入中间态, 如 "#1a2" 尚未输完) */
const hexDraft = ref('');
const hexInputRef = ref<HTMLInputElement | null>(null);

/** 拖色盘实时预览: 跟随指针即时套用色板(不落盘) */
function onPaletteInput(e: Event): void {
  const hex = (e.target as HTMLInputElement).value;
  hexDraft.value = hex;
  if (!normalizeHex(hex)) { return; }
  // 直接预览: 只改CSS 变量, 不动 state.settings -> 天然不落盘
  previewTheme({ theme: 'custom', customHex: hex });
}

/** 拖动结束/关闭面板时提交, 避免拖动过程中疯狂写设置 */
function commitPalette(): void {
  const hex = normalizeHex(hexDraft.value || savedHex.value);
  if (!hex) { return; }
  restoreTheme();
  if (hex !== savedHex.value) {
    persistSettings({ customHex: hex, theme: 'custom' });
  }
}

/** 粘贴/键入颜色: 回车或失焦生效; 输入非法时恢复为上次有效值 */
function applyHexText(): void {
  const raw = hexDraft.value.trim();
  const hex = normalizeHex(raw);
  if (!hex) {
    // 非法输入: 静默回退, 不弹提示打断阅读
    hexDraft.value = state.settings && state.settings.theme === 'custom' ? hexInput.value : '';
    restoreTheme();
    return;
  }
  restoreTheme();
  persistSettings({ customHex: hex, theme: 'custom' });
  hexDraft.value = hex;
}

/** 悬浮预览: 键盘聚焦时也能看到效果 */
function previewCustom(): void {
  const hex = normalizeHex(hexDraft.value || savedHex.value);
  if (hex) { previewTheme({ theme: 'custom', customHex: hex }); }
}

// 面板关闭时结束任何残留预览
watch(function () { return state.settingsOpen; }, function (open) {
  if (!open) { hexDraft.value = ''; restoreTheme(); }
});

const fontOptions = [
  { id: 'heiti', name: '黑体' },
  { id: 'songti', name: '宋体' },
  { id: 'kaiti', name: '楷体' },
];

/* ---------- 页面宽度: 视口比例档(33.33% 起) + 自定义像素(独占一行) ---------- */
const customInputRef = ref<HTMLInputElement | null>(null);

/** 当前生效的比例档(0 = 自定义像素) */
const curRatio = computed(function () {
  return Number(state.settings ? state.settings.widthRatio : 0) || 0;
});

/** 比例 -> 百分比文案: 0.3333 -> 33.33% */
function pctText(r: number): string {
  return (r * 100).toFixed(2) + '%';
}

/** 自定义输入框显示值: 比例档时显示换算后的实际像素 */
const customValue = computed(function () {
  const s = state.settings;
  if (!s) { return ''; }
  if (curRatio.value > 0) {
    const vw = document.documentElement.clientWidth || window.innerWidth || 0;
    return String(Math.round(vw * curRatio.value));
  }
  return String(Math.round(Number(s.contentWidth) || 0));
});

/** 聚焦即全选, 直接输入即可覆盖 */
function onCustomFocus(e: FocusEvent): void {
  const el = e.target as HTMLInputElement;
  el.select();
}

/** 失焦/回车时应用自定义像素宽度 */
function applyCustomWidth(e: Event): void {
  const el = e.target as HTMLInputElement;
  const n = Math.round(Number(el.value));
  if (!isFinite(n) || n <= 0) { return; }
  const v = Math.min(CONTENT_WIDTH.max, Math.max(CONTENT_WIDTH.min, n));
  el.value = String(v);
  if (v !== Math.round(Number(state.settings ? state.settings.contentWidth : 0)) || curRatio.value !== 0) {
    persistSettings({ contentWidth: v, widthRatio: 0 });
  }
}

const settings = computed(() => state.settings);
const shortcutHintText = computed(function () {
  const s = state.settings;
  if (!s) { return ''; }
  return 'Ctrl + 滚轮 缩放字号 · 上一章 ' + shortcutLabel(s.shortcutPrev) +
    ' · 下一章 ' + shortcutLabel(s.shortcutNext) +
    '（可在 VS Code 设置中自定义）';
});
</script>

<template>
  <section id="settingsPanel" ref="rootRef" class="settings-panel" :class="{ open: state.settingsOpen }">
    <div class="sp-head">
      <b class="sp-title">设置</b>
      <span class="spacer"></span>
      <button class="popup-close" @click.stop="state.settingsOpen = false">关闭</button>
    </div>
    <div class="sp-row sp-row-theme">
      <span class="sp-label">阅读主题</span>
      <div class="sp-themes" @mouseleave="endPreview()">
        <div class="sp-theme-dots">
          <span v-for="t in THEMES" :key="t.id" class="sp-dot" :data-theme="t.id" :title="t.name"
            :style="{ background: t.id === 'dark' ? '#1c1c1c' : t.bg, color: t.fg, '--sp-check': t.fg }"
            :class="{ active: settings && settings.theme === t.id }"
            @mouseenter="previewPreset(t.id)" @focus="previewPreset(t.id)"
            @click="choosePreset(t.id)"></span>
        </div>
        <!-- 第二行: 地域色彩 / 廿四节气 两个选择器(仍归属于「阅读主题」行) -->
        <div class="sp-theme-extra">
        <div class="sp-province-picker">
          <button class="sp-province-btn" :class="{ open: provinceOpen }"
            :title="settings && settings.theme === 'province' ? '当前使用地域色彩主题' : '选择省份后自动切换到地域色彩主题'"
            @click.stop="provinceOpen = !provinceOpen; termOpen = false">
            <span>{{ provinceName }}</span>
            <svg class="sp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div v-if="provinceOpen" class="sp-province-menu" @mouseleave="endPreview()">
            <!-- 仅在正在使用地域主题时才高亮"当前省", 否则与占位文案语义保持一致 -->
            <button v-for="p in PROVINCES" :key="p.code" class="sp-province-item"
              :class="{ active: settings && settings.theme === 'province' && p.code === provinceCode }"
              :style="{ borderLeftColor: p.colors[0] ? p.colors[0].hex : 'transparent' }"
              :title="p.name + (p.colors[0] ? ' · ' + p.colors[0].name : '')"
              @mouseenter="previewProvince(p.code)" @focus="previewProvince(p.code)"
              @click="chooseProvince(p.code)">{{ p.name }}</button>
          </div>
        </div>
        <!-- 廿四节气: 与地域色彩同一行 -->
        <div class="sp-province-picker" data-kind="term">
          <button class="sp-province-btn" :class="{ open: termOpen }"
            :title="settings && settings.theme === 'term' ? '当前使用廿四节气主题' : '选择节气后自动切换到廿四节气主题'"
            @click.stop="termOpen = !termOpen; provinceOpen = false">
            <span>{{ termName }}</span>
            <svg class="sp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div v-if="termOpen" class="sp-province-menu sp-term-menu" @mouseleave="endPreview()">
            <button v-for="t in SOLAR_TERMS" :key="t.id" class="sp-province-item"
              :class="{ active: settings && settings.theme === 'term' && settings.term === t.id }"
              :style="{ borderLeftColor: t.hex }" :title="t.name + ' · ' + t.color"
              @mouseenter="previewTerm(t.id)" @focus="previewTerm(t.id)"
              @click="chooseTerm(t.id)">{{ t.name }}</button>
          </div>
        </div>
        <!-- 第三行: 自定义主题色 —— 左边原生色盘(拖动实时预览), 右边粘贴/键入色值 -->
        <div class="sp-custom-row" @mouseleave="endPreview()">
          <span class="sp-custom-label">自定义色</span>
          <label class="sp-color-well" :class="{ active: settings && settings.theme === 'custom' }"
            :title="'当前代表色 ' + savedHex + ' —— 点击/拖动选取颜色'">
            <input type="color" :value="savedHex"
              @input="onPaletteInput" @change="commitPalette" @blur="commitPalette" />
          </label>
          <input ref="hexInputRef" class="sp-hex-input" type="text" spellcheck="false"
            autocomplete="off" placeholder="#1A2847 或 rgb(26,40,71)"
            :value="hexDraft || hexInput"
            :title="'粘贴或键入颜色值(#rgb / #rrggbb / rgb(r,g,b)), 回车或失焦生效'"
            @focus="previewCustom"
            @input="hexDraft = ($event.target as HTMLInputElement).value"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            @blur="applyHexText" />
          <span class="sp-hex-preview" :style="{ background: normalizeHex(hexDraft || savedHex) || 'transparent' }"
            aria-hidden="true"></span>
        </div>
        </div>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">正文字体</span>
      <div class="sp-seg">
        <button v-for="f in fontOptions" :key="f.id" class="sp-seg-btn"
          :class="{ active: settings && settings.fontFamily === f.id }"
          @click="persistSettings({ fontFamily: f.id })">{{ f.name }}</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">字号大小</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepFontSize(-1)">−</button>
        <span class="sp-step-val">{{ settings ? settings.fontSize : '' }}</span>
        <button class="sp-step-btn" @click="stepFontSize(1)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">行距</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepSetting('lineHeight', -0.1, 1.2, 2.8)">−</button>
        <span class="sp-step-val">{{ settings ? Number(settings.lineHeight).toFixed(1) : '' }}</span>
        <button class="sp-step-btn" @click="stepSetting('lineHeight', 0.1, 1.2, 2.8)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">段距</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepSetting('paragraphSpacing', -0.1, 0, 2)">−</button>
        <span class="sp-step-val">{{ settings ? Number(settings.paragraphSpacing).toFixed(1) : '' }}</span>
        <button class="sp-step-btn" @click="stepSetting('paragraphSpacing', 0.1, 0, 2)">＋</button>
      </div>
    </div>
    <!-- 页面宽度: 与「阅读主题」同构 —— 第一行比例档, 第二行自定义输入(标签只占第一行) -->
    <div class="sp-row sp-row-stack">
      <span class="sp-label">页面宽度</span>
      <div class="sp-stack-box">
        <div class="sp-seg">
          <button v-for="r in CONTENT_WIDTH.ratios" :key="r" class="sp-seg-btn"
            :class="{ active: curRatio === r }"
            :title="'视口宽度的 ' + pctText(r)"
            @click="persistSettings({ widthRatio: r })">{{ pctText(r) }}</button>
        </div>
        <div class="sp-width-custom">
          <!-- 用 text + inputmode=numeric 而非 number: number 输入框不支持 select(), 聚焦无法全选 -->
          <input ref="customInputRef" class="sp-width-input" type="text" inputmode="numeric"
            pattern="[0-9]*" autocomplete="off"
            :value="customValue" :min="CONTENT_WIDTH.min" :max="CONTENT_WIDTH.max" step="10"
            :title="'自定义 ' + CONTENT_WIDTH.min + '–' + CONTENT_WIDTH.max + 'px, 聚焦后直接输入, 回车或失焦生效'"
            @focus="onCustomFocus" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            @blur="applyCustomWidth" />
          <span class="sp-width-unit">px</span>
        </div>
      </div>
    </div>
    <button class="sp-reset" @click="resetSettings">恢复默认设置</button>
    <div class="settings-hint">{{ shortcutHintText }}</div>
  </section>
</template>

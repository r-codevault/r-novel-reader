<script setup lang="ts">
/**
 * SettingsPanel.vue — 设置面板(起点风格)
 * 面板定位(贴合悬浮球)由 App 协调, 本组件暴露根元素
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { state, THEMES, PROVINCES, SOLAR_TERMS, FESTIVALS, CONTENT_WIDTH, persistSettings, previewTheme, restoreTheme, stepFontSize, stepSetting, resetSettings } from '../store';
import { shortcutLabel } from '../composables/shortcut';

const rootRef = ref<HTMLElement | null>(null);
/**
 * 宽度档位**只改展示层**：内部存储值仍是 33.33/55.55/66.66/77.77，不迁移、不改名，
 * 只把按钮文案换成「窄/标准/宽/特宽」并补上真实比例说明（PRD Q5 / R8-04）。
 */
const WIDTH_TIERS = [
  { ratio: 0.3333, name: '窄', pct: '33.33%' },
  { ratio: 0.5555, name: '标准', pct: '55.55%' },
  { ratio: 0.6666, name: '宽', pct: '66.66%' },
  { ratio: 0.7777, name: '特宽', pct: '77.77%' },
];

function tierOf(ratio: number): { name: string; pct: string } {
  const hit = WIDTH_TIERS.find(function (t) { return Math.abs(t.ratio - ratio) < 0.0001; });
  const pct = (Math.round(ratio * 10000) / 100) + '%';
  return hit ? { name: hit.name, pct: hit.pct } : { name: pct, pct: pct };
}

/**
 * 主题单选组的方向键: 选中即提交（"实时预览选中项"）。
 * roving tabindex 由模板的 :tabindex 控制，这里只负责移动焦点与提交。
 */
function onThemeKey(currentId: string, e: KeyboardEvent): void {
  const idx = THEMES.findIndex(function (t) { return t.id === currentId; });
  if (idx < 0) { return; }
  let next = idx;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { next = (idx + 1) % THEMES.length; }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { next = (idx - 1 + THEMES.length) % THEMES.length; }
  else if (e.key === 'Home') { next = 0; }
  else if (e.key === 'End') { next = THEMES.length - 1; }
  else { return; }
  e.preventDefault();
  const target = THEMES[next];
  choosePreset(target.id);
  const el = document.querySelector('[data-theme="' + target.id + '"]') as HTMLElement | null;
  if (el && typeof el.focus === 'function') { el.focus(); }
}

/**
 * Esc 分层: 三个下拉全关后本层才让位给"关面板"。
 * 每次关下拉都 restoreTheme()，避免留下未提交的预览色（R8-03）。
 */
function handleEscape(): boolean {
  if (festivalOpen.value) { festivalOpen.value = false; restoreTheme(); return true; }
  if (termOpen.value) { termOpen.value = false; restoreTheme(); return true; }
  if (provinceOpen.value) { provinceOpen.value = false; restoreTheme(); return true; }
  return false;
}

/**
 * 关闭面板时统一收尾（R8-03 / R8-06）：
 * 以前只有 provinceOpen 的 watcher 会 restoreTheme，于是"键盘聚焦色块 → Esc 关面板"
 * 这条路径会把**未提交的预览色**留在页面上：重开面板时高亮的是已保存主题，
 * 正文却还是预览色，两边错位。现在三个下拉 + settingsOpen 统一监听。
 *
 * 顺序很重要: 先关下拉(避免下拉的 watcher 再 restore 一次), 再 restoreTheme()。
 */
watch(function () { return state.settingsOpen; }, function (open) {
  if (open) { return; }
  provinceOpen.value = false;
  termOpen.value = false;
  festivalOpen.value = false;
  restoreTheme();
});

// 组件被卸载(切到别的浮层/换书)时同样不能留预览色
onBeforeUnmount(function () { restoreTheme(); });

defineExpose({ el: rootRef, handleEscape });

/** 当前选中省份(未启用地域主题时也回退到已选省, 便于预览) */
const provinceCode = computed(function () {
  const s = state.settings;
  return s ? s.province : '110000';
});

/** 省份/节气/节日列表展开状态(自绘下拉, 避免原生 select 的粗滚动条); 三者互斥 */
const provinceOpen = ref(false);
const termOpen = ref(false);
const festivalOpen = ref(false);

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

/** 手动可选节日: 只渲染日景(18 项), 夜场不出现在列表里(仅供自动切换) */
const FESTIVALS_DAYLIGHT = FESTIVALS.filter(function (f) { return !f.night; });

/** 节日按钮文案: 仅在正在使用节日主题时显示节日名, 否则为占位「节日色彩」 */
const festivalName = computed(function () {
  if (!state.settings || state.settings.theme !== 'festival') { return '节日色彩'; }
  const found = FESTIVALS.find(function (f) { return f.id === state.settings!.festival; });
  return found ? found.name : '节日色彩';
});

/** 悬浮预览节日(不落盘, 只改 CSS 变量) */
function previewFestival(id: string): void {
  previewTheme({ theme: 'festival', festival: id });
}

/** 选择节日: 同时切到「传统节日」主题 */
function chooseFestival(id: string): void {
  festivalOpen.value = false;
  // 先还原预览态, 再交给持久化后的正式设置接管, 避免预览变量残留
  restoreTheme();
  if (!id) { return; }
  persistSettings({ festival: id, theme: 'festival' });
}

/** 选择省份: 同时切到「地域色彩」主题 */
function chooseProvince(code: string): void {
  provinceOpen.value = false;
  // 先还原预览态, 再交给持久化后的正式设置接管, 避免预览变量残留
  restoreTheme();
  if (!code) { return; }
  persistSettings({ province: code, theme: 'province' });
}

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
  <section id="settingsPanel" ref="rootRef" class="settings-panel" :class="{ open: state.settingsOpen }"
    role="dialog" aria-modal="false" aria-labelledby="settingsPanelTitle">
    <div class="sp-head">
      <h2 class="sp-title" id="settingsPanelTitle" tabindex="-1">设置</h2>
      <span class="spacer"></span>
      <button class="popup-close" @click.stop="state.settingsOpen = false">关闭</button>
    </div>
    <div class="sp-row sp-row-theme">
      <span class="sp-label">阅读主题</span>
      <div class="sp-themes" @mouseleave="endPreview()">
        <!-- 主题预设是单选组: role=radiogroup/radio + 可见名称 + roving tabindex + 方向键 -->
        <div class="sp-theme-dots" role="radiogroup" aria-label="阅读主题">
          <button v-for="t in THEMES" :key="t.id" type="button" class="sp-dot" :data-theme="t.id"
            role="radio" :aria-checked="settings && settings.theme === t.id ? 'true' : 'false'"
            :aria-label="t.name" :title="t.name"
            :tabindex="settings && settings.theme === t.id ? 0 : -1"
            :style="{ '--sp-check': t.fg }"
            :class="{ active: settings && settings.theme === t.id }"
            @mouseenter="previewPreset(t.id)" @focus="previewPreset(t.id)"
            @keydown="onThemeKey(t.id, $event)"
            @click="choosePreset(t.id)">
            <span class="sp-dot-swatch" :style="{ background: t.bg, color: t.fg }"></span>
            <span class="sp-dot-name">{{ t.name }}</span>
          </button>
        </div>
        <!-- 第二行: 地域色彩 / 廿四节气 / 节日色彩 三个选择器(仍归属于「阅读主题」行) -->
        <div class="sp-theme-extra">
        <div class="sp-province-picker">
          <button class="sp-province-btn" :class="{ open: provinceOpen }"
            :title="settings && settings.theme === 'province' ? '当前使用地域色彩主题' : '选择省份后自动切换到地域色彩主题'"
            @click.stop="provinceOpen = !provinceOpen; termOpen = false; festivalOpen = false">
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
            @click.stop="termOpen = !termOpen; provinceOpen = false; festivalOpen = false">
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
        <!-- 传统节日: 列表只渲染日景 18 项(夜场仅供自动切换, 手动不可选) -->
        <div class="sp-province-picker" data-kind="festival">
          <button class="sp-province-btn" :class="{ open: festivalOpen }"
            :title="settings && settings.theme === 'festival' ? '当前使用传统节日主题' : '选择节日后自动切换到传统节日主题'"
            @click.stop="festivalOpen = !festivalOpen; provinceOpen = false; termOpen = false">
            <span>{{ festivalName }}</span>
            <svg class="sp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div v-if="festivalOpen" class="sp-province-menu sp-festival-menu" @mouseleave="endPreview()">
            <button v-for="f in FESTIVALS_DAYLIGHT" :key="f.id" class="sp-province-item"
              :class="{ active: settings && settings.theme === 'festival' && settings.festival === f.id }"
              :style="{ borderLeftColor: f.main.hex }" :title="f.name + ' · ' + f.main.name"
              @mouseenter="previewFestival(f.id)" @focus="previewFestival(f.id)"
              @click="chooseFestival(f.id)">{{ f.name }}</button>
          </div>
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
    <div class="sp-row">
      <span class="sp-label">章节切换</span>
      <div class="sp-seg">
        <button class="sp-seg-btn" :class="{ active: settings && settings.sideNavMode === 'always' }"
          title="正文两侧箭头常驻显示"
          @click="persistSettings({ sideNavMode: 'always' })">常驻</button>
        <button class="sp-seg-btn" :class="{ active: settings && settings.sideNavMode === 'hover' }"
          title="鼠标移到两侧箭头区域时才淡入（默认，不打扰阅读）"
          @click="persistSettings({ sideNavMode: 'hover' })">悬浮</button>
        <button class="sp-seg-btn" :class="{ active: settings && settings.sideNavMode === 'hidden' }"
          title="不显示两侧箭头：用底部「上一章/下一章」或键盘快捷键翻章"
          @click="persistSettings({ sideNavMode: 'hidden' })">隐藏</button>
      </div>
    </div>
    <!-- 页面宽度: 与「阅读主题」同构 —— 第一行比例档, 第二行自定义输入(标签只占第一行) -->
    <div class="sp-row sp-row-stack">
      <span class="sp-label">页面宽度</span>
      <div class="sp-stack-box">
        <div class="sp-seg">
          <button v-for="r in CONTENT_WIDTH.ratios" :key="r" class="sp-seg-btn"
            :class="{ active: curRatio === r }" :data-ratio="r" :data-width-tier="tierOf(r).name"
            :aria-pressed="curRatio === r ? 'true' : 'false'"
            :title="'视口宽度的 ' + tierOf(r).pct"
            @click="persistSettings({ widthRatio: r })">
            {{ tierOf(r).name }}<span class="sr-only">{{ '视口宽度的' + tierOf(r).pct }}</span>
          </button>
        </div>
        <div class="sp-width-custom">
          <label class="sr-only" for="spWidthInput">自定义宽度（{{ CONTENT_WIDTH.min }}–{{ CONTENT_WIDTH.max }} 像素）</label>
          <!-- 用 text + inputmode=numeric 而非 number: number 输入框不支持 select(), 聚焦无法全选 -->
          <input id="spWidthInput" ref="customInputRef" class="sp-width-input" type="text" inputmode="numeric"
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

<script setup lang="ts">
/**
 * SettingsPanel.vue — 设置面板(起点风格)
 * 面板定位(贴合悬浮球)由 App 协调, 本组件暴露根元素
 */
import { computed, ref, watch } from 'vue';
import { state, THEMES, PROVINCES, persistSettings, applyDailyTheme, requestDailyRefresh, stepFontSize, stepSetting, resetSettings } from '../store';
import { shortcutLabel } from '../composables/shortcut';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

/** 今日色(来自扩展下发的推导色板; 未取过则为空) */
const dailyColor = computed(function () {
  // 优先用扩展下发的原始色值(推导后的 accent 会被压暗, 不能当展示色)
  if (state.dailyInfo) { return state.dailyInfo; }
  return state.dailyTheme ? { name: state.dailyTheme.name, hex: state.dailyTheme.accent } : null;
});

/** 当前是否正在使用每日一色 */
const dailyFromText = computed(function () {
  const from = state.dailyInfo && state.dailyInfo.from;
  return from === 'remote' ? '今日色来自官网每日推荐' : '今日色来自本地轮换(官网不可用或未更新)';
});

const usingDaily = computed(function () {
  return !!state.settings && state.settings.theme === 'daily';
});

// 每天首次打开阅读设置时请求一次今日色(扩展侧按日期去重, 当天重复调用不会重复请求)
watch(function () { return state.settingsOpen; }, function (open) {
  if (open) { requestDailyRefresh(); }
});

/** 当前选中省份(未启用地域主题时也回退到已选省, 便于预览) */
const provinceCode = computed(function () {
  const s = state.settings;
  return s ? s.province : '110000';
});

/** 当前省份的色卡(用于下方小圆点预览) */
const provinceColors = computed(function () {
  const found = PROVINCES.find(function (p) { return p.code === provinceCode.value; });
  return found ? found.colors : [];
});

/** 切换省份: 同时切到「地域色彩」主题 */
function onProvinceChange(e: Event): void {
  const code = (e.target as HTMLSelectElement).value;
  if (!code) { return; }
  persistSettings({ province: code, theme: 'province' });
}

const widthSteps = [640, 800, 1000, 1200];
const fontOptions = [
  { id: 'heiti', name: '黑体' },
  { id: 'songti', name: '宋体' },
  { id: 'kaiti', name: '楷体' },
];

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
    <div class="sp-row">
      <span class="sp-label">阅读主题</span>
      <div class="sp-themes">
        <span v-for="t in THEMES" :key="t.id" class="sp-dot" :data-theme="t.id" :title="t.name"
          :style="{ background: t.id === 'dark' ? '#1c1c1c' : t.bg, color: t.fg, '--sp-check': t.fg }"
          :class="{ active: settings && settings.theme === t.id }"
          @click="persistSettings({ theme: t.id })"></span>
      </div>
    </div>
    <!-- 地域色彩: 34 个省级区域, 按该省色卡推导"可长时间阅读"的色板 -->
    <div class="sp-row">
      <span class="sp-label">地域色彩</span>
      <div class="sp-province">
        <select class="sp-select" :value="provinceCode" @change="onProvinceChange"
          :title="settings && settings.theme === 'province' ? '当前使用地域色彩主题' : '选择省份后自动切换到地域色彩主题'">
          <option v-for="p in PROVINCES" :key="p.code" :value="p.code">{{ p.name }}</option>
        </select>
        <span class="sp-province-colors">
          <i v-for="c in provinceColors" :key="c.hex + c.name" class="sp-color-chip"
            :style="{ background: c.hex }" :title="c.name + ' ' + c.hex"></i>
        </span>
      </div>
    </div>
    <!-- 每日一色: 每天首次自动同步官网(失败静默用本地), 点应用即用当日色做主题 -->
    <div class="sp-row">
      <span class="sp-label">每日一色</span>
      <div class="sp-daily">
        <i class="sp-daily-chip" :style="{ background: dailyColor ? dailyColor.hex : 'transparent' }"
          :title="dailyColor ? dailyColor.name + ' ' + dailyColor.hex : '尚未取色'"></i>
        <span class="sp-daily-name">{{ dailyColor ? dailyColor.name : '—' }}</span>
        <span class="sp-daily-hex">{{ dailyColor ? dailyColor.hex : '' }}</span>
        <span v-if="dailyColor" class="sp-daily-from" :title="dailyFromText">{{ dailyColor.from === 'remote' ? '官网' : '本地' }}</span>
        <span class="spacer"></span>
        <button class="sp-daily-apply" :class="{ active: usingDaily }"
          :disabled="usingDaily" @click="applyDailyTheme()">{{ usingDaily ? '已应用' : '应用' }}</button>
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
      <span class="sp-label">页面宽度</span>
      <div class="sp-seg">
        <button v-for="w in widthSteps" :key="w" class="sp-seg-btn"
          :class="{ active: settings && Number(settings.contentWidth) === w }"
          @click="persistSettings({ contentWidth: w })">{{ w }}</button>
      </div>
    </div>
    <button class="sp-reset" @click="resetSettings">恢复默认设置</button>
    <div class="settings-hint">{{ shortcutHintText }}</div>
  </section>
</template>

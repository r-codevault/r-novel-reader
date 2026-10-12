/**
 * register-local-extension.js — 在无法使用 VS Code CLI 的环境下, 手动注册本地扩展
 *
 * 背景:
 *   通过"解包 vsix 到 ~/.vscode/extensions/"的方式安装后, 若插件目录名(版本号)变更,
 *   extensions.json 里的旧条目会失配, 导致:
 *     1) 扩展被显示为"无效的扩展"(⚠)
 *     2) 卸载其他扩展触发 cleanUp 时, 本目录被写入 .obsolete, 下次重启会被删除
 *   本脚本把 extensions.json 条目对齐到当前目录, 并清除 .obsolete 误标。
 *
 * 用法: node scripts/register-local-extension.js [扩展目录名]
 *   默认: local.novel-reader-1.0.1 (从 package.json 自动拼接 publisher.name-version)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const extId = `${pkg.publisher}.${pkg.name}`;
const version = pkg.version;
const folderName = process.argv[2] || `${extId}-${version}`;

const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
const folderPath = path.join(extRoot, folderName);
const manifestPath = path.join(extRoot, 'extensions.json');
const obsoletePath = path.join(extRoot, '.obsolete');

if (!fs.existsSync(folderPath)) {
  console.error(`✗ 扩展目录不存在: ${folderPath}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(folderPath, 'package.json'))) {
  console.error(`✗ 目录里没有 package.json: ${folderPath}`);
  process.exit(1);
}

// ---- 备份 ----
fs.copyFileSync(manifestPath, `${manifestPath}.bak`);
if (fs.existsSync(obsoletePath)) {
  fs.copyFileSync(obsoletePath, `${obsoletePath}.bak`);
}

// ---- 对齐 extensions.json 条目 ----
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const idx = manifest.findIndex((e) => e.identifier && e.identifier.id === extId);
const uuid = (idx >= 0 && manifest[idx].identifier.uuid) || crypto.randomUUID();
const uriPath = `/${folderPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':')}`;

const entry = {
  identifier: { id: extId, uuid },
  version,
  location: { $mid: 1, path: uriPath, scheme: 'file' },
  relativeLocation: folderName,
  metadata: {
    installedTimestamp: Date.now(),
    pinned: false,
    source: 'vsix',
    id: uuid,
    publisherId: crypto.randomUUID(),
    targetPlatform: 'undefined',
    updated: false,
    private: false,
    isPreReleaseVersion: false,
    hasPreReleaseVersion: false,
  },
};

if (idx >= 0) {
  const old = manifest[idx];
  console.log(`· 更新条目: ${old.relativeLocation} (v${old.version}) -> ${folderName} (v${version})`);
  manifest[idx] = entry;
} else {
  console.log(`· 新增条目: ${extId} -> ${folderName}`);
  manifest.push(entry);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`✓ extensions.json 已更新 (共 ${manifest.length} 条)`);

// ---- 清理 .obsolete 误标(否则下次重启插件目录会被删除) ----
let obsolete = {};
if (fs.existsSync(obsoletePath)) {
  try {
    obsolete = JSON.parse(fs.readFileSync(obsoletePath, 'utf8')) || {};
  } catch {
    obsolete = {};
  }
}
if (Object.prototype.hasOwnProperty.call(obsolete, folderName)) {
  delete obsolete[folderName];
  console.log(`✓ 已从 .obsolete 移除误标: ${folderName}`);
}
fs.writeFileSync(obsoletePath, JSON.stringify(obsolete));

// ---- 结果校验 ----
const check = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).find(
  (e) => e.identifier && e.identifier.id === extId
);
console.log('\n当前清单条目:');
console.log(JSON.stringify(check, null, 2));
console.log('\n完成。重启 VS Code 后生效。');

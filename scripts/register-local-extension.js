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
// 改过 ID 的旧标识(需要清理旧目录/清单条目, 并迁移其 globalState)
const legacyIds = ['local.novel-reader'].filter((id) => id !== extId);
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
// 移除旧扩展 ID 的残留条目(否则 VS Code 会提示无效扩展)
if (legacyIds.length) {
  const beforeLen = manifest.length;
  for (let i = manifest.length - 1; i >= 0; i--) {
    const id = manifest[i].identifier && manifest[i].identifier.id;
    if (id && legacyIds.includes(id)) { manifest.splice(i, 1); }
  }
  if (manifest.length !== beforeLen) {
    console.log(`✓ 已移除旧扩展 ID 清单条目: ${legacyIds.join(', ')}`);
  }
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

// ---- 清理同扩展的旧版本目录(升级后残留的孤儿目录会被 VS Code 标记待删) ----
// 含「旧扩展 ID」目录: 改 ID(r-novel-reader) 后旧目录必须清掉
const stalePrefixes = [`${extId}-`, ...legacyIds.map((id) => `${id}-`)];
const staleDirs = fs
  .readdirSync(extRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && stalePrefixes.some((p) => d.name.startsWith(p)) && d.name !== folderName)
  .map((d) => d.name);
for (const stale of staleDirs) {
  fs.rmSync(path.join(extRoot, stale), { recursive: true, force: true });
  console.log(`✓ 已清理旧版本目录: ${stale}`);
  const ob = JSON.parse(fs.readFileSync(obsoletePath, 'utf8') || '{}');
  if (Object.prototype.hasOwnProperty.call(ob, stale)) {
    delete ob[stale];
    fs.writeFileSync(obsoletePath, JSON.stringify(ob));
  }
}

// ---- 旧扩展 ID 的 globalState 迁移(书架 / 阅读进度 / 阅读偏好) ----
// 状态按扩展 ID 分区, 改 ID 后不迁移会表现为"书架清空、进度丢失"
try {
  const { execFileSync } = require('child_process');
  const migrate = path.join(__dirname, 'migrate-state-id.js');
  if (fs.existsSync(migrate)) {
    const out = execFileSync(process.execPath, [migrate], { encoding: 'utf8' });
    process.stdout.write(out);
  }
} catch (err) {
  console.log(`· 状态迁移跳过: ${err instanceof Error ? err.message : String(err)}`);
}

// ---- 结果校验 ----
const check = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).find(
  (e) => e.identifier && e.identifier.id === extId
);
console.log('\n当前清单条目:');
console.log(JSON.stringify(check, null, 2));
console.log('\n完成。重启 VS Code 后生效。');

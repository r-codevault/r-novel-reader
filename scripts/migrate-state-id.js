/**
 * 迁移扩展 globalState: 旧扩展 ID 的记录 -> 新扩展 ID
 *
 * 背景: VS Code 的扩展全局状态(书架、阅读进度、阅读偏好)在 state.vscdb 里
 *       按「扩展 ID」分区存储, 改 package.json 的 name/publisher 会让新 ID
 *       "看不到"旧数据, 表现为书架清空、进度丢失。本脚本把旧行复制到新行。
 *
 * 用法:
 *   node scripts/migrate-state-id.js                 # 自动读 package.json 取新 ID
 *   node scripts/migrate-state-id.js --old=local.novel-reader
 *   node scripts/migrate-state-id.js --force         # 新 ID 已有记录时也覆盖
 *
 * 注意: 只在 VS Code 完全退出后运行, 才能保证迁移的是最新状态;
 *       运行中执行得到的是"当前快照", 之后新写入的进度不会带过来。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const newId = `${pkg.publisher}.${pkg.name}`;
const DEFAULT_OLD_ID = 'local.novel-reader';

const args = process.argv.slice(2);
const force = args.includes('--force');
const oldArg = args.find((a) => a.startsWith('--old='));
const oldId = oldArg ? oldArg.slice('--old='.length) : DEFAULT_OLD_ID;

/** 找到 state.vscdb(按当前平台列举常见位置) */
function findStateDb() {
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    for (const flavor of ['Code', 'Code - Insiders']) {
      candidates.push(path.join(appData, flavor, 'User', 'globalStorage', 'state.vscdb'));
    }
  } else if (process.platform === 'darwin') {
    for (const flavor of ['Code', 'Code - Insiders']) {
      candidates.push(path.join(os.homedir(), 'Library', 'Application Support', flavor, 'User', 'globalStorage', 'state.vscdb'));
    }
  } else {
    for (const flavor of ['Code', 'Code - Insiders']) {
      candidates.push(path.join(os.homedir(), '.config', flavor, 'User', 'globalStorage', 'state.vscdb'));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** 找一个可用的 python(用标准库 sqlite3 安全地改库, 避免手写 SQLite 页) */
function findPython() {
  const candidates = [
    'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'C:/Users/Administrator/AppData/Local/Programs/Python/Python312/python.exe',
    'python',
    'python3',
    'py',
  ];
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['-c', 'import sqlite3'], { stdio: 'ignore' });
      return exe;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

const PY_CODE = `
import sqlite3, sys
db, old, new, force = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
con = sqlite3.connect(db)
try:
    cur = con.cursor()
    row = cur.execute('SELECT value FROM ItemTable WHERE key = ?', (old,)).fetchone()
    if not row or row[0] is None:
        print('SKIP: 旧扩展 ID（%s）没有记录, 无需迁移' % old)
    else:
        cur2 = cur.execute('SELECT value FROM ItemTable WHERE key = ?', (new,)).fetchone()
        if cur2 and cur2[0] and not force:
            print('SKIP: 新扩展 ID（%s）已有记录, 未覆盖（需要覆盖请加 --force）' % new)
        else:
            cur.execute('INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)', (new, row[0]))
            con.commit()
            size = len(row[0]) if isinstance(row[0], (bytes, str)) else 0
            print('OK: 已迁移 %s -> %s（%d 字节）' % (old, new, size))
finally:
    con.close()
`;

function main() {
  const db = findStateDb();
  if (!db) {
    console.log('· 未找到 state.vscdb, 跳过状态迁移');
    return;
  }
  const python = findPython();
  if (!python) {
    console.log(`· 未找到 python, 无法自动迁移。请手动把 state.vscdb 里 key="${oldId}" 的记录复制给 key="${newId}"`);
    console.log(`  数据库: ${db}`);
    return;
  }
  const out = execFileSync(python, ['-c', PY_CODE, db, oldId, newId, force ? '1' : '0'], {
    encoding: 'utf8',
  });
  process.stdout.write('· 状态迁移: ' + out.trim() + '\n');
}

main();

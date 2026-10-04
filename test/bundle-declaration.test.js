// 真跑断言: 用宿主【真实的】bundlePatchPaths 解析本插件的 dsh.bundle 声明,
// 确认 (a) 不抛错, (b) 解析出的绝对路径确实指向仓库里的 cordis.patch.yml。
//
// 运行时路径从 ~/.dsh/start-dsh.ps1 的 $dshEntry 派生(本机硬规则: 禁止写死版本号),
// 派生不到就 skip —— 让没装 DSH 的人 clone 下来也能跑通测试套件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 从 start-dsh.ps1 的 $dshEntry 反推运行时 node_modules/@deepseek-ai 目录。 */
function deepseekModulesDir() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const start = join(home, '.dsh', 'start-dsh.ps1');
  if (!existsSync(start)) return null;
  const assignment = readFileSync(start, 'utf8').match(/^\s*\$dshEntry\s*=\s*(.+)$/m);
  if (assignment === null) return null;
  // 两种写法都要认(实测本机是第二种):
  //   $dshEntry = 'C:\...\node_modules\@deepseek-ai\dsh\lib\bin.js'
  //   $dshEntry = Join-Path $env:USERPROFILE '.dsh\runtime\...\@deepseek-ai\dsh\lib\bin.js'
  const quoted = assignment[1].match(/['"]([^'"]*@deepseek-ai[^'"]*)['"]/);
  if (quoted === null) return null;
  const entry = /^[A-Za-z]:/.test(quoted[1]) ? quoted[1] : join(home, quoted[1]);
  const marker = join('node_modules', '@deepseek-ai').replace(/\\/g, '/');
  const idx = entry.replace(/\\/g, '/').indexOf(marker);
  return idx === -1 ? null : entry.slice(0, idx + marker.length);
}

const modulesDir = deepseekModulesDir();
const appBoot = modulesDir === null ? null : join(modulesDir, 'dsh-app-boot', 'lib', 'index.js');
const available = appBoot !== null && existsSync(appBoot);

test('dsh.bundle.patch 声明被宿主正确解析', { skip: available ? false : '未找到 DSH 运行时' }, async () => {
  const { bundlePatchPaths } = await import(`file://${appBoot.replace(/\\/g, '/')}`);
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

  assert.ok(manifest.dsh?.bundle !== undefined, 'dsh.bundle 必须存在');
  assert.equal(typeof manifest.dsh.bundle.patch, 'string', 'dsh.bundle.patch 必须是字符串');

  const paths = bundlePatchPaths(pkgDir, manifest.dsh.bundle);
  assert.equal(paths.length, 1, '应恰好解析出 1 个 patch 文件');
  assert.equal(
    resolve(paths[0]),
    resolve(pkgDir, 'cordis.patch.yml'),
    '解析出的路径必须指向包内的 cordis.patch.yml',
  );
  assert.ok(existsSync(paths[0]), `patch 文件必须存在: ${paths[0]}`);

  const body = readFileSync(paths[0], 'utf8');
  assert.match(body, /^\s*-\s*insert:/m, 'patch 必须是 - insert: 形式');
  assert.ok(body.includes('name: dsh-plugin-codemode'), 'patch 必须插入 dsh-plugin-codemode 这一行');

  // 负例: 坏声明必须抛错, 证明走的是真实校验而不是空转
  assert.throws(() => bundlePatchPaths(pkgDir, { patch: 123 }), /must be a file path/);
});

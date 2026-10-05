// 页面“构建”：本站为零打包的原生 ES 模块静态站，
// 构建 = 结构校验 + 全部 JS 语法检查 + 汇总到 dist。
// 任一环节失败即以非零退出码交付。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site');
const distDir = join(root, 'dist');

let failures = 0;
const fail = (m) => { console.error('  ✘ ' + m); failures++; };
const ok = (m) => console.log('  ✔ ' + m);

console.log('[build] 1/3 结构与引用校验');
for (const f of ['index.html', 'styles.css', 'app.mjs', 'src/engine.mjs', 'src/bptree.mjs', 'src/store.mjs', 'src/digest.mjs']) {
  if (!existsSync(join(siteDir, f))) fail(`缺少文件 site/${f}`);
  else ok(`site/${f}`);
}
const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
for (const ref of ['./styles.css', './app.mjs']) {
  if (!html.includes(ref)) fail(`index.html 未引用 ${ref}`);
  else ok(`index.html -> ${ref}`);
}
const app = readFileSync(join(siteDir, 'app.mjs'), 'utf8');
for (const src of ['./src/engine.mjs', './src/store.mjs']) {
  if (!app.includes(src)) fail(`app.mjs 未导入 ${src}`);
}

console.log('[build] 2/3 JavaScript 语法检查（node --check）');
const walk = (d) => readdirSync(d).flatMap((name) => {
  const p = join(d, name);
  return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.mjs') ? [p] : []);
});
for (const f of [...walk(join(siteDir)), ...walk(join(root, 'verify'))]) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${f}\n${r.stderr}`);
  else ok(`syntax ${f.replace(root + '/', '')}`);
}

console.log('[build] 3/3 汇总到 dist/');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
cpSync(siteDir, distDir, { recursive: true });
ok('site -> dist');

if (failures) {
  console.error(`[build] 失败 ${failures} 项`);
  process.exit(1);
}
console.log('[build] 完成');

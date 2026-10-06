// verify 容器入口：规则测试 -> IDB 集成测试 -> 页面构建 -> 等待 web 健康 -> HTTP 冒烟。
// 全部通过以退出码 0 交付结论；任一失败立即非零退出。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, label) => new Promise((resolve) => {
  console.log(`\n=== ${label} ===`);
  const p = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
  p.on('close', (code) => resolve(code));
});

const BASE = process.env.BASE_URL ?? 'http://web';

let code = await run(process.execPath, [
  '--test',
  'verify/rules.test.mjs',
  'verify/idb.integration.test.mjs',
  'verify/concurrency.test.mjs',
  'verify/dom.test.mjs',
], '规则、IndexedDB 适配、并发回执一致性与页面控制层测试（node --test）');
if (code !== 0) process.exit(code);

code = await run(process.execPath, ['verify/build.mjs'], '页面构建');
if (code !== 0) process.exit(code);

// 等待 web 健康（depends_on healthy 已保证，这里再做应用层等待，幂等无害）
console.log(`\n=== 等待站点健康 ${BASE}/healthz ===`);
const deadline = Date.now() + 30000;
for (;;) {
  try {
    const res = await fetch(BASE + '/healthz');
    if (res.ok) { console.log('web 健康'); break; }
  } catch { /* 尚未起来 */ }
  if (Date.now() > deadline) {
    console.error('等待 web 健康超时');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}

code = await new Promise((resolve) => {
  console.log('\n=== HTTP 冒烟 ===');
  const p = spawn(process.execPath, ['verify/smoke.mjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, BASE_URL: BASE },
  });
  p.on('close', resolve);
});
if (code !== 0) process.exit(code);

console.log('\n✅ verify 全项通过：规则、分裂、阶段恢复、冲突重传、并发回执一致性、构建与 HTTP 冒烟');
process.exit(0);

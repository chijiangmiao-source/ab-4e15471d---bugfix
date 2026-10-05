// HTTP 冒烟：健康响应、页面与模块资源可达、404 行为。
// BASE_URL 由调用方给出（Compose 网内 http://web，本机 http://localhost:8080）。
const BASE = process.env.BASE_URL ?? 'http://localhost:8080';

let failures = 0;
async function check(name, path, { status = 200, includes } = {}) {
  const url = BASE.replace(/\/$/, '') + path;
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();
    const okStatus = res.status === status;
    const okBody = !includes || body.includes(includes);
    if (okStatus && okBody) {
      console.log(`  ✔ GET ${path} -> ${res.status}`);
    } else {
      failures++;
      console.error(`  ✘ GET ${path} -> ${res.status}（期望 ${status}）`
        + (includes && !okBody ? `，正文缺少 ${JSON.stringify(includes.slice(0, 60))}` : ''));
    }
  } catch (e) {
    failures++;
    console.error(`  ✘ GET ${path} 请求失败: ${e.message}`);
  }
}

console.log(`[smoke] 目标 ${BASE}`);
await check('healthz', '/healthz', { status: 200, includes: 'ok' });
await check('index', '/', { status: 200, includes: '离线航迹交换站' });
await check('styles', '/styles.css', { status: 200, includes: '.layout' });
await check('app', '/app.mjs', { status: 200, includes: 'Engine' });
await check('engine', '/src/engine.mjs', { status: 200, includes: 'CRASH_POINTS' });
await check('bptree', '/src/bptree.mjs', { status: 200, includes: 'ORDER' });
await check('digest', '/src/digest.mjs', { status: 200, includes: 'fnv1a64' });
await check('store', '/src/store.mjs', { status: 200, includes: 'indexedDB' });
await check('missing', '/no-such-track', { status: 404 });

if (failures) {
  console.error(`[smoke] 失败 ${failures} 项`);
  process.exit(1);
}
console.log('[smoke] 全部通过');

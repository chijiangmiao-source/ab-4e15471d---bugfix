// 64 位 FNV-1a 摘要：纯同步、无依赖，浏览器与 Node 行为一致。
// 用途：检测页内容损坏（意外位翻转 / 被篡改），非密码学抗碰撞需求。

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function fnv1a64(str) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    // 取 UTF-8 字节，保证中文载荷在任意平台摘要一致
    const code = str.codePointAt(i);
    if (code > 0xffff) i++;
    const bytes = code < 0x80 ? [code]
      : code < 0x800 ? [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
      : code < 0x10000 ? [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
      : [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
    for (const b of bytes) {
      hash ^= BigInt(b);
      hash = (hash * FNV_PRIME) & MASK;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

// 键排序的稳定 JSON，避免对象键顺序差异导致摘要漂移
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// 计算页摘要：地址 id 与摘要本身不参与（id 由内容寻址派生）
export function digestPage(page) {
  const { id, digest, ...body } = page;
  return fnv1a64(stableStringify(body));
}

export function verifyDigest(page) {
  if (!page || typeof page.digest !== 'string') return false;
  return digestPage(page) === page.digest;
}

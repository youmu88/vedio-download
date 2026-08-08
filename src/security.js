/**
 * SSRF 防护工具 — 字面量检测 + DNS 解析校验 + 重定向链校验
 *
 * 相比原来的 checkSsrf（只做字面量正则）：
 *  - 支持 IPv6 / IPv4-mapped IPv6
 *  - 对目标域名做 DNS 解析，拒绝解析到内网/回环地址
 *  - 可选校验 HTTP 重定向链（深度限制 3）
 *  - 供 index.js（入口 URL / 捕获到的流 URL）与 js-downloader（分片 URL）共用
 */

import dns from 'node:dns/promises';

const PRIVATE_V4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^169\.254\./,
];

/**
 * 规范化 hostname：去括号、小写、IPv4-mapped IPv6 → IPv4
 */
export function normalizeHost(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // ::ffff:a.b.c.d
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  return host;
}

/**
 * 判断单个 IP/主机名是否为内网/回环/链路本地地址（不做 DNS 解析）
 */
export function isPrivateHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;

  // IPv6
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
    // 其它 IPv6 地址不阻塞（公网 IPv6 正常使用）
    return false;
  }

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  for (const pattern of PRIVATE_V4_PATTERNS) {
    if (pattern.test(host)) return true;
  }
  return false;
}

/**
 * 判断 URL 是否指向内网/回环地址（仅字面量，无 DNS）
 */
export function hasPrivateLiteral(url) {
  try {
    const parsed = new URL(url);
    return isPrivateHost(parsed.hostname);
  } catch {
    return true; // 无法解析的 URL 一律视为不安全
  }
}

/**
 * 字面量校验，不合法/内网直接抛错
 */
export function assertPublicUrlLiteral(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('无效的 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`不支持的协议: ${parsed.protocol}`);
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`禁止下载内网地址: ${parsed.hostname}`);
  }
}

/**
 * 完整校验：字面量 + DNS 解析 + 可选重定向链
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.checkRedirects] 是否跟随 HEAD 检查重定向（默认 true，尽力而为）
 * @param {number} [opts.depth] 内部递归深度
 */
export async function assertPublicUrl(url, opts = {}) {
  const { checkRedirects = true, depth = 0 } = opts;
  if (depth > 3) throw new Error('重定向链过深，已终止校验');

  assertPublicUrlLiteral(url);

  const parsed = new URL(url);
  try {
    const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    for (const { address } of addresses) {
      if (isPrivateHost(address)) {
        throw new Error(`域名 ${parsed.hostname} 解析到内网地址: ${address}`);
      }
    }
  } catch (err) {
    if (err.message?.includes('解析到内网地址')) throw err;
    // DNS 解析失败：下载本来也无法进行，fail-closed
    throw new Error(`域名解析失败（${parsed.hostname}）: ${err.message}`);
  }

  // 重定向链校验（尽力而为：HEAD 不支持/超时不阻塞）
  if (checkRedirects && depth === 0) {
    try {
      const { default: fetch } = await import('node-fetch');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).finally(() => clearTimeout(timer));

      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) {
        const nextUrl = new URL(location, url).href;
        await assertPublicUrl(nextUrl, { checkRedirects: true, depth: depth + 1 });
      }
    } catch (err) {
      // HEAD 探测失败（405/超时等）不阻塞下载，实际下载链路仍会校验字面量与 DNS
      if (err.message?.includes('禁止下载') || err.message?.includes('解析到内网') || err.message?.includes('重定向链过深')) {
        throw err;
      }
    }
  }
}

/**
 * 校验流/分片 URL（只做字面量，避免对每个分片做 DNS 查询）
 */
export function assertStreamUrlLiteral(url) {
  assertPublicUrlLiteral(url);
}

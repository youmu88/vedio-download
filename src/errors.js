/**
 * 错误分类 — 区分“临时性错误（值得自动重试）”与“永久性错误（重试无意义）”
 *
 * 原则：
 *  - 网络抖动、超时、服务端 5xx、解析失败 → transient，走自动重试
 *  - HTTP 4xx、非法 URL、磁盘不足、完整性校验失败 → permanent，直接判死
 */

const PERMANENT_PATTERNS = [
  /HTTP\s+4\d\d/i,
  /状态码\s+4\d\d/i,
  /\b4(?:0[134]|04)\b/,           // 401/403/404
  /非法的/i,
  /磁盘空间不足/i,
  /完整性校验失败/i,
  /DRM|受保护的内容|Widevine/i,
  /永久/i,
];

/**
 * 分类错误
 * @param {string|Error} error
 * @returns {'permanent'|'transient'}
 */
export function classifyError(error) {
  const message = String(error?.message || error || '');
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(message)) return 'permanent';
  }
  return 'transient';
}

/**
 * 是否为永久性错误（重试无意义）
 */
export function isPermanentError(error) {
  return classifyError(error) === 'permanent';
}

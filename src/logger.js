/**
 * 结构化日志系统 — 基于 pino
 *
 * 解决设计文档 P2-9「日志与监控增强」：
 * - JSON 格式结构化输出
 * - 每条日志包含：timestamp、taskId、level、message、context
 * - 支持文件输出和 stdout 双写
 * - 支持日志级别动态控制
 *
 * @module logger
 */

import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE = path.join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10)}.log`);

// 文件传输流
const fileTransport = pino.transport({
  target: 'pino/file',
  options: { destination: LOG_FILE, mkdir: true },
});

// 控制台传输流（美化输出）
const consoleTransport = pino.transport({
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
    ignore: 'pid,hostname',
  },
});

/**
 * 创建带 taskId 上下文的 logger 实例
 *
 * @param {object} [defaultBindings] - 默认绑定字段，如 { taskId, module }
 * @returns {object} pino logger 实例
 *
 * @example
 *   const log = createLogger({ module: 'downloader' });
 *   log.info({ taskId: 'xxx' }, '开始下载');
 */
export function createLogger(defaultBindings = {}) {
  const logger = pino(
    {
      level: LOG_LEVEL,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    pino.multistream([
      { stream: consoleTransport },
      { stream: fileTransport },
    ])
  );

  if (Object.keys(defaultBindings).length > 0) {
    return logger.child(defaultBindings);
  }

  return logger;
}

// 默认 logger 实例
const logger = createLogger({ module: 'app' });

/**
 * 创建带 taskId 上下文的子 logger
 * @param {string} taskId
 * @param {string} [moduleName]
 * @returns {object}
 */
export function taskLogger(taskId, moduleName = 'task') {
  return logger.child({ taskId, module: moduleName });
}

export default logger;
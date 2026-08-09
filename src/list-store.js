/**
 * 列表存储 — 公开列表 + 私密列表 + 私密密码
 *
 * ⭐ 持久化方案：SQLite 数据库（node:sqlite，WAL 模式）
 *   data/vd.db → 表 lists（列表 + 条目 JSON）+ 表 private_pass（scrypt 密码摘要）
 *
 * 选择 SQLite 而非 JSON 文件的原因：
 *   - 事务性写入：每次变更原子落盘，崩溃/断电不损坏、不丢失
 *   - WAL 模式：读写在独立日志中提交，天然抗损坏
 *   - 单文件：备份/迁移简单，且不依赖"文件恰好存在"的脆弱假设
 *   - 旧 JSON（lists.json/private-pass.json）首次启动自动迁移导入
 *
 * 私密列表默认不可见：listAll() 仅返回公开列表；
 * 私密列表通过 token 访问（验证密码后签发，默认 30 分钟有效，内存存储）。
 *
 * 使用方式：
 *   import listStore from './list-store.js';
 *   listStore.create('我的收藏');                 // 创建公开列表
 *   listStore.create('隐藏清单', true, token);     // 创建私密列表（需 token）
 *   listStore.setPassword('1234');                // 首次设置密码
 *   listStore.verifyPassword('1234');             // → { token, expiresAt }
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ⭐ 数据目录支持环境变量覆盖：测试/隔离环境可用 VD_DATA_DIR 指向独立目录，避免污染真实数据
const DATA_DIR = process.env.VD_DATA_DIR ? path.resolve(process.env.VD_DATA_DIR) : path.resolve(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'vd.db');
// 旧 JSON 文件：仅用于首次迁移（历史数据导入）
const LEGACY_LISTS_FILE = path.join(DATA_DIR, 'lists.json');
const LEGACY_PASS_FILE = path.join(DATA_DIR, 'private-pass.json');

const TOKEN_TTL_MS = 30 * 60 * 1000; // token 有效期 30 分钟
const PIN_RE = /^(\d{4}|\d{6})$/;    // 4 位或 6 位数字密码

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

class ListStore {
  constructor() {
    this.tokens = new Map(); // token → { expiresAt }
    ensureDataDir();
    this.db = new DatabaseSync(DB_FILE);
    this._initSchema();
    this._importLegacy();
  }

  // ═══════════════════════════════════════════
  // 数据库初始化
  // ═══════════════════════════════════════════

  _initSchema() {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        items TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS private_pass (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `);
  }

  /** 旧 JSON 数据迁移导入（仅首次执行，DB 为空列表且旧文件存在时） */
  _importLegacy() {
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM lists').get().n;
      if (count > 0) return; // 已有数据，不覆盖
      // 迁移列表
      if (fs.existsSync(LEGACY_LISTS_FILE)) {
        try {
          const raw = JSON.parse(fs.readFileSync(LEGACY_LISTS_FILE, 'utf-8'));
          if (raw && Array.isArray(raw.lists) && raw.lists.length) {
            const ins = this.db.prepare('INSERT INTO lists (id, name, is_private, created_at, items) VALUES (?,?,?,?,?)');
            for (const l of raw.lists) {
              if (!l || !l.id) continue;
              try {
                ins.run(l.id, String(l.name || '').slice(0, 40), l.private ? 1 : 0, l.createdAt || new Date().toISOString(), JSON.stringify(l.items || []));
              } catch (_) {}
            }
            console.log(`[ListStore] 已从旧 JSON 迁移 ${raw.lists.length} 个列表`);
          }
        } catch (err) {
          console.error('[ListStore] 旧列表 JSON 解析失败（跳过迁移）:', err.message);
        }
      }
      // 迁移私密密码
      if (fs.existsSync(LEGACY_PASS_FILE)) {
        try {
          const { salt, hash } = JSON.parse(fs.readFileSync(LEGACY_PASS_FILE, 'utf-8'));
          if (salt && hash && typeof salt === 'string' && typeof hash === 'string' && hash.length >= 64) {
            this.db.prepare('INSERT OR REPLACE INTO private_pass (id, salt, hash) VALUES (1,?,?)').run(salt, hash);
            console.log('[ListStore] 已从旧 JSON 迁移私密密码');
          }
        } catch (err) {
          console.error('[ListStore] 旧密码 JSON 解析失败（跳过迁移）:', err.message);
        }
      }
    } catch (err) {
      console.error('[ListStore] 旧数据迁移失败:', err.message);
    }
  }

  // ═══════════════════════════════════════════
  // 内部读写（SQLite 事务性落盘）
  // ═══════════════════════════════════════════

  _rowToList(r) {
    if (!r) return null;
    let items = [];
    try { items = JSON.parse(r.items || '[]'); } catch (_) {}
    return {
      id: r.id,
      name: r.name,
      private: !!r.is_private,
      createdAt: r.created_at,
      items: Array.isArray(items) ? items : [],
    };
  }

  _allRows() {
    return this.db.prepare('SELECT * FROM lists').all().map((r) => this._rowToList(r));
  }

  _upsert(list) {
    this.db.prepare('INSERT OR REPLACE INTO lists (id, name, is_private, created_at, items) VALUES (?,?,?,?,?)')
      .run(list.id, list.name, list.private ? 1 : 0, list.createdAt, JSON.stringify(list.items || []));
  }

  _getPass() {
    return this.db.prepare('SELECT salt, hash FROM private_pass WHERE id = 1').get() || null;
  }

  // ═══════════════════════════════════════════
  // 列表查询
  // ═══════════════════════════════════════════

  /** 公开列表（私密列表默认不可见） */
  listAll() {
    return this._allRows()
      .filter((l) => !l.private)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /** 私密列表（需 token 验证） */
  listPrivate(token) {
    this._requireToken(token);
    return this._allRows()
      .filter((l) => l.private)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /** 是否有私密列表（供前端显示锁图标） */
  hasPrivateList() {
    return this._allRows().some((l) => l.private);
  }

  /**
   * 所有列表（含私密）中的条目文件名集合
   * 用于浏览页过滤：已加入列表的视频不再直接可见
   */
  allItemNames() {
    const set = new Set();
    for (const l of this._allRows()) {
      for (const i of l.items) set.add(i.name);
    }
    return set;
  }

  /** 条目是否已存在于任何列表 */
  isListed(name) {
    return this.allItemNames().has(name);
  }

  get(id) {
    return this._rowToList(this.db.prepare('SELECT * FROM lists WHERE id = ?').get(id));
  }

  // ═══════════════════════════════════════════
  // 列表 CRUD（每次变更立即事务落盘）
  // ═══════════════════════════════════════════

  /**
   * 创建列表
   * @param {string} name 列表名称
   * @param {boolean} [isPrivate] 是否私密（默认 false）
   * @param {string} [token] 创建私密列表时必须携带有效 token
   * @returns {{id: string, name: string, private: boolean}}
   */
  create(name, isPrivate = false, token = null) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('列表名称不能为空');
    if (isPrivate) this._requireToken(token);
    const list = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: clean,
      private: !!isPrivate,
      createdAt: new Date().toISOString(),
      items: [],
    };
    this._upsert(list);
    return list;
  }

  /**
   * 删除列表（私密列表需 token）
   */
  remove(id, token = null) {
    const list = this.get(id);
    if (!list) return false;
    if (list.private) this._requireToken(token);
    this.db.prepare('DELETE FROM lists WHERE id = ?').run(id);
    return true;
  }

  /**
   * 向列表添加条目（按视频文件名，重复自动去重）
   * @param {string[]} names 视频文件名数组
   */
  addItems(id, names, token = null) {
    const list = this.get(id);
    if (!list) throw new Error('列表不存在');
    if (list.private) this._requireToken(token);
    if (!Array.isArray(names) || names.length === 0) throw new Error('缺少视频条目');
    const exist = new Set(list.items.map((i) => i.name));
    const now = new Date().toISOString();
    for (const name of names) {
      const clean = String(name || '').trim();
      if (!clean || exist.has(clean)) continue;
      list.items.push({ name: clean, size: null, mtime: null, addedAt: now });
      exist.add(clean);
    }
    this._upsert(list);
    return list;
  }

  /**
   * 从列表移除条目
   */
  removeItems(id, names, token = null) {
    const list = this.get(id);
    if (!list) throw new Error('列表不存在');
    if (list.private) this._requireToken(token);
    if (!Array.isArray(names) || names.length === 0) throw new Error('缺少视频条目');
    const drop = new Set(names.map((n) => String(n).trim()));
    list.items = list.items.filter((i) => !drop.has(i.name));
    this._upsert(list);
    return list;
  }

  // ═══════════════════════════════════════════
  // 私密密码（4/6 位数字，SQLite 存储）
  // ═══════════════════════════════════════════

  hasPassword() {
    const p = this._getPass();
    // 内容无效（缺字段）时视为未设置，避免进入验证分支后永远报密码错误
    if (!p || !p.salt || !p.hash || typeof p.salt !== 'string' || typeof p.hash !== 'string' || p.hash.length < 64) {
      return false;
    }
    return true;
  }

  /**
   * 首次设置密码（4 位或 6 位数字）
   */
  setPassword(pin) {
    if (!PIN_RE.test(String(pin || ''))) {
      throw new Error('密码需为 4 位或 6 位数字');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
    this.db.prepare('INSERT OR REPLACE INTO private_pass (id, salt, hash) VALUES (1,?,?)').run(salt, hash);
  }

  /**
   * 验证密码；正确则签发 token
   * @returns {{ token: string, expiresAt: number }}
   */
  verifyPassword(pin) {
    if (!this.hasPassword()) throw new Error('尚未设置私密密码');
    const p = this._getPass();
    if (!p) throw new Error('密码验证失败');
    const expected = Buffer.from(p.hash, 'hex');
    const actual = crypto.scryptSync(String(pin || ''), p.salt, 64);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new Error('密码错误');
    }
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.tokens.set(token, { expiresAt });
    // 定期清理过期 token，防止 Map 无限增长
    this._sweepTokens();
    return { token, expiresAt };
  }

  /**
   * 修改密码（需已持有有效 token，先验证旧密码）
   */
  changePassword(token, oldPin, newPin) {
    this._requireToken(token);
    const p = this._getPass();
    if (!p) throw new Error('密码验证失败');
    const expected = Buffer.from(p.hash, 'hex');
    const actual = crypto.scryptSync(String(oldPin || ''), p.salt, 64);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new Error('原密码错误');
    }
    this.setPassword(newPin);
  }

  /** 公开校验 token（供路由层调用，抛错即无效） */
  verifyToken(token) {
    return this._requireToken(token);
  }

  /** 校验 token 有效性 */
  _requireToken(token) {
    const t = this.tokens.get(String(token || ''));
    if (!t || t.expiresAt < Date.now()) {
      if (t) this.tokens.delete(token);
      throw new Error('私密验证已过期，请重新输入密码');
    }
    return true;
  }

  _sweepTokens() {
    const now = Date.now();
    for (const [token, t] of this.tokens) {
      if (t.expiresAt < now) this.tokens.delete(token);
    }
  }
}

export default new ListStore();
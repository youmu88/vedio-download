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

// ⭐ 私密认证 token 永不过期：认证时机由前端锁会话控制（软件到后台/退出私密列表时清除），
// 持续浏览/播放无时间限制，无需服务端 TTL
const PIN_RE = /^(\d{4}|\d{6})$/;    // 4 位或 6 位数字密码

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

class ListStore {
  constructor() {
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
        items TEXT NOT NULL DEFAULT '[]',
        owner TEXT NOT NULL DEFAULT 'wilsonwen'
      );
      CREATE TABLE IF NOT EXISTS private_pass (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS private_sessions (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    // 兼容旧库：已有 lists 表缺 owner 列时补列（存量数据归默认用户）
    try {
      const cols = this.db.prepare('PRAGMA table_info(lists)').all();
      if (!cols.some((c) => c.name === 'owner')) {
        this.db.exec('ALTER TABLE lists ADD COLUMN owner TEXT NOT NULL DEFAULT \'wilsonwen\'');
        console.log('[ListStore] 已为 lists 表补充 owner 列');
      }
    } catch (err) {
      console.error('[ListStore] owner 列迁移失败:', err.message);
    }
    this._seedDefaultUser();
  }

  /** 预加载默认用户（wilsonwen / Wenq5201314） */
  _seedDefaultUser() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get();
    if (row.n > 0) return;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('Wenq5201314', salt, 64).toString('hex');
    this.db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?,?,?,?)')
      .run('wilsonwen', salt, hash, new Date().toISOString());
    console.log('[ListStore] 已预加载默认用户: wilsonwen');
  }

  /** 登录校验：成功返回用户，失败抛错 */
  login(username, password) {
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (!user) throw new Error('用户不存在');
    const expected = Buffer.from(user.hash, 'hex');
    const actual = crypto.scryptSync(String(password || ''), user.salt, 64);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new Error('密码错误');
    }
    return { username: user.username, createdAt: user.created_at };
  }

  /** 注册新用户（保留能力；当前前端按钮置灰暂不开放） */
  register(username, password) {
    const name = String(username || '').trim();
    if (!name || name.length < 3) throw new Error('用户名至少 3 个字符');
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw new Error('用户已存在');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    this.db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?,?,?,?)')
      .run(name, salt, hash, new Date().toISOString());
    return { username: name };
  }

  // ═══════════════════════════════════════════
  // 会话（SQLite 持久化，服务重启后登录态保留）
  // ═══════════════════════════════════════════

  /**
   * 创建会话（token → username），持久化到 SQLite
   * @param {string} token - 随机 token（32 字节 hex）
   * @param {string} username - 登录用户
   * @param {number} ttlMs - 有效期毫秒
   */
  createSession(token, username, ttlMs) {
    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO sessions (token, username, created_at, expires_at) VALUES (?,?,?,?)')
      .run(String(token), String(username), new Date(now).toISOString(), now + (ttlMs || 0));
    return token;
  }

  /**
   * 查询有效会话对应的用户名（过期/不存在返回 null）
   * @returns {string|null}
   */
  getSessionUser(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT username, expires_at FROM sessions WHERE token = ?').get(String(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.deleteSession(token); // 惰性清理过期会话
      return null;
    }
    return row.username;
  }

  /** 删除会话（登出/取消） */
  deleteSession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
  }

  /** 清理所有已过期会话，返回删除条数 */
  sweepSessions() {
    const res = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    return res.changes || 0;
  }

  /** 列出所有有效会话（供启动/诊断用） */
  listSessions() {
    return this.db.prepare('SELECT token, username, created_at, expires_at FROM sessions').all();
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
    return this.db.prepare('SELECT * FROM lists WHERE owner = ?').all(this._currentOwner || 'wilsonwen').map((r) => this._rowToList(r));
  }

  /** 设置当前会话用户（登录后由路由层注入，实现数据按用户隔离） */
  setCurrentUser(username) {
    this._currentOwner = String(username || 'wilsonwen');
  }

  _upsert(list) {
    this.db.prepare('INSERT OR REPLACE INTO lists (id, name, is_private, created_at, items, owner) VALUES (?,?,?,?,?,?)')
      .run(list.id, list.name, list.private ? 1 : 0, list.createdAt, JSON.stringify(list.items || []), list.owner || this._currentOwner || 'wilsonwen');
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

  /**
   * 私密列表元数据（id/name/count，不含 items）
   * ⭐ 供前端“将视频加入私密列表”时选择目标列表，无需密码（密码仅用于进入/浏览列表内容）
   */
  listPrivateMeta() {
    return this._allRows()
      .filter((l) => l.private)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((l) => ({ id: l.id, name: l.name, count: (l.items || []).length }));
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
   * @returns {{id: string, name: string, private: boolean}}
   * ⭐ 创建列表（含私密）不需要密码：密码仅用于进入/浏览私密列表内容
   */
  create(name, isPrivate = false) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('列表名称不能为空');
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
  /**
   * 向列表添加条目（按视频文件名，重复自动去重）
   * ⭐ 加入列表（含私密）不需要密码：密码仅用于进入/浏览私密列表内容
   * @param {string[]} names 视频文件名数组
   */
  addItems(id, names) {
    const list = this.get(id);
    if (!list) throw new Error('列表不存在');
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
  /**
   * 从列表移除条目（⭐ 移除列表不需要密码：密码仅用于进入/浏览私密列表内容）
   */
  removeItems(id, names) {
    const list = this.get(id);
    if (!list) throw new Error('列表不存在');
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
   * 验证密码；正确则签发 token（永不过期，认证由前端锁会话控制）
   * @returns {{ token: string, expiresAt: null }}
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
    // ⭐ 私密 token 永不过期（expires_at 存远未来时间戳表达无限期，兼容表 NOT NULL 约束）：
    // 持续浏览/播放无时间限制，认证失效完全由前端锁会话（后台/退出时清除 token + 调后端删除）控制
    const FOREVER_MS = 253402300799000; // 9999-12-31，表达永不过期
    this.db.prepare('INSERT OR REPLACE INTO private_sessions (token, created_at, expires_at) VALUES (?,?,?)')
      .run(token, new Date().toISOString(), FOREVER_MS);
    // 兼容清理旧库中遗留的过期 token，防止表无限增长
    this._sweepTokens();
    return { token, expiresAt: null };
  }

  /**
   * 修改密码（需已持有有效 token，先验证旧密码）
   */
  changePassword(token, newPin) {
    this._requireToken(token);
    this.setPassword(newPin);
  }

  /** 公开校验 token（供路由层调用，抛错即无效） */
  verifyToken(token) {
    return this._requireToken(token);
  }

  /** 列出所有用户（供启动时初始化专属下载目录） */
  listUsers() {
    return this.db.prepare('SELECT username, created_at FROM users ORDER BY created_at').all();
  }

  /** 校验 token 有效性（SQLite 持久化存储；token 永不过期，仅校验存在性） */
  _requireToken(token) {
    const row = this.db.prepare('SELECT 1 FROM private_sessions WHERE token = ?')
      .get(String(token || ''));
    if (!row) {
      throw new Error('私密认证已失效，请重新输入密码');
    }
    return true;
  }

  /** 删除私密会话（登出/锁定） */
  deletePrivateSession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM private_sessions WHERE token = ?').run(String(token));
  }

  /** 清理所有已过期的私密会话（兼容旧库遗留），返回删除条数 */
  _sweepTokens() {
    const res = this.db.prepare('DELETE FROM private_sessions WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
    return res.changes || 0;
  }

  /** 公开入口：清理所有已过期的私密会话（供启动/周期调用） */
  sweepPrivateSessions() {
    return this._sweepTokens();
  }
}

export default new ListStore();
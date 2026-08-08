/**
 * 列表存储 — 公开列表 + 私密列表 + 私密密码
 *
 * 数据文件：
 *   data/lists.json        → { lists: [{ id, name, private, createdAt, items: [{ name, size, mtime, addedAt }] }] }
 *   data/private-pass.json → { salt, hash }（scrypt 哈希，仅存 4/6 位数字 PIN 的摘要）
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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const LISTS_FILE = path.join(DATA_DIR, 'lists.json');
const PASS_FILE = path.join(DATA_DIR, 'private-pass.json');

const TOKEN_TTL_MS = 30 * 60 * 1000; // token 有效期 30 分钟
const PIN_RE = /^(\d{4}|\d{6})$/;    // 4 位或 6 位数字密码

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

class ListStore {
  constructor() {
    this.lists = [];       // 全部列表（含私密）
    this.tokens = new Map(); // token → { expiresAt }
    ensureDataDir();
    this._load();
  }

  // ═══════════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════════

  _load() {
    try {
      if (!fs.existsSync(LISTS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(LISTS_FILE, 'utf-8'));
      if (raw && Array.isArray(raw.lists)) this.lists = raw.lists;
    } catch (err) {
      console.error('[ListStore] 列表加载失败:', err.message);
    }
  }

  _save() {
    try {
      const tmpFile = `${LISTS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify({ lists: this.lists }, null, 2), 'utf-8');
      fs.renameSync(tmpFile, LISTS_FILE);
    } catch (err) {
      console.error('[ListStore] 列表保存失败:', err.message);
    }
  }

  // ═══════════════════════════════════════════
  // 列表 CRUD
  // ═══════════════════════════════════════════

  /** 公开列表（私密列表默认不可见） */
  listAll() {
    return this.lists
      .filter((l) => !l.private)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /** 私密列表（需 token 验证） */
  listPrivate(token) {
    this._requireToken(token);
    return this.lists
      .filter((l) => l.private)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /** 是否有私密列表（供前端显示锁图标） */
  hasPrivateList() {
    return this.lists.some((l) => l.private);
  }

  get(id) {
    return this.lists.find((l) => l.id === id) || null;
  }

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
    this.lists.push(list);
    this._save();
    return list;
  }

  /**
   * 删除列表（私密列表需 token）
   */
  remove(id, token = null) {
    const list = this.get(id);
    if (!list) return false;
    if (list.private) this._requireToken(token);
    this.lists = this.lists.filter((l) => l.id !== id);
    this._save();
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
    this._save();
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
    this._save();
    return list;
  }

  // ═══════════════════════════════════════════
  // 私密密码（4/6 位数字）
  // ═══════════════════════════════════════════

  hasPassword() {
    try {
      return fs.existsSync(PASS_FILE);
    } catch {
      return false;
    }
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
    ensureDataDir();
    fs.writeFileSync(PASS_FILE, JSON.stringify({ salt, hash }, null, 2), 'utf-8');
  }

  /**
   * 验证密码；正确则签发 token
   * @returns {{ token: string, expiresAt: number }}
   */
  verifyPassword(pin) {
    if (!this.hasPassword()) throw new Error('尚未设置私密密码');
    try {
      const { salt, hash } = JSON.parse(fs.readFileSync(PASS_FILE, 'utf-8'));
      const expected = Buffer.from(hash, 'hex');
      const actual = crypto.scryptSync(String(pin || ''), salt, 64);
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw new Error('密码错误');
      }
    } catch (err) {
      if (err.message === '密码错误') throw err;
      throw new Error('密码验证失败');
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
    // 复用 verifyPassword 校验旧密码（不签发新 token）
    const { salt, hash } = JSON.parse(fs.readFileSync(PASS_FILE, 'utf-8'));
    const expected = Buffer.from(hash, 'hex');
    const actual = crypto.scryptSync(String(oldPin || ''), salt, 64);
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

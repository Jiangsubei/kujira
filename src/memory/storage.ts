/**
 * kujira: Memory 存储管理器
 * 管理 .dsh/kujira/memory/ 下的单聊 Session 记忆与 User Profile 纯 Markdown 文件读写。
 * 两层记忆均以当前单聊 `peer` 为物理主键，严禁跨会话复用或 default.md 兜底。
 */

import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, atomicWriteFileSync } from '../utils/atomic-write.js';
import { DEFAULT_MEMORY_DIR } from '../constants/index.js';
import { encodeSegment, resolveDshPath } from '../utils/path.js';

const KUJIRA_SESSION_ID_PREFIX_REGEX =
  /^kujira-user-([0-9a-zA-Z_]+?)(?:-r\d+)?(?:-\d+)?(?:-[0-9a-fA-F]{4,16})?$/;

export class MemoryStorage {
  private baseDir: string;
  private dshHome?: string;
  private sessionCache: Map<string, string> = new Map();
  private userCache: Map<string, string> = new Map();
  private updateLocks: Map<string, Promise<void>> = new Map();

  constructor(storageDir?: string, dshHome?: string) {
    this.dshHome = dshHome;
    this.baseDir = resolveDshPath(this.dshHome, storageDir, DEFAULT_MEMORY_DIR);
  }

  public setBaseDir(storageDir?: string, dshHome?: string): void {
    if (dshHome) {
      this.dshHome = dshHome;
    }
    this.baseDir = resolveDshPath(this.dshHome, storageDir, DEFAULT_MEMORY_DIR);
    this.invalidateCache();
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public invalidateCache(key?: string): void {
    if (key) {
      const normalized = this.normalizePeerKey(key);
      if (normalized) {
        this.sessionCache.delete(normalized);
        this.userCache.delete(normalized);
      }
      this.sessionCache.delete(key);
      this.userCache.delete(key);
    } else {
      this.sessionCache.clear();
      this.userCache.clear();
    }
  }

  /**
   * 归一化记忆主键：
   * - `kujira-user-<hash>[-r<round>-<version>[-<hash>]]` 归一化为 `user_<hash>`
   * - 其余非空键保留原始大小写与字符语义，交由 `encodeSegment` 安全编码
   */
  private normalizePeerKey(raw?: string): string {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) {
      return '';
    }
    const sessionMatch = KUJIRA_SESSION_ID_PREFIX_REGEX.exec(trimmed);
    if (sessionMatch) {
      return `user_${sessionMatch[1]!}`;
    }
    return trimmed;
  }

  private requireNormalizedKey(raw?: string): string {
    const key = this.normalizePeerKey(raw);
    if (!key) {
      throw new Error('Memory peer key cannot be empty');
    }
    return key;
  }

  public getSessionMemoryPath(peer: string): string {
    const key = this.requireNormalizedKey(peer);
    return path.join(this.baseDir, 'session', `${encodeSegment(key)}.md`);
  }

  public getUserProfilePath(peer: string): string {
    const key = this.requireNormalizedKey(peer);
    return path.join(this.baseDir, 'user', `${encodeSegment(key)}.md`);
  }

  // ==================== 异步读写方法 ====================

  public async readSessionMemory(peer: string): Promise<string> {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return '';
    }
    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key)!;
    }
    const filePath = this.getSessionMemoryPath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.sessionCache.set(key, content);
      return content;
    } catch {
      return '';
    }
  }

  public async writeSessionMemory(peer: string, content: string): Promise<void> {
    const key = this.requireNormalizedKey(peer);
    const filePath = this.getSessionMemoryPath(key);
    await atomicWriteFile(filePath, content);
    this.sessionCache.set(key, content);
  }

  /**
   * 线程安全 CAS / 原子更新 Session 记忆
   */
  public async updateSessionMemory(
    peer: string,
    updater: (current: string) => Promise<string> | string
  ): Promise<{ success: boolean; content: string; error?: string }> {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return { success: false, content: '', error: 'Memory peer key cannot be empty' };
    }
    const lockKey = `session:${key}`;
    const prevLock = this.updateLocks.get(lockKey) || Promise.resolve();
    let releaseLock!: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.updateLocks.set(lockKey, newLock);

    try {
      await prevLock;
      const current = await this.readSessionMemory(key);
      const updated = await updater(current);
      await this.writeSessionMemory(key, updated);
      return { success: true, content: updated };
    } catch (err: any) {
      return { success: false, content: '', error: err?.message || String(err) };
    } finally {
      releaseLock();
      if (this.updateLocks.get(lockKey) === newLock) {
        this.updateLocks.delete(lockKey);
      }
    }
  }

  public async readSessionMemoryRaw(peer: string): Promise<string> {
    return this.readSessionMemory(peer);
  }

  public async existsSessionMemory(peer: string): Promise<boolean> {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return false;
    }
    const filePath = this.getSessionMemoryPath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async readUserProfileRaw(peer: string): Promise<string> {
    return this.readUserProfile(peer);
  }

  public async existsUserProfile(peer: string): Promise<boolean> {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return false;
    }
    const filePath = this.getUserProfilePath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async readUserProfile(peer: string): Promise<string> {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return '';
    }
    if (this.userCache.has(key)) {
      return this.userCache.get(key)!;
    }
    const filePath = this.getUserProfilePath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim().length > 0) {
        this.userCache.set(key, content);
        return content;
      }
      return '';
    } catch {
      return '';
    }
  }

  public async writeUserProfile(peer: string, content: string): Promise<void> {
    const key = this.requireNormalizedKey(peer);
    const filePath = this.getUserProfilePath(key);
    await atomicWriteFile(filePath, content);
    this.userCache.set(key, content);
  }

  /**
   * 线程安全 CAS / 原子更新 User Profile
   */
  public async updateUserProfile(
    peer: string,
    updater: (current: string) => Promise<string> | string
  ): Promise<{ success: boolean; content: string; error?: string }> {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return { success: false, content: '', error: 'Memory peer key cannot be empty' };
    }
    const lockKey = `user:${key}`;
    const prevLock = this.updateLocks.get(lockKey) || Promise.resolve();
    let releaseLock!: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.updateLocks.set(lockKey, newLock);

    try {
      await prevLock;
      const current = await this.readUserProfile(key);
      const updated = await updater(current);
      await this.writeUserProfile(key, updated);
      return { success: true, content: updated };
    } catch (err: any) {
      return { success: false, content: '', error: err?.message || String(err) };
    } finally {
      releaseLock();
      if (this.updateLocks.get(lockKey) === newLock) {
        this.updateLocks.delete(lockKey);
      }
    }
  }

  // ==================== 同步读写方法 (供 System Prompt 同步组装) ====================

  public readSessionMemorySync(peer: string): string {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return '';
    }
    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key)!;
    }
    const filePath = this.getSessionMemoryPath(key);
    try {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      this.sessionCache.set(key, content);
      return content;
    } catch {
      return '';
    }
  }

  public writeSessionMemorySync(peer: string, content: string): void {
    const key = this.requireNormalizedKey(peer);
    const filePath = this.getSessionMemoryPath(key);
    atomicWriteFileSync(filePath, content);
    this.sessionCache.set(key, content);
  }

  public readUserProfileSync(peer: string): string {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return '';
    }
    if (this.userCache.has(key)) {
      return this.userCache.get(key)!;
    }
    const filePath = this.getUserProfilePath(key);
    try {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      if (content.trim().length > 0) {
        this.userCache.set(key, content);
        return content;
      }
      return '';
    } catch {
      return '';
    }
  }

  public writeUserProfileSync(peer: string, content: string): void {
    const key = this.requireNormalizedKey(peer);
    const filePath = this.getUserProfilePath(key);
    atomicWriteFileSync(filePath, content);
    this.userCache.set(key, content);
  }

  /**
   * 单独提取当前单聊 Session 规则与长程记忆快照（全量注入）
   */
  public getSessionRulesSnapshotSync(peer: string): string {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return '';
    }
    const sessionMemory = this.readSessionMemorySync(key).trim();
    if (!sessionMemory) {
      return '';
    }
    if (sessionMemory.startsWith('#')) {
      return sessionMemory;
    }
    return `### Session 记忆（${key}）\n${sessionMemory}`;
  }

  /**
   * 单独提取当前单聊用户画像快照（全量读取当前 peer，严禁跨会话兜底）
   */
  public getUserProfilesSnapshotSync(peer: string): string {
    const key = this.normalizePeerKey(peer);
    if (!key) {
      return '';
    }
    const profile = this.readUserProfileSync(key).trim();
    if (!profile) {
      return '';
    }
    if (profile.startsWith('#')) {
      return profile;
    }
    return `### 用户画像\n${profile}`;
  }

  /**
   * 组装单聊 System Prompt 动态记忆上下文快照（Session 规则 + 用户画像全量注入）
   */
  public getPromptSnapshotSync(peer: string): string {
    const rules = this.getSessionRulesSnapshotSync(peer);
    const profiles = this.getUserProfilesSnapshotSync(peer);

    const parts: string[] = [];
    if (rules) parts.push(rules);
    if (profiles) parts.push(profiles);
    return parts.join('\n\n').trim();
  }
}

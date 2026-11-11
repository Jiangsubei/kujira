/**
 * tests/contract/path-anchoring.test.ts
 *
 * 契约测试: Memory 存储目录、媒体下载与 Workspace 工作区路径的绝对路径锚定
 *
 * 核心契约:
 * 1. 当 process.cwd() 位于任意与 dshHome 毫无关系的临时工作目录时，
 *    MemoryStorage 的 getBaseDir() 必须严格基于 dshHome 展开，绝不污染当前进程 cwd；
 * 2. 相对路径（如 .dsh/kujira/memory 或 kujira/memory）传入时，
 *    必须正确剥离前导 .dsh/ 并以 dshHome 为基准展开；绝对路径传入时保留；
 * 3. SessionManager 的 resolveCwd() 与工作区注册逻辑必须严格锚定在 dshHome 内，
 *    绝对不使用 process.cwd()；
 * 4. 真实生产装配闭环 (bootDshKujira):
 *    在模拟的非 dshHome 目录启动时，挂载插件后能正确从 dshHome/kujira/memory
 *    读取既有的 Session 记忆与 User Profile 并注入动态 Prompt，且当前进程工作目录下绝不产生 .dsh 污染。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';
import { setupMemoryService } from '../../src/memory/index.js';
import { encodeSegment } from '../../src/utils/path.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';
import { SessionManager } from '../../src/gateway/session.js';
import { bootDshKujira, resolveDshHome, type BootedDsh } from '../../src/boot.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { MediaStorageManager } from '../../src/storage/media.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);

describe('契约测试: Memory 与 Workspace 绝对路径锚定 (Path Anchoring Contract)', () => {
  let originalCwd: string;
  let originalDshHome: string | undefined;
  let arbitraryCwd: string;
  let customDshHome: string;
  let booted: BootedDsh | null = null;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDshHome = process.env.DSH_HOME;

    arbitraryCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'arbitrary-run-dir-'));
    customDshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'custom-dsh-home-'));

    process.chdir(arbitraryCwd);
    process.env.DSH_HOME = customDshHome;
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }

    process.chdir(originalCwd);
    if (originalDshHome !== undefined) {
      process.env.DSH_HOME = originalDshHome;
    } else {
      delete process.env.DSH_HOME;
    }

    if (arbitraryCwd) {
      await fsp.rm(arbitraryCwd, { recursive: true, force: true }).catch(() => {});
    }
    if (customDshHome) {
      await fsp.rm(customDshHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('契约 1: MemoryStorage 路径绝对锚定', () => {
    it('无参构造函数必须默认锚定在 dshHome/kujira/memory，绝不指向 process.cwd()', () => {
      const storage = new MemoryStorage();
      const expectedDir = path.resolve(customDshHome, 'kujira/memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
      expect(path.isAbsolute(storage.getBaseDir())).toBe(true);
    });

    it('传入相对路径 .dsh/kujira/memory 时正确剥离前导并锚定在 dshHome 下', () => {
      const storage = new MemoryStorage('.dsh/kujira/memory', customDshHome);
      const expectedDir = path.resolve(customDshHome, 'kujira/memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
    });

    it('传入相对路径 kujira/memory 时正确锚定在 dshHome 下', () => {
      const storage = new MemoryStorage('kujira/memory', customDshHome);
      const expectedDir = path.resolve(customDshHome, 'kujira/memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
    });

    it('传入绝对路径时保持绝对路径不变', () => {
      const customAbsolute = path.resolve(os.tmpdir(), 'some-absolute-storage');
      const storage = new MemoryStorage(customAbsolute, customDshHome);

      expect(storage.getBaseDir()).toBe(customAbsolute);
    });

    it('setBaseDir 也严格遵循 dshHome 绝对锚定规则', () => {
      const storage = new MemoryStorage();
      storage.setBaseDir('.dsh/custom_memory', customDshHome);
      const expectedDir = path.resolve(customDshHome, 'custom_memory');

      expect(storage.getBaseDir()).toBe(expectedDir);
      expect(storage.getBaseDir().startsWith(arbitraryCwd)).toBe(false);
    });
  });

  describe('契约 2: SessionManager Workspace 路径绝对锚定', () => {
    it('SessionManager.resolveCwd() 始终锚定在 dshHome/workspace/kujira，绝不污染 process.cwd()', () => {
      const mockCtx: any = {
        get: () => undefined,
        logger: () => ({ debug: () => {}, warn: () => {}, error: () => {} }),
      };
      const sessionManager = new SessionManager(mockCtx, customDshHome);
      const resolvedCwd = sessionManager.resolveCwd(MOCK_PEER);
      const expectedCwd = path.resolve(customDshHome, 'workspace/kujira');

      expect(resolvedCwd).toBe(expectedCwd);
      expect(resolvedCwd.startsWith(arbitraryCwd)).toBe(false);
      expect(path.isAbsolute(resolvedCwd)).toBe(true);
    });

    it('SessionManager.registerWorkspace 必须在 dshHome 目录下创建物理工作区，当前工作区绝不产生目录', async () => {
      let createdPath = '';
      const mockWorkspaceRegistry = {
        create: async (cwd: string) => {
          createdPath = cwd;
          return { attachSession: async () => {} };
        },
      };
      const mockCtx: any = {
        get: (name: string) => (name === 'workspaceRegistry' ? mockWorkspaceRegistry : undefined),
        logger: () => ({ debug: () => {}, warn: () => {}, error: () => {} }),
      };

      const sessionManager = new SessionManager(mockCtx, customDshHome);
      await sessionManager.registerWorkspace(sessionManager.resolveCwd());

      expect(createdPath).toBe(path.resolve(customDshHome, 'workspace/kujira'));
      expect(fs.existsSync(path.resolve(customDshHome, 'workspace/kujira'))).toBe(true);
      expect(fs.existsSync(path.resolve(arbitraryCwd, '.dsh'))).toBe(false);
    });
  });

  describe('契约 3: 真实装配闭环 - bootDshKujira 下 Memory 动态注入与零工作区污染', () => {
    it('在独立进程 cwd 启动时，插件正确从 dshHome 读取记忆并注入 Prompt，cwd 绝无 .dsh 污染', async () => {
      // 1. 在 customDshHome 下准备真实的记忆目录与文件
      const memSessionDir = path.resolve(customDshHome, 'kujira/memory/session');
      const memUserDir = path.resolve(customDshHome, 'kujira/memory/user');
      await fsp.mkdir(memSessionDir, { recursive: true });
      await fsp.mkdir(memUserDir, { recursive: true });

      const testSessionContent =
        `# Session 记忆（${MOCK_PEER}）\n\n### 单聊规则\n- 本会话是技术研发交流，严禁灌水`;
      const testUserProfile =
        `# 用户画像（${MOCK_PEER}）\n\n### 特征\n- 资深架构师，关注绝对路径与安全性`;

      await fsp.writeFile(path.join(memSessionDir, `${MOCK_PEER}.md`), testSessionContent, 'utf-8');
      await fsp.writeFile(path.join(memUserDir, `${MOCK_PEER}.md`), testUserProfile, 'utf-8');

      // 2. 在 customDshHome 的 SQLite 数据库中写入消息记录
      const dbDir = path.resolve(customDshHome, 'kujira');
      await fsp.mkdir(dbDir, { recursive: true });
      const db = new MessageDatabase(path.join(dbDir, 'messages.sqlite'));
      db.init();
      db.saveMessage({
        msg_id: 'msg-anchor-001',
        peer: MOCK_PEER,
        user_id: MOCK_OPENID,
        sender_name: '架构师小张',
        time: Date.now() - 5000,
        type: 'text',
        content: '路径锚定测试消息',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });
      db.close();

      // 3. 启动 DSH 装配并挂载 Kujira 插件
      booted = await bootDshKujira({
        dshHome: customDshHome,
        mountPlugin: true,
        config: {},
      });

      const ctx = booted.ctx;
      const systemPrompt = ctx.get('systemPrompt') || (ctx as any).systemPrompt;
      expect(systemPrompt).toBeDefined();

      // 4. 断言 Prompt 动态注入正确读取 customDshHome 下的记忆与画像 (独立快照通道)
      const snapshotManager = (ctx as any).snapshotManager;
      expect(snapshotManager).toBeDefined();

      const preStepResult = await snapshotManager.handlePreStep({
        agent: { session: { id: MOCK_SESSION_ID } },
      });
      const injectedTexts = (preStepResult?.messages || [])
        .map((m: any) => m.content?.[0]?.text || '')
        .join('\n');

      expect(injectedTexts).toContain('本会话是技术研发交流，严禁灌水');
      expect(injectedTexts).toContain('资深架构师，关注绝对路径与安全性');

      // 5. 验证真实装配下，messages.sqlite 位于 customDshHome/kujira 下，绝不在 workspace/kujira 下
      expect(fs.existsSync(path.resolve(customDshHome, 'kujira/messages.sqlite'))).toBe(true);
      expect(fs.existsSync(path.resolve(customDshHome, 'workspace/kujira/messages.sqlite'))).toBe(false);

      // 6. 严格验证 arbitraryCwd 绝无任何 .dsh 目录生成或被污染
      const arbitraryDshDir = path.resolve(arbitraryCwd, '.dsh');
      expect(fs.existsSync(arbitraryDshDir)).toBe(false);
    });
  });

  describe('契约 4: MediaStorageManager 路径绝对锚定与隔离验证', () => {
    it('显式传入 dshHome 时 downloadRoot 必须严格基于 dshHome 展开，绝不使用 process.cwd()', () => {
      const media = new MediaStorageManager({ dshHome: customDshHome });
      const expectedDir = path.resolve(customDshHome, 'kujira/downloads');

      expect(media.downloadRoot).toBe(expectedDir);
      expect(media.downloadRoot.startsWith(arbitraryCwd)).toBe(false);
      expect(path.isAbsolute(media.downloadRoot)).toBe(true);
    });

    it('未显式传参时根据 process.env.DSH_HOME 自动锚定在 customDshHome 下', () => {
      const media = new MediaStorageManager();
      const expectedDir = path.resolve(customDshHome, 'kujira/downloads');

      expect(media.downloadRoot).toBe(expectedDir);
      expect(media.downloadRoot.startsWith(arbitraryCwd)).toBe(false);
      expect(path.isAbsolute(media.downloadRoot)).toBe(true);
    });

    it('传入相对路径 downloadDir（含 .dsh/ 前缀或普通相对路径）时正确剥离并锚定在 dshHome 下', () => {
      const media1 = new MediaStorageManager({ downloadDir: '.dsh/custom_download', dshHome: customDshHome });
      expect(media1.downloadRoot).toBe(path.resolve(customDshHome, 'custom_download'));
      expect(media1.downloadRoot.startsWith(arbitraryCwd)).toBe(false);

      const media2 = new MediaStorageManager({ downloadDir: 'custom_download', dshHome: customDshHome });
      expect(media2.downloadRoot).toBe(path.resolve(customDshHome, 'custom_download'));
      expect(media2.downloadRoot.startsWith(arbitraryCwd)).toBe(false);
    });

    it('传入绝对路径 downloadDir 时保持该绝对路径', () => {
      const absPath = path.resolve(os.tmpdir(), 'abs-media-download');
      const media = new MediaStorageManager({ downloadDir: absPath, dshHome: customDshHome });
      expect(media.downloadRoot).toBe(absPath);
    });

    it('saveBuffer 物理落盘严格保存在 dshHome 目录内，进程工作目录绝无污染', async () => {
      const media = new MediaStorageManager({ dshHome: customDshHome });
      const testBuffer = Buffer.from('path-anchoring-test-image-content');
      const result = await media.saveBuffer(testBuffer, {
        type: 'image',
        sessionId: MOCK_PEER,
        filename: 'test.png',
      });

      expect(result.localPath.startsWith(customDshHome)).toBe(true);
      expect(result.localPath.startsWith(arbitraryCwd)).toBe(false);
      expect(fs.existsSync(result.localPath)).toBe(true);
      expect(fs.existsSync(path.resolve(arbitraryCwd, '.dsh'))).toBe(false);
      expect(fs.readdirSync(arbitraryCwd).length).toBe(0);
    });
  });

  describe('契约 5: setupMemoryService 物理存储与 dshHome 绝对锚定', () => {
    it('setupMemoryService 初始化时 MemoryStorage 自动继承规范化的 effectiveDshHome', () => {
      const mockCtx: any = {
        get: () => undefined,
        logger: () => ({ warn: () => {} }),
      };
      const svc = setupMemoryService(mockCtx, { dshHome: customDshHome });

      expect((svc.storage as any).dshHome).toBe(path.resolve(customDshHome));
      expect(path.isAbsolute((svc.storage as any).dshHome)).toBe(true);
      svc.dispose();
    });
  });

  describe('契约 6: MessageDatabase 路径防御性绝对化', () => {
    it('构造函数传入相对路径时自动转换为绝对路径', () => {
      const dbRel = new MessageDatabase('relative-messages.sqlite');
      expect(path.isAbsolute(dbRel.dbPath)).toBe(true);
      expect(dbRel.dbPath).toBe(path.resolve(arbitraryCwd, 'relative-messages.sqlite'));
    });

    it('传入 customDshHome 下的路径并初始化，物理数据库严格在 dshHome 内', () => {
      const dbPath = path.resolve(customDshHome, 'kujira/messages.sqlite');
      const db = new MessageDatabase(dbPath);
      expect(db.dbPath).toBe(dbPath);

      db.init();
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(path.resolve(arbitraryCwd, '.dsh'))).toBe(false);
      db.close();
    });
  });

  describe('契约 7: boot.ts resolveDshHome 规范化与锚定防御', () => {
    it('resolveDshHome 传入相对路径时返回规范化的绝对路径', () => {
      const resolvedRel = resolveDshHome('./relative-dsh-home');
      expect(path.isAbsolute(resolvedRel)).toBe(true);
      expect(resolvedRel).toBe(path.resolve('./relative-dsh-home'));
    });

    it('resolveDshHome 在 process.env.DSH_HOME 存在时返回规范化的绝对路径', () => {
      const resolvedEnv = resolveDshHome();
      expect(path.isAbsolute(resolvedEnv)).toBe(true);
      expect(resolvedEnv).toBe(path.resolve(customDshHome));
    });
  });

  describe('契约 8: encodeSegment 路径转义契约（对齐 DSH 0.2.x 规范）', () => {
    it('空字符串抛出异常', () => {
      expect(() => encodeSegment('')).toThrow('cannot encode an empty path segment');
    });

    it('. 与 .. 正确转义', () => {
      expect(encodeSegment('.')).toBe('~002E');
      expect(encodeSegment('..')).toBe('~002E~002E');
    });

    it('常规字符保持原样', () => {
      expect(encodeSegment('session-123_abc.log')).toBe('session-123_abc.log');
    });

    it('特殊字符与波浪号正确转义为 ~XXXX', () => {
      expect(encodeSegment('kujira-user-abc:456')).toBe('kujira-user-abc~003A456');
      expect(encodeSegment('user@host~1')).toBe('user~0040host~007E1');
    });
  });
});

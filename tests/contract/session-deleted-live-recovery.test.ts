import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { SessionManager } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer } from '../../src/utils/peer.js';

const PEER_14 = openidToPeer('10000000000000000000000000000014');
const PEER_15 = openidToPeer('10000000000000000000000000000015');
const PEER_16 = openidToPeer('10000000000000000000000000000016');
const OPENID_17 = '10000000000000000000000000000017';
const PEER_17 = openidToPeer(OPENID_17);

describe('契约测试: 运行期物理删除会话后的僵尸句柄自动淘汰与新会话恢复 (Live Deletion & Zombie Handle Eviction)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-live-deletion-'));
  });

  afterEach(async () => {
    if (db) {
      db.close();
      db = null;
    }
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: isSessionPhysicallyPresent 必须以真实物理日志文件为准，严禁因内存持有 handle 或空目录而误判为存在', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const agent = await sessionManager.getOrCreateAgent(PEER_14);
    const sid = agent.session.id;
    await (booted.ctx as any).sessions.flush(agent.session);

    expect(sessionManager.hasActiveHandle(sid)).toBe(true);
    expect(sessionManager.isSessionPhysicallyPresent(sid)).toBe(true);

    const baseSessionsDir = path.join(tmpHome, 'sessions');
    if (fs.existsSync(baseSessionsDir)) {
      const dirs = fs.readdirSync(baseSessionsDir);
      for (const d of dirs) {
        const p = path.join(baseSessionsDir, d, sid);
        if (fs.existsSync(p)) {
          await fsp.rm(p, { recursive: true, force: true });
        }
      }
    }

    expect(sessionManager.isSessionPhysicallyPresent(sid)).toBe(false);

    const dummyDir = path.join(tmpHome, 'sessions', '--test--', sid);
    await fsp.mkdir(dummyDir, { recursive: true });
    expect(sessionManager.isSessionPhysicallyPresent(sid)).toBe(false);

    await sessionManager.dispose();
  });

  it('契约 2: 运行期物理删除会话后无需重启 DSH，再次调用 getOrCreateAgent 自动淘汰僵尸句柄并创建全新物理会话', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const agent1 = await sessionManager.getOrCreateAgent(PEER_15);
    const sid1 = agent1.session.id;
    await (booted.ctx as any).sessions.flush(agent1.session);
    expect(sessionManager.hasActiveHandle(sid1)).toBe(true);

    const baseSessionsDir = path.join(tmpHome, 'sessions');
    if (fs.existsSync(baseSessionsDir)) {
      const dirs = fs.readdirSync(baseSessionsDir);
      for (const d of dirs) {
        const p = path.join(baseSessionsDir, d, sid1);
        if (fs.existsSync(p)) {
          await fsp.rm(p, { recursive: true, force: true });
        }
      }
    }

    const agent2 = await sessionManager.getOrCreateAgent(PEER_15);
    const sid2 = agent2.session.id;

    await (booted.ctx as any).sessions.flush(agent2.session);
    expect(sessionManager.isSessionPhysicallyPresent(sid2)).toBe(true);
    expect(sessionManager.hasActiveHandle(sid2)).toBe(true);

    await sessionManager.dispose();
  });

  it('契约 3: Archive Manager 广播 api-session/removed 事件时，SessionManager 立即清除内存句柄与 SQLite 状态', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const agent = await sessionManager.getOrCreateAgent(PEER_16);
    const sid = agent.session.id;
    await (booted.ctx as any).sessions.flush(agent.session);

    expect(sessionManager.hasActiveHandle(sid)).toBe(true);
    expect(sessionManager.peerToSessionId(PEER_16)).toBe(sid);
    const dbStateBefore = db.getSessionState(PEER_16);
    expect(dbStateBefore?.current_session_id).toBe(sid);

    (booted.ctx as any).emit('api-session/removed', sid);
    await new Promise((res) => setTimeout(res, 50));

    expect(sessionManager.hasActiveHandle(sid)).toBe(false);
    const dbStateAfter = db.getSessionState(PEER_16);
    expect(dbStateAfter?.current_session_id).toBe('');

    const newSid = sessionManager.peerToSessionId(PEER_16);
    expect(newSid).not.toBe(sid);

    await sessionManager.dispose();
  });

  it('契约 4: 外部删除会话后，新消息通过 dispatchWakeup 能够顺利创建新会话应答，绝不回退到被删会话', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const msg1 = await sessionManager.dispatchWakeup({
      peer: PEER_17,
      content: '你好',
      trigger: 'direct',
      from_user: OPENID_17,
      from_name: '测试用户',
      timestamp: Date.now(),
    });
    expect(msg1).toBeDefined();
    const oldSid = sessionManager.peerToSessionId(PEER_17);
    const oldAgent = sessionManager.getAgent(oldSid);
    expect(oldAgent).toBeDefined();
    await (booted.ctx as any).sessions.flush(oldAgent!.session);

    const baseSessionsDir = path.join(tmpHome, 'sessions');
    if (fs.existsSync(baseSessionsDir)) {
      const dirs = fs.readdirSync(baseSessionsDir);
      for (const d of dirs) {
        const p = path.join(baseSessionsDir, d, oldSid);
        if (fs.existsSync(p)) {
          await fsp.rm(p, { recursive: true, force: true });
        }
      }
    }
    (booted.ctx as any).emit('api-session/removed', oldSid);
    await new Promise((res) => setTimeout(res, 50));

    const msg2 = await sessionManager.dispatchWakeup({
      peer: PEER_17,
      content: '新的一天',
      trigger: 'direct',
      from_user: OPENID_17,
      from_name: '测试用户',
      timestamp: Date.now(),
    });
    expect(msg2).toBeDefined();

    const activeSid = sessionManager.peerToSessionId(PEER_17);
    expect(activeSid).not.toBe(oldSid);

    const activeAgent = sessionManager.getAgent(activeSid);
    expect(activeAgent).toBeDefined();
    await (booted.ctx as any).sessions.flush(activeAgent!.session);
    expect(sessionManager.isSessionPhysicallyPresent(activeSid)).toBe(true);

    await sessionManager.dispose();
  });
});

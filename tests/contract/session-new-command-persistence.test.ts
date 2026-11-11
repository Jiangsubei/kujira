import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { SessionManager, formatSessionTitle, parseSessionId } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer } from '../../src/utils/peer.js';
import type { WakeupPayload } from '../../src/types/index.js';

const OPENID = '10000000000000000000000000000001';
const PEER = openidToPeer(OPENID);

describe('契约测试：QQ /新建 命令版本自增与未落盘新会话消息路由防回退', () => {
  let tmpHome: string;
  let db: MessageDatabase | undefined;
  let booted: BootedDsh | undefined;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-new-sid-'));
  });

  afterEach(async () => {
    try {
      if (db) {
        db.close();
        db = undefined;
      }
      if (booted) {
        await booted.dispose();
        booted = undefined;
      }
    } catch {}
    try {
      await fsp.rm(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: 当前会话一无论是否落盘，执行 markSessionCleared 必须生成版本 2，严禁重复生成版本 1', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const a1 = await sessionManager.getOrCreateAgent(PEER);
    const s1Id = a1.session.id;
    const parsed1 = parseSessionId(s1Id);
    expect(parsed1?.version).toBe(1);
    expect(formatSessionTitle(PEER, s1Id)).toContain('#1');

    const clearedPeer = sessionManager.markSessionCleared(s1Id);
    expect(clearedPeer).toBe(PEER);

    const a2 = await sessionManager.getOrCreateAgent(PEER);
    const s2Id = a2.session.id;
    const parsed2 = parseSessionId(s2Id);
    expect(parsed2?.version).toBe(2);
    expect(s2Id).not.toBe(s1Id);
    expect(formatSessionTitle(PEER, s2Id)).toContain('#2');

    await sessionManager.dispose();
  });

  it('契约 2: 刚通过 agents.create 创建的新会话在尚未落盘期间，后续消息不被误杀，不回退到旧会话', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const a1 = await sessionManager.getOrCreateAgent(PEER);
    await (booted.ctx as any).sessions.flush(a1.session);
    const s1Id = a1.session.id;

    sessionManager.markSessionCleared(PEER);

    const a2 = await sessionManager.getOrCreateAgent(PEER);
    const s2Id = a2.session.id;
    expect(s2Id).not.toBe(s1Id);

    const a2Second = await sessionManager.getOrCreateAgent(PEER);
    expect(a2Second.session.id).toBe(s2Id);
    expect(sessionManager.peerToSessionId(PEER)).toBe(s2Id);

    await sessionManager.dispose();
  });

  it('契约 3: dispatchWakeup 端到端唤醒流下，/新建 后的消息必须锁定新会话 ID 与标题 #2，严禁回退旧会话 #1', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const sessionTitleSvc = booted.ctx.get('sessionTitle') || (booted.ctx as any).sessionTitle;
    const renameCalls: string[] = [];
    if (sessionTitleSvc && typeof sessionTitleSvc.rename === 'function') {
      const origRename = sessionTitleSvc.rename.bind(sessionTitleSvc);
      sessionTitleSvc.rename = vi.fn().mockImplementation((session: any, title: string) => {
        renameCalls.push(title);
        return origRename(session, title);
      });
    }

    const p1: WakeupPayload = {
      peer: PEER,
      trigger: 'direct',
      from_user: OPENID,
      from_name: '测试用户B',
      content: '早上好',
      timestamp: Date.now(),
    };
    await sessionManager.dispatchWakeup(p1);
    const s1Id = sessionManager.peerToSessionId(PEER);
    expect(parseSessionId(s1Id)?.version).toBe(1);

    sessionManager.markSessionCleared(s1Id);

    vi.spyOn(sessionManager, 'isSessionPhysicallyPresent').mockImplementation((sid: string) => {
      if (sid === s1Id) return true;
      return false;
    });

    const p2: WakeupPayload = {
      peer: PEER,
      trigger: 'direct',
      from_user: OPENID,
      from_name: '测试用户B',
      content: '早上晚',
      timestamp: Date.now(),
    };
    await sessionManager.dispatchWakeup(p2);

    const s2Id = sessionManager.peerToSessionId(PEER);
    const parsed2 = parseSessionId(s2Id);
    expect(parsed2?.version).toBe(2);
    expect(s2Id).not.toBe(s1Id);

    const lastRenameTitle = renameCalls[renameCalls.length - 1];
    expect(lastRenameTitle).toContain('#2');
    expect(lastRenameTitle).not.toContain('#1');

    const p3: WakeupPayload = {
      peer: PEER,
      trigger: 'quote',
      from_user: OPENID,
      from_name: '测试用户B',
      content: '那就晚上早',
      timestamp: Date.now(),
    };
    await sessionManager.dispatchWakeup(p3);
    expect(sessionManager.peerToSessionId(PEER)).toBe(s2Id);

    await sessionManager.dispose();
  });
});

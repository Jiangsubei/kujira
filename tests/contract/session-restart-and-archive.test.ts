import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import {
  SessionManager,
  formatFallbackSessionTitle,
  formatSessionVersionTag,
  parseSessionId,
} from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer, openidToSessionBaseId, extractPeerHash } from '../../src/utils/peer.js';

const OPENID_1 = '10000000000000000000000000000001';
const PEER_1 = openidToPeer(OPENID_1);
const HASH_1 = extractPeerHash(PEER_1)!;
const SID_1 = openidToSessionBaseId(OPENID_1);

const OPENID_6 = '10000000000000000000000000000006';
const PEER_6 = openidToPeer(OPENID_6);
const SID_6 = openidToSessionBaseId(OPENID_6);

describe('契约测试: DSH 重启后会话恢复与全归档开启新轮次 (Session Restart & Archive Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-restart-archive-'));
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

  it('契约 1: parseSessionId 正确解析 kujira-user 基础版本与多轮归档版本，拒绝旧版 qq-* 格式', () => {
    expect(parseSessionId(SID_1)).toEqual({
      peer: PEER_1,
      id: HASH_1,
      round: 0,
      version: 1,
      isGroup: false,
    });
    expect(parseSessionId(`${SID_1}-2`)).toEqual({
      peer: PEER_1,
      id: HASH_1,
      round: 0,
      version: 2,
      isGroup: false,
    });
    expect(parseSessionId(`${SID_1}-r1-1`)).toEqual({
      peer: PEER_1,
      id: HASH_1,
      round: 1,
      version: 1,
      isGroup: false,
    });
    expect(parseSessionId(`${SID_1}-r1-2`)).toEqual({
      peer: PEER_1,
      id: HASH_1,
      round: 1,
      version: 2,
      isGroup: false,
    });
    expect(parseSessionId(`${SID_1}-r2-3`)).toEqual({
      peer: PEER_1,
      id: HASH_1,
      round: 2,
      version: 3,
      isGroup: false,
    });
    // 不再识别旧 qq-user- / qq-group- 前缀
    expect(parseSessionId('qq-user-2000000001')).toBeNull();
    expect(parseSessionId('qq-group-3000000001')).toBeNull();
  });

  it('契约 2: 真实装配下 /clear 到 #2 后重启 DSH，唤醒必须精准恢复 #2 绝不回退至 #1', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager1 = new SessionManager(booted.ctx, tmpHome, db);

    const agent1 = await sessionManager1.getOrCreateAgent(PEER_1);
    expect(agent1.session.id).toBe(SID_1);
    await (booted.ctx as any).sessions.flush(agent1.session);

    sessionManager1.markSessionCleared(PEER_1);
    const agent2 = await sessionManager1.getOrCreateAgent(PEER_1);
    expect(agent2.session.id).toBe(`${SID_1}-2`);
    await (booted.ctx as any).sessions.flush(agent2.session);

    await sessionManager1.dispose();
    await booted.dispose();
    booted = null;

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager2 = new SessionManager(booted.ctx, tmpHome, db);

    const resumedSessionId = sessionManager2.peerToSessionId(PEER_1);
    expect(resumedSessionId).toBe(`${SID_1}-2`);

    const resumedAgent = await sessionManager2.getOrCreateAgent(PEER_1);
    expect(resumedAgent.session.id).toBe(`${SID_1}-2`);

    await sessionManager2.dispose();
  });

  it('契约 3: Web UI 全部归档旧会话后，新消息自动开启 #1 (1) 并在 /clear 与重启后保持一致', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const a1 = await sessionManager.getOrCreateAgent(PEER_1);
    await (booted.ctx as any).sessions.flush(a1.session);
    sessionManager.markSessionCleared(PEER_1);
    const a2 = await sessionManager.getOrCreateAgent(PEER_1);
    await (booted.ctx as any).sessions.flush(a2.session);

    const wsRegistry = (booted.ctx as any).workspaceRegistry;
    await wsRegistry.archiveSession(SID_1);
    await wsRegistry.archiveSession(`${SID_1}-2`);

    const newSessionId = sessionManager.peerToSessionId(PEER_1);
    expect(newSessionId).toBe(`${SID_1}-r1-1`);

    const aNew = await sessionManager.getOrCreateAgent(PEER_1);
    expect(aNew.session.id).toBe(`${SID_1}-r1-1`);

    expect(formatSessionVersionTag(aNew.session.id)).toBe('#1 (1)');
    expect(formatFallbackSessionTitle(aNew.session.id)).toBe('新会话 #1 (1)');
    await (booted.ctx as any).sessions.flush(aNew.session);

    sessionManager.markSessionCleared(PEER_1);
    const aNew2 = await sessionManager.getOrCreateAgent(PEER_1);
    expect(aNew2.session.id).toBe(`${SID_1}-r1-2`);
    expect(formatSessionVersionTag(aNew2.session.id)).toBe('#2 (1)');
    expect(formatFallbackSessionTitle(aNew2.session.id)).toBe('新会话 #2 (1)');
    await (booted.ctx as any).sessions.flush(aNew2.session);

    await sessionManager.dispose();
    await booted.dispose();
    booted = null;

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManagerRestarted = new SessionManager(booted.ctx, tmpHome, db);
    expect(sessionManagerRestarted.peerToSessionId(PEER_1)).toBe(`${SID_1}-r1-2`);

    const wsRegistry2 = (booted.ctx as any).workspaceRegistry;
    await wsRegistry2.archiveSession(`${SID_1}-r1-1`);
    await wsRegistry2.archiveSession(`${SID_1}-r1-2`);

    const round2SessionId = sessionManagerRestarted.peerToSessionId(PEER_1);
    expect(round2SessionId).toBe(`${SID_1}-r2-1`);
    expect(formatSessionVersionTag(round2SessionId)).toBe('#1 (2)');
    expect(formatFallbackSessionTitle(round2SessionId)).toBe('新会话 #1 (2)');

    await sessionManagerRestarted.dispose();
  });

  it('契约 4: 物理删除历史会话文件后，peerToSessionId 自动回退至 #1 (版本 1)', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome, db);

    const a1 = await sessionManager.getOrCreateAgent(PEER_1);
    await (booted.ctx as any).sessions.flush(a1.session);
    sessionManager.markSessionCleared(PEER_1);
    const a2 = await sessionManager.getOrCreateAgent(PEER_1);
    await (booted.ctx as any).sessions.flush(a2.session);

    expect(sessionManager.peerToSessionId(PEER_1)).toBe(`${SID_1}-2`);

    await sessionManager.dispose();
    await booted.dispose();
    booted = null;

    const checkRoots = [
      path.join(tmpHome, 'sessions'),
      path.join(os.homedir(), '.dsh', 'sessions'),
    ];
    for (const r of checkRoots) {
      if (fs.existsSync(r)) {
        const dirs = fs.readdirSync(r);
        for (const d of dirs) {
          const s1 = path.join(r, d, SID_1);
          const s2 = path.join(r, d, `${SID_1}-2`);
          await fsp.rm(s1, { recursive: true, force: true }).catch(() => {});
          await fsp.rm(s2, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManagerRestarted = new SessionManager(booted.ctx, tmpHome, db);

    const resetSessionId = sessionManagerRestarted.peerToSessionId(PEER_1);
    expect(resetSessionId).toBe(SID_1);

    const state = db.getSessionState(PEER_1);
    expect(state?.current_session_id).toBe(SID_1);

    const aReset = await sessionManagerRestarted.getOrCreateAgent(PEER_1);
    expect(aReset.session.id).toBe(SID_1);

    await sessionManagerRestarted.dispose();
  });

  it('契约 6: DSH 关闭重启后，Kujira 会话与全局设定的模型与思考档位能从 SQLite 完整恢复，且恢复的 Agent 携带正确思考档位', async () => {
    const dbPath = path.resolve(tmpHome, 'kujira/messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager1 = new SessionManager(booted.ctx, tmpHome, db);

    sessionManager1.setKujiraDefaultModel('deepseek-official', 'deepseek-v4-pro', 'low');

    const agent1 = await sessionManager1.getOrCreateAgent(PEER_6);
    sessionManager1.setModelSelection(agent1.session.id, 'deepseek-official', 'deepseek-v4-pro', 'max');
    await (booted.ctx as any).sessions.flush(agent1.session);

    await sessionManager1.dispose();
    await booted.dispose();
    booted = null;

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager2 = new SessionManager(booted.ctx, tmpHome, db);

    const restoredDefault = sessionManager2.getKujiraDefaultModel();
    expect(restoredDefault.provider).toBe('deepseek-official');
    expect(restoredDefault.model).toBe('deepseek-v4-pro');
    expect(restoredDefault.reasoningEffort).toBe('low');

    const restoredAgent = await sessionManager2.getOrCreateAgent(PEER_6);
    expect(restoredAgent.session.id).toBe(SID_6);
    const restoredSel = sessionManager2.getModelSelection(restoredAgent.session.id);
    expect(restoredSel?.provider).toBe('deepseek-official');
    expect(restoredSel?.model).toBe('deepseek-v4-pro');
    expect(restoredSel?.reasoningEffort).toBe('max');

    expect((restoredAgent as any).modelSelection?.current?.reasoningEffort).toBe('max');

    await sessionManager2.dispose();
  });
});

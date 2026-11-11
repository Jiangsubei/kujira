import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import {
  SessionManager,
  formatSessionTitle,
  parseSessionId,
  buildSessionId,
  findSmallestAvailableVersion,
} from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer, openidToSessionBaseId, extractPeerHash } from '../../src/utils/peer.js';

const OPENID = '10000000000000000000000000000001';
const PEER = openidToPeer(OPENID);
const HASH = extractPeerHash(PEER)!;
const BASE_SID = openidToSessionBaseId(OPENID);

describe('契约测试: 会话编号空缺填补与短哈希防撞契约 (Session Gap-Filling & Hash Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-gap-filling-'));
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

  it('契约 1: parseSessionId 与 buildSessionId 正确处理 kujira-user-* 基础与带短哈希格式', () => {
    expect(parseSessionId(BASE_SID)).toEqual({
      peer: PEER,
      id: HASH,
      round: 0,
      version: 1,
      hash: undefined,
      isGroup: false,
    });
    expect(parseSessionId(`${BASE_SID}-2`)).toEqual({
      peer: PEER,
      id: HASH,
      round: 0,
      version: 2,
      hash: undefined,
      isGroup: false,
    });
    expect(parseSessionId(`${BASE_SID}-r1-2`)).toEqual({
      peer: PEER,
      id: HASH,
      round: 1,
      version: 2,
      hash: undefined,
      isGroup: false,
    });

    expect(parseSessionId(`${BASE_SID}-1-a7b3c9`)).toEqual({
      peer: PEER,
      id: HASH,
      round: 0,
      version: 1,
      hash: 'a7b3c9',
      isGroup: false,
    });
    expect(parseSessionId(`${BASE_SID}-3-f1e2d3`)).toEqual({
      peer: PEER,
      id: HASH,
      round: 0,
      version: 3,
      hash: 'f1e2d3',
      isGroup: false,
    });
    expect(parseSessionId(`${BASE_SID}-r1-2-123456`)).toEqual({
      peer: PEER,
      id: HASH,
      round: 1,
      version: 2,
      hash: '123456',
      isGroup: false,
    });

    expect(buildSessionId(BASE_SID, 0, 1, 'a7b3c9')).toBe(`${BASE_SID}-1-a7b3c9`);
    expect(buildSessionId(BASE_SID, 0, 2, 'a7b3c9')).toBe(`${BASE_SID}-2-a7b3c9`);
    expect(buildSessionId(BASE_SID, 1, 2, 'a7b3c9')).toBe(`${BASE_SID}-r1-2-a7b3c9`);
    expect(buildSessionId(BASE_SID, 0, 1)).toBe(BASE_SID);
    expect(buildSessionId(BASE_SID, 0, 2)).toBe(`${BASE_SID}-2`);
  });

  it('契约 2: findSmallestAvailableVersion 纯算法契约 (First Missing Positive)', () => {
    expect(findSmallestAvailableVersion([])).toBe(1);
    expect(findSmallestAvailableVersion([3])).toBe(1);
    expect(findSmallestAvailableVersion([1, 3])).toBe(2);
    expect(findSmallestAvailableVersion([1, 2, 3])).toBe(4);
    expect(findSmallestAvailableVersion([2, 3])).toBe(1);
    expect(findSmallestAvailableVersion([1, 2])).toBe(3);
  });

  it('契约 3: 真实装配下有会话 1, 2, 3，删除 1, 2 后新建依次为 1, 2，已有 3 则跳过新建 4', async () => {
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
    expect(formatSessionTitle(PEER, s1Id)).toContain('#1');

    sessionManager.markSessionCleared(PEER);
    const a2 = await sessionManager.getOrCreateAgent(PEER);
    await (booted.ctx as any).sessions.flush(a2.session);
    const s2Id = a2.session.id;
    expect(formatSessionTitle(PEER, s2Id)).toContain('#2');

    sessionManager.markSessionCleared(PEER);
    const a3 = await sessionManager.getOrCreateAgent(PEER);
    await (booted.ctx as any).sessions.flush(a3.session);
    const s3Id = a3.session.id;
    expect(formatSessionTitle(PEER, s3Id)).toContain('#3');

    const wsRegistry = (booted.ctx as any).workspaceRegistry;
    await wsRegistry.archiveSession(s1Id);
    await wsRegistry.archiveSession(s2Id);

    const activeList = sessionManager.listPeerSessionIds(PEER);
    expect(activeList).toEqual([s3Id]);

    sessionManager.markSessionCleared(PEER);
    const aNew1 = await sessionManager.getOrCreateAgent(PEER);
    await (booted.ctx as any).sessions.flush(aNew1.session);
    const new1Parsed = parseSessionId(aNew1.session.id);
    expect(new1Parsed?.version).toBe(1);
    expect(new1Parsed?.hash).toBeDefined();
    expect(aNew1.session.id).not.toBe(s1Id);
    expect(formatSessionTitle(PEER, aNew1.session.id)).toContain('#1');

    sessionManager.markSessionCleared(PEER);
    const aNew2 = await sessionManager.getOrCreateAgent(PEER);
    await (booted.ctx as any).sessions.flush(aNew2.session);
    const new2Parsed = parseSessionId(aNew2.session.id);
    expect(new2Parsed?.version).toBe(2);
    expect(new2Parsed?.hash).toBeDefined();
    expect(aNew2.session.id).not.toBe(s2Id);
    expect(formatSessionTitle(PEER, aNew2.session.id)).toContain('#2');

    sessionManager.markSessionCleared(PEER);
    const aNew4 = await sessionManager.getOrCreateAgent(PEER);
    await (booted.ctx as any).sessions.flush(aNew4.session);
    const new4Parsed = parseSessionId(aNew4.session.id);
    expect(new4Parsed?.version).toBe(4);
    expect(formatSessionTitle(PEER, aNew4.session.id)).toContain('#4');

    await wsRegistry.unarchiveSession(s1Id);
    expect(wsRegistry.archivedSessionIds).not.toContain(s1Id);
    expect(s1Id).not.toBe(aNew1.session.id);

    await sessionManager.dispose();
  }, 15000);
});

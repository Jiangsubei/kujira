import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import {
  SessionManager,
  encodeSegment,
} from '../../src/gateway/session.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const PEER_18 = openidToPeer('10000000000000000000000000000018');
const SID_18 = openidToSessionBaseId('10000000000000000000000000000018');

describe('契约测试: DSH V3/V4 路径编码寻址与存量会话探测 (Session V3 Persistence Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-v3-persistence-'));
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: encodeSegment 转义算法完全对齐 DSH 规范', () => {
    expect(() => encodeSegment('')).toThrow('cannot encode an empty path segment');

    expect(encodeSegment('.')).toBe('~002E');
    expect(encodeSegment('..')).toBe('~002E~002E');

    expect(encodeSegment('kujira-user-abc123_def.xyz-DEF')).toBe('kujira-user-abc123_def.xyz-DEF');

    expect(encodeSegment('user:123')).toBe('user~003A123');
    expect(encodeSegment('session~01')).toBe('session~007E01');
    expect(encodeSegment('a/b/c')).toBe('a~002Fb~002Fc');
    expect(encodeSegment('hello world')).toBe('hello~0020world');
  });

  it('契约 2: 包含特殊字符（冒号/波浪号）的 SessionId 能在 V3 编码目录中准确寻址探测', async () => {
    const ctx = new Context();
    const sessionManager = new SessionManager(ctx, tmpHome);

    const specialSessionId = 'kujira-user-12345:6789~v3';
    const encodedDirName = encodeSegment(specialSessionId);
    expect(encodedDirName).toBe('kujira-user-12345~003A6789~007Ev3');

    const projectSessionsDir = path.join(tmpHome, 'sessions', 'default', encodedDirName);
    await fsp.mkdir(projectSessionsDir, { recursive: true });
    await fsp.writeFile(
      path.join(projectSessionsDir, 'session.v3.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: specialSessionId }) + '\n'
    );

    expect(sessionManager.isSessionPhysicallyPresent(specialSessionId)).toBe(true);
    expect(sessionManager.isSessionPhysicallyPresent('kujira-user-not-exists:123')).toBe(false);

    await sessionManager.dispose();
  });

  it('契约 3: 存量 V2/V3/V4 与旧版候选会话文件兼容性探测', async () => {
    const ctx = new Context();
    const sessionManager = new SessionManager(ctx, tmpHome);

    const sidV2 = 'kujira-user-v2-legacy';
    const dirV2 = path.join(tmpHome, 'sessions', 'default', sidV2);
    await fsp.mkdir(dirV2, { recursive: true });
    await fsp.writeFile(
      path.join(dirV2, 'session.v2.jsonl'),
      JSON.stringify({ type: 'session', version: 2, id: sidV2 }) + '\n'
    );
    expect(sessionManager.isSessionPhysicallyPresent(sidV2)).toBe(true);

    const sidV2Zstd = 'kujira-user-v2-zstd';
    const dirV2Zstd = path.join(tmpHome, 'sessions', 'default', sidV2Zstd);
    await fsp.mkdir(dirV2Zstd, { recursive: true });
    await fsp.writeFile(path.join(dirV2Zstd, 'session.v2.jsonl.zstd'), 'mock-zstd-binary');
    expect(sessionManager.isSessionPhysicallyPresent(sidV2Zstd)).toBe(true);

    const sidV1 = 'kujira-user-old-v1';
    const dirV1 = path.join(tmpHome, 'sessions', 'default', sidV1);
    await fsp.mkdir(dirV1, { recursive: true });
    await fsp.writeFile(path.join(dirV1, 'session.jsonl'), '{"type":"session"}\n');
    expect(sessionManager.isSessionPhysicallyPresent(sidV1)).toBe(true);

    const sidV3Zstd = 'kujira-user-v3-zstd';
    const dirV3Zstd = path.join(tmpHome, 'sessions', 'default', encodeSegment(sidV3Zstd));
    await fsp.mkdir(dirV3Zstd, { recursive: true });
    await fsp.writeFile(path.join(dirV3Zstd, 'session.v3.jsonl.zstd'), 'mock-zstd-binary');
    expect(sessionManager.isSessionPhysicallyPresent(sidV3Zstd)).toBe(true);

    const sidV4 = 'kujira-user-v4-modern';
    const dirV4 = path.join(tmpHome, 'sessions', 'default', encodeSegment(sidV4));
    await fsp.mkdir(dirV4, { recursive: true });
    await fsp.writeFile(path.join(dirV4, 'session.v4.jsonl'), '{"type":"session"}\n');
    expect(sessionManager.isSessionPhysicallyPresent(sidV4)).toBe(true);

    await sessionManager.dispose();
  });

  it('契约 4: isSessionPhysicallyPresentAsync 优先利用 sessionPersistence.stat 进行无锁轻量探测', async () => {
    const ctx = new Context();
    const sessionId = 'kujira-user-stat-probe';

    const mockStat = vi.fn().mockImplementation(async (id: string) => {
      if (id === sessionId) {
        return {
          id,
          createdAt: Date.now(),
          eventCount: 42,
        };
      }
      return undefined;
    });

    (ctx as any).sessionPersistence = {
      stat: mockStat,
    };

    const sessionManager = new SessionManager(ctx, tmpHome);

    const resultTrue = await sessionManager.isSessionPhysicallyPresentAsync(sessionId);
    expect(resultTrue).toBe(true);
    expect(mockStat).toHaveBeenCalledWith(sessionId);

    const resultFalse = await sessionManager.isSessionPhysicallyPresentAsync('kujira-user-not-stat');
    expect(resultFalse).toBe(false);

    mockStat.mockRejectedValueOnce(new Error('stat query error'));
    const dirFallback = path.join(tmpHome, 'sessions', 'default', sessionId);
    await fsp.mkdir(dirFallback, { recursive: true });
    await fsp.writeFile(path.join(dirFallback, 'session.v3.jsonl'), '{"type":"session"}\n');

    const resultFallback = await sessionManager.isSessionPhysicallyPresentAsync(sessionId);
    expect(resultFallback).toBe(true);

    await sessionManager.dispose();
  });

  it('契约 5: 真实装配路径下 flush 会话与物理探针双向闭环', async () => {
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome);

    const agent = await sessionManager.getOrCreateAgent(PEER_18);
    const sessionId = agent.session.id;
    expect(sessionId).toBe(SID_18);

    await (booted.ctx as any).sessions.flush(agent.session);

    expect(sessionManager.isSessionPhysicallyPresent(sessionId)).toBe(true);
    const asyncPresent = await sessionManager.isSessionPhysicallyPresentAsync(sessionId);
    expect(asyncPresent).toBe(true);

    await sessionManager.dispose();
  });
});

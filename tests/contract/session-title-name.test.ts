/**
 * tests/contract/session-title-name.test.ts
 *
 * 契约测试: 单聊会话昵称解析、持久化与“不得降级覆盖”
 *
 * 覆盖规范:
 * 1. 从单聊会话标题（`私聊: [<name> ]<hash16> #N`）反向提取名称（纯函数边界）；
 * 2. 真实装配下 setPeerName / ensurePeerName 解析并持久化到 plugin_kv (`kujira_peer_names`)；
 * 3. 名字未知且已有标题时，updateSessionTitle 绝不降级覆盖。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import {
  extractNameFromSessionTitle,
  formatSessionTitle,
} from '../../src/gateway/session.js';
import {
  computeOpenidHash16,
  openidToPeer,
  openidToSessionBaseId,
} from '../../src/utils/peer.js';

const MOCK_OPENID_1 = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_OPENID_2 = 'B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6A1';
const MOCK_OPENID_3 = 'C3D4E5F6A7B8C9D0E1F2A3B4C5D6A1B2';

const MOCK_HASH_1 = computeOpenidHash16(MOCK_OPENID_1);
const MOCK_PEER_1 = openidToPeer(MOCK_OPENID_1);
const MOCK_PEER_2 = openidToPeer(MOCK_OPENID_2);
const MOCK_PEER_3 = openidToPeer(MOCK_OPENID_3);
const MOCK_HASH_3 = computeOpenidHash16(MOCK_OPENID_3);
const MOCK_SID_3 = openidToSessionBaseId(MOCK_OPENID_3);

describe('契约测试: 会话昵称解析与持久化', () => {
  let tmpHome: string;
  let booted: BootedDsh | undefined;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-name-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {},
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = undefined;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 从单聊会话标题提取名称（有名称 / 纯哈希 / 无标题）', () => {
    expect(extractNameFromSessionTitle(`私聊: 小明 ${MOCK_HASH_1} #1`, MOCK_PEER_1)).toBe('小明');
    expect(extractNameFromSessionTitle(`私聊: 小红 ${MOCK_HASH_1} #2 (1)`, MOCK_PEER_1)).toBe('小红');
    expect(extractNameFromSessionTitle(`私聊: ${MOCK_HASH_1} #1`, MOCK_PEER_1)).toBeUndefined();
    expect(extractNameFromSessionTitle(undefined, MOCK_PEER_1)).toBeUndefined();
    expect(extractNameFromSessionTitle('', MOCK_PEER_1)).toBeUndefined();
  });

  it('契约 2: setPeerName 与 ensurePeerName 解析单聊昵称并持久化到 plugin_kv (kujira_peer_names)', async () => {
    const ctx: any = booted!.ctx;
    const gateway: any = ctx.get('kujira-gateway');
    expect(gateway).toBeDefined();

    gateway.getPeerName = async (peer: string) =>
      peer === MOCK_PEER_1 ? { name: '装配测试用户' } : undefined;

    const sessionManager: any = ctx.get('kujira-session');
    expect(sessionManager).toBeDefined();

    // 路径 A: 通过 kujira-gateway 可选昵称查询解析并持久化
    expect(await sessionManager.ensurePeerName(MOCK_PEER_1)).toBe('装配测试用户');
    expect(sessionManager.getPeerName(MOCK_PEER_1)).toBe('装配测试用户');

    // 路径 B: 通过入站事件/直接写入 setPeerName 持久化
    sessionManager.setPeerName(MOCK_PEER_2, '入站用户备注');
    expect(sessionManager.getPeerName(MOCK_PEER_2)).toBe('入站用户备注');

    const rawDb = new DatabaseSync(path.join(tmpHome, 'kujira', 'messages.sqlite'), {
      readOnly: true,
    });
    try {
      const row = rawDb
        .prepare("SELECT value FROM plugin_kv WHERE key = 'kujira_peer_names'")
        .get() as any;
      expect(row?.value).toBeTruthy();
      const persisted = JSON.parse(row.value);
      expect(persisted[MOCK_PEER_1]).toBe('装配测试用户');
      expect(persisted[MOCK_PEER_2]).toBe('入站用户备注');
    } finally {
      rawDb.close();
    }
  });

  it('契约 3: 名字未知且已有标题时，绝不降级覆盖为纯哈希标题', async () => {
    const ctx: any = booted!.ctx;
    const gateway: any = ctx.get('kujira-gateway');
    gateway.getPeerName = async () => {
      throw new Error('Gateway offline');
    };

    const sessionManager: any = ctx.get('kujira-session');
    const cwd = path.join(tmpHome, 'title-ws');
    await fsp.mkdir(cwd, { recursive: true });
    const handle = await ctx.agents.create({
      sessionId: MOCK_SID_3,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd },
    });
    const session = (handle.agent || handle).session;

    const titleSvc: any = ctx.get('sessionTitle') || ctx.sessionTitle;
    expect(typeof titleSvc?.rename).toBe('function');
    const initialTitle = formatSessionTitle(MOCK_PEER_3, MOCK_SID_3, '原始单聊昵称');
    expect(initialTitle).toBe(`私聊: 原始单聊昵称 ${MOCK_HASH_3} #1`);
    titleSvc.rename(session, initialTitle);

    // 名字解析失败，且内存/持久化缓存均无该 peer
    expect(await sessionManager.ensurePeerName(MOCK_PEER_3)).toBeUndefined();
    sessionManager.updateSessionTitle(session, MOCK_PEER_3, MOCK_SID_3);

    expect(titleSvc.get(session)?.title).toBe(initialTitle);
  });
});

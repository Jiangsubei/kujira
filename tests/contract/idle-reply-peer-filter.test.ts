import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Context } from '@deepseek-ai/cordis';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer } from '../../src/utils/peer.js';
import { registerPeerRoutes, PEERS_API_PATH } from '../../src/server/peer-routes.js';
import { ProactiveManager, isPeerAllowedForIdleReply } from '../../src/gateway/proactive.js';
import { KujiraFormModel } from '../../src/client/model.js';
import { KujiraSettingsCard, DEFAULT_BASE_CONFIG } from '../../src/client/card.js';
import {
  ReplyTab,
} from '../../src/client/tabs/ReplyTab.js';
import {
  MoreTab,
} from '../../src/client/tabs/MoreTab.js';
import {
  PEERS_POLL_MS as IDLE_REPLY_PEERS_POLL_MS,
  formatPeerDropdownLabel,
  startPeerListPolling,
  type KnownPeerSummary,
} from '../../src/client/components/PeerListEditor.js';
import type { BridgePluginConfig } from '../../src/types/index.js';
import * as KujiraPlugin from '../../src/index.js';

const OPENID_A = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const OPENID_B = 'B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7';
const OPENID_C = 'C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8';

const PEER_A = openidToPeer(OPENID_A);
const PEER_B = openidToPeer(OPENID_B);
const PEER_C = openidToPeer(OPENID_C);

function createMockRes() {
  let statusCode = 200;
  let headers: Record<string, string | number> = {};
  let body = '';
  const res = {
    writeHead(status: number, hdrs?: Record<string, string | number>) {
      statusCode = status;
      if (hdrs) headers = { ...hdrs };
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += chunk.toString();
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    getHeaders: () => headers,
    getJson: () => (body ? JSON.parse(body) : null),
    getRawBody: () => body,
  };
}

describe('契约测试: 冷场主动搭话黑白名单过滤、脱敏用户摘要路由与 ReplyTab 交互', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-peer-filter-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('1. 存储层: listKnownPeersWithLastMessage', () => {
    it('按最近入站消息时间倒序返回用户摘要，包含截断短 OpenID 与最后一句入站消息，不含机器人自身出站消息与完整 OpenID', () => {
      db.upsertPeerOpenid(PEER_A, OPENID_A);
      db.upsertPeerOpenid(PEER_B, OPENID_B);
      db.upsertPeerOpenid(PEER_C, OPENID_C);

      // PEER_A 较早发言，随后机器人有更新的出站回复（出站不能覆盖入站最后发言）
      db.saveMessage({
        msg_id: 'in-a-1',
        peer: PEER_A,
        user_id: OPENID_A,
        sender_name: '',
        time: 1_700_000_010_000,
        type: 'text',
        content: '这是一条非常非常长的测试消息用来验证前端截断效果',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });
      db.saveMessage({
        msg_id: 'out-a-1',
        peer: PEER_A,
        user_id: 'bot',
        sender_name: 'kujira',
        time: 1_700_000_999_000,
        type: 'text',
        content: '机器人的回复绝不能出现在用户最近发言里',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 1,
        reply_to: null,
      });

      // PEER_B 最近发言（含换行，应折叠为空格）
      db.saveMessage({
        msg_id: 'in-b-1',
        peer: PEER_B,
        user_id: OPENID_B,
        sender_name: '',
        time: 1_700_000_050_000,
        type: 'text',
        content: '在吗\n测试一下',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });

      // PEER_C 无消息记录

      const list = db.listKnownPeersWithLastMessage();
      expect(list).toHaveLength(3);

      // 按最近入站消息时间倒序：PEER_B (50s) > PEER_A (10s) > PEER_C (null)
      expect(list[0].peer).toBe(PEER_B);
      expect(list[0].short_openid).toBe('B2C3D4E5');
      expect(list[0].last_message_time).toBe(1_700_000_050_000);
      expect(list[0].last_message_preview).toBe('在吗 测试一下');
      expect((list[0] as any).openid).toBeUndefined();

      expect(list[1].peer).toBe(PEER_A);
      expect(list[1].short_openid).toBe('A1B2C3D4');
      expect(list[1].last_message_time).toBe(1_700_000_010_000);
      expect(list[1].last_message_preview.length).toBeLessThanOrEqual(17);
      expect(list[1].last_message_preview.endsWith('…')).toBe(true);
      expect(list[1].last_message_preview).not.toContain('机器人的回复');

      expect(list[2].peer).toBe(PEER_C);
      expect(list[2].short_openid).toBe('C3D4E5F6');
      expect(list[2].last_message_time).toBeNull();
      expect(list[2].last_message_preview).toBe('');
    });
  });

  describe('2. HTTP REST 路由: GET /plugins/kujira/peers 与真实插件装配', () => {
    it('严格执行 Fail-Closed 宿主鉴权，返回脱敏摘要且绝不泄漏完整 OpenID，拒绝非 GET 方法', async () => {
      db.upsertPeerOpenid(PEER_A, OPENID_A);
      db.saveMessage({
        msg_id: 'in-route-1',
        peer: PEER_A,
        user_id: OPENID_A,
        sender_name: '',
        time: 1_700_000_100_000,
        type: 'text',
        content: '你好呀',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });

      const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>();
      let authRejection: number | undefined = undefined;
      let hasConnection = true;

      const fakeCtx = {
        get(name: string) {
          if (name === 'webServer') {
            return {
              register(spec: { kind: string; path: string; handler: any }) {
                handlers.set(spec.path, spec.handler);
                return () => handlers.delete(spec.path);
              },
            };
          }
          if (name === 'connection') {
            return hasConnection ? { requestRejection: () => authRejection } : undefined;
          }
          return undefined;
        },
      } as unknown as Context;

      const dispose = registerPeerRoutes({ ctx: fakeCtx, db });
      const handler = handlers.get(PEERS_API_PATH);
      expect(handler).toBeDefined();

      // 1. 正常 GET 返回脱敏数据，绝对不含完整 OPENID_A
      const okRes = createMockRes();
      await handler!({ method: 'GET' } as IncomingMessage, okRes.res);
      expect(okRes.getStatus()).toBe(200);
      expect(okRes.getRawBody()).not.toContain(OPENID_A);
      const body = okRes.getJson();
      expect(body.ok).toBe(true);
      expect(body.peers).toHaveLength(1);
      expect(body.peers[0]).toEqual({
        peer: PEER_A,
        short_openid: 'A1B2C3D4',
        last_message_time: 1_700_000_100_000,
        last_message_preview: '你好呀',
      });

      // 2. 非 GET 返回 405
      const postRes = createMockRes();
      await handler!({ method: 'POST' } as IncomingMessage, postRes.res);
      expect(postRes.getStatus()).toBe(405);

      // 3. 宿主拒绝鉴权返回 401
      authRejection = 401;
      const unauthRes = createMockRes();
      await handler!({ method: 'GET' } as IncomingMessage, unauthRes.res);
      expect(unauthRes.getStatus()).toBe(401);

      // 4. 缺失 connection 服务 Fail-Closed 返回 403
      authRejection = undefined;
      hasConnection = false;
      const forbidRes = createMockRes();
      await handler!({ method: 'GET' } as IncomingMessage, forbidRes.res);
      expect(forbidRes.getStatus()).toBe(403);

      // 5. dispose 清理路由
      dispose();
      expect(handlers.has(PEERS_API_PATH)).toBe(false);
    });

    it('真实插件入口 apply() 必须完成 /plugins/kujira/peers 路由装配并在 dispose 时注销', async () => {
      const prevHome = process.env.DSH_HOME;
      process.env.DSH_HOME = tmpDir;
      const registeredPaths = new Set<string>();
      const fakeWebServer = {
        register(spec: { path: string }) {
          registeredPaths.add(spec.path);
          return () => registeredPaths.delete(spec.path);
        },
      };

      const ctx = new Context();
      (ctx as any).provide('webServer', fakeWebServer);
      (ctx as any).provide('connection', { requestRejection: () => undefined });

      try {
        KujiraPlugin.apply(ctx, {});
        expect(registeredPaths.has(PEERS_API_PATH)).toBe(true);
      } finally {
        await (ctx as any).parallel?.('dispose').catch(() => {});
        if (prevHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevHome;
      }

      expect(registeredPaths.has(PEERS_API_PATH)).toBe(false);
    });
  });

  describe('3. ProactiveManager 冷场搭话黑白名单过滤与聚合隔离', () => {
    const baseCfg: BridgePluginConfig = {
      idle_reply_enabled: true,
      idle_reply_min_mins: 30,
      idle_reply_max_mins: 30,
      aggregation_enabled: true,
      aggregation_min_seconds: 10,
      aggregation_max_seconds: 10,
      proactive_attitude: 'balanced',
    };

    it('纯函数 isPeerAllowedForIdleReply 完整覆盖黑白名单分表存储与互斥语义', () => {
      // 默认配置（blacklist + []）全部放行
      expect(isPeerAllowedForIdleReply(PEER_A, {})).toBe(true);
      expect(
        isPeerAllowedForIdleReply(PEER_A, {
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [],
          idle_reply_whitelist: [],
        })
      ).toBe(true);

      // 黑名单模式：仅 idle_reply_blacklist 生效，idle_reply_whitelist 互斥不生效
      expect(
        isPeerAllowedForIdleReply(PEER_A, {
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [PEER_A],
          idle_reply_whitelist: [PEER_A],
        })
      ).toBe(false);
      expect(
        isPeerAllowedForIdleReply(PEER_B, {
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [PEER_A],
          idle_reply_whitelist: [PEER_A],
        })
      ).toBe(true);

      // 白名单模式为空：全部拦截（即使黑名单为空也不放行）
      expect(
        isPeerAllowedForIdleReply(PEER_A, {
          idle_reply_list_mode: 'whitelist',
          idle_reply_blacklist: [],
          idle_reply_whitelist: [],
        })
      ).toBe(false);

      // 白名单模式非空：仅 idle_reply_whitelist 生效，idle_reply_blacklist 互斥不生效
      expect(
        isPeerAllowedForIdleReply(PEER_A, {
          idle_reply_list_mode: 'whitelist',
          idle_reply_blacklist: [PEER_A],
          idle_reply_whitelist: [PEER_A],
        })
      ).toBe(true);
      expect(
        isPeerAllowedForIdleReply(PEER_B, {
          idle_reply_list_mode: 'whitelist',
          idle_reply_blacklist: [],
          idle_reply_whitelist: [PEER_A],
        })
      ).toBe(false);
    });

    it('黑名单模式：排除名单内用户不触发冷场搭话且清空残留潜水闹钟，其余用户正常触发', async () => {
      const dispatched: any[] = [];
      const mgr = new ProactiveManager();
      const t0 = 1_700_000_000_000;
      const t31m = t0 + 31 * 60_000;

      // 先给 PEER_A 采样出一个闹钟（在黑名单为空时），验证加入黑名单后闹钟被清空
      await mgr.checkProactive({
        config: {
          ...baseCfg,
          idle_reply_min_mins: 30,
          idle_reply_max_mins: 60,
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [],
          idle_reply_whitelist: [PEER_A],
        },
        dispatch: (ev) => { dispatched.push(ev); },
        knownPeers: () => [PEER_A, PEER_B],
        lastHumanMessageAt: () => t0,
        now: t31m,
        rng: () => 0.9, // 采样落在 57min 处，尚未到点
      });
      expect(mgr.getPeerTiming(PEER_A)?.idleTargetWakeupAt).not.toBeNull();

      // 热更新将 PEER_A 加入黑名单，推进到 61 分钟
      const t61m = t0 + 61 * 60_000;
      await mgr.checkProactive({
        config: {
          ...baseCfg,
          idle_reply_min_mins: 30,
          idle_reply_max_mins: 60,
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [PEER_A],
          idle_reply_whitelist: [PEER_A],
        },
        dispatch: (ev) => { dispatched.push(ev); },
        knownPeers: () => [PEER_A, PEER_B],
        lastHumanMessageAt: () => t0,
        now: t61m,
        rng: () => 0.5,
      });

      const idleEvents = dispatched.filter((e) => e.kind === 'idle_reply');
      expect(idleEvents.map((e) => e.peer)).toEqual([PEER_B]);
      expect(mgr.getPeerTiming(PEER_A)?.idleTargetWakeupAt).toBeNull();
    });

    it('白名单模式：空名单不触发任何人；仅配置自己时新好友永不触发冷场搭话，但消息聚合回复不受影响', async () => {
      const dispatched: any[] = [];
      const mgr = new ProactiveManager();
      const t0 = 1_700_000_000_000;
      // 30min 恰好抵达下限采样点（不触发离线防追溯门控）
      const t30m = t0 + 30 * 60_000;

      // 1. 白名单为空 -> 任何人都不触发
      await mgr.checkProactive({
        config: {
          ...baseCfg,
          idle_reply_list_mode: 'whitelist',
          idle_reply_blacklist: [],
          idle_reply_whitelist: [],
        },
        dispatch: (ev) => { dispatched.push(ev); },
        knownPeers: () => [PEER_A, PEER_B],
        lastHumanMessageAt: () => t0,
        now: t30m,
        rng: () => 0.5,
      });
      expect(dispatched).toHaveLength(0);

      // 2. 白名单仅包含 PEER_A -> PEER_A 触发（即使 PEER_A 也在黑名单里），PEER_B 与新来的 PEER_C 均不触发
      await mgr.checkProactive({
        config: {
          ...baseCfg,
          idle_reply_list_mode: 'whitelist',
          idle_reply_blacklist: [PEER_A],
          idle_reply_whitelist: [PEER_A],
        },
        dispatch: (ev) => { dispatched.push(ev); },
        knownPeers: () => [PEER_A, PEER_B, PEER_C],
        lastHumanMessageAt: () => t0,
        now: t30m,
        rng: () => 0.5,
      });
      expect(dispatched.filter((e) => e.kind === 'idle_reply').map((e) => e.peer)).toEqual([PEER_A]);

      // 3. 非白名单好友 PEER_B 发消息走聚合回复必须完全正常
      const tMsg = t30m + 5_000;
      mgr.recordMessage(
        PEER_B,
        { content: '好友发消息测试聚合', time: tMsg },
        OPENID_B,
        {
          config: { ...baseCfg, idle_reply_list_mode: 'whitelist', idle_reply_whitelist: [PEER_A] },
          now: tMsg,
          rng: () => 0.5,
        }
      );
      await mgr.checkProactive({
        config: { ...baseCfg, idle_reply_list_mode: 'whitelist', idle_reply_whitelist: [PEER_A] },
        dispatch: (ev) => { dispatched.push(ev); },
        knownPeers: () => [PEER_A, PEER_B, PEER_C],
        lastHumanMessageAt: () => tMsg,
        now: tMsg + 15_000,
        rng: () => 0.5,
      });
      const aggEvents = dispatched.filter((e) => e.kind === 'aggregated_messages');
      expect(aggEvents).toHaveLength(1);
      expect(aggEvents[0].peer).toBe(PEER_B);
    });
  });

  describe('4. KujiraFormModel 数组字段与 ReplyTab 布局/交互/5秒轮询契约', () => {
    it('KujiraFormModel 正确判定 idle_reply_blacklist / idle_reply_whitelist 的 isOverridden / isDirty / resetField', () => {
      const model = new KujiraFormModel({
        initialValues: {
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [],
          idle_reply_whitelist: [],
        },
        baseDefaults: DEFAULT_BASE_CONFIG,
      });

      expect(model.isOverridden('idle_reply_blacklist')).toBe(false);
      expect(model.isOverridden('idle_reply_whitelist')).toBe(false);
      expect(model.isDirty()).toBe(false);

      model.setField('idle_reply_blacklist', [PEER_A]);
      expect(model.isOverridden('idle_reply_blacklist')).toBe(true);
      expect(model.isOverridden('idle_reply_whitelist')).toBe(false);
      expect(model.isDirty()).toBe(true);

      model.setField('idle_reply_whitelist', [PEER_B]);
      expect(model.isOverridden('idle_reply_whitelist')).toBe(true);

      model.resetField('idle_reply_blacklist');
      expect(model.getDraft().idle_reply_blacklist).toEqual([]);
      expect(model.getDraft().idle_reply_whitelist).toEqual([PEER_B]);
      expect(model.isOverridden('idle_reply_blacklist')).toBe(false);
      expect(model.isOverridden('idle_reply_whitelist')).toBe(true);

      model.resetField('idle_reply_whitelist');
      expect(model.getDraft().idle_reply_whitelist).toEqual([]);
      expect(model.isDirty()).toBe(false);
    });

    it('ReplyTab 顺序为「新消息行为 → 互动偏好 → 连续消息聚合 → 冷场主动搭话 → 潜水搭话时长」，黑白名单迁至更多配置 Tab 且平铺展示', () => {
      // 默认 idle_reply_enabled = false
      const closedHtml = renderToStaticMarkup(
        React.createElement(KujiraSettingsCard, {
          initialExpanded: true,
          initialTab: 'reply',
          onSaveSettings: vi.fn(),
        })
      );
      const replyPanel = closedHtml.match(
        /id="kujira-tabpanel-reply"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-persona")/
      )![0];

      // 严格验证顺序：新消息行为 < 互动偏好 < 连续消息聚合 < 冷场主动搭话 < 潜水搭话最小沉默时长 < 潜水搭话最大沉默时长
      const posNewMsg = replyPanel.indexOf('id="kujira-new-message-behavior"');
      const posAttitude = replyPanel.indexOf('id="kujira-proactive-attitude"');
      const posAgg = replyPanel.indexOf('id="kujira-aggregation-enabled"');
      const posIdle = replyPanel.indexOf('id="kujira-idle-reply-enabled"');
      const posMinMins = replyPanel.indexOf('id="kujira-idle-reply-min-mins"');
      const posMaxMins = replyPanel.indexOf('id="kujira-idle-reply-max-mins"');
      expect(posNewMsg).toBeGreaterThan(-1);
      expect(posAttitude).toBeGreaterThan(posNewMsg);
      expect(posAgg).toBeGreaterThan(posAttitude);
      expect(posIdle).toBeGreaterThan(posAgg);
      expect(posMinMins).toBeGreaterThan(posIdle);
      expect(posMaxMins).toBeGreaterThan(posMinMins);

      // ReplyTab 纯净化：不再包含名单过滤或折叠按钮
      expect(replyPanel).not.toContain('id="kujira-idle-reply-more-toggle"');
      expect(replyPanel).not.toContain('id="kujira-idle-reply-peer-filter"');
      expect(replyPanel).not.toContain('id="kujira-idle-reply-list-mode"');
      expect(replyPanel).not.toContain('id="kujira-idle-reply-peer-select"');

      const knownPeers: KnownPeerSummary[] = [
        {
          peer: PEER_A,
          short_openid: 'A1B2C3D4',
          last_message_time: Date.now() - 120_000,
          last_message_preview: '你好测试',
        },
        {
          peer: PEER_B,
          short_openid: 'B2C3D4E5',
          last_message_time: Date.now() - 3600_000,
          last_message_preview: '晚安',
        },
      ];

      // MoreTab 中冷场名单过滤直接平铺展示（无折叠按钮）
      const modelUnconfigured = new KujiraFormModel({
        initialValues: {
          idle_reply_enabled: true,
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [],
          idle_reply_whitelist: [],
        },
        baseDefaults: DEFAULT_BASE_CONFIG,
      });

      const moreTabDefaultHtml = renderToStaticMarkup(
        React.createElement(MoreTab, {
          active: true,
          draft: modelUnconfigured.getDraft(),
          model: modelUnconfigured,
          saving: false,
          initialKnownPeers: knownPeers,
          onFieldChange: vi.fn(),
          onResetField: vi.fn(),
        })
      );

      // 无折叠按钮，直接平铺展示搭话名单模式与黑名单空态
      expect(moreTabDefaultHtml).not.toContain('id="kujira-idle-reply-more-toggle"');
      expect(moreTabDefaultHtml).toContain('id="kujira-idle-reply-peer-filter"');
      expect(moreTabDefaultHtml).toContain('id="kujira-idle-reply-list-mode"');
      expect(moreTabDefaultHtml).toContain('搭话名单模式 (idle_reply_list_mode)');
      expect(moreTabDefaultHtml).toContain('黑名单用户 (idle_reply_blacklist)');
      expect(moreTabDefaultHtml).toContain('暂未配置，所有用户都会触发冷场主动搭话。');

      // 切换为白名单模式直接展示白名单空态
      const modelWhitelistEmpty = new KujiraFormModel({
        initialValues: {
          idle_reply_enabled: true,
          idle_reply_list_mode: 'whitelist',
          idle_reply_blacklist: [PEER_A],
          idle_reply_whitelist: [],
        },
        baseDefaults: DEFAULT_BASE_CONFIG,
      });

      const whitelistEmptyHtml = renderToStaticMarkup(
        React.createElement(MoreTab, {
          active: true,
          draft: modelWhitelistEmpty.getDraft(),
          model: modelWhitelistEmpty,
          saving: false,
          initialKnownPeers: knownPeers,
          onFieldChange: vi.fn(),
          onResetField: vi.fn(),
        })
      );

      expect(whitelistEmptyHtml).toContain('白名单用户 (idle_reply_whitelist)');
      expect(whitelistEmptyHtml).toContain('暂未配置，所有用户都不会触发冷场主动搭话。');
      expect(whitelistEmptyHtml).not.toContain(`data-testid="kujira-idle-reply-peer-item-${PEER_A}"`);

      // 已添加 PEER_A 的展示与内联编辑态
      const modelWithPeer = new KujiraFormModel({
        initialValues: {
          idle_reply_enabled: true,
          idle_reply_list_mode: 'blacklist',
          idle_reply_blacklist: [PEER_A],
          idle_reply_whitelist: [],
        },
        baseDefaults: DEFAULT_BASE_CONFIG,
      });

      const withPeerDefaultHtml = renderToStaticMarkup(
        React.createElement(MoreTab, {
          active: true,
          draft: modelWithPeer.getDraft(),
          model: modelWithPeer,
          saving: false,
          initialKnownPeers: knownPeers,
          onFieldChange: vi.fn(),
          onResetField: vi.fn(),
        })
      );

      expect(withPeerDefaultHtml).toContain(`data-testid="kujira-idle-reply-peer-item-${PEER_A}"`);
      expect(withPeerDefaultHtml).toContain(`data-testid="kujira-idle-reply-peer-remove-${PEER_A}"`);

      // 内联添加态：下拉框排除已添加的 PEER_A
      const withPeerEditingHtml = renderToStaticMarkup(
        React.createElement(MoreTab, {
          active: true,
          draft: modelWithPeer.getDraft(),
          model: modelWithPeer,
          saving: false,
          initialKnownPeers: knownPeers,
          initialAddingIdlePeer: true,
          onFieldChange: vi.fn(),
          onResetField: vi.fn(),
        })
      );

      expect(withPeerEditingHtml).toMatch(/id="kujira-idle-reply-peer-add"[^>]*disabled/);
      expect(withPeerEditingHtml).toContain('id="kujira-idle-reply-peer-editor"');
      const selectBlock = withPeerEditingHtml.match(
        /<select[^>]*id="kujira-idle-reply-peer-select"[\s\S]*?<\/select>/
      )![0];
      expect(selectBlock).not.toContain(`value="${PEER_A}"`);
      expect(selectBlock).toContain(`value="${PEER_B}"`);
      expect(selectBlock).toContain('B2C3D4E5');
      expect(selectBlock).toContain('晚安');
    });

    it('formatPeerDropdownLabel 清晰展示短 OpenID、最近发言时间与消息预览；5 秒轮询在启动时立即拉取且每 5 秒自动刷新，停止后清理定时器', () => {
      const now = 1_700_000_300_000;
      const label = formatPeerDropdownLabel(
        {
          peer: PEER_A,
          short_openid: 'A1B2C3D4',
          last_message_time: now - 5 * 60_000,
          last_message_preview: '在吗测试一下',
        },
        now
      );
      expect(label).toContain('A1B2C3D4…');
      expect(label).toContain('5分钟前');
      expect(label).toContain('在吗测试一下');

      vi.useFakeTimers();
      expect(IDLE_REPLY_PEERS_POLL_MS).toBe(5_000);
      const fetcher = vi.fn();
      const stop = startPeerListPolling(fetcher, IDLE_REPLY_PEERS_POLL_MS);

      // 打开/切入时立即刷新一次
      expect(fetcher).toHaveBeenCalledTimes(1);

      // 每 5 秒自动刷新一次
      vi.advanceTimersByTime(5_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(10_000);
      expect(fetcher).toHaveBeenCalledTimes(4);

      // 离开 Tab / 关闭开关 / 卸载后彻底停止
      stop();
      vi.advanceTimersByTime(15_000);
      expect(fetcher).toHaveBeenCalledTimes(4);
    });
  });
});

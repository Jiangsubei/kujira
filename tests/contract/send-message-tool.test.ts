/**
 * 契约测试: send_qq_message 工具装配、6000 字符硬拦截、固定原生 Markdown、短 ID 化与参数校验契约
 *
 * 覆盖规范清单:
 * 契约 1: 真实 DSH 服务装配下（bootDshKujira + mountPlugin: false + kujira-tools 插件与 OutboundStreamBridge）：
 *         QQ 单聊会话包含 send_qq_message；非单聊会话（WebUI / Review）安全排除；
 * 契约 2: splitMessageText 基于 UTF-8 字节安全切分算法契约（绝不从多字节码点中间切断、绝不丢字）；
 * 契约 3: send_qq_message 6000 字符硬拦截、固定原生 Markdown、短 ID reply_to 校验与反查、短出站 ID 返回及 Lossless JSON 输出契约。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { MediaStorageManager } from '../../src/storage/media.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { recordOutboundSelfMessage } from '../../src/outbound/self-record.js';
import {
  splitMessageText,
  sendQqMessage,
  createSendQqMessageTool,
  registerAgentTools,
  resetGlobalToolContext,
} from '../../src/tools/index.js';
import KujiraToolsPlugin, {
  setGlobalBridgeToolsProvider,
} from '../../src/tools/plugin.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';
import { QQ_MSG_TYPE_MARKDOWN, QQ_SEND_MESSAGE_MAX_CHARS } from '../../src/constants/index.js';

const TEST_OPENID = '0123456789ABCDEF0123456789ABCDEF';
const TEST_PEER = openidToPeer(TEST_OPENID);
const TEST_SESSION_ID = openidToSessionBaseId(TEST_OPENID);

function assertNoUndefinedFields(obj: unknown, currentPath = ''): void {
  if (obj === undefined) {
    throw new Error(`Found undefined at "${currentPath}"`);
  }
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => assertNoUndefinedFields(item, `${currentPath}[${idx}]`));
    return;
  }
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) {
      throw new Error(`Found undefined key "${currentPath ? `${currentPath}.${key}` : key}"`);
    }
    assertNoUndefinedFields(val, currentPath ? `${currentPath}.${key}` : key);
  }
}

describe('契约 1: send_qq_message 工具装配与单聊隔离契约', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let db: MessageDatabase;
  let mediaManager: MediaStorageManager;
  let outboundBridge: OutboundStreamBridge;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-send-tool-asm-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });
    db = new MessageDatabase(path.join(tmpHome, 'messages.sqlite'));
    db.init();
    db.upsertPeerOpenid(TEST_PEER, TEST_OPENID);
    mediaManager = new MediaStorageManager({ dshHome: tmpHome, db });

    const mockGateway: any = {
      sendC2CMessage: vi.fn(async (_openid: string, payload: any) => ({
        ok: true,
        status: 200,
        body: {
          id: 'ROBOT1.0_OUT_BOOT_01',
          ext_info: { ref_idx: 'REFIDX_OUT_BOOT_01' },
          payload,
        },
      })),
      sendC2CStreamMessage: vi.fn(),
      sendInputNotify: vi.fn(),
      deleteC2CMessage: vi.fn(),
      uploadC2CMedia: vi.fn(),
      emitMessageSent: vi.fn(),
    };

    outboundBridge = new OutboundStreamBridge(booted.ctx, {
      gateway: mockGateway,
      db,
      getConfig: () => ({}),
    });

    const provider = {
      registerTools(targetCtx: any) {
        return registerAgentTools(targetCtx, {
          db,
          outboundBridge,
          gateway: mockGateway,
          mediaManager,
          dshHome: tmpHome,
          config: () => ({}),
        });
      },
    };
    setGlobalBridgeToolsProvider(provider);
    if (typeof (booted.ctx as any).provide === 'function') {
      try {
        (booted.ctx as any).provide('kujiraBridgeTools', provider);
      } catch {}
    }
  });

  afterEach(async () => {
    resetGlobalToolContext();
    setGlobalBridgeToolsProvider(undefined);
    outboundBridge?.dispose();
    db?.close();
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('1.1 真实装配下：QQ 单聊会话经 kujira-tools 挂载后 assemble 结果包含 send_qq_message', async () => {
    const ctx = booted.ctx;
    const qqWs = path.join(tmpHome, 'qq-ws-user');
    await fsp.mkdir(qqWs, { recursive: true });

    const qqUserHandle = await ctx.agents.create({
      sessionId: TEST_SESSION_ID as any,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await agentCtx.plugin(KujiraToolsPlugin);
      },
    });
    const qqUserAgent = (qqUserHandle as any).agent || qqUserHandle;
    const asmUser = await ctx.systemPrompt.assemble({
      scope: qqUserAgent,
      agent: qqUserAgent,
    } as any);
    const userToolNames = (asmUser.tools as any[]).map((t) => t.name);
    expect(userToolNames).toContain('send_qq_message');
    expect(userToolNames).toContain('recall_message');
    expect(userToolNames).toContain('send_file');
    expect(userToolNames).toContain('read_chat_history');
  });

  it('1.2 真实装配下：WebUI 与 Review 沙箱会话均排除 send_qq_message 工具', async () => {
    const ctx = booted.ctx;
    const webWs = path.join(tmpHome, 'web-ws');
    await fsp.mkdir(webWs, { recursive: true });
    const webHandle = await ctx.agents.create({
      sessionId: 'web-session-1000000001' as any,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: webWs },
    });
    const webAgent = (webHandle as any).agent || webHandle;
    const asmWeb = await ctx.systemPrompt.assemble({
      scope: webAgent,
      agent: webAgent,
    } as any);
    const webToolNames = (asmWeb.tools as any[]).map((t) => t.name);
    expect(webToolNames).not.toContain('send_qq_message');

    const reviewWs = path.join(tmpHome, 'review-ws');
    await fsp.mkdir(reviewWs, { recursive: true });
    const reviewHandle = await ctx.agents.create({
      sessionId: `review-${TEST_PEER}` as any,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: reviewWs },
    });
    const reviewAgent = (reviewHandle as any).agent || reviewHandle;
    const asmReview = await ctx.systemPrompt.assemble({
      scope: reviewAgent,
      agent: reviewAgent,
    } as any);
    const reviewToolNames = (asmReview.tools as any[]).map((t) => t.name);
    expect(reviewToolNames).not.toContain('send_qq_message');
  });

  it('1.3 send_qq_message 执行校验：空文本、非单聊会话与群聊 peer 安全拒绝', async () => {
    const resEmpty = await sendQqMessage({ text: '   ' }, { peer: TEST_PEER });
    expect(resEmpty.success).toBe(false);
    expect(resEmpty.error).toContain('不能为空');
    assertNoUndefinedFields(resEmpty);

    const resNonQQ = await sendQqMessage({ text: 'hello' }, { peer: 'web-session' });
    expect(resNonQQ.success).toBe(false);
    expect(resNonQQ.error).toContain('QQ 聊天会话');
    assertNoUndefinedFields(resNonQQ);

    const resGroupRejected = await sendQqMessage({ text: 'hello' }, { peer: 'group_3000000001' });
    expect(resGroupRejected.success).toBe(false);
    expect(resGroupRejected.error).toContain('单聊');
    assertNoUndefinedFields(resGroupRejected);
  });

  it('1.4 send_qq_message 通过 OutboundStreamBridge 固定走原生 Markdown、支持短 ID reply_to、6000 字符硬拦截与短出站 ID 返回', async () => {
    const sentPayloads: any[] = [];
    let outSeq = 0;
    const mockGateway: any = {
      sendC2CMessage: vi.fn(async (openid: string, payload: any, meta?: any) => {
        sentPayloads.push(payload);
        outSeq += 1;
        const rawId = `ROBOT1.0_OUT_MSG_${outSeq}`;
        const refIdx = `REFIDX_OUT_${outSeq}`;
        recordOutboundSelfMessage(
          {
            peer: meta?.peer ?? TEST_PEER,
            openid,
            msgId: rawId,
            refIdx,
            replyTo: meta?.replyTo ?? null,
            msgType: 2,
            text: meta?.text ?? payload?.markdown?.content ?? 'outbound',
            payload,
            time: Date.now(),
          },
          { db, botId: '1000000000', senderName: 'Kujira' }
        );
        return {
          ok: true,
          status: 200,
          body: {
            id: rawId,
            ext_info: { ref_idx: refIdx },
          },
        };
      }),
      sendC2CStreamMessage: vi.fn(),
      sendInputNotify: vi.fn(),
      deleteC2CMessage: vi.fn(),
      uploadC2CMedia: vi.fn(),
      emitMessageSent: vi.fn(),
    };

    const inboundRec = {
      msg_id: 'ROBOT1.0_INBOUND_123',
      peer: TEST_PEER,
      user_id: TEST_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'text',
      content: '原消息',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      ref_idx: 'REFIDX_INBOUND_123',
      source: 'qq' as const,
    };
    db.saveMessage(inboundRec);

    // 1. 固定原生 Markdown + 传入短 ID reply_to 自动换取 REFIDX_... + 返回短出站 ID（无 ref_idx）
    const resMd = await sendQqMessage(
      { text: '#标题测试\n测试回复消息', reply_to: inboundRec.short_id! },
      { peer: TEST_PEER, gateway: mockGateway, db }
    );

    expect(resMd.success).toBe(true);
    expect(resMd.message_id).toBe('msg_self_1');
    expect((resMd as any).ref_idx).toBeUndefined();
    assertNoUndefinedFields(resMd);
    expect(sentPayloads[0]).toMatchObject({
      msg_type: QQ_MSG_TYPE_MARKDOWN,
      markdown: { content: '# 标题测试\n测试回复消息' },
      message_reference: { message_id: 'REFIDX_INBOUND_123' },
    });

    // 2. 非法 reply_to（REFIDX_... / ROBOT1.0_...）直接本地拒绝，不调用网关
    const callsBeforeInvalid = mockGateway.sendC2CMessage.mock.calls.length;
    const resBadRef = await sendQqMessage(
      { text: '非法引用', reply_to: 'REFIDX_INBOUND_123' },
      { peer: TEST_PEER, gateway: mockGateway, db }
    );
    expect(resBadRef.success).toBe(false);
    expect(resBadRef.error).toContain('无效的 reply_to 短消息 ID');
    expect(resBadRef.error).toContain('msg_12');
    assertNoUndefinedFields(resBadRef);
    expect(mockGateway.sendC2CMessage.mock.calls.length).toBe(callsBeforeInvalid);

    // 3. 6000 字符硬拦截边界：6000 码点放行（含 4 字节 emoji 码点），6001 码点本地拦截
    const exact6000Emoji = '🐳'.repeat(QQ_SEND_MESSAGE_MAX_CHARS);
    expect([...exact6000Emoji].length).toBe(6000);
    const res6000 = await sendQqMessage(
      { text: exact6000Emoji },
      { peer: TEST_PEER, gateway: mockGateway, db }
    );
    expect(res6000.success).toBe(true);
    expect(res6000.message_id).toMatch(/^msg_self_[1-9]\d*$/);
    assertNoUndefinedFields(res6000);

    const callsBeforeOverLimit = mockGateway.sendC2CMessage.mock.calls.length;
    const res6001Ascii = await sendQqMessage(
      { text: 'a'.repeat(QQ_SEND_MESSAGE_MAX_CHARS + 1) },
      { peer: TEST_PEER, gateway: mockGateway, db }
    );
    expect(res6001Ascii.success).toBe(false);
    expect(res6001Ascii.error).toContain('6001');
    expect(res6001Ascii.error).toContain('6000');
    expect(res6001Ascii.error).toContain('拆分');
    assertNoUndefinedFields(res6001Ascii);

    const res6001Emoji = await sendQqMessage(
      { text: '🐳'.repeat(QQ_SEND_MESSAGE_MAX_CHARS + 1) },
      { peer: TEST_PEER, gateway: mockGateway, db }
    );
    expect(res6001Emoji.success).toBe(false);
    expect(res6001Emoji.error).toContain('6001');
    expect(mockGateway.sendC2CMessage.mock.calls.length).toBe(callsBeforeOverLimit);

    // 4. 若无 DB 映射短 ID，绝不返回原始长 ROBOT1.0_...
    const noDbGateway: any = {
      sendC2CMessage: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: { id: 'ROBOT1.0_RAW_LEAK_GUARD' },
      })),
      sendInputNotify: vi.fn(),
      deleteC2CMessage: vi.fn(),
      uploadC2CMedia: vi.fn(),
    };
    const resNoDb = await sendQqMessage(
      { text: '无 DB 短 ID 保护' },
      { peer: TEST_PEER, openid: TEST_OPENID, gateway: noDbGateway }
    );
    expect(resNoDb.success).toBe(true);
    expect(resNoDb.message_id).toBeUndefined();
    assertNoUndefinedFields(resNoDb);
  });

  it('1.5 send_qq_message 工具描述与参数规范：包含分段发送与 6000 上限引导，禁止 XML/HTML 标签，移除 at_user 与 markdown', async () => {
    const ctx = booted.ctx;
    const qqWs = path.join(tmpHome, 'qq-ws-desc');
    await fsp.mkdir(qqWs, { recursive: true });

    const qqHandle = await ctx.agents.create({
      sessionId: TEST_SESSION_ID as any,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await agentCtx.plugin(KujiraToolsPlugin);
      },
    });
    const qqAgent = (qqHandle as any).agent || qqHandle;
    const asm = await ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const sendTool = (asm.tools as any[]).find((t) => t.name === 'send_qq_message');
    expect(sendTool).toBeDefined();
    expect(sendTool.description).toContain(
      '若要发送的内容较长，或包含多个不同要点、转折与独立意思，可以拆分成多条简短消息，多次调用本工具分开发送。'
    );
    expect(sendTool.description).toContain('6000');
    expect(sendTool.description).toContain('Markdown');
    const props = sendTool.parameters?.properties;
    expect(props?.at_user).toBeUndefined();
    expect(props?.markdown).toBeUndefined();
    expect(props?.reply_to?.type).toBe('string');
    expect(props?.reply_to?.description).toContain('msg_12');
    const textDesc = props?.text?.description;
    expect(typeof textDesc).toBe('string');
    expect(textDesc).toContain('直接填写展示给用户的原始文本');
    expect(textDesc).toContain('禁止附加任何 XML/HTML 标签、标签闭合符或外层包裹标记');

    // 验证 output.render 仅显示短 ID（不拼 ref_idx）
    const directTool = createSendQqMessageTool();
    expect(
      (directTool as any).output.render({}, { success: true, message_id: 'msg_self_8', ref_idx: 'REFIDX_NO_SHOW' })[0].text
    ).toBe('消息已发送 (ID: msg_self_8)');
    expect((directTool as any).output.render({}, { success: true })[0].text).toBe('消息已发送');
  });
});

describe('契约 2: 文本按 UTF-8 字节安全分段工具函数 (splitMessageText)', () => {
  it('空文本返回空数组', () => {
    expect(splitMessageText('')).toEqual([]);
    expect(splitMessageText(null as any)).toEqual([]);
  });

  it('字节数未超限的文本直接返回单元素数组', () => {
    const shortText = '这是一段普通的简短消息文本。';
    expect(splitMessageText(shortText, 1024)).toEqual([shortText]);
  });

  it('超出 UTF-8 字节上限时优先按换行边界切分且不丢字', () => {
    const line1 = 'A'.repeat(800) + '\n';
    const line2 = 'B'.repeat(800);
    const text = `${line1}${line2}`;
    const chunks = splitMessageText(text, 1000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
    expect(chunks.join('')).toBe(text);
  });

  it('无换行符时按空格边界切分且不超过字节上限', () => {
    const part1 = 'word'.repeat(150); // 600 bytes
    const part2 = 'test'.repeat(150); // 600 bytes
    const text = `${part1} ${part2}`;
    const chunks = splitMessageText(text, 800);
    expect(chunks).toHaveLength(2);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(800);
    }
  });

  it('超长多字节 CJK 与 emoji 连续文本按码点边界切分，绝不切断多字节字符', () => {
    const text = '鲸'.repeat(400) + '🐳'.repeat(100); // 400*3 + 100*4 = 1600 bytes
    const chunks = splitMessageText(text, 500);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(500);
      expect(c).not.toContain('\uFFFD');
    }
  });
});

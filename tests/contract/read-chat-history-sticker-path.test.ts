/**
 * tests/contract/read-chat-history-sticker-path.test.ts
 *
 * 契约测试: read_chat_history 新式表情记录存储与渲染契约（单聊版本）
 *
 * 覆盖规范:
 * 1. 命中表情库记录：通过 attachment/render (`renderAttachments`) 与 `serializeAttachments` 标准入库，
 *    `db.readHistory` 完整保留 `local_path` 与结构化 `attachments` JSON，渲染文本为 `[表情包: face_id (情绪: mood) 路径: <local_path>]`；
 * 2. 普通表情记录：`renderAttachment` / `renderAttachments` 输出精简本地路径格式 `[表情包:<path>]`；
 * 3. 无本地路径兜底：`renderAttachments` 仅输出脱敏占位 `[表情包]` 且绝不泄漏 URL query 凭证，同时 `attachments` 保留远端元数据；
 * 4. 真实工具装配闭环：通过 `read_chat_history` `defineTool` `execute`（`kujira-user-<hash>` 会话绑定）与 `output.render` 验证短 ID 渲染 + Lossless JSON 无 `undefined`。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import {
  registerAgentTools,
  renderChatHistoryText,
  resetGlobalToolContext,
} from '../../src/tools/index.js';
import { renderAttachment, renderAttachments } from '../../src/attachment/render.js';
import { deserializeAttachments, serializeAttachments } from '../../src/attachment/store.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';
import type { ReadChatHistoryResult } from '../../src/types/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = '22223333444455556666777788889999';
const PEER = openidToPeer(MOCK_OPENID);
const SESSION_ID = openidToSessionBaseId(MOCK_OPENID);

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

describe('契约测试: read_chat_history 新式表情记录存储与渲染契约', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let historyTool: any;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-read-sticker-path-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();

    // 预置表情库资产
    db.insertFace({
      id: 'face_mock_cat',
      file_path: path.join(tmpDir, 'cat.png'),
      md5: 'mock_cat_md5',
      source: 'collect',
      tags: ['猫猫'],
      mood: '嘲讽',
      enabled: true,
      size: 100,
      format: 'png',
    });

    const mockCtx = new Context();
    const registeredTools: any[] = [];
    mockCtx.provide('tools', {
      register: (tool: any) => {
        registeredTools.push(tool);
        return () => {};
      },
    });
    registerAgentTools(mockCtx, {
      db,
      mediaManager: {} as any,
      dshHome: tmpDir,
      config: {},
    });
    historyTool = registeredTools.find((t) => t.name === 'read_chat_history');
  });

  afterEach(async () => {
    resetGlobalToolContext();
    if (db) db.close();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 库内表情新记录入库后查询 → local_path 与 attachments 完整保留且渲染带路径', () => {
    const filePath = path.join(tmpDir, 'cat.png');
    const descriptor: AttachmentDescriptor = {
      kind: 'sticker',
      origin: 'inbound',
      local: { path: filePath, format: 'png', md5: 'mock_cat_md5' },
      face: { id: 'face_mock_cat', mood: '嘲讽', tags: ['猫猫'] },
    };
    const [renderedContent] = renderAttachments([descriptor]);
    const serialized = serializeAttachments([descriptor]);

    expect(renderedContent).toBe(`[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`);

    db.saveMessage({
      msg_id: 'ROBOT1.0_STK_101',
      peer: PEER,
      user_id: MOCK_OPENID,
      sender_name: '好友A',
      time: 1793716500000,
      type: 'sticker',
      content: renderedContent!,
      raw: '{}',
      file_id: null,
      local_path: filePath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq',
      attachments: serialized,
    });

    const res = db.readHistory(PEER);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.local_path).toBe(filePath);
    expect(res.messages[0]!.content).toBe(
      `[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`
    );

    const parsedDescriptors = deserializeAttachments(res.messages[0]!.attachments);
    expect(parsedDescriptors).toHaveLength(1);
    expect(parsedDescriptors[0]!.face?.id).toBe('face_mock_cat');
    expect(parsedDescriptors[0]!.local?.path).toBe(filePath);

    const rendered = renderChatHistoryText(res);
    expect(rendered).toContain(`[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`);
  });

  it('契约 2: 普通表情经 renderAttachments 统一清洗与精简路径格式后入库检索', () => {
    const stickerPath = path.join(tmpDir, 'sticker.gif');
    const descriptor: AttachmentDescriptor = {
      kind: 'sticker',
      origin: 'inbound',
      summary: '[动画表情]',
      local: { path: stickerPath, format: 'gif' },
    };

    const content = renderAttachment(descriptor)!;
    expect(content).toBe(`[表情包:${stickerPath}]`);

    db.saveMessage({
      msg_id: 'ROBOT1.0_STK_102',
      peer: PEER,
      user_id: MOCK_OPENID,
      sender_name: '好友B',
      time: 1793716510000,
      type: 'sticker',
      content,
      raw: '{}',
      file_id: null,
      local_path: stickerPath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq',
      attachments: serializeAttachments([descriptor]),
    });

    const res = db.readHistory(PEER);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.msg_id).toBe('msg_1');
    expect(res.messages[0]!.local_path).toBe(stickerPath);
    expect(res.messages[0]!.content).toBe(`[表情包:${stickerPath}]`);

    const parsed = deserializeAttachments(res.messages[0]!.attachments);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.kind).toBe('sticker');
    expect(parsed[0]!.local?.path).toBe(stickerPath);

    const rendered = renderChatHistoryText(res);
    expect(rendered).toContain('[msg_1]');
    expect(rendered).toContain(`[表情包:${stickerPath}]`);
    expect(rendered).not.toContain('[:[');
    expect(rendered).not.toContain('已保存:');
  });

  it('契约 3: 无 local.path 的表情描述符仅渲染脱敏占位且不泄漏 URL 凭证，同时保留 attachments', () => {
    const descriptor: AttachmentDescriptor = {
      kind: 'sticker',
      origin: 'inbound',
      summary: '[动画表情]',
      remote: {
        fileUuid: 'uuid_sticker_remote_01',
        url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=SECRET_CREDENTIAL_XYZ',
      },
    };
    const [safeContent] = renderAttachments([descriptor]);
    expect(safeContent).toBe('[表情包]');
    expect(safeContent).not.toContain('rkey=');
    expect(safeContent).not.toContain('SECRET_CREDENTIAL_XYZ');

    db.saveMessage({
      msg_id: 'ROBOT1.0_STK_103',
      peer: PEER,
      user_id: MOCK_OPENID,
      sender_name: '好友C',
      time: 1793716520000,
      type: 'sticker',
      content: safeContent!,
      raw: '{}',
      file_id: 'uuid_sticker_remote_01',
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq',
      attachments: serializeAttachments([descriptor]),
    });

    const res = db.readHistory(PEER);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.local_path).toBeNull();
    expect(res.messages[0]!.content).toBe('[表情包]');
    const descriptors = deserializeAttachments(res.messages[0]!.attachments);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.remote?.fileUuid).toBe('uuid_sticker_remote_01');
  });

  it('契约 4: 真实 read_chat_history 工具调用装配闭环与 Lossless JSON 合规性', async () => {
    const filePath = path.join(tmpDir, 'cat.png');
    const descriptor: AttachmentDescriptor = {
      kind: 'sticker',
      origin: 'inbound',
      local: { path: filePath, format: 'png', md5: 'mock_cat_md5' },
      face: { id: 'face_mock_cat', mood: '嘲讽' },
    };
    db.saveMessage({
      msg_id: 'ROBOT1.0_STK_104',
      peer: PEER,
      user_id: MOCK_OPENID,
      sender_name: '好友A',
      time: 1793716530000,
      type: 'sticker',
      content: renderAttachments([descriptor])[0]!,
      raw: '{}',
      file_id: null,
      local_path: filePath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq',
      attachments: serializeAttachments([descriptor]),
    });

    expect(historyTool).toBeDefined();
    const result: ReadChatHistoryResult = await historyTool.execute(
      {},
      { agent: { session: { id: SESSION_ID } } }
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.msg_id).toBe('msg_1');
    expect(result.messages[0]!.local_path).toBe(filePath);
    expect(deserializeAttachments(result.messages[0]!.attachments)[0]!.face?.id).toBe(
      'face_mock_cat'
    );
    assertNoUndefinedFields(result);

    const renderedOutput = historyTool.output.render({}, result);
    expect(renderedOutput).toHaveLength(1);
    expect(renderedOutput[0].type).toBe('text');
    expect(renderedOutput[0].text).toContain('[msg_1]');
    expect(renderedOutput[0].text).toContain(
      `[表情包: face_mock_cat (情绪: 嘲讽) 路径: ${filePath}]`
    );
    expect(renderedOutput[0].text).not.toContain('ROBOT1.0_STK_104');
    expect(renderedOutput[0].text).not.toContain('好友A');
    expect(renderedOutput[0].text).not.toContain(MOCK_OPENID);
  });
});

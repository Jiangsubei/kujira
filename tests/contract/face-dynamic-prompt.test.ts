/**
 * tests/contract/face-dynamic-prompt.test.ts
 * 契约测试: 表情包动态情绪锚点 System Prompt 上下文注入 (Kujira C2C)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';
import { registerFacePromptContext } from '../../src/prompt/dynamic.js';
import { SnapshotManager } from '../../src/prompt/snapshot.js';
import { openidToSessionBaseId } from '../../src/utils/peer.js';

describe('契约测试: 表情包动态情绪锚点 System Prompt 上下文注入', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let mockCtx: any;
  const kujiraSessionId = openidToSessionBaseId('MOCK_OPENID_FACE_USER_01');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-face-prompt-'));
    db = new MessageDatabase(path.join(tmpDir, 'test.db'));

    const snapshotManager = new SnapshotManager({} as any);
    mockCtx = {
      snapshotManager,
      get: () => undefined,
    };
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: registerFacePromptContext 正确注册 kujira:face_summary 且 order 为 48', () => {
    const unregister = registerFacePromptContext(mockCtx, db);

    const promptObj = mockCtx.snapshotManager.getProvider('kujira:face_summary');
    expect(promptObj).toBeDefined();
    expect(promptObj.order).toBe(48);
    expect(mockCtx.snapshotManager.getProvider('napcat:face_summary')).toBeUndefined();

    unregister();
    expect(mockCtx.snapshotManager.getProvider('kujira:face_summary')).toBeUndefined();
  });

  it('契约 2: Kujira 单聊会话且库内有表情时，注入总数与 Top 情绪分布概览', () => {
    db.insertFace({
      id: 'f1',
      file_path: '/path/f1.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });
    db.insertFace({
      id: 'f2',
      file_path: '/path/f2.png',
      md5: 'md5_2',
      source: 'manual',
      tags: ['小猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });
    db.insertFace({
      id: 'f3',
      file_path: '/path/f3.png',
      md5: 'md5_3',
      source: 'manual',
      tags: ['熊猫头'],
      mood: '调侃',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    registerFacePromptContext(mockCtx, db);
    const promptObj = mockCtx.snapshotManager.getProvider('kujira:face_summary');

    const assembleCtx = {
      agent: {
        session: { id: kujiraSessionId },
      },
    };

    const text = promptObj.text(assembleCtx);
    expect(text).toContain('本地表情包库存 (Sticker & Meme Library)');
    expect(text).toContain('共 3 张可用表情包');
    expect(text).toContain('### 卖萌 (2)');
    expect(text).toContain('### 调侃 (1)');
    expect(text).toContain('- f1: 标签: 猫猫');
    expect(text).toContain('- f2: 标签: 小猫');
    expect(text).toContain('- f3: 标签: 熊猫头');
    expect(text).toContain('send_face(face_id="..."');
  });

  it('契约 3: Kujira 单聊会话且库为空时，输出空字符串保持静默', () => {
    registerFacePromptContext(mockCtx, db);
    const promptObj = mockCtx.snapshotManager.getProvider('kujira:face_summary');

    const assembleCtx = {
      agent: {
        session: { id: `${kujiraSessionId}-r1-1-a1b2c3` },
      },
    };

    const text = promptObj.text(assembleCtx);
    expect(text).toBe('');
  });

  it('契约 4: 非 Kujira 单聊会话（Web UI 及旧群聊格式）静默，输出为空字符串', () => {
    db.insertFace({
      id: 'f1',
      file_path: '/path/f1.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    registerFacePromptContext(mockCtx, db);
    const promptObj = mockCtx.snapshotManager.getProvider('kujira:face_summary');

    expect(promptObj.text({ agent: { session: { id: 'web-assistant-session-999' } } })).toBe('');
    expect(promptObj.text({ agent: { session: { id: 'qq-group-3000000014' } } })).toBe('');
    expect(promptObj.text({ agent: { session: { id: 'group_3000000014' } } })).toBe('');
  });

  it('契约 5: 上下文注入上限动态遵循 getFaceStoreMax 配置', () => {
    for (let i = 1; i <= 5; i++) {
      db.insertFace({
        id: `face_${i}`,
        file_path: `/path/face_${i}.png`,
        md5: `md5_face_${i}`,
        source: 'manual',
        tags: [`标签${i}`],
        mood: '测试',
        enabled: true,
        size: 100,
        format: 'png',
      });
    }

    registerFacePromptContext(mockCtx, db, () => 2);
    const promptObj = mockCtx.snapshotManager.getProvider('kujira:face_summary');

    const assembleCtx = {
      agent: {
        session: { id: kujiraSessionId },
      },
    };

    const text = promptObj.text(assembleCtx);
    expect(text).toContain('当前本地库共 5 张可用表情包（当前已列出前 2 张');
    expect(text).toContain('face_5');
    expect(text).toContain('face_4');
    expect(text).not.toContain('face_1');
  });
});

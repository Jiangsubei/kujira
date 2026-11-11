import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import type { MessageRecord } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const OPENID_A = '0123456789ABCDEF0123456789ABCDEF';
const OPENID_B = 'FEDCBA9876543210FEDCBA9876543210';
const PEER_A = openidToPeer(OPENID_A);
const PEER_B = openidToPeer(OPENID_B);

describe('契约测试: SQLite 消息存储、三 ID 隔离与单聊多条件查询 (Storage & Query Contract)', () => {
  let tmpDir: string;
  let dbFile: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-db-'));
    dbFile = path.join(tmpDir, 'test_messages.sqlite');
    db = new MessageDatabase(dbFile);
    db.init();
  });

  afterEach(async () => {
    if (db) db.close();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 字符串 msg_id、ref_idx 保真入库与按 ref_idx 精确检索', () => {
    const record: MessageRecord = {
      msg_id: 'ROBOT1.0_in_1001',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: '测试用户',
      time: 1788045798000,
      type: 'image',
      content: '[图片:/path/to/img.png] 拼接消息测试',
      raw: JSON.stringify({ id: 'ROBOT1.0_in_1001', content: '拼接消息测试' }),
      ref_idx: 'REFIDX_1001_ABC',
      file_id: 'C488.png',
      local_path: '/path/to/img.png',
      fingerprint: 'sha256_hash_value',
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq',
      attachments: JSON.stringify([{ kind: 'image', origin: 'inbound', local: { path: '/path/to/img.png' } }]),
    };

    db.saveMessage(record);

    expect(db.hasMessage('ROBOT1.0_in_1001')).toBe(true);
    expect(db.hasMessage('ROBOT1.0_not_found')).toBe(false);

    const fetched = db.getMessage('ROBOT1.0_in_1001');
    expect(fetched).not.toBeNull();
    expect(fetched?.msg_id).toBe('ROBOT1.0_in_1001');
    expect(fetched?.peer).toBe(PEER_A);
    expect(fetched?.ref_idx).toBe('REFIDX_1001_ABC');
    expect(fetched?.content).toBe('[图片:/path/to/img.png] 拼接消息测试');
    expect(fetched?.fingerprint).toBe('sha256_hash_value');
    expect(fetched?.recalled).toBe(0);
    expect(fetched?.source).toBe('qq');

    const byRef = db.getMessageByRefIdx('REFIDX_1001_ABC');
    expect(byRef).not.toBeNull();
    expect(byRef?.msg_id).toBe('ROBOT1.0_in_1001');
    expect(db.getMessageByRefIdx('REFIDX_NON_EXISTENT')).toBeNull();
  });

  it('契约 2: 读历史记录支持多条件组合筛选与单聊 peer 强隔离', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_1',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 1000,
      type: 'text',
      content: 'Msg 1',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_2',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 2000,
      type: 'text',
      content: 'Msg 2',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_3',
      peer: PEER_A,
      user_id: 'bot',
      sender_name: 'Bot',
      time: 3000,
      type: 'text',
      content: 'Msg 3 (Bot)',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 1,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_4',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 4000,
      type: 'text',
      content: 'Msg 4',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_5',
      peer: PEER_B,
      user_id: OPENID_B,
      sender_name: 'Bob',
      time: 5000,
      type: 'text',
      content: 'Msg 5 (Other C2C Peer)',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(PEER_A, {
      exclude_self: true,
      since: 1500,
      limit: 10,
      order: 'desc',
    });

    expect(res.messages).toHaveLength(2);
    expect(res.messages[0].msg_id).toBe('ROBOT1.0_4');
    expect(res.messages[1].msg_id).toBe('ROBOT1.0_2');

    // 跨会话隔离断言: PEER_A 绝对查不到 PEER_B 的消息
    const resIso = db.readHistory(PEER_A, { since: 0 });
    expect(resIso.messages.some((m) => m.msg_id === 'ROBOT1.0_5')).toBe(false);
  });

  it('契约 3: 撤回通知按字符串 msg_id 更新状态（自身消息保留原文，用户消息脱敏占位）', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_user_2001',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 1000,
      type: 'text',
      content: '原消息内容',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_out_2002',
      peer: PEER_A,
      user_id: 'bot',
      sender_name: 'Bot',
      time: 2000,
      type: 'text',
      content: '机器人已撤回消息原文',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 1,
      reply_to: null,
    });

    db.markRecalled('ROBOT1.0_user_2001');
    db.markRecalled('ROBOT1.0_out_2002');

    const userMsg = db.getMessage('ROBOT1.0_user_2001');
    expect(userMsg?.recalled).toBe(1);
    expect(userMsg?.content).toBe('〔已撤回〕');

    const botMsg = db.getMessage('ROBOT1.0_out_2002');
    expect(botMsg?.recalled).toBe(1);
    expect(botMsg?.content).toBe('机器人已撤回消息原文');
  });

  it('契约 4: 关键词模糊检索 (keyword)', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_101',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 1000,
      type: 'text',
      content: '今天晚上讨论部署方案',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_102',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 2000,
      type: 'text',
      content: '明天吃火锅',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_103',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 3000,
      type: 'text',
      content: '部署方案文档已上传',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(PEER_A, { keyword: '部署' });
    expect(res.messages).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.messages.map((m) => m.msg_id)).toEqual(['ROBOT1.0_103', 'ROBOT1.0_101']);
  });

  it('契约 5: 发送者昵称模糊检索 (sender_name)', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_201',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: '张三【开发组】',
      time: 1000,
      type: 'text',
      content: 'Hello',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_202',
      peer: PEER_A,
      user_id: 'bot',
      sender_name: 'Kujira Bot',
      time: 2000,
      type: 'text',
      content: 'World',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 1,
      reply_to: null,
    });

    const res = db.readHistory(PEER_A, { sender_name: '张三' });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe('ROBOT1.0_201');
  });

  it('契约 6: 消息类型精确与多类型组合筛选 (type)', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_301',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 1000,
      type: 'text',
      content: '文字',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_302',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 2000,
      type: 'image',
      content: '[图片:a.png]',
      raw: '{}',
      file_id: 'img1',
      local_path: '/tmp/a.png',
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_303',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 3000,
      type: 'voice',
      content: '[语音: 3s]',
      raw: '{}',
      file_id: 'v1',
      local_path: '/tmp/v1.wav',
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_304',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 4000,
      type: 'card',
      content: '[卡片]',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const resImg = db.readHistory(PEER_A, { type: 'image' });
    expect(resImg.messages).toHaveLength(1);
    expect(resImg.messages[0].msg_id).toBe('ROBOT1.0_302');

    const resMedia = db.readHistory(PEER_A, { type: ['image', 'voice'] });
    expect(resMedia.messages).toHaveLength(2);
    expect(resMedia.messages.map((m) => m.msg_id)).toEqual(['ROBOT1.0_303', 'ROBOT1.0_302']);
  });

  it('契约 7: 人性化相对时间解析与范围筛选 (relative / since 相对表达式)', () => {
    const now = Date.now();
    db.saveMessage({
      msg_id: 'ROBOT1.0_401',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: now - 30 * 60 * 1000,
      type: 'text',
      content: '半小时前',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_402',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: now - 3 * 3600 * 1000,
      type: 'text',
      content: '三小时前',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_403',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: now - 2 * 86400 * 1000,
      type: 'text',
      content: '两天前',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res1h = db.readHistory(PEER_A, { relative: '1h' });
    expect(res1h.messages).toHaveLength(1);
    expect(res1h.messages[0].msg_id).toBe('ROBOT1.0_401');

    const res4h = db.readHistory(PEER_A, { since: '4h' });
    expect(res4h.messages).toHaveLength(2);
    expect(res4h.messages.map((m) => m.msg_id)).toEqual(['ROBOT1.0_401', 'ROBOT1.0_402']);
  });

  it('契约 8: 友好日期字符串时间解析与筛选 (since / until)', () => {
    const t1 = new Date('2026-08-30T10:00:00+08:00').getTime();
    const t2 = new Date('2026-08-31T10:00:00+08:00').getTime();

    db.saveMessage({
      msg_id: 'ROBOT1.0_501',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: t1,
      type: 'text',
      content: '8月30日消息',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_502',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: t2,
      type: 'text',
      content: '8月31日消息',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(PEER_A, { since: '2026-08-31' });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe('ROBOT1.0_502');
  });

  it('契约 9: 附件/文件存在性筛选 (has_file)', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_601',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 1000,
      type: 'text',
      content: '普通文本',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_602',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 2000,
      type: 'file',
      content: '[文件:doc.pdf]',
      raw: '{}',
      file_id: 'f_602',
      local_path: '/path/doc.pdf',
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(PEER_A, { has_file: true });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe('ROBOT1.0_602');
    expect(res.messages[0].file_id).toBe('f_602');
  });

  it('契约 10: 机器人自身消息过滤与定向筛选 (exclude_self / self_only)', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_701',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'User 1',
      time: 1000,
      type: 'text',
      content: '用户说',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_702',
      peer: PEER_A,
      user_id: 'bot',
      sender_name: 'Bot',
      time: 2000,
      type: 'text',
      content: '机器人回复',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 1,
      reply_to: 'ROBOT1.0_701',
    });

    const resEx = db.readHistory(PEER_A, { exclude_self: true });
    expect(resEx.messages).toHaveLength(1);
    expect(resEx.messages[0].msg_id).toBe('ROBOT1.0_701');

    const resSelf = db.readHistory(PEER_A, { self_only: true });
    expect(resSelf.messages).toHaveLength(1);
    expect(resSelf.messages[0].msg_id).toBe('ROBOT1.0_702');
  });

  it('契约 11: 引用回复链关系筛选 (字符串 reply_to)', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_801',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 1000,
      type: 'text',
      content: '原始问题',
      raw: '{}',
      ref_idx: 'REFIDX_801',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_802',
      peer: PEER_A,
      user_id: 'bot',
      sender_name: 'Bot',
      time: 2000,
      type: 'reply',
      content: '回答问题',
      raw: '{}',
      ref_idx: 'REFIDX_802',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 1,
      reply_to: 'REFIDX_801',
    });

    const res = db.readHistory(PEER_A, { reply_to: 'REFIDX_801' });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].msg_id).toBe('ROBOT1.0_802');
    expect(res.messages[0].reply_to).toBe('REFIDX_801');
    expect(res.messages[0].ref_idx).toBe('REFIDX_802');
  });

  it('契约 12: 消息出参携带格式化人类可读时间 (formatted_time)', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_901',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'U1',
      time: 1725062400000,
      type: 'text',
      content: '时间测试',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const res = db.readHistory(PEER_A, { limit: 1 });
    expect(res.messages[0].formatted_time).toBeDefined();
    expect(typeof res.messages[0].formatted_time).toBe('string');
    expect(res.messages[0].formatted_time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('契约 13: saveMessageIfNotExists 幂等保护与异常 attachments JSON 容错读取', () => {
    const firstInsert = db.saveMessageIfNotExists({
      msg_id: 'ROBOT1.0_1001',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 1000,
      type: 'image',
      content: '[图片:/keep/original.png]',
      raw: '{}',
      file_id: 'fid_1001',
      local_path: '/keep/original.png',
      fingerprint: 'fp_1',
      recalled: 0,
      self: 0,
      reply_to: null,
      attachments: '{broken-json',
    });
    expect(firstInsert).toBe(true);

    // 重复插入同一 msg_id 时不得覆盖已有 local_path
    const dupInsert = db.saveMessageIfNotExists({
      msg_id: 'ROBOT1.0_1001',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 1000,
      type: 'image',
      content: 'should-not-overwrite',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    expect(dupInsert).toBe(false);
    expect(db.getMessage('ROBOT1.0_1001')?.local_path).toBe('/keep/original.png');

    // 损坏的 attachments JSON 容错回退为 null，绝不阻断历史读取
    const res = db.readHistory(PEER_A, { limit: 10 });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].attachments).toBeNull();

    // updateMessageMedia 支持局部补全且不携带 busid
    db.updateMessageMedia('ROBOT1.0_1001', {
      ref_idx: 'REFIDX_PATCHED',
      attachments: JSON.stringify([{ kind: 'image', origin: 'inbound' }]),
    });
    const patched = db.getMessage('ROBOT1.0_1001');
    expect(patched?.ref_idx).toBe('REFIDX_PATCHED');
    expect(patched?.local_path).toBe('/keep/original.png');
    expect(patched?.attachments).toBe(JSON.stringify([{ kind: 'image', origin: 'inbound' }]));
  });

  it('契约 14: parseTimeValue 支持英文自然相对时间 ("1 hour", "2 hrs", "30 mins", "1 day", "2 weeks")', async () => {
    const { parseTimeValue } = await import('../../src/storage/database.js');
    const now = Date.now();

    const oneHour = parseTimeValue('1 hour');
    expect(oneHour).toBeDefined();
    expect(Math.abs(now - 3600000 - oneHour!)).toBeLessThan(1000);

    const twoHours = parseTimeValue('2 hours');
    expect(twoHours).toBeDefined();
    expect(Math.abs(now - 7200000 - twoHours!)).toBeLessThan(1000);

    const thirtyMins = parseTimeValue('30 mins');
    expect(thirtyMins).toBeDefined();
    expect(Math.abs(now - 1800000 - thirtyMins!)).toBeLessThan(1000);

    const oneDay = parseTimeValue('1 day');
    expect(oneDay).toBeDefined();
    expect(Math.abs(now - 86400000 - oneDay!)).toBeLessThan(1000);

    const twoWeeks = parseTimeValue('2 weeks');
    expect(twoWeeks).toBeDefined();
    expect(Math.abs(now - 14 * 86400000 - twoWeeks!)).toBeLessThan(1000);
  });

  it('契约 15: readHistory 按 type="text" 查询时兼顾包含带引用的回复文本 (type="reply")', () => {
    db.saveMessage({
      msg_id: 'ROBOT1.0_3001',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 1000,
      type: 'text',
      content: '普通纯文本',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_3002',
      peer: PEER_A,
      user_id: 'bot',
      sender_name: 'Bot',
      time: 2000,
      type: 'reply',
      content: '带引用的回复文本',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 1,
      reply_to: 'ROBOT1.0_3001',
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_3003',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: 'Alice',
      time: 3000,
      type: 'image',
      content: '[图片:/a.png]',
      raw: '{}',
      file_id: null,
      local_path: '/a.png',
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const resText = db.readHistory(PEER_A, { type: 'text' });
    expect(resText.messages.map((m) => m.msg_id)).toEqual(['ROBOT1.0_3002', 'ROBOT1.0_3001']);

    const resReply = db.readHistory(PEER_A, { type: 'reply' });
    expect(resReply.messages.map((m) => m.msg_id)).toEqual(['ROBOT1.0_3002']);
  });

  it('契约 16: parseTimeValue 支持裸时间 ("19:00", "19:00:00")，自动补全本地当前日期且支持防未来跨天回退', async () => {
    vi.useFakeTimers();
    const mockNow = new Date(2026, 9, 30, 12, 0, 0, 0);
    vi.setSystemTime(mockNow);
    try {
      const { parseTimeValue } = await import('../../src/storage/database.js');
      const now = new Date();

      const ts19 = parseTimeValue('19:00', false);
      expect(ts19).toBeDefined();
      const d19 = new Date(ts19!);
      expect(d19.getHours()).toBe(19);
      expect(d19.getMinutes()).toBe(0);
      expect(d19.getSeconds()).toBe(0);
      expect(d19.getMilliseconds()).toBe(0);

      const ts19End = parseTimeValue('19:00', true);
      expect(ts19End).toBeDefined();
      const d19End = new Date(ts19End!);
      expect(d19End.getHours()).toBe(19);
      expect(d19End.getMinutes()).toBe(0);
      expect(d19End.getSeconds()).toBe(59);
      expect(d19End.getMilliseconds()).toBe(999);

      const futureHour = (now.getHours() + 2) % 24;
      if (futureHour > now.getHours()) {
        const futureTimeStr = `${String(futureHour).padStart(2, '0')}:00`;
        const tsFuture = parseTimeValue(futureTimeStr, false);
        expect(tsFuture).toBeDefined();
        expect(tsFuture!).toBeLessThan(now.getTime());
        const dFuture = new Date(tsFuture!);
        const yesterday = new Date(now.getTime() - 86400000);
        expect(dFuture.getDate()).toBe(yesterday.getDate());
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('契约 17: parseTimeValue 支持省略年份的月日格式 ("10-30 19:00", "10-30") 并正确识别为当年', async () => {
    const { parseTimeValue } = await import('../../src/storage/database.js');
    const now = new Date();
    const currentYear = now.getFullYear();

    const ts = parseTimeValue('10-30 19:00', false);
    expect(ts).toBeDefined();
    const d = new Date(ts!);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(30);
    expect(d.getHours()).toBe(19);
    expect(d.getMinutes()).toBe(0);
    expect(d.getFullYear()).toBe(currentYear);
  });

  it('契约 18: readHistory 传入裸时间 since: "19:00" 正确生效，不再退回最早历史老消息', () => {
    vi.useFakeTimers();
    const mockNow = new Date(2026, 9, 30, 20, 0, 0, 0);
    vi.setSystemTime(mockNow);
    try {
      const now = new Date();
      const oldTime = new Date('2026-08-30T08:40:00+08:00').getTime();
      const today18 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0).getTime();
      const today1930 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 30, 0).getTime();

      db.saveMessage({
        msg_id: 'ROBOT1.0_5001',
        peer: PEER_A,
        user_id: OPENID_A,
        sender_name: 'U1',
        time: oldTime,
        type: 'text',
        content: '8月30日历史老消息',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });
      db.saveMessage({
        msg_id: 'ROBOT1.0_5002',
        peer: PEER_A,
        user_id: OPENID_A,
        sender_name: 'U1',
        time: today18,
        type: 'text',
        content: '今天18点消息',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });
      db.saveMessage({
        msg_id: 'ROBOT1.0_5003',
        peer: PEER_A,
        user_id: OPENID_A,
        sender_name: 'U1',
        time: today1930,
        type: 'text',
        content: '今天19点半消息',
        raw: '{}',
        file_id: null,
        local_path: null,
        fingerprint: null,
        recalled: 0,
        self: 0,
        reply_to: null,
      });

      const res = db.readHistory(PEER_A, { since: '19:00', order: 'asc' });
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].msg_id).toBe('ROBOT1.0_5003');
      expect(res.messages[0].content).toBe('今天19点半消息');
    } finally {
      vi.useRealTimers();
    }
  });

  it('契约 19: peer_openid_map 方案 A 双向映射读写与备注保护', () => {
    expect(db.getOpenidByPeer(PEER_A)).toBeNull();
    expect(db.getPeerByOpenid(OPENID_A)).toBeNull();

    db.upsertPeerOpenid(PEER_A, OPENID_A, '初始备注');
    expect(db.getOpenidByPeer(PEER_A)).toBe(OPENID_A);
    expect(db.getPeerByOpenid(OPENID_A)).toBe(PEER_A);

    // 省略 remark 再次刷新时，不覆盖已有 remark
    db.upsertPeerOpenid(PEER_A, OPENID_A);
    const row1 = (db as any).db
      .prepare('SELECT remark FROM peer_openid_map WHERE peer = ?')
      .get(PEER_A) as { remark: string };
    expect(row1.remark).toBe('初始备注');

    // 显式传 remark 时更新
    db.upsertPeerOpenid(PEER_A, OPENID_A, '新备注');
    const row2 = (db as any).db
      .prepare('SELECT remark FROM peer_openid_map WHERE peer = ?')
      .get(PEER_A) as { remark: string };
    expect(row2.remark).toBe('新备注');
  });

  it('契约 20: inbound_reply_slots 槽位持久化、重启防重递增、40054005 跳槽与误用出站 ID 防护', () => {
    const inboundId1 = 'ROBOT1.0_in_slot_1';
    const inboundId2 = 'ROBOT1.0_in_slot_2';

    // 未登记 ID 且无 seed 时直接抛错（严防误将出站 body.id 当作被动锚点）
    expect(() => db.allocateNextMsgSeq('ROBOT1.0_unregistered_outbound')).toThrow(/Unregistered inbound msg_id/);

    // 登记入站锚点并原子分配 msg_seq
    db.recordInboundReplySlot(inboundId1, PEER_A, OPENID_A, 1000);
    expect(db.allocateNextMsgSeq(inboundId1)).toBe(1);
    expect(db.allocateNextMsgSeq(inboundId1)).toBe(2);

    // 重复登记同一入站锚点仅刷新 received_at，绝不回退 last_seq
    db.recordInboundReplySlot(inboundId1, PEER_A, OPENID_A, 1500);
    const slotBeforeRestart = db.getLatestValidInboundSlot(PEER_A);
    expect(slotBeforeRestart?.last_seq).toBe(2);
    expect(slotBeforeRestart?.received_at).toBe(1500);

    // 模拟进程重启：关闭并重新打开 SQLite 库，继续递增不得回退
    db.close();
    db = new MessageDatabase(dbFile);
    db.init();

    expect(db.allocateNextMsgSeq(inboundId1)).toBe(3);

    // 40054005 跨天残留跳槽持久化（如跳过 4 直接跳到 10）
    expect(db.advanceMsgSeq(inboundId1, 10)).toBe(10);
    expect(db.allocateNextMsgSeq(inboundId1)).toBe(11);
    // 传入较小的 minNextSeq 也不得倒退
    expect(db.advanceMsgSeq(inboundId1, 4)).toBe(12);

    // 登记更新的入站槽位应成为 getLatestValidInboundSlot 首选；将其作废后回落上一有效槽位
    db.recordInboundReplySlot(inboundId2, PEER_A, OPENID_A, 2000);
    expect(db.getLatestValidInboundSlot(PEER_A)?.msg_id).toBe(inboundId2);

    db.markInboundSlotInvalidated(inboundId2);
    expect(db.getLatestValidInboundSlot(PEER_A)?.msg_id).toBe(inboundId1);

    db.markInboundSlotInvalidated(inboundId1);
    expect(db.getLatestValidInboundSlot(PEER_A)).toBeNull();

    // 携带 seed 时允许自动补建并分配首槽 1
    expect(db.allocateNextMsgSeq('ROBOT1.0_in_seed', { peer: PEER_B, openid: OPENID_B })).toBe(1);
    expect(db.getLatestValidInboundSlot(PEER_B)?.last_seq).toBe(1);
  });

  it('契约 21: media_upload_cache 富媒体上传缓存命中与 TTL 过期失效', () => {
    const t0 = 1_780_000_000_000;
    const ttlMs = 86_400_000;

    db.saveCachedMediaUpload({
      openid: OPENID_A,
      md5: 'abc123md5',
      file_type: 1,
      file_info: 'FILE_INFO_BLOB_001',
      file_uuid: 'uuid_001',
      expires_at: t0 + ttlMs,
    });

    // 未过期命中
    const hit = db.getCachedMediaUpload(OPENID_A, 'abc123md5', 1, t0 + 10_000);
    expect(hit).toEqual({
      openid: OPENID_A,
      md5: 'abc123md5',
      file_type: 1,
      file_info: 'FILE_INFO_BLOB_001',
      file_uuid: 'uuid_001',
      expires_at: t0 + ttlMs,
    });

    // 不同 openid 或 file_type 不串用
    expect(db.getCachedMediaUpload(OPENID_B, 'abc123md5', 1, t0 + 10_000)).toBeNull();
    expect(db.getCachedMediaUpload(OPENID_A, 'abc123md5', 4, t0 + 10_000)).toBeNull();

    // 达到或超过 expires_at 过期失效
    expect(db.getCachedMediaUpload(OPENID_A, 'abc123md5', 1, t0 + ttlMs)).toBeNull();
    expect(db.getCachedMediaUpload(OPENID_A, 'abc123md5', 1, t0 + ttlMs + 1)).toBeNull();
  });
});

describe('契约测试: MediaStorageManager 媒体落盘与魔数推断 (Media Storage Contract)', () => {
  let tmpMediaDir: string;
  let mediaManager: any;

  beforeEach(async () => {
    tmpMediaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-media-'));
    const { MediaStorageManager } = await import('../../src/storage/media.js');
    mediaManager = new MediaStorageManager({ downloadDir: tmpMediaDir });
  });

  afterEach(async () => {
    if (tmpMediaDir) {
      await fsp.rm(tmpMediaDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: saveBuffer 对 GIF89a / GIF87a 魔数推断为 .gif，存盘后缀正确', async () => {
    const gif89Buffer = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00');
    const res89 = await mediaManager.saveBuffer(gif89Buffer, {
      type: 'sticker',
      sessionId: PEER_A,
    });
    expect(res89.localPath.endsWith('.gif')).toBe(true);
    const content89 = await fsp.readFile(res89.localPath);
    expect(content89.subarray(0, 6).toString('ascii')).toBe('GIF89a');

    const gif87Buffer = Buffer.from('GIF87a\x01\x00\x01\x00\x80\x00\x00');
    const res87 = await mediaManager.saveBuffer(gif87Buffer, {
      type: 'image',
      sessionId: PEER_A,
    });
    expect(res87.localPath.endsWith('.gif')).toBe(true);
  });

  it('契约 2: saveBuffer 对 PNG / JPEG / WebP 自动识别魔数', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const resPng = await mediaManager.saveBuffer(pngBuffer, { type: 'image' });
    expect(resPng.localPath.endsWith('.png')).toBe(true);

    const jpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const resJpg = await mediaManager.saveBuffer(jpgBuffer, { type: 'image' });
    expect(resJpg.localPath.endsWith('.jpg')).toBe(true);

    const webpBuffer = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.alloc(10),
    ]);
    const resWebp = await mediaManager.saveBuffer(webpBuffer, { type: 'sticker' });
    expect(resWebp.localPath.endsWith('.webp')).toBe(true);
  });

  it('契约 3: 已知魔数识别优先级高于外部传入的 options.ext（防止外部伪后缀污染）', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const resPng = await mediaManager.saveBuffer(pngBuffer, {
      type: 'sticker',
      ext: 'jpg',
    });
    expect(resPng.localPath.endsWith('.png')).toBe(true);

    const gifBuffer = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00');
    const resGif = await mediaManager.saveBuffer(gifBuffer, {
      type: 'sticker',
      ext: 'custom',
    });
    expect(resGif.localPath.endsWith('.gif')).toBe(true);
  });

  it('契约 4: 无法识别魔数的未知格式/二进制流，回退使用 options.ext 与默认后缀', async () => {
    const customBuffer = Buffer.from('some custom binary or text data');
    const res = await mediaManager.saveBuffer(customBuffer, {
      type: 'files',
      ext: 'custom',
    });
    expect(res.localPath.endsWith('.custom')).toBe(true);
  });
});

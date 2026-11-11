#!/usr/bin/env tsx
/**
 * QQ 官方 Bot API v2 空白协议实测探针（C2C 单聊专用）
 *
 * 覆盖此前尚未形成实证档案的关键协议空白：
 *   1. `author.user_openid` 与 `C2C_MESSAGE_CREATE` 真实原始字段形态；
 *   2. 单聊撤回接口 `DELETE /v2/users/{openid}/messages/{message_id}`（纯文本 / Markdown / 富媒体 / 重复撤回 / 越权撤回入站ID / ?hidetip / >120s 超时窗口）；
 *   3. 手机端用户长按「引用」机器人消息或自身消息时，`C2C_MESSAGE_CREATE` 携带的真实引用字段；
 *   4. 其余 Gateway 事件（`FRIEND_ADD` / `FRIEND_DEL` / `C2C_MSG_REJECT` / `C2C_MSG_RECEIVE` / 入站卡片/富媒体）原始载荷；
 *   5. 当前测试账号下不带 `msg_id` 的主动消息基础可用性。
 *
 * 注意：产物仅写入已忽略的 `logs/probe/`，严禁提交到 Git 仓库。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { QQProbeClient, resolveCredentials, type QQApiResult } from './lib/qq-probe-client.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `c2c-gaps-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `c2c-gaps-${stamp}.summary.json`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const md5Hex = (b: Buffer): string => crypto.createHash('md5').update(b).digest('hex');
const sha1Hex = (b: Buffer): string => crypto.createHash('sha1').update(b).digest('hex');

interface LogRec {
  ts: number;
  kind: 'dispatch' | 'req' | 'res' | 'note';
  step?: string;
  eventName?: string;
  payload: unknown;
}

const rawRecords: LogRec[] = [];
const summary: {
  startedAt: string;
  readyInfo?: unknown;
  openidShape?: unknown;
  inboundEvents: unknown[];
  otherDispatches: unknown[];
  recallProbes: Record<string, unknown>;
  delayedRecallProbe?: unknown;
  activeProbe?: unknown;
  anchors: Record<string, unknown>;
} = {
  startedAt: new Date().toISOString(),
  inboundEvents: [],
  otherDispatches: [],
  recallProbes: {},
  anchors: {},
};

function maskId(val: unknown, keepHead = 6, keepTail = 4): string {
  const s = String(val ?? '');
  if (!s) return '';
  if (s.length <= keepHead + keepTail) return s.slice(0, 2) + '***';
  return `${s.slice(0, keepHead)}...${s.slice(-keepTail)} (len=${s.length})`;
}

function sanitizeAttachmentMeta(a: any): Record<string, unknown> {
  let urlSummary = '';
  if (typeof a?.url === 'string' && a.url) {
    try {
      const u = new URL(a.url);
      urlSummary = `${u.host}${u.pathname}?<redacted>`;
    } catch {
      urlSummary = '<invalid-url>';
    }
  }
  let wavSummary = '';
  if (typeof a?.voice_wav_url === 'string' && a.voice_wav_url) {
    try {
      const u = new URL(a.voice_wav_url);
      wavSummary = `${u.host}${u.pathname}?<redacted>`;
    } catch {
      wavSummary = '<invalid-url>';
    }
  }
  return {
    keys: a && typeof a === 'object' ? Object.keys(a) : [],
    content_type: a?.content_type ?? null,
    filename: a?.filename ?? null,
    size: a?.size ?? null,
    width: a?.width ?? null,
    height: a?.height ?? null,
    content: a?.content ?? null,
    asr_refer_text: a?.asr_refer_text ?? null,
    has_voice_wav_url: Boolean(a?.voice_wav_url),
    url_redacted: urlSummary || null,
    voice_wav_url_redacted: wavSummary || null,
  };
}

function flush(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RAW_PATH, rawRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n', 'utf8');
}

function record(r: Omit<LogRec, 'ts'>): void {
  rawRecords.push({ ts: Date.now(), ...r });
}

async function uploadTinyPng(client: QQProbeClient, openid: string): Promise<{ ok: boolean; fileInfo?: string; error?: string }> {
  // 合法 1x1 像素透明 PNG
  const buf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const md5_10m = md5Hex(buf.subarray(0, Math.min(10002432, buf.length)));
  const prep = await client.apiPost(`/v2/users/${encodeURIComponent(openid)}/upload_prepare`, {
    file_type: 1,
    file_size: String(buf.length),
    file_name: 'recall-probe.png',
    md5: md5Hex(buf),
    sha1: sha1Hex(buf),
    md5_10m,
  });
  record({ kind: 'res', step: 'upload_prepare', payload: prep });
  if (!prep.ok || !prep.body?.upload_id || !Array.isArray(prep.body?.parts)) {
    return { ok: false, error: `upload_prepare failed: status=${prep.status} code=${prep.code} msg=${prep.message}` };
  }
  const uploadId = prep.body.upload_id as string;
  const globalBlockSize = Number(prep.body.block_size) || 10485760;
  const parts = [...prep.body.parts].sort((a: any, b: any) => Number(a.index) - Number(b.index));

  let offset = 0;
  for (const part of parts) {
    const partSize = Number(part.block_size) || globalBlockSize;
    const end = Math.min(offset + partSize, buf.length);
    const slice = buf.subarray(offset, end);
    offset = end;
    const putRes = await fetch(part.presigned_url, {
      method: 'PUT',
      body: new Uint8Array(slice),
    });
    if (!putRes.ok) {
      return { ok: false, error: `PUT part ${part.index} failed HTTP ${putRes.status}` };
    }
    const fin = await client.apiPost(`/v2/users/${encodeURIComponent(openid)}/upload_part_finish`, {
      upload_id: uploadId,
      part_index: part.index,
      block_size: String(slice.length),
      md5: md5Hex(slice),
    });
    if (!fin.ok) {
      return { ok: false, error: `upload_part_finish ${part.index} failed: ${fin.code} ${fin.message}` };
    }
  }

  const merged = await client.apiPost(`/v2/users/${encodeURIComponent(openid)}/files`, { upload_id: uploadId });
  record({ kind: 'res', step: 'upload_files', payload: merged });
  if (!merged.ok || !merged.body?.file_info) {
    return { ok: false, error: `files merge failed: status=${merged.status} code=${merged.code} msg=${merged.message}` };
  }
  return { ok: true, fileInfo: String(merged.body.file_info) };
}

function summarizeResult(res: QQApiResult): Record<string, unknown> {
  return {
    ok: res.ok,
    status: res.status,
    code: res.code ?? null,
    message: res.message ?? null,
    bodyKeys: res.body && typeof res.body === 'object' ? Object.keys(res.body) : typeof res.body,
    idMasked: res.body?.id ? maskId(res.body.id) : null,
    refIdxMasked: res.body?.ext_info?.ref_idx ? maskId(res.body.ext_info.ref_idx, 10, 6) : null,
    rawBodyIfNotOk: !res.ok ? res.body : undefined,
  };
}

async function runFirstRoundProbes(client: QQProbeClient, openid: string, inboundMsgId: string): Promise<void> {
  let seq = 1;

  // R1: 普通纯文本发送 + 1.5s 后撤回
  const r1Send = await client.sendMessage(openid, {
    msg_type: 0,
    content: '【探针 R1】1.5s 后尝试撤回此纯文本消息',
    msg_id: inboundMsgId,
    msg_seq: seq++,
  });
  record({ kind: 'res', step: 'R1_send', payload: r1Send });
  console.log(`[probe:gaps] R1 send: ok=${r1Send.ok} status=${r1Send.status} code=${r1Send.code ?? 'none'}`);
  if (r1Send.ok && r1Send.body?.id) {
    await sleep(1500);
    const r1Del = await client.deleteMessage(openid, r1Send.body.id);
    record({ kind: 'res', step: 'R1_delete', payload: r1Del });
    summary.recallProbes.R1_plainText = { send: summarizeResult(r1Send), delete: r1Del };
    console.log(`[probe:gaps] R1 DELETE: ok=${r1Del.ok} status=${r1Del.status} code=${r1Del.code ?? 'none'} body=${JSON.stringify(r1Del.body)}`);

    // R1_DUP: 重复撤回同一条消息
    const r1Dup = await client.deleteMessage(openid, r1Send.body.id);
    record({ kind: 'res', step: 'R1_delete_dup', payload: r1Dup });
    summary.recallProbes.R1_duplicateDelete = r1Dup;
    console.log(`[probe:gaps] R1_DUP DELETE: ok=${r1Dup.ok} status=${r1Dup.status} code=${r1Dup.code ?? 'none'} body=${JSON.stringify(r1Dup.body)}`);
  } else {
    summary.recallProbes.R1_plainText = { send: summarizeResult(r1Send) };
  }

  // R2: Markdown 发送 + 1.5s 后撤回
  const r2Send = await client.sendMessage(openid, {
    msg_type: 2,
    markdown: { content: '**【探针 R2】** 1.5s 后尝试撤回此 `Markdown` 消息' },
    msg_id: inboundMsgId,
    msg_seq: seq++,
  });
  record({ kind: 'res', step: 'R2_send', payload: r2Send });
  if (r2Send.ok && r2Send.body?.id) {
    await sleep(1500);
    const r2Del = await client.deleteMessage(openid, r2Send.body.id);
    record({ kind: 'res', step: 'R2_delete', payload: r2Del });
    summary.recallProbes.R2_markdown = { send: summarizeResult(r2Send), delete: r2Del };
    console.log(`[probe:gaps] R2 DELETE (md): ok=${r2Del.ok} status=${r2Del.status} code=${r2Del.code ?? 'none'} body=${JSON.stringify(r2Del.body)}`);
  } else {
    summary.recallProbes.R2_markdown = { send: summarizeResult(r2Send) };
  }

  // R3: 富媒体图片 msg_type=7 发送 + 1.5s 后撤回
  const up = await uploadTinyPng(client, openid);
  if (up.ok && up.fileInfo) {
    const r3Send = await client.sendMessage(openid, {
      msg_type: 7,
      content: ' ',
      media: { file_info: up.fileInfo },
      msg_id: inboundMsgId,
      msg_seq: seq++,
    });
    record({ kind: 'res', step: 'R3_send_media', payload: r3Send });
    if (r3Send.ok && r3Send.body?.id) {
      await sleep(1500);
      const r3Del = await client.deleteMessage(openid, r3Send.body.id);
      record({ kind: 'res', step: 'R3_delete_media', payload: r3Del });
      summary.recallProbes.R3_media = { send: summarizeResult(r3Send), delete: r3Del };
      console.log(`[probe:gaps] R3 DELETE (media): ok=${r3Del.ok} status=${r3Del.status} code=${r3Del.code ?? 'none'} body=${JSON.stringify(r3Del.body)}`);
    } else {
      summary.recallProbes.R3_media = { send: summarizeResult(r3Send) };
    }
  } else {
    summary.recallProbes.R3_media = { uploadError: up.error };
  }

  // R4: 发送带明确文字的【引用测试锚点】，保留不撤回
  const r4Send = await client.sendMessage(openid, {
    msg_type: 2,
    markdown: { content: '### 【引用测试锚点】\n请长按 **【引用】** 我这条消息回复任意内容，用来验证入站引用字段格式。' },
    msg_id: inboundMsgId,
    msg_seq: seq++,
  });
  record({ kind: 'res', step: 'R4_quote_anchor', payload: r4Send });
  summary.anchors.botQuoteAnchor = summarizeResult(r4Send);
  if (r4Send.body?.id) {
    summary.anchors.botQuoteAnchorRawIdsForCompare = {
      id: r4Send.body.id,
      ref_idx: r4Send.body?.ext_info?.ref_idx ?? null,
    };
  }
  console.log(`[probe:gaps] R4 quote anchor: ok=${r4Send.ok} refIdx=${maskId(r4Send.body?.ext_info?.ref_idx)}`);

  // R5: 发送【延时撤回目标】，约 135 秒后自动尝试撤回，检验 2 分钟时间窗是否存在
  const r5Send = await client.sendMessage(openid, {
    msg_type: 0,
    content: '【延时撤回测试目标】135 秒后将自动尝试撤回我，用来确认单聊是否有 2 分钟限制。',
    msg_id: inboundMsgId,
    msg_seq: seq++,
  });
  record({ kind: 'res', step: 'R5_delay_send', payload: r5Send });
  const r5Id = r5Send.body?.id as string | undefined;
  summary.anchors.delayedRecallTarget = summarizeResult(r5Send);
  if (r5Id) {
    setTimeout(() => {
      void (async () => {
        const res = await client.deleteMessage(openid, r5Id);
        record({ kind: 'res', step: 'R5_delayed_delete_135s', payload: res });
        summary.delayedRecallProbe = {
          elapsedSeconds: 135,
          targetMasked: maskId(r5Id),
          result: res,
        };
        flush();
        console.log(`\n[probe:gaps] R5 135s delayed DELETE: ok=${res.ok} status=${res.status} code=${res.code ?? 'none'} body=${JSON.stringify(res.body)}`);
      })();
    }, 135_000);
  }

  // R6: 测试 ?hidetip=true
  const r6Send = await client.sendMessage(openid, {
    msg_type: 0,
    content: '【探针 R6】1.5s 后测试 ?hidetip=true 撤回',
    msg_id: inboundMsgId,
    msg_seq: seq++,
  });
  record({ kind: 'res', step: 'R6_send', payload: r6Send });
  if (r6Send.ok && r6Send.body?.id) {
    await sleep(1500);
    const r6Del = await client.deleteMessage(openid, r6Send.body.id, 'hidetip=true');
    record({ kind: 'res', step: 'R6_delete_hidetip', payload: r6Del });
    summary.recallProbes.R6_hidetip = { send: summarizeResult(r6Send), delete: r6Del };
    console.log(`[probe:gaps] R6 DELETE ?hidetip=true: ok=${r6Del.ok} status=${r6Del.status} code=${r6Del.code ?? 'none'} body=${JSON.stringify(r6Del.body)}`);
  }

  // R7: 异常边界：撤回用户自己的入站 msg_id & 不存在的 message_id
  const r7Inbound = await client.deleteMessage(openid, inboundMsgId);
  record({ kind: 'res', step: 'R7_delete_user_inbound_id', payload: r7Inbound });
  const r7Bogus = await client.deleteMessage(openid, 'ROBOT1.0_nonexistent_test_000');
  record({ kind: 'res', step: 'R7_delete_bogus_id', payload: r7Bogus });
  summary.recallProbes.R7_errors = {
    deleteInboundMsgId: r7Inbound,
    deleteBogusMsgId: r7Bogus,
  };
  console.log(`[probe:gaps] R7 delete inbound ID: status=${r7Inbound.status} code=${r7Inbound.code} body=${JSON.stringify(r7Inbound.body)}`);
  console.log(`[probe:gaps] R7 delete bogus ID: status=${r7Bogus.status} code=${r7Bogus.code} body=${JSON.stringify(r7Bogus.body)}`);

  // R8: 无 msg_id 主动消息验证 + 给用户发操作指引
  const r8Active = await client.sendMessage(openid, {
    msg_type: 0,
    content:
      '【主动消息测试 + 需配合测试步骤】\n' +
      '刚才已自动测完即时撤回与异常码，现在请按顺序在手机端操作：\n' +
      '1. 长按上面的【引用测试锚点】并点“引用”，回复任意文字；\n' +
      '2. 再长按你刚才自己发出的第一条消息并点“引用”，回复任意文字；\n' +
      '3. （可选）可发送 1 张图片 / 语音 / 卡片或测试消息拒收开关；\n' +
      '4. 请留意上面的【延时撤回测试目标】大约 2 分钟后是否被成功撤回。',
  });
  record({ kind: 'res', step: 'R8_active_send', payload: r8Active });
  summary.activeProbe = summarizeResult(r8Active);
  console.log(`[probe:gaps] R8 active (no msg_id): ok=${r8Active.ok} status=${r8Active.status} code=${r8Active.code ?? 'none'}`);

  flush();
}

async function main(): Promise<void> {
  const creds = resolveCredentials();
  console.log(`[probe:gaps] 初始化客户端（AppID=${maskId(creds.appId, 4, 2)}）`);
  const client = new QQProbeClient({ credentials: creds, logger: (m) => console.log(m) });

  let firstHandled = false;

  client.onReady = (info) => {
    summary.readyInfo = { botId: info.botId, botName: info.botName, hasSessionId: Boolean(info.sessionId) };
    flush();
    console.log(`\n[probe:gaps] ✅ Bot 已上线 READY！请现在用手机 QQ 给「${info.botName}」发第一条消息...`);
  };

  client.onDispatch = (eventName, data, fullPayload) => {
    record({ kind: 'dispatch', eventName, payload: fullPayload });

    if (eventName !== 'READY' && eventName !== 'RESUMED' && eventName !== 'C2C_MESSAGE_CREATE') {
      console.log(`\n[probe:gaps] ★ 捕获非消息事件 t=${eventName}:`, JSON.stringify(data));
      summary.otherDispatches.push({
        ts: Date.now(),
        eventName,
        data,
      });
      flush();
      return;
    }

    if (eventName === 'C2C_MESSAGE_CREATE') {
      const openid = String(data?.author?.user_openid ?? '');
      const knownKeys = new Set(['id', 'content', 'timestamp', 'author', 'message_scene', 'message_type', 'attachments', 'group_openid', 'group_id']);
      const extraKeys = data && typeof data === 'object' ? Object.keys(data).filter((k) => !knownKeys.has(k)) : [];
      const extraFields: Record<string, unknown> = {};
      for (const k of extraKeys) extraFields[k] = data[k];

      if (!summary.openidShape && openid) {
        summary.openidShape = {
          length: openid.length,
          matchesHexUpper: /^[0-9A-F]+$/.test(openid),
          matchesHexAny: /^[0-9a-fA-F]+$/.test(openid),
          matchesAlphaNum: /^[0-9a-zA-Z]+$/.test(openid),
          hasHyphen: openid.includes('-'),
          hasUnderscore: openid.includes('_'),
          masked: maskId(openid),
        };
      }

      const evtSummary = {
        seqIndex: summary.inboundEvents.length + 1,
        ts: Date.now(),
        idMasked: maskId(data?.id, 10, 6),
        rawIdForCompare: data?.id ?? null,
        timestamp: data?.timestamp ?? null,
        message_type: data?.message_type ?? null,
        content: data?.content ?? null,
        authorKeys: data?.author ? Object.keys(data.author) : [],
        message_scene: data?.message_scene ?? null,
        extraKeys,
        extraFields: extraKeys.length > 0 ? extraFields : undefined,
        attachments: Array.isArray(data?.attachments) ? data.attachments.map(sanitizeAttachmentMeta) : undefined,
      };
      summary.inboundEvents.push(evtSummary);
      flush();

      console.log(`\n[probe:gaps] ← C2C_MESSAGE_CREATE #${evtSummary.seqIndex}: content=${JSON.stringify(data?.content)}`);
      console.log(`[probe:gaps]   keys=${Object.keys(data || {}).join(',')} scene=${JSON.stringify(data?.message_scene)} extra=${extraKeys.length ? JSON.stringify(extraFields) : 'none'}`);

      if (!firstHandled && openid && data?.id) {
        firstHandled = true;
        console.log('[probe:gaps] 开始执行首轮自动撤回 & 主动消息探针...');
        void runFirstRoundProbes(client, openid, String(data.id)).catch((err) => {
          console.error('[probe:gaps] runFirstRoundProbes 异常:', err);
        });
      }
    }
  };

  await client.start();

  // 最长等待 20 分钟
  setTimeout(() => {
    console.log('[probe:gaps] 达到 20 分钟保护超时，自动退出并落盘');
    flush();
    client.stop();
    process.exit(0);
  }, 20 * 60 * 1000);
}

void main().catch((err) => {
  console.error('[probe:gaps] 致命错误:', err);
  flush();
  process.exit(1);
});

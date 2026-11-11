#!/usr/bin/env tsx
/**
 * QQ 官方 Bot 引用/直发媒体入站形态探针（被动抓取，不发送任何消息）
 *
 * 目的：确认 `message_type=103` 引用消息的 `msg_elements[].content` 在「引用图片 / 视频 / 文件 /
 * 普通文本 / 合并转发」时到底是什么形态，为「文本媒体 URL 统一本地化」模块提供实测依据。
 *
 * 用法：
 *   pnpm probe:quote                  # 默认监听 25 分钟
 *   pnpm probe:quote -- --minutes=40
 *   pnpm probe:quote -- --out=logs/probe/custom.jsonl
 *
 * 凭据：QQ_BOT_APP_ID / QQ_BOT_SECRET（环境变量优先，其次 $DSH_HOME/.credentials.yaml）
 *
 * 产物（logs/ 已在 .gitignore 内）：
 *   - logs/probe/quote-<ts>.jsonl         每条入站事件一行（URL 凭证已掩码）
 *   - logs/probe/quote-<ts>.summary.json  形态指纹摘要
 *
 * 隐私：控制台与产物均对 openid / msg_id / rkey 凭证做掩码，不写入真实凭据。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { QQProbeClient, resolveCredentials } from './lib/qq-probe-client.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');

const argv = process.argv.slice(2);
const args = new Map<string, string>();
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}

const minutes = Number(args.get('minutes') ?? 25);
const OUT_PATH = path.resolve(args.get('out') ?? path.join(LOG_DIR, `quote-${stamp}.jsonl`));
const SUMMARY_PATH = OUT_PATH.replace(/\.jsonl$/, '.summary.json');

const URL_TOKEN_RE = /(https?:\/\/[^\s"'<>)\]]+)/gi;
const RKEY_RE = /([?&](?:rkey|token|sig|sign|auth|key)=)[^&\s"'<>)\]]+/gi;

/** 掩码 URL 中的访问凭证，仅保留 host + path 前段用于形态判断。 */
function maskUrl(raw: string): string {
  let out = raw.replace(RKEY_RE, (_m, prefix: string) => `${prefix}<masked>`);
  try {
    const u = new URL(out);
    const pathHead = u.pathname.length > 48 ? `${u.pathname.slice(0, 48)}…` : u.pathname;
    const queryKeys = [...u.searchParams.keys()].join(',');
    return `${u.protocol}//${u.host}${pathHead}${queryKeys ? `?[${queryKeys}]` : ''}`;
  } catch {
    return out.replace(/[A-Za-z0-9_-]{24,}/g, '<masked>');
  }
}

function maskText(text: string): string {
  return text.replace(URL_TOKEN_RE, (m) => maskUrl(m));
}

function maskId(id: unknown): string {
  const s = String(id ?? '');
  return s.length <= 10 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

interface ShapeFingerprint {
  index: number;
  message_type: unknown;
  contentLength: number;
  attachmentCount: number;
  attachmentTypes: string[];
  elementCount: number;
  elementShapes: Array<{
    message_type: unknown;
    length: number;
    hasForwardHeader: boolean;
    hasAttachmentLine: boolean;
    hasUrlMarker: boolean;
    hasBareUrl: boolean;
    hasImagePlaceholder: boolean;
    preview: string;
  }>;
  parallelNodeShapes: Array<{ message_type: unknown; length: number; hasUrlMarker: boolean }>;
  hasMsgElements: boolean;
  hasAttachments: boolean;
}

function analyze(event: any, index: number): ShapeFingerprint {
  const content = String(event?.content ?? '');
  const attachments: any[] = Array.isArray(event?.attachments) ? event.attachments : [];
  const elements: any[] = Array.isArray(event?.msg_elements) ? event.msg_elements : [];
  const nodes: any[] = Array.isArray(event?.parallel_message?.msg_nodes)
    ? event.parallel_message.msg_nodes
    : [];

  const elementShapes = elements.map((el) => {
    const text = String(el?.content ?? '');
    return {
      message_type: el?.message_type,
      length: text.length,
      hasForwardHeader: /(?:^|\n)\s*===\s*消息\s*\d+\s*===/.test(text),
      hasAttachmentLine: /\[附件\d+\]/.test(text),
      hasUrlMarker: /URL\s*:\s*https?:\/\//i.test(text),
      hasBareUrl: /https?:\/\//i.test(text) && !/URL\s*:\s*https?:\/\//i.test(text),
      hasImagePlaceholder: /\[图片\]|\[图片[:：]/.test(text),
      preview: maskText(text).slice(0, 400),
    };
  });

  return {
    index,
    message_type: event?.message_type,
    contentLength: content.length,
    attachmentCount: attachments.length,
    attachmentTypes: attachments.map(
      (a) => `${a?.content_type ?? '?'}${a?.filename ? `:${a.filename}` : ''}`
    ),
    elementCount: elements.length,
    elementShapes,
    parallelNodeShapes: nodes.map((n) => {
      const text = String(n?.content ?? '');
      return {
        message_type: n?.message_type,
        length: text.length,
        hasUrlMarker: /URL\s*:\s*https?:\/\//i.test(text),
      };
    }),
    hasMsgElements: elements.length > 0,
    hasAttachments: attachments.length > 0,
  };
}

/** 递归掩码：openid / msg_id / ref_idx / URL 凭证。 */
function sanitizePayload(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, raw) => {
      if (typeof raw !== 'string') return raw;
      if (/openid$/i.test(key)) return maskId(raw);
      if (/^(id|msg_id|msg_idx|ref_msg_idx|ref_idx)$/i.test(key)) return maskId(raw);
      if (/^(content|text)$/i.test(key)) return maskText(raw);
      if (/url$/i.test(key)) return maskUrl(raw);
      return raw;
    })
  );
}

function main(): void {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const creds = resolveCredentials();
  console.log(`[probe:quote] AppID=${creds.appId}（Secret 已就绪，不回显）`);
  console.log(`[probe:quote] 产物: ${OUT_PATH}`);
  console.log(
    '[probe:quote] 采集窗口: ' + (Number.isFinite(minutes) && minutes > 0 ? `${minutes} 分钟` : '不限')
  );

  const client = new QQProbeClient({ credentials: creds, logger: (m) => console.log(m) });
  const records: Array<{ at: string; shape: ShapeFingerprint; payload: unknown }> = [];
  let index = 0;

  const flush = (): void => {
    fs.writeFileSync(OUT_PATH, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify(
        {
          probe: 'QQ-QUOTE-SHAPE',
          ranAt: new Date().toISOString(),
          rawPath: OUT_PATH,
          events: records.map((r) => ({ at: r.at, ...r.shape })),
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    console.log(`\n[probe:quote] 已写入 ${records.length} 条事件`);
    console.log(`[probe:quote] 原始: ${OUT_PATH}`);
    console.log(`[probe:quote] 摘要: ${SUMMARY_PATH}`);
  };

  client.onC2CMessage = (event: any) => {
    index += 1;
    const shape = analyze(event, index);
    records.push({ at: new Date().toISOString(), shape, payload: sanitizePayload(event) });

    console.log('\n' + '─'.repeat(70));
    console.log(
      `[probe:quote] #${index} message_type=${String(shape.message_type)} ` +
        `attachments=${shape.attachmentCount} msg_elements=${shape.elementCount}`
    );
    if (shape.attachmentCount > 0) {
      console.log(`[probe:quote]   attachments: ${shape.attachmentTypes.join(' | ')}`);
    }
    for (const [i, el] of shape.elementShapes.entries()) {
      console.log(
        `[probe:quote]   msg_elements[${i}] type=${String(el.message_type)} len=${el.length} ` +
          `forward=${el.hasForwardHeader} 附件行=${el.hasAttachmentLine} URL标记=${el.hasUrlMarker} ` +
          `裸URL=${el.hasBareUrl} 图片占位=${el.hasImagePlaceholder}`
      );
      console.log(`[probe:quote]     ${el.preview.replace(/\n/g, ' ⏎ ')}`);
    }
    console.log(`[probe:quote]   content: ${maskText(String(event?.content ?? '')).slice(0, 300)}`);
    flush();
  };

  const timeout =
    Number.isFinite(minutes) && minutes > 0
      ? setTimeout(() => {
          console.log(`\n[probe:quote] 采集窗口结束（${minutes} 分钟）`);
          flush();
          client.stop();
          process.exit(0);
        }, minutes * 60 * 1000)
      : null;

  process.on('SIGINT', () => {
    if (timeout) clearTimeout(timeout);
    console.log('\n[probe:quote] 收到中断，落盘退出');
    flush();
    client.stop();
    process.exit(0);
  });

  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待 READY 超时（30s）：WS 未就绪')), 30_000);
    client.onReady = () => {
      clearTimeout(t);
      resolve();
    };
  });

  void client
    .start()
    .then(() => ready)
    .then(() => {
      console.log('[probe:quote] ✅ 机器人已上线，等待入站消息（不会回复任何内容）');
    })
    .catch((err) => {
      console.error('[probe:quote] 启动失败:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

main();

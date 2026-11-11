/**
 * kujira: 单聊短消息 ID 规范与纯函数校验/解析工具
 *
 * 按单聊会话 (peer) 持久化单调自增序号格式化短消息 ID，隔离底层 QQ 协议长 ID：
 * - 入站用户消息：`msg_<n>`（n 为正整数，从 1 开始）
 * - 出站机器人消息：`msg_self_<n>`（n 为正整数，从 1 开始）
 */

export const SHORT_INBOUND_MSG_ID_RE = /^msg_([1-9]\d*)$/;

export const SHORT_OUTBOUND_MSG_ID_RE = /^msg_self_([1-9]\d*)$/;

export const SHORT_MSG_ID_RE = /^msg_(?:self_)?[1-9]\d*$/;

export type ShortMessageDirection = 'inbound' | 'outbound';

export interface ParsedShortMessageId {
  direction: ShortMessageDirection;
  seq: number;
  shortId: string;
}

/** 校验是否为合法的入站短消息 ID（`msg_<n>`，n 为正整数） */
export function isShortInboundMessageId(id: unknown): id is string {
  return typeof id === 'string' && SHORT_INBOUND_MSG_ID_RE.test(id);
}

/** 校验是否为合法的出站短消息 ID（`msg_self_<n>`，n 为正整数） */
export function isShortOutboundMessageId(id: unknown): id is string {
  return typeof id === 'string' && SHORT_OUTBOUND_MSG_ID_RE.test(id);
}

/** 校验是否为合法的单聊短消息 ID（`msg_<n>` 或 `msg_self_<n>`） */
export function isShortMessageId(id: unknown): id is string {
  return typeof id === 'string' && SHORT_MSG_ID_RE.test(id);
}

/**
 * 解析单聊短消息 ID（先 trim 空白再匹配），返回方向、正整数序号与规范化短 ID；
 * 非法输入返回 `null`。
 */
export function parseShortMessageId(id: unknown): ParsedShortMessageId | null {
  if (typeof id !== 'string') {
    return null;
  }
  const trimmed = id.trim();
  const match =
    SHORT_OUTBOUND_MSG_ID_RE.exec(trimmed) ?? SHORT_INBOUND_MSG_ID_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    return null;
  }
  const direction: ShortMessageDirection = trimmed.startsWith('msg_self_')
    ? 'outbound'
    : 'inbound';
  return {
    direction,
    seq,
    shortId: trimmed,
  };
}

/**
 * 按消息方向与正整数序号生成标准短消息 ID：
 * - `Boolean(self) === true` -> `msg_self_${seq}`
 * - `Boolean(self) === false` -> `msg_${seq}`
 */
export function formatShortMessageId(self: boolean | number, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError(`Invalid short message sequence: ${seq}. Expected a positive integer.`);
  }
  return Boolean(self) ? `msg_self_${seq}` : `msg_${seq}`;
}

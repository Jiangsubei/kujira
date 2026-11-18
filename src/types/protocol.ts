/**
 * kujira: QQ 官方 Bot API v2 单聊网关与 REST 协议契约
 *
 * 所有字段与边界约束均严格对齐 QQ 开放平台实测响应（而非官方文档滞后描述）：
 * - 入站 `msg_id` (`C2C_MESSAGE_CREATE d.id`) 与出站撤回 `id` (`body.id`) 及引用 `ref_idx` (`REFIDX_...`) 严格三 ID 隔离；
 * - 分片上传 `parts[].index` 为 1-based，且 `file_size`/`block_size` 为字符串；
 * - 流式发送必须携带入站 `msg_id`（无 `msg_id` 必报 50015001），且单次 `content_raw` 受 UTF-8 字节上限约束。
 */

/** 统一 REST API 调用结果封装（保留 HTTP 状态码与业务错误码） */
export interface QQApiResult<T = any> {
  ok: boolean;
  status: number;
  /** QQ 在 HTTP 200 或 4xx 的 body 中可能携带的业务错误码（如 40007、40054005、40064004） */
  code?: string | number;
  message?: string;
  body: T;
}

/** 入站附件对象（实测无需鉴权头即可裸 GET；语音以 content_type === 'voice' 为准） */
export interface QQAttachment {
  content_type?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  /** 带访问凭证的下载地址（严禁将完整 query 明文落盘日志或注入模型上下文） */
  url?: string;
  /** 官方提供的语音 WAV 转码地址（audio/x-wav） */
  voice_wav_url?: string;
  /** 官方自带语音识别转写文本 */
  asr_refer_text?: string;
  content?: string;
}

/** 入站卡片 / 小程序结构化载荷（message_type=3 时附带） */
export interface QQArkData {
  ark_name?: string;
  ark_type?: string;
  fields?: Record<string, string>;
  prompt?: string;
}

/** 入站引用展开元素（message_type=103 时附带） */
export interface QQMsgElement {
  content?: string;
  message_type?: number;
  msg_idx?: string;
  /**
   * 被引用原消息的附件（实测：引用图片/视频时官方直接下发结构化附件，
   * `content` 为空串；引用文件时可能缺失，需回退 `parallel_message` 形态摘要）。
   */
  attachments?: QQAttachment[];
}

/** C2C 单聊事件发送者（实测 username 可能为空或下发真实昵称；2026-11-18 实测已下发 username 与 avatar） */
export interface QQC2CAuthor {
  avatar?: string;
  bot?: boolean;
  id?: string;
  union_openid?: string;
  /** 实测为 32 位大写十六进制用户标识 */
  user_openid: string;
  username?: string;
}

/** 消息场景扩展信息（ext 数组内含 msg_idx=REFIDX_... 与 ref_msg_idx=REFIDX_.../TMP_...） */
export interface QQMessageScene {
  ext?: string[];
  source?: string;
}

/** 复合引用消息底层形态摘要 */
export interface QQParallelMessageNode {
  content?: string;
  message_type?: number;
}

export interface QQParallelMessage {
  msg_nodes?: QQParallelMessageNode[];
}

/** Gateway DISPATCH: C2C_MESSAGE_CREATE 单聊入站消息事件 */
export interface QQC2CMessageCreateEvent {
  /** 入站被动回复锚点（如 ROBOT1.0_...） */
  id: string;
  content: string;
  /** ISO-8601 带时区时间戳 */
  timestamp: string;
  author: QQC2CAuthor;
  /** 0=普通/富媒体, 3=卡片, 102=合并转发(已展开至 content), 103=引用消息 */
  message_type?: number;
  message_scene?: QQMessageScene;
  attachments?: QQAttachment[];
  msg_elements?: QQMsgElement[];
  parallel_message?: QQParallelMessage;
  ark_data?: QQArkData;
}

/** Gateway READY 事件中的机器人身份信息 */
export interface QQReadyUser {
  id: string;
  username: string;
  bot?: boolean;
}

/** Gateway DISPATCH: READY 就绪事件 */
export interface QQReadyEvent {
  version?: number;
  session_id: string;
  user: QQReadyUser;
  shard?: [number, number];
}

/** QQ Gateway 操作码 */
export type QQGatewayOpcode = 0 | 1 | 2 | 6 | 7 | 9 | 10 | 11;

/** QQ Gateway 通用帧结构 */
export interface QQGatewayPayload<T = any> {
  op: QQGatewayOpcode | number;
  d?: T;
  s?: number | null;
  t?: string | null;
  id?: string;
}

/** 单聊普通/富媒体/状态消息发送请求体（POST /v2/users/{openid}/messages） */
export interface QQSendMessagePayload {
  /** 0=纯文本, 2=Markdown, 6=输入中状态, 7=富媒体 */
  msg_type: 0 | 2 | 6 | 7;
  content?: string;
  markdown?: { content: string };
  input_notify?: { input_type: 1; input_second: number };
  media?: { file_info: string };
  /** 引用目标消息的 ref_idx（REFIDX_...），非 msg_id */
  message_reference?: { message_id: string };
  /** 被动回复锚点（来自入站 C2C_MESSAGE_CREATE d.id；主动发送时省略） */
  msg_id?: string;
  /** 同 msg_id 下的递增正整数去重槽位（主动发送时省略） */
  msg_seq?: number;
}

/** 单聊发信响应体 */
export interface QQSendMessageResponse {
  /** 出站消息撤回 ID（仅用于 120s 内 DELETE 撤回，严禁当作被动回复锚点 msg_id） */
  id: string;
  timestamp?: string;
  ext_info?: {
    /** 出站消息自身引用索引（REFIDX_...） */
    ref_idx?: string;
  };
}

/** 官方富媒体上传文件类型：1=图片, 2=视频, 3=语音, 4=文件 */
export type QQMediaFileType = 1 | 2 | 3 | 4;

/** 富媒体四步上传 Step 1：upload_prepare 请求体 */
export interface QQUploadPrepareRequest {
  file_type: QQMediaFileType;
  /** 总字节数字符串（官方接口要求字符串） */
  file_size: string;
  file_name: string;
  md5: string;
  sha1: string;
  /** 文件前 10002432 字节的 MD5 */
  md5_10m: string;
}

/** 富媒体分片预签名描述项（实测 index 为 1-based，且每片自带独立 block_size） */
export interface QQUploadPart {
  /** 1-based 分片序号 */
  index: number;
  presigned_url: string;
  /** 单片实际字节数（末片为余数，可能为字符串或数字） */
  block_size?: string | number;
}

/** 富媒体四步上传 Step 1：upload_prepare 响应体 */
export interface QQUploadPrepareResponse {
  upload_id: string;
  /** 全局分片大小（实测默认 10485760 = 10MB） */
  block_size: string | number;
  parts: QQUploadPart[];
}

/** 富媒体四步上传 Step 3：upload_part_finish 请求体 */
export interface QQUploadPartFinishRequest {
  upload_id: string;
  /** 对应 parts[].index 的 1-based 分片序号 */
  part_index: number;
  /** 必须上报该分片自身的实际字节数字符串 */
  block_size: string;
  /** 当前分片二进制数据的 MD5 */
  md5: string;
}

/** 富媒体四步上传 Step 4：files 合并响应体 */
export interface QQFilesMergeResponse {
  file_uuid?: string;
  file_info: string;
  /** 有效复用 TTL（秒，实测 86400） */
  ttl?: number;
}

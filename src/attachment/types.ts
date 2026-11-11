/**
 * kujira: 统一附件描述符类型（QQ 官方 Bot API v2 合规单聊）。
 *
 * 设计约束：
 * - `remote` 只承载 QQ 官方侧元信息（fileUuid / fileInfo / url / voiceWavUrl / contentType / asrReferText / fileId）；
 * - `local` 只承载本机落盘事实（OS 路径 / 字节魔数或实测格式 / 大小 / md5 / 去重指纹）；
 * - `remote.url` 与 `remote.voiceWavUrl` 可能携带访问凭证 query，渲染层与日志层严禁明文输出；
 * - 可选字段一律条件展开，描述符中绝不出现 `undefined` 键。
 */

export type AttachmentKind =
  | 'image'
  | 'sticker'
  | 'file'
  | 'record'
  | 'video'
  | 'forward';

export type AttachmentOrigin = 'inbound' | 'outbound';

/** QQ 官方侧的远端附件元信息（严禁将带凭证 url 直接明文输出给模型）。 */
export interface AttachmentRemoteMeta {
  /** 仅作兼容只读展示如需（或无 fileUuid 时的远端标识）。 */
  fileId?: string;
  /** 官方文件 UUID（上传 files 合并或远端文件标识）。 */
  fileUuid?: string;
  /** 官方四步上传返回的 file_info（用于 msg_type=7 下发）。 */
  fileInfo?: string;
  /** 远端下载地址（可能携带凭证 query，日志与正文渲染严禁暴露）。 */
  url?: string;
  /** 官方语音 WAV 转码地址（audio/x-wav）。 */
  voiceWavUrl?: string;
  /** 入站附件原始 content_type（如 image/png、voice、video/mp4、file）。 */
  contentType?: string;
  /** 官方自带语音识别转写文本。 */
  asrReferText?: string;
}

/** 本机落盘事实。 */
export interface AttachmentLocalMeta {
  path: string;
  /** 真实格式，以字节魔数或实测格式为准（png / jpg / gif / webp / wav / amr / mp4 / dat...）。 */
  format?: string;
  size?: number;
  md5?: string;
  /** 本地去重指纹。 */
  fingerprint?: string;
}

export interface AttachmentFaceMeta {
  id: string;
  mood?: string;
  tags?: string[];
}

export interface AttachmentDescriptor {
  kind: AttachmentKind;
  origin: AttachmentOrigin;
  remote?: AttachmentRemoteMeta;
  local?: AttachmentLocalMeta;
  face?: AttachmentFaceMeta;
  /** 原始文件名（外部传入需先经 basename 与安全净化）。 */
  fileName?: string;
  /** 摘要信息（如表情包或合并转发摘要）。 */
  summary?: string;
  /** 入站落盘失败原因标记（已脱敏，不含 URL query 凭证）。 */
  unavailable?: string;
}

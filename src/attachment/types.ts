/**
 * kujira: 统一附件描述符类型（QQ 官方 Bot API v2 合规单聊）。
 *
 * 设计约束：
 * - `remote` 只承载 QQ 官方侧元信息（fileUuid / fileInfo / url / voiceWavUrl / contentType / asrReferText / fileId）；
 * - `local` 只承载本机落盘事实（OS 路径 / 字节魔数或实测格式 / 大小 / md5 / 去重指纹 / 分辨率 / 时长）；
 * - `remote.url` 与 `remote.voiceWavUrl` 可能携带较长访问凭证 query，服务器日志避免随意刷屏；面向 Agent 展示未落盘或下载失败附件时需提供真实可用直链 URL，已落盘附件仅展示本地路径；
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

/** QQ 官方侧的远端附件元信息（日志应避免刷屏长凭证，未落盘/失败时向 Agent 展示可用直链）。 */
export interface AttachmentRemoteMeta {
  /** 仅作兼容只读展示如需（或无 fileUuid 时的远端标识）。 */
  fileId?: string;
  /** 官方文件 UUID（上传 files 合并或远端文件标识）。 */
  fileUuid?: string;
  /** 官方四步上传返回的 file_info（用于 msg_type=7 下发）。 */
  fileInfo?: string;
  /** 远端下载地址（可能携带凭证 query，日志避免刷屏；未落盘或下载失败时向 Agent 展示直链）。 */
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
  /** 媒体分辨率（例如 `'720x1280'`，在已知分辨率时保存）。 */
  dimensions?: string;
  /** 视频时长秒数（例如 `8.776`）。 */
  durationSec?: number;
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

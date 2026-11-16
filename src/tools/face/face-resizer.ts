/**
 * kujira: 表情包出站小图拟态缩放器 (face-resizer)
 *
 * 针对 QQ 官方 Bot API v2 单聊富媒体消息设计：
 * - 仅对静态图片（PNG / JPEG / WebP 等）生效；GIF 等多帧动画原样跳过，保留原图；
 * - 若原图长宽均不超过 maxDimension（默认 240），保持原样跳过，绝不上采样；
 * - 采用高质量 Lanczos3 重采样，保持纵横比（fit: 'inside'），无损 PNG 输出；
 * - 产物缓存在目标目录（默认 thumb/），文件命名为 `${name}_${maxDimension}.png`，二次发送直接命中秒发；
 * - 全程 try/catch 兜底，遇到任何异常（非图片文件、损坏文件、写权限等）安全降级返回原图路径，绝不阻塞发送。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { DEFAULT_FACE_OUTBOUND_MAX_SIZE, DEFAULT_FACE_THUMB_DIRNAME } from '../../constants/index.js';

export interface PrepareFaceOutboundOptions {
  localPath: string;
  format?: string;
  maxDimension?: number;
  thumbDir?: string;
}

/**
 * 为出站发送的表情包准备适合 QQ 单聊气泡展示的缩略小图路径。
 */
export async function prepareFaceOutboundPath(
  options: PrepareFaceOutboundOptions
): Promise<string> {
  const { localPath, format, maxDimension = DEFAULT_FACE_OUTBOUND_MAX_SIZE } = options;
  if (!localPath || typeof localPath !== 'string') {
    return localPath;
  }

  // 1. 快速过滤：如果是 gif 格式或以 .gif 结尾，直接透传原图
  const normalizedFormat = (format || '').trim().toLowerCase();
  if (normalizedFormat === 'gif' || localPath.toLowerCase().endsWith('.gif')) {
    return localPath;
  }

  // 2. 检查本地原图是否存在
  if (!fs.existsSync(localPath)) {
    return localPath;
  }

  try {
    // 3. 读取图片元数据（同时借此检测文件完整性）
    const meta = await sharp(localPath).metadata();
    if (!meta || !meta.width || !meta.height) {
      return localPath;
    }

    // 格式二次过滤：防范扩展名写错但实际为 gif 的情况
    if (meta.format === 'gif') {
      return localPath;
    }

    // 若原图任一边均在阈值内，无需下采样
    if (meta.width <= maxDimension && meta.height <= maxDimension) {
      return localPath;
    }

    // 4. 确定缓存目录与目标文件路径
    const baseDir = path.dirname(localPath);
    const thumbDir = options.thumbDir || path.resolve(baseDir, DEFAULT_FACE_THUMB_DIRNAME);
    const parsed = path.parse(localPath);
    // 缓存文件名：例如 `${name}_${maxDimension}.png`
    const thumbPath = path.resolve(thumbDir, `${parsed.name}_${maxDimension}.png`);

    // 5. 命中缓存快速返回
    if (fs.existsSync(thumbPath)) {
      const stat = fs.statSync(thumbPath);
      if (stat.size > 0) {
        return thumbPath;
      }
    }

    // 6. 执行缩放并写入临时文件，再重命名保证原子写入
    fs.mkdirSync(thumbDir, { recursive: true });
    const tempPath = path.resolve(
      thumbDir,
      `${parsed.name}_${maxDimension}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );

    await sharp(localPath)
      .resize(maxDimension, maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3,
      })
      .png({ compressionLevel: 9 })
      .toFile(tempPath);

    fs.renameSync(tempPath, thumbPath);
    return thumbPath;
  } catch {
    // 优雅降级：遇到任何解析异常或权限问题直接回退原图
    return localPath;
  }
}

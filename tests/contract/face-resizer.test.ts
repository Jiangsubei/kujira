/**
 * tests/contract/face-resizer.test.ts
 * 契约测试: 表情包出站小图拟态缩放器 (Face Outbound Resizer Contract)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import sharp from 'sharp';
import { prepareFaceOutboundPath } from '../../src/tools/face/face-resizer.js';

describe('契约测试: 表情包出站小图拟态缩放 (face-resizer)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-resizer-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: 小于或等于 240x240 的静态图跳过缩放，直接返回原文件路径', async () => {
    const smallPath = path.join(tmpDir, 'small.png');
    await sharp({
      create: {
        width: 120,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toFile(smallPath);

    const result = await prepareFaceOutboundPath({
      localPath: smallPath,
      format: 'png',
      maxDimension: 240,
    });

    expect(result).toBe(smallPath);
  });

  it('契约 2: GIF 格式直接跳过缩放，无论扩展名还是元数据均为 GIF 均透传原路径', async () => {
    const gifPath = path.join(tmpDir, 'sample.gif');
    await sharp({
      create: {
        width: 500,
        height: 500,
        channels: 4,
        background: { r: 0, g: 255, b: 0, alpha: 1 },
      },
    })
      .gif()
      .toFile(gifPath);

    const result1 = await prepareFaceOutboundPath({
      localPath: gifPath,
      format: 'gif',
      maxDimension: 240,
    });
    expect(result1).toBe(gifPath);

    // 扩展名为 .png 但内部为 gif 的情况
    const fakeExtGif = path.join(tmpDir, 'fake.png');
    fs.copyFileSync(gifPath, fakeExtGif);
    const result2 = await prepareFaceOutboundPath({
      localPath: fakeExtGif,
      format: 'png',
      maxDimension: 240,
    });
    expect(result2).toBe(fakeExtGif);
  });

  it('契约 3: 大于 240x240 的静态图等比缩放至 240 以内，输出无损 PNG 并生成缓存', async () => {
    const largePath = path.join(tmpDir, 'large.jpg');
    // 宽 600, 高 300 (长宽比 2:1)
    await sharp({
      create: {
        width: 600,
        height: 300,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .jpeg()
      .toFile(largePath);

    const thumbDir = path.join(tmpDir, 'thumb');
    const result = await prepareFaceOutboundPath({
      localPath: largePath,
      format: 'jpg',
      maxDimension: 240,
      thumbDir,
    });

    expect(result).not.toBe(largePath);
    expect(fs.existsSync(result)).toBe(true);
    expect(result.endsWith('.png')).toBe(true);

    const meta = await sharp(result).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(240);
    expect(meta.height).toBe(120); // 严格保持 2:1 比例，不拉伸
  });

  it('契约 4: 重复调用命中缩略图缓存，不再重新生成文件', async () => {
    const largePath = path.join(tmpDir, 'cached.png');
    await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 4,
        background: { r: 100, g: 100, b: 100, alpha: 1 },
      },
    })
      .png()
      .toFile(largePath);

    const thumbDir = path.join(tmpDir, 'thumb');
    const firstRes = await prepareFaceOutboundPath({
      localPath: largePath,
      format: 'png',
      maxDimension: 240,
      thumbDir,
    });

    const mtime1 = fs.statSync(firstRes).mtimeMs;
    // 稍等 10ms
    await new Promise((r) => setTimeout(r, 15));

    const secondRes = await prepareFaceOutboundPath({
      localPath: largePath,
      format: 'png',
      maxDimension: 240,
      thumbDir,
    });

    expect(secondRes).toBe(firstRes);
    const mtime2 = fs.statSync(secondRes).mtimeMs;
    expect(mtime2).toBe(mtime1); // 缓存命中，文件未被修改
  });

  it('契约 5: 损坏图片或非图片二进制发生异常时，安全兜底返回原路径，绝不抛出错误', async () => {
    const corruptedPath = path.join(tmpDir, 'corrupted.png');
    fs.writeFileSync(corruptedPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

    const result = await prepareFaceOutboundPath({
      localPath: corruptedPath,
      format: 'png',
      maxDimension: 240,
    });

    expect(result).toBe(corruptedPath);
  });
});

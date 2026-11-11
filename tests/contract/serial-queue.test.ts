import { describe, it, expect } from 'vitest';
import { PerPeerSerialSender } from '../../src/outbound/queue.js';

describe('契约测试: 共享 per-peer 串行发送器保序 (Kujira 单聊)', () => {
  const PEER = 'user_a1b2c3d4e5f60708';
  const PEER_ALT = 'user_0011223344556677';

  it('契约 1: 同一 peer 任务严格按入队顺序执行（前置任务延迟不插队）', async () => {
    const order: number[] = [];
    const sender = new PerPeerSerialSender();

    const tasks = [1, 2, 3].map((n) =>
      sender.enqueue(PEER, async () => {
        await new Promise((r) => setTimeout(r, n === 1 ? 40 : 5));
        order.push(n);
      })
    );

    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it('契约 2: 不同 peer 互不阻塞（独立队列）', async () => {
    const order: string[] = [];
    const sender = new PerPeerSerialSender();

    const p1 = sender.enqueue(PEER, async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push(PEER);
    });
    const p2 = sender.enqueue(PEER_ALT, async () => {
      order.push(PEER_ALT);
    });

    await Promise.all([p1, p2]);
    expect(order[0]).toBe(PEER_ALT);
  });

  it('契约 3: 前置任务失败不阻塞后续任务，且调用方仍收到拒绝', async () => {
    const order: string[] = [];
    const sender = new PerPeerSerialSender();

    const failing = sender.enqueue(PEER, async () => {
      throw new Error('boom');
    });
    const next = sender.enqueue(PEER, async () => {
      order.push('after-failure');
    });

    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(order).toEqual(['after-failure']);
  });

  it('契约 4: 正文 -> 提问 -> 审批 经同一队列严格保序', async () => {
    const order: string[] = [];
    const sender = new PerPeerSerialSender();

    const textPromise = sender.enqueue(PEER, async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('正文回复内容');
    });
    const askPromise = sender.enqueue(PEER, async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('【请回答问题】');
    });
    const approvalPromise = sender.enqueue(PEER, async () => {
      order.push('【审批请求】');
    });

    await Promise.all([textPromise, askPromise, approvalPromise]);
    expect(order).toEqual(['正文回复内容', '【请回答问题】', '【审批请求】']);
  });

  it('契约 5: 任务 settle 后自动清理空闲 chains 映射，防止内存泄漏', async () => {
    const sender = new PerPeerSerialSender();
    await sender.enqueue(PEER, async () => 42);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((sender as any).chains.has(PEER)).toBe(false);
  });
});

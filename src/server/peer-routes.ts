/**
 * kujira: 已互动单聊用户脱敏摘要 HTTP REST API 路由
 * 为 Web UI 设置卡（回复节奏 Tab 的冷场主动搭话黑白名单）提供用户列表查询。
 * 严格脱敏：仅返回内部 peer、截断后的短 OpenID、最近入站发言时间与最后一条入站消息摘要，
 * 绝不向前端暴露完整明文 openid。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import { sendJson, assertHostAuthentication } from './routes.js';

export const PEERS_API_PATH = '/plugins/kujira/peers';

export interface PeerRoutesOptions {
  ctx: Context;
  db: MessageDatabase;
}

export function registerPeerRoutes(options: PeerRoutesOptions): () => void {
  const { ctx, db } = options;
  let unregister: (() => void) | undefined;
  let isDisposed = false;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!assertHostAuthentication(ctx, req, res)) {
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    try {
      const peers = db.listKnownPeersWithLastMessage();
      sendJson(res, 200, {
        ok: true,
        peers,
      });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || '获取已互动用户列表失败' });
    }
  };

  const doRegister = (server: any) => {
    if (isDisposed || !server || typeof server.register !== 'function') return;
    try {
      unregister = server.register({
        kind: 'exact',
        path: PEERS_API_PATH,
        handler,
      });
    } catch {}
  };

  const directServer = typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined;
  if (directServer) {
    doRegister(directServer);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (injectedCtx: any) => {
      const s =
        injectedCtx?.webServer ??
        (typeof injectedCtx?.get === 'function' ? injectedCtx.get('webServer') : undefined);
      if (s) doRegister(s);
    });
  }

  return () => {
    isDisposed = true;
    if (typeof unregister === 'function') {
      try {
        unregister();
      } catch {}
      unregister = undefined;
    }
  };
}

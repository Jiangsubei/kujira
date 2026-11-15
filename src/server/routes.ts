/**
 * kujira Server Configuration REST Routes
 *
 * 为 DSH 桌面端与 Web 端客户端提供独立的 HTTP 配置读取与更新通道：
 *   - GET  /plugins/kujira/config: 获取当前 15 项核心配置与脱敏凭据状态元数据（绝不回显 AppID/AppSecret 明文）
 *   - POST /plugins/kujira/config: 保存配置与可选凭据（写入 ctx.credentials，剥离非 schema 字段后持久化 settings 并触发热更新）
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { BridgePluginConfig } from '../types/index.js';
import { sanitizeConfigPayload, healProfileConfigFile } from '../config/heal.js';
import {
  describeCredentials,
  saveCredentials,
  unsetCredentials,
  type CredentialInputKey,
  type CredentialResolveOptions,
  type SaveCredentialsInput,
} from '../config/credentials.js';
import { DEFAULT_BASE_CONFIG, SETTINGS_NAMESPACE } from '../constants/index.js';

export { DEFAULT_BASE_CONFIG };

export const CONFIG_ROUTE_PATH = '/plugins/kujira/config';

export interface ConfigRouteOptions extends CredentialResolveOptions {}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function parseJsonBody<T = any>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (!text.trim()) {
          resolve({} as T);
          return;
        }
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * 校验请求是否来自可信宿主身份 (DSH Connection 门控)
 * 严格 Fail-Closed：对接 ctx.connection.requestRejection，防御 CSRF、DNS Rebinding 与非授权访问。
 */
export function assertHostAuthentication(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  let connection: any;
  if (typeof (ctx as any).get === 'function') {
    connection = (ctx as any).get('connection');
  }
  if (!connection) {
    try {
      connection = (ctx as any).connection;
    } catch {
      // 忽略未 inject 时 Cordis Proxy get trap 抛出的异常
    }
  }

  // 严格 Fail-Closed：若宿主未提供 connection 认证服务，坚决拒绝访问 (403 Forbidden)
  if (!connection || typeof connection.requestRejection !== 'function') {
    sendJson(res, 403, {
      ok: false,
      error: 'Forbidden: host connection authentication service unavailable',
    });
    return false;
  }

  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    sendJson(res, rejection, {
      ok: false,
      error: rejection === 401 ? 'Unauthorized' : 'Forbidden',
    });
    return false;
  }

  return true;
}

export function registerConfigRoute(
  ctx: Context,
  currentConfigGetter: () => BridgePluginConfig,
  queueReconcile: (cfg?: BridgePluginConfig) => Promise<void>,
  options?: ConfigRouteOptions
): () => void {
  const logger = typeof (ctx as any).logger === 'function' ? (ctx as any).logger(SETTINGS_NAMESPACE) : console;
  const credOptions: CredentialResolveOptions | undefined = options
    ? {
        ...(options.dshHome !== undefined ? { dshHome: options.dshHome } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      }
    : undefined;

  let unregister: (() => void) | undefined;
  let isDisposed = false;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!assertHostAuthentication(ctx, req, res)) {
      return;
    }

    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      try {
        const rawCfg = currentConfigGetter() || {};
        const [{ valid: cleanCfg }, credStatus] = await Promise.all([
          Promise.resolve(sanitizeConfigPayload(rawCfg)),
          describeCredentials(ctx, credOptions),
        ]);
        if (typeof cleanCfg.persona === 'string' && cleanCfg.persona.trim() === '') {
          cleanCfg.persona = DEFAULT_BASE_CONFIG.persona;
        }
        if (typeof cleanCfg.behavior === 'string' && cleanCfg.behavior.trim() === '') {
          cleanCfg.behavior = DEFAULT_BASE_CONFIG.behavior;
        }
        sendJson(res, 200, {
          ok: true,
          credentials: credStatus,
          config: cleanCfg,
          baseDefaults: DEFAULT_BASE_CONFIG,
        });
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || 'Internal Server Error' });
      }
      return;
    }

    if (method === 'POST') {
      try {
        const body = (await parseJsonBody(req)) || {};
        const rawCredentials =
          body && typeof body === 'object' && !Array.isArray(body) ? (body as any).credentials : undefined;
        const rawClearCredentials =
          body && typeof body === 'object' && !Array.isArray(body)
            ? (body as any).clear_credentials
            : undefined;

        // 剥离凭据相关字段（绝不允许 app_id / app_secret / credentials 混入 settings 或配置热对齐载荷）
        const settingsCandidate: Record<string, any> =
          body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
        delete settingsCandidate.credentials;
        delete settingsCandidate.clear_credentials;
        delete settingsCandidate.app_id;
        delete settingsCandidate.app_secret;

        // 自愈过滤：仅保留 100% 符合当前 15 项 Schema 的干净配置字段，剔除任何已下线或未知字段
        const { valid: cleanPayload, removed } = sanitizeConfigPayload(settingsCandidate);

        // 自愈空白 persona / behavior：若提交空白，回填为默认基线，防空白配置污染持久化层
        if (typeof cleanPayload.persona === 'string' && cleanPayload.persona.trim() === '') {
          cleanPayload.persona = DEFAULT_BASE_CONFIG.persona;
        }
        if (typeof cleanPayload.behavior === 'string' && cleanPayload.behavior.trim() === '') {
          cleanPayload.behavior = DEFAULT_BASE_CONFIG.behavior;
        }

        // 先处理可选凭据写入/清除（留空不覆盖既有凭据）
        const clearKeys: CredentialInputKey[] = Array.isArray(rawClearCredentials)
          ? rawClearCredentials.filter(
              (k): k is CredentialInputKey => k === 'app_id' || k === 'app_secret'
            )
          : [];

        const credInput: SaveCredentialsInput | undefined =
          rawCredentials && typeof rawCredentials === 'object' && !Array.isArray(rawCredentials)
            ? {
                ...(typeof rawCredentials.app_id === 'string' ? { app_id: rawCredentials.app_id } : {}),
                ...(typeof rawCredentials.app_secret === 'string'
                  ? { app_secret: rawCredentials.app_secret }
                  : {}),
              }
            : undefined;

        const hasNewCredValues = Boolean(
          (credInput?.app_id && credInput.app_id.trim().length > 0) ||
            (credInput?.app_secret && credInput.app_secret.trim().length > 0)
        );

        let credentialsMutated = false;
        if (clearKeys.length > 0) {
          await unsetCredentials(ctx, clearKeys, credOptions);
          credentialsMutated = true;
        }
        if (hasNewCredValues && credInput) {
          await saveCredentials(ctx, credInput, credOptions);
          credentialsMutated = true;
        }

        const updatedCredStatus = await describeCredentials(ctx, credOptions);

        if (removed.length > 0) {
          logger.info?.(
            `[Config] 保存时检测到并自愈过滤过时配置项 (${removed.length} 项): ${removed.join(', ')}`
          );
          try {
            healProfileConfigFile(options?.dshHome, undefined, logger);
          } catch {
            // 物理自愈静默
          }
        }

        const hasSettingsChanges = Object.keys(cleanPayload).length > 0;

        // 持久化到 settings（仅提交通过 15 项 Schema 白名单校验的干净字段）
        if (hasSettingsChanges) {
          const settings = (ctx as any).get?.('settings');
          if (settings) {
            try {
              if (typeof settings.mutate === 'function') {
                const ops = Object.entries(cleanPayload).map(([key, value]) => ({
                  op: 'set' as const,
                  path: [key],
                  value,
                }));
                await settings.mutate(SETTINGS_NAMESPACE, ops);
              } else if (typeof settings.update === 'function') {
                await settings.update(SETTINGS_NAMESPACE, cleanPayload);
              }
            } catch (err: any) {
              logger.error?.('[Plugin] 持久化配置到 settings 失败:', err);
              sendJson(res, 500, {
                ok: false,
                error: err?.message || 'Failed to persist settings',
              });
              return;
            }
          }
        }

        // 触发热更新（settings 变化或仅凭据更新成功时均触发运行时对齐/热重连）
        if (hasSettingsChanges) {
          await queueReconcile(cleanPayload);
        } else if (credentialsMutated) {
          await queueReconcile();
        }

        sendJson(res, 200, {
          ok: true,
          credentials: updatedCredStatus,
          config: cleanPayload,
          healedKeys: removed,
        });
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || 'Failed to update config' });
      }
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  };

  const doRegister = (server: any) => {
    if (isDisposed) return;
    if (typeof server?.register === 'function') {
      try {
        unregister = server.register({
          kind: 'exact',
          path: CONFIG_ROUTE_PATH,
          handler,
        });
      } catch (err: any) {
        const regLogger = typeof (ctx as any).logger === 'function' ? (ctx as any).logger(SETTINGS_NAMESPACE) : console;
        regLogger.warn?.(`[routes] Failed to register ${CONFIG_ROUTE_PATH}: ${err?.message || err}`);
      }
    }
  };

  const directServer = typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined;
  if (directServer) {
    doRegister(directServer);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (subCtx: any) => {
      const server = subCtx?.webServer ?? (typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined);
      doRegister(server);
    });
  }

  const disposeRoute = () => {
    isDisposed = true;
    if (typeof unregister === 'function') {
      try {
        unregister();
      } catch {
        // ignore
      }
      unregister = undefined;
    }
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposeRoute();
    });
  }

  return disposeRoute;
}

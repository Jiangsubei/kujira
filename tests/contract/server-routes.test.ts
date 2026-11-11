import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  registerConfigRoute,
  CONFIG_ROUTE_PATH,
  DEFAULT_BASE_CONFIG,
  sendJson,
  parseJsonBody,
} from '../../src/server/routes.js';
import { DEFAULT_BASE_CONFIG as CONSTANTS_BASE_CONFIG, SETTINGS_NAMESPACE } from '../../src/constants/index.js';
import type { BridgePluginConfig } from '../../src/types/index.js';

function createMockReq(method: string, body?: any): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): {
  res: ServerResponse;
  getResult: () => Promise<{ status: number; headers: any; body: any }>;
} {
  const res = new EventEmitter() as any;
  let statusCode = 200;
  let headers: any = {};
  const chunks: Buffer[] = [];
  let isFinished = false;

  res.writeHead = vi.fn((status: number, h?: any) => {
    statusCode = status;
    if (h) headers = { ...headers, ...h };
    return res;
  });

  res.end = vi.fn((data?: any) => {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    isFinished = true;
    res.emit('finish');
    return res;
  });

  const parseResult = () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: statusCode, headers, body };
  };

  const getResult = () =>
    new Promise<{ status: number; headers: any; body: any }>((resolve) => {
      if (isFinished) {
        resolve(parseResult());
        return;
      }
      res.on('finish', () => {
        resolve(parseResult());
      });
    });

  return { res, getResult };
}

describe('契约测试: 服务端配置 REST API 路由 (/plugins/kujira/config)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-routes-home-'));
    tmpCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-routes-cwd-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(tmpCwd, { recursive: true, force: true }).catch(() => {});
  });

  describe('1. 路由注册与生命周期反注册契约', () => {
    it('正确向 ctx.webServer 注册 exact 路径 /plugins/kujira/config，且 DEFAULT_BASE_CONFIG 与常量同源', () => {
      const registerMock = vi.fn();
      const mockCtx: any = {
        get: vi.fn((name) => (name === 'webServer' ? { register: registerMock } : undefined)),
        inject: vi.fn(),
      };

      expect(CONFIG_ROUTE_PATH).toBe('/plugins/kujira/config');
      expect(DEFAULT_BASE_CONFIG).toBe(CONSTANTS_BASE_CONFIG);
      expect(Object.keys(DEFAULT_BASE_CONFIG)).toHaveLength(15);

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {}, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      expect(registerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'exact',
          path: CONFIG_ROUTE_PATH,
          handler: expect.any(Function),
        })
      );
    });

    it('支持在 webServer 未就绪时通过 ctx.inject 延迟注册 (注入依赖模式)', () => {
      const registerMock = vi.fn();
      let injectCallback: ((subCtx: any) => void) | undefined;
      const mockCtx: any = {
        get: vi.fn(() => undefined),
        inject: vi.fn((deps, cb) => {
          expect(deps).toContain('webServer');
          injectCallback = cb;
        }),
      };

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {}, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      expect(registerMock).not.toHaveBeenCalled();
      expect(mockCtx.inject).toHaveBeenCalled();

      injectCallback?.({ webServer: { register: registerMock } });
      expect(registerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'exact',
          path: CONFIG_ROUTE_PATH,
          handler: expect.any(Function),
        })
      );
    });

    it('调用返回的清理函数可注销路由，避免内存泄漏', () => {
      const unregisterMock = vi.fn();
      const mockCtx: any = {
        get: vi.fn((name) =>
          name === 'webServer'
            ? {
                register: vi.fn(() => unregisterMock),
              }
            : undefined
        ),
        inject: vi.fn(),
      };

      const unregister = registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {});
      expect(unregisterMock).not.toHaveBeenCalled();

      unregister();
      expect(unregisterMock).toHaveBeenCalled();
    });
  });

  describe('2. GET /plugins/kujira/config 配置读取与凭据零明文脱敏保护', () => {
    it('返回 200 JSON，已配置凭据时仅返回脱敏元数据 (configured/source/writable)，绝不回显 AppID/AppSecret 明文', async () => {
      let handler: any;
      const credStore = new Map<string, string>([
        ['QQ_BOT_APP_ID', '1000000091'],
        ['QQ_BOT_SECRET', 'super-secret-value-never-leak'],
      ]);
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'credentials') {
            return {
              describe: async (ref: string) =>
                credStore.has(ref)
                  ? { configured: true, source: 'file', writable: true }
                  : { configured: false, writable: true },
            };
          }
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      // 故意混入已下线的历史键（含已固化开关 markdown_enabled / input_notify_enabled）以验证 GET 清洗
      const currentCfg = {
        markdown_enabled: true,
        input_notify_enabled: false,
        new_message_behavior: 'steer',
        image_ttl_days: 7,
        persona: '测试人格设定',
        ws_port: 8080,
        admins: ['1000000001'],
        app_id: '1000000091',
      } as unknown as BridgePluginConfig;

      registerConfigRoute(mockCtx, () => currentCfg, async () => {}, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      const req = createMockReq('GET');
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.credentials).toEqual({
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: true, source: 'file', writable: true },
        ready: true,
      });

      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toContain('1000000091');
      expect(serialized).not.toContain('super-secret-value-never-leak');

      expect(result.body.config.new_message_behavior).toBe('steer');
      expect(result.body.config.image_ttl_days).toBe(7);
      expect(result.body.config.persona).toBe('测试人格设定');
      expect(result.body.config.markdown_enabled).toBeUndefined();
      expect(result.body.config.input_notify_enabled).toBeUndefined();
      expect(result.body.config.ws_port).toBeUndefined();
      expect(result.body.config.admins).toBeUndefined();
      expect(result.body.config.app_id).toBeUndefined();
      expect(result.body.baseDefaults).toEqual(DEFAULT_BASE_CONFIG);
    });

    it('未配置凭据时返回 ready: false 与明确的未配置元数据', async () => {
      let handler: any;
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      registerConfigRoute(
        mockCtx,
        () => ({ new_message_behavior: 'steer' } as BridgePluginConfig),
        async () => {},
        { dshHome: tmpHome, cwd: tmpCwd, env: {} }
      );

      const req = createMockReq('GET');
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.credentials.ready).toBe(false);
      expect(result.body.credentials.appId.configured).toBe(false);
      expect(result.body.credentials.appSecret.configured).toBe(false);
    });
  });

  describe('3. POST /plugins/kujira/config 配置保存、凭据安全写入与非 schema 字段剥离', () => {
    it('提交凭据与 15 项配置时，凭据写入 ctx.credentials 且被完全剥离出 settings 与 queueReconcile，遗留开关自动自愈过滤', async () => {
      let handler: any;
      const mutateMock = vi.fn().mockResolvedValue({ ok: true });
      const credStore = new Map<string, string>();
      const setCredMock = vi.fn(async (ref: string, val: string) => {
        credStore.set(ref, val);
      });
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'credentials') {
            return {
              set: setCredMock,
              describe: async (ref: string) =>
                credStore.has(ref)
                  ? { configured: true, source: 'file', writable: true }
                  : { configured: false, writable: true },
            };
          }
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { mutate: mutateMock };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      let currentCfg: BridgePluginConfig = {
        new_message_behavior: 'steer',
        image_ttl_days: 7,
      };
      const reconcileMock = vi.fn().mockImplementation(async (next) => {
        if (next) currentCfg = { ...currentCfg, ...next };
      });

      registerConfigRoute(mockCtx, () => currentCfg, reconcileMock, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      const req = createMockReq('POST', {
        new_message_behavior: 'queue',
        image_ttl_days: 14,
        persona: 'Kujira 单聊助手',
        credentials: {
          app_id: '1000000055',
          app_secret: 'mock-secret-new-55',
        },
        // 即使错误混入顶层凭据、已下线开关或老字段也必须被自愈剥离
        app_id: '1000000055',
        app_secret: 'mock-secret-new-55',
        markdown_enabled: false,
        input_notify_enabled: true,
        admins: ['1000000001'],
      });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.credentials).toEqual({
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: true, source: 'file', writable: true },
        ready: true,
      });
      expect(result.body.healedKeys).toEqual(['markdown_enabled', 'input_notify_enabled', 'admins']);
      expect(result.body.config).toEqual({
        new_message_behavior: 'queue',
        image_ttl_days: 14,
        persona: 'Kujira 单聊助手',
      });

      // 响应中绝不回显明文凭据
      const responseText = JSON.stringify(result.body);
      expect(responseText).not.toContain('1000000055');
      expect(responseText).not.toContain('mock-secret-new-55');

      // 凭据持久化
      expect(setCredMock).toHaveBeenCalledWith('QQ_BOT_APP_ID', '1000000055');
      expect(setCredMock).toHaveBeenCalledWith('QQ_BOT_SECRET', 'mock-secret-new-55');

      // settings.mutate 与 reconcile 仅接收干净 schema 字段
      expect(mutateMock).toHaveBeenCalledTimes(1);
      const [ns, ops] = mutateMock.mock.calls[0];
      expect(ns).toBe(SETTINGS_NAMESPACE);
      const persistedKeys = ops.map((op: any) => op.path[0]);
      expect(persistedKeys).toEqual(['new_message_behavior', 'image_ttl_days', 'persona']);

      expect(reconcileMock).toHaveBeenCalledTimes(1);
      const passedToReconcile = reconcileMock.mock.calls[0][0];
      expect(passedToReconcile).toEqual({
        new_message_behavior: 'queue',
        image_ttl_days: 14,
        persona: 'Kujira 单聊助手',
      });
    });

    it('仅更新凭据且留空 app_secret 时保留既有密钥，并触发 queueReconcile 热重连而不误写 settings', async () => {
      let handler: any;
      const mutateMock = vi.fn().mockResolvedValue({ ok: true });
      const credStore = new Map<string, string>([
        ['QQ_BOT_APP_ID', '1000000011'],
        ['QQ_BOT_SECRET', 'existing-secret-must-keep'],
      ]);
      const setCredMock = vi.fn(async (ref: string, val: string) => {
        credStore.set(ref, val);
      });
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'credentials') {
            return {
              set: setCredMock,
              describe: async (ref: string) =>
                credStore.has(ref)
                  ? { configured: true, source: 'file', writable: true }
                  : { configured: false, writable: true },
            };
          }
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { mutate: mutateMock };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const reconcileMock = vi.fn().mockResolvedValue(undefined);
      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), reconcileMock);

      const req = createMockReq('POST', {
        credentials: {
          app_id: '1000000012',
          app_secret: '',
        },
      });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(setCredMock).toHaveBeenCalledTimes(1);
      expect(setCredMock).toHaveBeenCalledWith('QQ_BOT_APP_ID', '1000000012');
      expect(credStore.get('QQ_BOT_SECRET')).toBe('existing-secret-must-keep');
      expect(mutateMock).not.toHaveBeenCalled();
      expect(reconcileMock).toHaveBeenCalledTimes(1);
    });

    it('支持 clear_credentials 清除持久化凭据并回退环境变量与触发热对齐', async () => {
      let handler: any;
      await fsp.writeFile(
        path.join(tmpHome, '.credentials.yaml'),
        'version: 1\nrefs:\n  QQ_BOT_APP_ID: "1000000088"\n  QQ_BOT_SECRET: "secret-yaml"\n',
        'utf8'
      );

      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const reconcileMock = vi.fn().mockResolvedValue(undefined);
      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), reconcileMock, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      const req = createMockReq('POST', {
        clear_credentials: ['app_secret'],
      });
      const { res, getResult } = createMockRes();
      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.credentials.appId.configured).toBe(true);
      expect(result.body.credentials.appSecret.configured).toBe(false);
      expect(result.body.credentials.ready).toBe(false);
      expect(reconcileMock).toHaveBeenCalledTimes(1);
      const savedYaml = fs.readFileSync(path.join(tmpHome, '.credentials.yaml'), 'utf8');
      expect(savedYaml).toContain('QQ_BOT_APP_ID');
      expect(savedYaml).not.toContain('QQ_BOT_SECRET');
    });

    it('兼容支持 settings.update 持久化通道', async () => {
      let handler: any;
      const updateMock = vi.fn().mockResolvedValue({ ok: true });
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { update: updateMock };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const reconcileMock = vi.fn().mockResolvedValue(undefined);
      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), reconcileMock, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      const req = createMockReq('POST', { image_ttl_days: 10 });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(updateMock).toHaveBeenCalledWith(SETTINGS_NAMESPACE, { image_ttl_days: 10 });
    });

    it('当持久化 settings.mutate 抛出异常时，正确记录日志并返回 HTTP 500 与错误消息', async () => {
      let handler: any;
      const errorMock = vi.fn();
      const mockCtx: any = {
        logger: () => ({ error: errorMock, info: vi.fn(), warn: vi.fn() }),
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return {
              mutate: vi.fn().mockRejectedValue(new Error('Config field "invalid_field" is not volatile')),
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {}, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      const req = createMockReq('POST', { image_ttl_days: 15 });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(500);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toContain('is not volatile');
      expect(errorMock).toHaveBeenCalledWith(
        expect.stringContaining('持久化配置到 settings 失败'),
        expect.any(Error)
      );
    });

    it('保存包含 new_message_behavior 与 persona 的配置后，后续 GET 请求能正确读取更新后的配置（防恢复默认值）', async () => {
      let handler: any;
      let persistedSettings: Record<string, unknown> = {};
      const mutateMock = vi.fn().mockImplementation(async (_ns: string, ops: any[]) => {
        for (const op of ops) {
          if (op.op === 'set') {
            persistedSettings[op.path[0]] = op.value;
          }
        }
        return { ok: true };
      });

      let currentConfig: BridgePluginConfig = {
        new_message_behavior: 'steer',
        image_ttl_days: 7,
        persona: '',
      };

      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          if (name === 'settings') {
            return { mutate: mutateMock };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const reconcileMock = vi.fn().mockImplementation(async (payload) => {
        if (payload) currentConfig = { ...currentConfig, ...payload };
      });

      registerConfigRoute(mockCtx, () => currentConfig, reconcileMock, {
        dshHome: tmpHome,
        cwd: tmpCwd,
        env: {},
      });

      const saveReq = createMockReq('POST', {
        new_message_behavior: 'queue',
        image_ttl_days: 21,
        persona: '元气伙伴',
      });
      const { res: saveRes, getResult: getSaveResult } = createMockRes();
      await handler(saveReq, saveRes);
      const saveResult = await getSaveResult();

      expect(saveResult.status).toBe(200);
      expect(saveResult.body.ok).toBe(true);
      expect(mutateMock).toHaveBeenCalled();
      expect(persistedSettings.new_message_behavior).toBe('queue');
      expect(persistedSettings.persona).toBe('元气伙伴');

      const readReq = createMockReq('GET');
      const { res: readRes, getResult: getReadResult } = createMockRes();
      await handler(readReq, readRes);
      const readResult = await getReadResult();

      expect(readResult.status).toBe(200);
      expect(readResult.body.ok).toBe(true);
      expect(readResult.body.config.new_message_behavior).toBe('queue');
      expect(readResult.body.config.image_ttl_days).toBe(21);
      expect(readResult.body.config.persona).toBe('元气伙伴');
    });
  });

  describe('4. HTTP 协议规范与工具函数契约', () => {
    it('不支持的 HTTP 方法返回 405 Method Not Allowed', async () => {
      let handler: any;
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'webServer') {
            return {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {});

      const req = createMockReq('DELETE');
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(405);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toBe('Method Not Allowed');
    });

    it('sendJson 正确格式化 JSON 响应并设置标头', async () => {
      const { res, getResult } = createMockRes();
      sendJson(res, 201, { success: true, count: 42 });

      const result = await getResult();
      expect(result.status).toBe(201);
      expect(result.headers['content-type']).toContain('application/json');
      expect(result.body).toEqual({ success: true, count: 42 });
    });

    it('parseJsonBody 正确从 IncomingMessage 解析 JSON 请求体', async () => {
      const req = createMockReq('POST', { testKey: 'testValue' });
      const parsed = await parseJsonBody(req);
      expect(parsed).toEqual({ testKey: 'testValue' });
    });

    it('parseJsonBody 面对空请求体返回空对象', async () => {
      const req = createMockReq('POST', undefined);
      const parsed = await parseJsonBody(req);
      expect(parsed).toEqual({});
    });
  });
});

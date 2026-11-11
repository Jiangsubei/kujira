import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  registerConfigRoute,
  CONFIG_ROUTE_PATH,
} from '../../src/server/routes.js';
import { registerFacesRoutes, FACES_API_PATH, FACES_PREVIEW_API_PREFIX } from '../../src/server/face-routes.js';
import { registerSlangRoutes, SLANG_API_PATH } from '../../src/server/slang-routes.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';
import type { BridgePluginConfig } from '../../src/types/index.js';

function createMockReq(method: string, body?: any): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:8080',
    cookie: 'dsh_session=test',
  };
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

describe('契约测试: Kujira 路由宿主身份认证门控 (Host Connection Authentication Fence - 严格 Fail-Closed)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-auth-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('当 ctx.connection 存在且 requestRejection 返回 401 时，GET /plugins/kujira/config 直接返回 401 Unauthorized', async () => {
    let handler: any;
    const requestRejectionMock = vi.fn().mockReturnValue(401);
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return { requestRejection: requestRejectionMock };
        return undefined;
      }),
      inject: vi.fn(),
    };

    const cfgGetter = vi.fn(() => ({} as BridgePluginConfig));
    registerConfigRoute(mockCtx, cfgGetter, async () => {}, { dshHome: tmpHome, cwd: tmpHome, env: {} });

    const req = createMockReq('GET');
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(CONFIG_ROUTE_PATH).toBe('/plugins/kujira/config');
    expect(requestRejectionMock).toHaveBeenCalledWith(req);
    expect(result.status).toBe(401);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toBe('Unauthorized');
    expect(cfgGetter).not.toHaveBeenCalled();
  });

  it('当 ctx.connection 存在且 requestRejection 返回 403 时，POST /plugins/kujira/config 直接返回 403 Forbidden', async () => {
    let handler: any;
    const requestRejectionMock = vi.fn().mockReturnValue(403);
    const mutateMock = vi.fn();
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return { requestRejection: requestRejectionMock };
        if (name === 'settings') return { mutate: mutateMock };
        return undefined;
      }),
      inject: vi.fn(),
    };

    const queueReconcileMock = vi.fn();
    registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), queueReconcileMock, {
      dshHome: tmpHome,
      cwd: tmpHome,
      env: {},
    });

    const req = createMockReq('POST', { image_ttl_days: 10 });
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(requestRejectionMock).toHaveBeenCalledWith(req);
    expect(result.status).toBe(403);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toBe('Forbidden');
    expect(mutateMock).not.toHaveBeenCalled();
    expect(queueReconcileMock).not.toHaveBeenCalled();
  });

  it('当 ctx.connection 存在且 requestRejection 返回 undefined 时，放行 GET 与 POST 请求', async () => {
    let handler: any;
    const requestRejectionMock = vi.fn().mockReturnValue(undefined);
    const mutateMock = vi.fn();
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return { requestRejection: requestRejectionMock };
        if (name === 'settings') return { mutate: mutateMock };
        return undefined;
      }),
      inject: vi.fn(),
    };

    const queueReconcileMock = vi.fn();
    registerConfigRoute(
      mockCtx,
      () => ({ new_message_behavior: 'steer' } as BridgePluginConfig),
      queueReconcileMock,
      { dshHome: tmpHome, cwd: tmpHome, env: {} }
    );

    const reqGet = createMockReq('GET');
    const { res: resGet, getResult: getResultGet } = createMockRes();
    await handler(reqGet, resGet);
    const resGetResult = await getResultGet();
    expect(resGetResult.status).toBe(200);
    expect(resGetResult.body.ok).toBe(true);

    const reqPost = createMockReq('POST', { new_message_behavior: 'queue' });
    const { res: resPost, getResult: getResultPost } = createMockRes();
    await handler(reqPost, resPost);
    const resPostResult = await getResultPost();
    expect(resPostResult.status).toBe(200);
    expect(resPostResult.body.ok).toBe(true);
    expect(queueReconcileMock).toHaveBeenCalled();
  });

  it('严格 Fail-Closed: 当 ctx.connection 不存在（未注入认证服务）时，坚决拦截并响应 403 Forbidden', async () => {
    let handler: any;
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        return undefined;
      }),
      inject: vi.fn(),
    };

    registerConfigRoute(mockCtx, () => ({ image_ttl_days: 7 } as BridgePluginConfig), async () => {}, {
      dshHome: tmpHome,
      cwd: tmpHome,
      env: {},
    });

    const req = createMockReq('GET');
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(result.status).toBe(403);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain('Forbidden');
  });

  it('Cordis 契约验证: 直接访问 ctx.connection 抛出 without inject 异常时，优先走 ctx.get("connection") 成功放行', async () => {
    let handler: any;
    const mockConnection = {
      requestRejection: vi.fn(() => undefined),
    };
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
        if (name === 'connection') return mockConnection;
        return undefined;
      }),
      inject: vi.fn(),
    };
    Object.defineProperty(mockCtx, 'connection', {
      get() {
        throw new Error('cannot get property "connection" without inject');
      },
    });

    registerConfigRoute(mockCtx, () => ({ new_message_behavior: 'steer' } as BridgePluginConfig), async () => {}, {
      dshHome: tmpHome,
      cwd: tmpHome,
      env: {},
    });

    const req = createMockReq('GET');
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(mockConnection.requestRejection).toHaveBeenCalled();
  });

  describe('15 项 Schema 与可选凭据保存放行契约', () => {
    it('Schema 兼容性: 空配置安全应用全部 15 项单聊默认值，绝不抛出解析异常且已剔除 markdown_enabled/input_notify_enabled/ws_token/admins', () => {
      const parsed = BridgeConfigSchema({});
      const dict = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
      const unwrap = (val: any) => (typeof val?.get === 'function' ? val.get() : val);
      expect(Object.keys(dict)).toHaveLength(15);
      expect(dict.markdown_enabled).toBeUndefined();
      expect(dict.input_notify_enabled).toBeUndefined();
      expect(dict.ws_token).toBeUndefined();
      expect(dict.admins).toBeUndefined();
      expect(unwrap(parsed.new_message_behavior)).toBe('steer');
      expect(unwrap(parsed.image_ttl_days)).toBe(7);
    });

    it('POST /plugins/kujira/config: 未配置凭据时仅修改普通配置项也正常放行并保存 (200 OK)，同时自愈剥离遗留开关', async () => {
      let handler: any;
      const mutateMock = vi.fn().mockResolvedValue({ ok: true });
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') return { register: (r: any) => { handler = r.handler; return () => {}; } };
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'settings') return { mutate: mutateMock };
          return undefined;
        }),
        inject: vi.fn(),
      };

      registerConfigRoute(mockCtx, () => ({} as BridgePluginConfig), async () => {}, {
        dshHome: tmpHome,
        cwd: tmpHome,
        env: {},
      });

      const req = createMockReq('POST', {
        persona: '温和助手',
        image_ttl_days: 10,
        markdown_enabled: false,
        input_notify_enabled: true,
      });
      const { res, getResult } = createMockRes();

      await handler(req, res);
      const result = await getResult();

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.credentials.ready).toBe(false);
      expect(result.body.config).toEqual({
        persona: '温和助手',
        image_ttl_days: 10,
      });
      expect(result.body.healedKeys).toEqual(['markdown_enabled', 'input_notify_enabled']);
      expect(mutateMock).toHaveBeenCalledTimes(1);
      const [, ops] = mutateMock.mock.calls[0];
      expect(ops.map((op: any) => op.path[0])).toEqual(['persona', 'image_ttl_days']);
    });
  });

  describe('face-routes 宿主身份认证门控 (Face Routes Host Connection Fence)', () => {
    it('当 ctx.connection 不存在时，所有 /plugins/kujira/faces* 路由严格 Fail-Closed 返回 403 Forbidden', async () => {
      expect(FACES_API_PATH).toBe('/plugins/kujira/faces');
      expect(FACES_PREVIEW_API_PREFIX).toBe('/plugins/kujira/faces/preview');

      const handlers = new Map<string, any>();
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') {
            return {
              register: (r: any) => {
                handlers.set(r.path, r.handler);
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const mockDb: any = {
        queryFaces: vi.fn(),
        insertFace: vi.fn(),
        updateFace: vi.fn(),
        deleteFace: vi.fn(),
        getFaceById: vi.fn(),
      };

      registerFacesRoutes({
        ctx: mockCtx,
        db: mockDb,
        getConfig: () => ({ face_enabled: true } as any),
        dshHome: tmpHome,
      });

      const getHandler = handlers.get(FACES_API_PATH);
      expect(getHandler).toBeDefined();
      const reqGet = createMockReq('GET');
      const { res: resGet, getResult: getResultGet } = createMockRes();
      await getHandler(reqGet, resGet);
      const resGetResult = await getResultGet();
      expect(resGetResult.status).toBe(403);
      expect(resGetResult.body.error).toContain('Forbidden');

      const reqPost = createMockReq('POST', { data: 'xxx' });
      const { res: resPost, getResult: getResultPost } = createMockRes();
      await getHandler(reqPost, resPost);
      const resPostResult = await getResultPost();
      expect(resPostResult.status).toBe(403);

      const editHandler = handlers.get(`${FACES_API_PATH}/edit`);
      expect(editHandler).toBeDefined();
      const reqEdit = createMockReq('POST', { id: 'face_123', tags: ['a'] });
      const { res: resEdit, getResult: getResultEdit } = createMockRes();
      await editHandler(reqEdit, resEdit);
      const resEditResult = await getResultEdit();
      expect(resEditResult.status).toBe(403);

      const delHandler = handlers.get(`${FACES_API_PATH}/delete`);
      expect(delHandler).toBeDefined();
      const reqDel = createMockReq('POST', { id: 'face_123' });
      const { res: resDel, getResult: getResultDel } = createMockRes();
      await delHandler(reqDel, resDel);
      const resDelResult = await getResultDel();
      expect(resDelResult.status).toBe(403);

      const previewHandler = handlers.get(FACES_PREVIEW_API_PREFIX);
      expect(previewHandler).toBeDefined();
      const reqPreview = createMockReq('GET');
      (reqPreview as any).url = `${FACES_PREVIEW_API_PREFIX}/face_123`;
      const { res: resPreview, getResult: getResultPreview } = createMockRes();
      await previewHandler(reqPreview, resPreview);
      const resPreviewResult = await getResultPreview();
      expect(resPreviewResult.status).toBe(403);
    });

    it('当 requestRejection 返回 401/403 时准确阻断，返回 undefined 时正常放行', async () => {
      let rejectionCode: number | undefined = 401;
      const handlers = new Map<string, any>();
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => rejectionCode };
          if (name === 'webServer') {
            return {
              register: (r: any) => {
                handlers.set(r.path, r.handler);
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const mockDb: any = {
        queryFaces: vi.fn(() => ({ faces: [], total: 0 })),
      };

      registerFacesRoutes({
        ctx: mockCtx,
        db: mockDb,
        getConfig: () => ({ face_enabled: true } as any),
        dshHome: tmpHome,
      });

      const getHandler = handlers.get(FACES_API_PATH);

      const req401 = createMockReq('GET');
      const { res: res401, getResult: getResult401 } = createMockRes();
      await getHandler(req401, res401);
      const res401Result = await getResult401();
      expect(res401Result.status).toBe(401);
      expect(mockDb.queryFaces).not.toHaveBeenCalled();

      rejectionCode = undefined;
      const reqPass = createMockReq('GET');
      const { res: resPass, getResult: getResultPass } = createMockRes();
      await getHandler(reqPass, resPass);
      const resPassResult = await getResultPass();
      expect(resPassResult.status).toBe(200);
      expect(mockDb.queryFaces).toHaveBeenCalled();
    });

    it('图片上传格式扩展名白名单防线: 恶意或未知扩展名安全规范化为 png，杜绝路径穿越', async () => {
      const handlers = new Map<string, any>();
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => undefined };
          if (name === 'webServer') {
            return {
              register: (r: any) => {
                handlers.set(r.path, r.handler);
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      let insertedRecord: any = null;
      const mockDb: any = {
        insertFace: vi.fn((record) => {
          insertedRecord = record;
          return { ...record, duplicated: false };
        }),
      };

      registerFacesRoutes({
        ctx: mockCtx,
        db: mockDb,
        getConfig: () => ({ face_enabled: true, face_store_max: 10 } as any),
        dshHome: tmpHome,
      });

      const postHandler = handlers.get(FACES_API_PATH);
      const fakeBase64 = Buffer.from('hello-image-white').toString('base64');

      const reqMalicious = createMockReq('POST', {
        data: fakeBase64,
        format: '../../evil.sh',
      });
      const { res: resMalicious, getResult: getResultMalicious } = createMockRes();
      await postHandler(reqMalicious, resMalicious);
      const resResult = await getResultMalicious();

      expect(resResult.status).toBe(200);
      expect(insertedRecord).toBeDefined();
      expect(insertedRecord.format).toBe('png');
      expect(insertedRecord.file_path).toMatch(/\.png$/);
      expect(insertedRecord.file_path).not.toContain('..');
    });
  });

  describe('slang-routes 宿主身份认证门控 (Slang Routes Host Connection Fence)', () => {
    it('当 ctx.connection 不存在时，所有 /plugins/kujira/slang* 路由严格 Fail-Closed 返回 403 Forbidden', async () => {
      expect(SLANG_API_PATH).toBe('/plugins/kujira/slang');

      const handlers = new Map<string, any>();
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'webServer') {
            return {
              register: (r: any) => {
                handlers.set(r.path, r.handler);
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const mockStorage: any = {
        getEntries: vi.fn(),
        getStats: vi.fn(),
        recordEntry: vi.fn(),
        editEntry: vi.fn(),
        deleteEntry: vi.fn(),
      };

      registerSlangRoutes({ ctx: mockCtx, storage: mockStorage });

      const getHandler = handlers.get(SLANG_API_PATH);
      expect(getHandler).toBeDefined();
      const reqGet = createMockReq('GET');
      const { res: resGet, getResult: getResultGet } = createMockRes();
      await getHandler(reqGet, resGet);
      const resGetResult = await getResultGet();
      expect(resGetResult.status).toBe(403);
      expect(resGetResult.body.error).toContain('Forbidden');

      const reqPost = createMockReq('POST', { term: 'a', tags: 'b', definition: 'c', example: 'd' });
      const { res: resPost, getResult: getResultPost } = createMockRes();
      await getHandler(reqPost, resPost);
      const resPostResult = await getResultPost();
      expect(resPostResult.status).toBe(403);

      const editHandler = handlers.get(`${SLANG_API_PATH}/edit`);
      expect(editHandler).toBeDefined();
      const reqEdit = createMockReq('POST', { term: 'a', definition: 'new' });
      const { res: resEdit, getResult: getResultEdit } = createMockRes();
      await editHandler(reqEdit, resEdit);
      const resEditResult = await getResultEdit();
      expect(resEditResult.status).toBe(403);

      const delHandler = handlers.get(`${SLANG_API_PATH}/delete`);
      expect(delHandler).toBeDefined();
      const reqDel = createMockReq('POST', { term: 'a' });
      const { res: resDel, getResult: getResultDel } = createMockRes();
      await delHandler(reqDel, resDel);
      const resDelResult = await getResultDel();
      expect(resDelResult.status).toBe(403);
    });

    it('当 requestRejection 返回 401/403 时准确阻断，返回 undefined 时放行', async () => {
      let rejectionCode: number | undefined = 403;
      const handlers = new Map<string, any>();
      const mockCtx: any = {
        get: vi.fn((name) => {
          if (name === 'connection') return { requestRejection: () => rejectionCode };
          if (name === 'webServer') {
            return {
              register: (r: any) => {
                handlers.set(r.path, r.handler);
                return () => {};
              },
            };
          }
          return undefined;
        }),
        inject: vi.fn(),
      };

      const mockStorage: any = {
        getEntries: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockReturnValue({ total: 0, maxEntries: 300, evictPolicy: 'reject' }),
      };

      registerSlangRoutes({ ctx: mockCtx, storage: mockStorage });

      const getHandler = handlers.get(SLANG_API_PATH);

      const req403 = createMockReq('GET');
      const { res: res403, getResult: getResult403 } = createMockRes();
      await getHandler(req403, res403);
      const res403Result = await getResult403();
      expect(res403Result.status).toBe(403);
      expect(mockStorage.getEntries).not.toHaveBeenCalled();

      rejectionCode = undefined;
      const reqPass = createMockReq('GET');
      const { res: resPass, getResult: getResultPass } = createMockRes();
      await getHandler(reqPass, resPass);
      const resPassResult = await getResultPass();
      expect(resPassResult.status).toBe(200);
      expect(mockStorage.getEntries).toHaveBeenCalled();
    });
  });
});

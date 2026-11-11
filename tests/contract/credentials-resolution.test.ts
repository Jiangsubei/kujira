import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveDshHome,
  readCredentialRefs,
  resolveCredentials,
  describeCredentials,
  saveCredentials,
  unsetCredentials,
} from '../../src/config/credentials.js';
import { CRED_APP_ID, CRED_SECRET } from '../../src/constants/index.js';

function assertLosslessJson(value: unknown, trail = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return;
  }
  if (value === undefined) {
    throw new Error(`Lossless JSON violation at ${trail}: found undefined`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, `${trail}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) {
        throw new Error(`Lossless JSON violation at ${trail}.${k}: property value is undefined`);
      }
      assertLosslessJson(v, `${trail}.${k}`);
    }
    return;
  }
  throw new Error(`Lossless JSON violation at ${trail}: unsupported type ${typeof value}`);
}

describe('契约测试: DSH 官方凭据管理与多层级解析 (Credentials Resolution Contract)', () => {
  let tmpRoot: string;
  let dshHome: string;
  let cwdDir: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-creds-'));
    dshHome = path.join(tmpRoot, 'dsh-home');
    cwdDir = path.join(tmpRoot, 'project-cwd');
    await fsp.mkdir(dshHome, { recursive: true });
    await fsp.mkdir(cwdDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('1. resolveDshHome 与 readCredentialRefs 纯函数契约', () => {
    it('resolveDshHome 按 explicitHome > env.DSH_HOME > ~/.dsh 优先级解析并忽略空白覆写', () => {
      const mockEnv = {
        DSH_HOME: path.join(tmpRoot, 'env-home'),
        HOME: path.join(tmpRoot, 'os-home'),
      } as NodeJS.ProcessEnv;

      expect(resolveDshHome(path.join(tmpRoot, 'explicit-home'), mockEnv)).toBe(
        path.resolve(tmpRoot, 'explicit-home')
      );
      expect(resolveDshHome('   ', mockEnv)).toBe(path.resolve(tmpRoot, 'env-home'));
      expect(
        resolveDshHome(undefined, { DSH_HOME: '  ', HOME: path.join(tmpRoot, 'os-home') } as NodeJS.ProcessEnv)
      ).toBe(path.resolve(tmpRoot, 'os-home', '.dsh'));
    });

    it('readCredentialRefs 读取 version: 1 的 refs 映射，忽略空值、records 及未知顶层键', async () => {
      expect(readCredentialRefs(dshHome)).toEqual({});

      await fsp.writeFile(
        path.join(dshHome, '.credentials.yaml'),
        [
          'version: 1',
          'refs:',
          '  QQ_BOT_APP_ID: "1000000001"',
          '  QQ_BOT_SECRET: "mock-secret-yaml"',
          '  EMPTY_REF: ""',
          'records:',
          '  kujira/session:',
          '    kind: grant',
          '    payload: {}',
          'foreign_tool_key: ignored',
          '',
        ].join('\n'),
        'utf8'
      );

      expect(readCredentialRefs(dshHome)).toEqual({
        QQ_BOT_APP_ID: '1000000001',
        QQ_BOT_SECRET: 'mock-secret-yaml',
      });
    });
  });

  describe('2. 对接 DSH ctx.credentials 服务契约', () => {
    it('优先通过 ctx.credentials 解析凭据，并返回无 undefined 的 Lossless JSON 结构', async () => {
      const store = new Map<string, string>([
        [CRED_APP_ID, '1000000001'],
        [CRED_SECRET, 'mock-secret-ctx'],
      ]);
      const resolveSpy = vi.fn(async (ref: string) => {
        const value = store.get(ref);
        return value ? { value, source: 'file' } : undefined;
      });
      const describeSpy = vi.fn(async (ref: string) => {
        const has = store.has(ref);
        return has ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true };
      });
      const mockCtx = {
        get: vi.fn((name: string) =>
          name === 'credentials' ? { resolve: resolveSpy, describe: describeSpy } : undefined
        ),
      };

      const res = await resolveCredentials(mockCtx);
      assertLosslessJson(res);
      expect(resolveSpy).toHaveBeenCalledWith(CRED_APP_ID);
      expect(resolveSpy).toHaveBeenCalledWith(CRED_SECRET);
      expect(res.credential).toEqual({
        appId: '1000000001',
        appSecret: 'mock-secret-ctx',
      });
      expect(res.reason).toBeUndefined();
      expect('reason' in res).toBe(false);
      expect(res.status).toEqual({
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: true, source: 'file', writable: true },
        ready: true,
      });
      expect('reason' in res.status).toBe(false);
    });

    it('仅缺失某一项凭据时返回明确 reason 与 ready=false，且不生成 credential: undefined 键', async () => {
      const mockCtx = {
        credentials: {
          resolve: vi.fn(async (ref: string) =>
            ref === CRED_APP_ID ? { value: '1000000002', source: 'env' } : undefined
          ),
          describe: vi.fn(async (ref: string) =>
            ref === CRED_APP_ID
              ? { configured: true, source: 'env', writable: true }
              : { configured: false, writable: true }
          ),
        },
      };

      const res = await resolveCredentials(mockCtx);
      assertLosslessJson(res);
      expect('credential' in res).toBe(false);
      expect(res.reason).toContain(CRED_SECRET);
      expect(res.status).toEqual({
        appId: { configured: true, source: 'env', writable: true },
        appSecret: { configured: false, writable: true },
        ready: false,
        reason: res.reason,
      });
      expect('source' in res.status.appSecret).toBe(false);
    });

    it('describeCredentials 仅读取脱敏元数据，绝不回显或泄露明文凭据值', async () => {
      const secretPlaintext = 'super-sensitive-mock-secret-xyz';
      const appIdPlaintext = '1000000009';
      const resolveSpy = vi.fn(async () => ({ value: secretPlaintext, source: 'file' }));
      const describeSpy = vi.fn(async () => ({ configured: true, source: 'file', writable: true }));
      const mockCtx = {
        get: vi.fn((name: string) =>
          name === 'credentials' ? { resolve: resolveSpy, describe: describeSpy } : undefined
        ),
      };

      const summary = await describeCredentials(mockCtx);
      assertLosslessJson(summary);
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(describeSpy).toHaveBeenCalledTimes(2);
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretPlaintext);
      expect(serialized).not.toContain(appIdPlaintext);
      expect(summary).toEqual({
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: true, source: 'file', writable: true },
        ready: true,
      });
    });
  });

  describe('3. 无 ctx.credentials 时独立回退优先级契约', () => {
    it('严格遵守 $DSH_HOME/.credentials.yaml refs: > process.env > <cwd>/.env > $DSH_HOME/.env', async () => {
      await fsp.writeFile(
        path.join(dshHome, '.env'),
        'QQ_BOT_APP_ID=1000000014\nQQ_BOT_SECRET=secret-from-user-env\n',
        'utf8'
      );

      // 层级 4: 仅 $DSH_HOME/.env
      const r4 = await resolveCredentials(undefined, { dshHome, cwd: cwdDir, env: {} });
      assertLosslessJson(r4);
      expect(r4.credential).toEqual({ appId: '1000000014', appSecret: 'secret-from-user-env' });
      expect(r4.status.appId.source).toBe('user-env');
      expect(r4.status.appSecret.source).toBe('user-env');
      expect(r4.status.ready).toBe(true);

      // 层级 3: <cwd>/.env 覆盖 $DSH_HOME/.env
      await fsp.writeFile(
        path.join(cwdDir, '.env'),
        'QQ_BOT_APP_ID=1000000013\nQQ_BOT_SECRET=secret-from-project-env\n',
        'utf8'
      );
      const r3 = await resolveCredentials(undefined, { dshHome, cwd: cwdDir, env: {} });
      expect(r3.credential).toEqual({ appId: '1000000013', appSecret: 'secret-from-project-env' });
      expect(r3.status.appId.source).toBe('project-env');

      // 层级 2: process.env 覆盖 .env
      const mockEnv = {
        QQ_BOT_APP_ID: '1000000012',
        QQ_BOT_SECRET: 'secret-from-process-env',
      } as NodeJS.ProcessEnv;
      const r2 = await resolveCredentials(undefined, { dshHome, cwd: cwdDir, env: mockEnv });
      expect(r2.credential).toEqual({ appId: '1000000012', appSecret: 'secret-from-process-env' });
      expect(r2.status.appId.source).toBe('env');

      // 层级 1: $DSH_HOME/.credentials.yaml refs: 覆盖所有环境变量与 .env
      await fsp.writeFile(
        path.join(dshHome, '.credentials.yaml'),
        'version: 1\nrefs:\n  QQ_BOT_APP_ID: "1000000011"\n  QQ_BOT_SECRET: "secret-from-yaml-file"\n',
        'utf8'
      );
      const r1 = await resolveCredentials(undefined, { dshHome, cwd: cwdDir, env: mockEnv });
      expect(r1.credential).toEqual({ appId: '1000000011', appSecret: 'secret-from-yaml-file' });
      expect(r1.status.appId.source).toBe('file');
      expect(r1.status.appSecret.source).toBe('file');
    });

    it('高位存储为空字符串时视为未配置，自动透传回落到低位来源', async () => {
      await fsp.writeFile(
        path.join(dshHome, '.credentials.yaml'),
        'version: 1\nrefs:\n  QQ_BOT_APP_ID: ""\n  QQ_BOT_SECRET: "file-secret"\n',
        'utf8'
      );
      const mockEnv = { QQ_BOT_APP_ID: '1000000015' } as NodeJS.ProcessEnv;

      const res = await resolveCredentials(undefined, { dshHome, cwd: cwdDir, env: mockEnv });
      assertLosslessJson(res);
      expect(res.credential).toEqual({ appId: '1000000015', appSecret: 'file-secret' });
      expect(res.status.appId.source).toBe('env');
      expect(res.status.appSecret.source).toBe('file');
    });

    it('独立回退模式下 describeCredentials 同样绝不暴露明文凭据', async () => {
      const secretVal = 'plain-secret-must-not-leak';
      await fsp.writeFile(
        path.join(dshHome, '.credentials.yaml'),
        `version: 1\nrefs:\n  QQ_BOT_APP_ID: "1000000016"\n  QQ_BOT_SECRET: "${secretVal}"\n`,
        'utf8'
      );
      const summary = await describeCredentials(undefined, { dshHome, cwd: cwdDir, env: {} });
      assertLosslessJson(summary);
      expect(JSON.stringify(summary)).not.toContain(secretVal);
      expect(JSON.stringify(summary)).not.toContain('1000000016');
      expect(summary).toEqual({
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: true, source: 'file', writable: true },
        ready: true,
      });
    });
  });

  describe('4. saveCredentials 与 unsetCredentials 持久化及防误覆写边界', () => {
    it('委托 ctx.credentials.set 写入非空字段；app_secret 为空或空白时绝不覆写或清除旧秘钥', async () => {
      const store = new Map<string, string>([
        [CRED_APP_ID, '1000000001'],
        [CRED_SECRET, 'existing-secret-keep-me'],
      ]);
      const setSpy = vi.fn(async (ref: string, val: string) => {
        store.set(ref, val);
      });
      const unsetSpy = vi.fn(async (ref: string) => {
        store.delete(ref);
      });
      const mockCtx = {
        get: vi.fn((name: string) =>
          name === 'credentials'
            ? {
                set: setSpy,
                unset: unsetSpy,
                resolve: async (ref: string) => {
                  const v = store.get(ref);
                  return v ? { value: v, source: 'file' } : undefined;
                },
                describe: async (ref: string) =>
                  store.has(ref)
                    ? { configured: true, source: 'file', writable: true }
                    : { configured: false, writable: true },
              }
            : undefined
        ),
      };

      // 只修改 app_id，app_secret 传空字符串 -> 绝不能覆盖或 unset QQ_BOT_SECRET
      const status1 = await saveCredentials(mockCtx, { app_id: '1000000002', app_secret: '   ' });
      assertLosslessJson(status1);
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledWith(CRED_APP_ID, '1000000002');
      expect(unsetSpy).not.toHaveBeenCalled();
      expect(store.get(CRED_SECRET)).toBe('existing-secret-keep-me');
      expect(status1.ready).toBe(true);

      // 显式 unset 后移除指定键
      const status2 = await unsetCredentials(mockCtx, ['app_secret']);
      assertLosslessJson(status2);
      expect(unsetSpy).toHaveBeenCalledTimes(1);
      expect(unsetSpy).toHaveBeenCalledWith(CRED_SECRET);
      expect(status2.appSecret).toEqual({ configured: false, writable: true });
      expect(status2.appId).toEqual({ configured: true, source: 'file', writable: true });
      expect(status2.ready).toBe(false);
      expect(status2.reason).toContain(CRED_SECRET);
    });

    it('ctx.credentials 为只读（缺少 set/unset）时抛出清晰错误，不静默吞错', async () => {
      const readOnlyCtx = {
        credentials: {
          resolve: async () => undefined,
          describe: async () => ({ configured: false, writable: false }),
        },
      };

      await expect(saveCredentials(readOnlyCtx, { app_id: '1000000001' })).rejects.toThrow(/不支持写入|set/);
      await expect(unsetCredentials(readOnlyCtx, ['app_id'])).rejects.toThrow(/不支持清除|unset/);
    });

    it('无 ctx.credentials 时原子更新与清理 $DSH_HOME/.credentials.yaml，保留既有 records 并支持空秘钥防覆写', async () => {
      const credFile = path.join(dshHome, '.credentials.yaml');
      await fsp.writeFile(
        credFile,
        [
          'version: 1',
          'refs:',
          '  OTHER_API_KEY: "keep-other"',
          'records:',
          '  kujira/token:',
          '    kind: grant',
          '    payload:',
          '      ok: true',
          '',
        ].join('\n'),
        'utf8'
      );

      const s1 = await saveCredentials(
        undefined,
        { app_id: ' 1000000003 ', app_secret: 'mock-secret-initial' },
        { dshHome, cwd: cwdDir, env: {} }
      );
      assertLosslessJson(s1);
      expect(s1.appId).toEqual({ configured: true, source: 'file', writable: true });
      expect(s1.appSecret).toEqual({ configured: true, source: 'file', writable: true });
      expect(s1.ready).toBe(true);

      // 再次保存仅改 app_id、app_secret 为空 -> 保留旧 secret 与原有 records/refs
      await saveCredentials(
        undefined,
        { app_id: '1000000004', app_secret: '' },
        { dshHome, cwd: cwdDir, env: {} }
      );
      const resolved = await resolveCredentials(undefined, { dshHome, cwd: cwdDir, env: {} });
      expect(resolved.credential).toEqual({ appId: '1000000004', appSecret: 'mock-secret-initial' });
      const rawFileText = fs.readFileSync(credFile, 'utf8');
      expect(rawFileText).toContain('OTHER_API_KEY');
      expect(rawFileText).toContain('kujira/token');

      // unset app_secret 后自动回落环境变量
      const s2 = await unsetCredentials(undefined, ['app_secret'], {
        dshHome,
        cwd: cwdDir,
        env: { QQ_BOT_SECRET: 'fallback-env-secret' } as NodeJS.ProcessEnv,
      });
      assertLosslessJson(s2);
      expect(s2.appSecret).toEqual({ configured: true, source: 'env', writable: true });
      expect(s2.ready).toBe(true);
      expect(readCredentialRefs(dshHome)).toEqual({
        OTHER_API_KEY: 'keep-other',
        QQ_BOT_APP_ID: '1000000004',
      });
    });
  });
});

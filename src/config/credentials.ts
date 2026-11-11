/**
 * kujira: DSH 官方凭据管理桥接模块
 *
 * 对接 DSH 原生 `ctx.credentials`（`@deepseek-ai/dsh-credentials` / `$DSH_HOME/.credentials.yaml`），
 * 负责 QQ Bot `QQ_BOT_APP_ID` 与 `QQ_BOT_SECRET` 的读取、脱敏状态描述、写入与清除：
 *   - 运行时优先通过 `ctx.credentials` 解析与持久化；
 *   - 独立 CLI / 单测无 `ctx.credentials` 时，严格按 DSH 官方优先级回退：
 *     `$DSH_HOME/.credentials.yaml (refs:)` > `process.env` > `<cwd>/.env` > `$DSH_HOME/.env`；
 *   - 所有对外状态描述符绝不返回明文值，且严格遵循 DSH Lossless JSON 约束（不含 undefined 键）。
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseEnv } from 'node:util';
import yaml from 'js-yaml';
import { CRED_APP_ID, CRED_SECRET } from '../constants/index.js';
import type {
  CredentialSlotStatus,
  CredentialStatusSummary,
  QqCredential,
} from '../types/index.js';
import { atomicWriteFile } from '../utils/atomic-write.js';

const CREDENTIALS_FILENAME = '.credentials.yaml';
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type CredentialRef = string & { readonly __brand?: 'CredentialRef' };

export type { CredentialSlotStatus, CredentialStatusSummary, QqCredential };

export interface CredentialResolveOptions {
  dshHome?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CredentialResolveResult {
  credential?: QqCredential;
  reason?: string;
  status: CredentialStatusSummary;
}

export interface SaveCredentialsInput {
  app_id?: string;
  app_secret?: string;
}

export type CredentialInputKey = 'app_id' | 'app_secret';

interface ResolvedEntry {
  value: string;
  source: string;
}

interface CredentialsServiceLike {
  resolve?: (ref: CredentialRef) => Promise<{ value: string; source: string } | undefined>;
  describe?: (ref: CredentialRef) => Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set?: (ref: CredentialRef, value: string) => Promise<void>;
  unset?: (ref: CredentialRef) => Promise<void>;
}

let cachedCredentialRefFn: ((value: string) => CredentialRef) | undefined;

/**
 * 获取 DSH 官方 `credentialRef` 校验/品牌标记函数；
 * 因 `@deepseek-ai/dsh-credentials` 属宿主 DSH 运行时能力（未作为本包硬依赖声明），
 * 运行时按需从宿主包锚点加载，缺失时回退等价的 POSIX 变量名正则校验。
 */
function toCredentialRef(name: string): CredentialRef {
  if (!cachedCredentialRefFn) {
    const req = createRequire(import.meta.url);
    for (const anchor of [
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-base/package.json',
      '@deepseek-ai/dsh-llm/package.json',
    ]) {
      try {
        const resolved =
          anchor === '@deepseek-ai/dsh-credentials'
            ? req.resolve(anchor)
            : createRequire(req.resolve(anchor)).resolve('@deepseek-ai/dsh-credentials');
        const mod = req(resolved);
        if (typeof mod?.credentialRef === 'function') {
          cachedCredentialRefFn = mod.credentialRef;
          break;
        }
      } catch {
        // 独立运行/单测环境下未暴露 @deepseek-ai/dsh-credentials 时使用本地等价校验
      }
    }
    if (!cachedCredentialRefFn) {
      cachedCredentialRefFn = (value: string): CredentialRef => {
        if (!REF_PATTERN.test(value)) {
          throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`);
        }
        return value as CredentialRef;
      };
    }
  }
  return cachedCredentialRefFn(name);
}

function expandHomePath(rawPath: string, homeDir: string): string {
  if (rawPath === '~') return homeDir;
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

/**
 * 解析 DSH 数据根目录：
 * 优先级：显式 `explicitHome` > `env.DSH_HOME` > `~/.dsh`（忽略空白覆盖）。
 */
export function resolveDshHome(
  explicitHome?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const osHome = env.HOME || env.USERPROFILE || os.homedir();
  const trimmedExplicit = explicitHome?.trim();
  if (trimmedExplicit) {
    return path.resolve(expandHomePath(trimmedExplicit, osHome));
  }
  const envHome = env.DSH_HOME?.trim();
  if (envHome) {
    return path.resolve(expandHomePath(envHome, osHome));
  }
  return path.resolve(osHome, '.dsh');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 纯函数：读取 `$DSH_HOME/.credentials.yaml` 中 `refs:` 区块的有效非空字符串映射。
 */
export function readCredentialRefs(
  dshHome?: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const resolvedHome = resolveDshHome(dshHome, env);
  const credFile = path.join(resolvedHome, CREDENTIALS_FILENAME);
  if (!fs.existsSync(credFile)) return {};

  try {
    const content = fs.readFileSync(credFile, 'utf8');
    if (!content.trim()) return {};
    const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA });
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.refs)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.refs)) {
      if (!REF_PATTERN.test(key)) continue;
      if (typeof value === 'string' && value.length > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function getCredentialsService(ctx?: any): CredentialsServiceLike | undefined {
  if (!ctx) return undefined;
  let svc: any;
  if (typeof ctx.get === 'function') {
    svc = ctx.get('credentials');
  }
  if (!svc) {
    try {
      svc = ctx.credentials;
    } catch {
      // 忽略未 inject 时 Cordis Proxy get trap 抛出的异常
    }
  }
  if (
    svc &&
    (typeof svc.resolve === 'function' ||
      typeof svc.describe === 'function' ||
      typeof svc.set === 'function' ||
      typeof svc.unset === 'function')
  ) {
    return svc as CredentialsServiceLike;
  }
  return undefined;
}

function readLookupValue(
  map: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string
): string | undefined {
  const exact = map[name];
  if (typeof exact === 'string' && exact.length > 0) {
    return exact;
  }
  if (process.platform === 'win32') {
    const targetUpper = name.toUpperCase();
    for (const [k, v] of Object.entries(map)) {
      if (k.toUpperCase() === targetUpper && typeof v === 'string' && v.length > 0) {
        return v;
      }
    }
  }
  return undefined;
}

function readDotEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseEnv(content);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

interface FallbackLayerSnapshot {
  refs: Record<string, string>;
  env: NodeJS.ProcessEnv;
  projectEnv: Record<string, string>;
  userEnv: Record<string, string>;
}

function loadFallbackLayers(options?: CredentialResolveOptions): FallbackLayerSnapshot {
  const env = options?.env ?? process.env;
  const dshHome = resolveDshHome(options?.dshHome, env);
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const refs = readCredentialRefs(dshHome, env);
  const projectEnv = readDotEnvFile(path.join(cwd, '.env'));
  const userEnv = cwd === dshHome ? {} : readDotEnvFile(path.join(dshHome, '.env'));
  return { refs, env, projectEnv, userEnv };
}

function resolveFromFallback(refName: string, layers: FallbackLayerSnapshot): ResolvedEntry | undefined {
  const fromFile = layers.refs[refName];
  if (typeof fromFile === 'string' && fromFile.length > 0) {
    return { value: fromFile, source: 'file' };
  }
  const fromEnv = readLookupValue(layers.env, refName);
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: 'env' };
  }
  const fromProjectEnv = readLookupValue(layers.projectEnv, refName);
  if (fromProjectEnv !== undefined) {
    return { value: fromProjectEnv, source: 'project-env' };
  }
  const fromUserEnv = readLookupValue(layers.userEnv, refName);
  if (fromUserEnv !== undefined) {
    return { value: fromUserEnv, source: 'user-env' };
  }
  return undefined;
}

function toSlotStatus(configured: boolean, source: string | undefined, writable: boolean): CredentialSlotStatus {
  return {
    configured,
    ...(configured && source !== undefined && source.length > 0 ? { source } : {}),
    writable,
  };
}

function buildStatusSummary(
  appId: CredentialSlotStatus,
  appSecret: CredentialSlotStatus
): CredentialStatusSummary {
  const missing: string[] = [];
  if (!appId.configured) missing.push(CRED_APP_ID);
  if (!appSecret.configured) missing.push(CRED_SECRET);
  const ready = missing.length === 0;
  return {
    appId,
    appSecret,
    ready,
    ...(ready ? {} : { reason: `缺少 QQ Bot 凭据：未配置 ${missing.join('、')}` }),
  };
}

async function resolveOneWithService(
  svc: CredentialsServiceLike,
  refName: string
): Promise<{ entry?: ResolvedEntry; slot: CredentialSlotStatus }> {
  const ref = toCredentialRef(refName);
  const resolved = typeof svc.resolve === 'function' ? await svc.resolve(ref) : undefined;
  const entry =
    resolved && typeof resolved.value === 'string' && resolved.value.length > 0
      ? { value: resolved.value, source: String(resolved.source || 'file') }
      : undefined;

  if (typeof svc.describe === 'function') {
    const info = await svc.describe(ref);
    const configured = Boolean(info?.configured);
    const slot = toSlotStatus(
      configured,
      info?.source,
      typeof info?.writable === 'boolean' ? info.writable : typeof svc.set === 'function'
    );
    return { ...(entry !== undefined ? { entry } : {}), slot };
  }

  return {
    ...(entry !== undefined ? { entry } : {}),
    slot: toSlotStatus(entry !== undefined, entry?.source, typeof svc.set === 'function'),
  };
}

async function describeOneWithService(
  svc: CredentialsServiceLike,
  refName: string
): Promise<CredentialSlotStatus> {
  const ref = toCredentialRef(refName);
  if (typeof svc.describe === 'function') {
    const info = await svc.describe(ref);
    return toSlotStatus(
      Boolean(info?.configured),
      info?.source,
      typeof info?.writable === 'boolean' ? info.writable : typeof svc.set === 'function'
    );
  }
  const resolved = typeof svc.resolve === 'function' ? await svc.resolve(ref) : undefined;
  const configured = Boolean(resolved && typeof resolved.value === 'string' && resolved.value.length > 0);
  return toSlotStatus(configured, resolved?.source, typeof svc.set === 'function');
}

/**
 * 描述当前 QQ Bot 凭据配置状态元数据，绝不返回明文值。
 */
export async function describeCredentials(
  ctx?: any,
  options?: CredentialResolveOptions
): Promise<CredentialStatusSummary> {
  const svc = getCredentialsService(ctx);
  if (svc) {
    const [appId, appSecret] = await Promise.all([
      describeOneWithService(svc, CRED_APP_ID),
      describeOneWithService(svc, CRED_SECRET),
    ]);
    return buildStatusSummary(appId, appSecret);
  }

  const layers = loadFallbackLayers(options);
  const appIdEntry = resolveFromFallback(CRED_APP_ID, layers);
  const appSecretEntry = resolveFromFallback(CRED_SECRET, layers);
  return buildStatusSummary(
    toSlotStatus(appIdEntry !== undefined, appIdEntry?.source, true),
    toSlotStatus(appSecretEntry !== undefined, appSecretEntry?.source, true)
  );
}

/**
 * 解析当前 QQ Bot `AppID` 与 `AppSecret` 凭据对及状态摘要。
 * 优先级：`$DSH_HOME/.credentials.yaml (refs:)` > `process.env` > `<cwd>/.env` > `$DSH_HOME/.env`。
 */
export async function resolveCredentials(
  ctx?: any,
  options?: CredentialResolveOptions
): Promise<CredentialResolveResult> {
  const svc = getCredentialsService(ctx);
  let appIdEntry: ResolvedEntry | undefined;
  let appSecretEntry: ResolvedEntry | undefined;
  let appIdSlot: CredentialSlotStatus;
  let appSecretSlot: CredentialSlotStatus;

  if (svc) {
    const [appIdRes, appSecretRes] = await Promise.all([
      resolveOneWithService(svc, CRED_APP_ID),
      resolveOneWithService(svc, CRED_SECRET),
    ]);
    appIdEntry = appIdRes.entry;
    appSecretEntry = appSecretRes.entry;
    appIdSlot = appIdRes.slot;
    appSecretSlot = appSecretRes.slot;
  } else {
    const layers = loadFallbackLayers(options);
    appIdEntry = resolveFromFallback(CRED_APP_ID, layers);
    appSecretEntry = resolveFromFallback(CRED_SECRET, layers);
    appIdSlot = toSlotStatus(appIdEntry !== undefined, appIdEntry?.source, true);
    appSecretSlot = toSlotStatus(appSecretEntry !== undefined, appSecretEntry?.source, true);
  }

  if (appIdEntry && appSecretEntry) {
    return {
      credential: {
        appId: appIdEntry.value,
        appSecret: appSecretEntry.value,
      },
      status: {
        appId: appIdSlot,
        appSecret: appSecretSlot,
        ready: true,
      },
    };
  }

  const missing: string[] = [];
  if (!appIdEntry) missing.push(CRED_APP_ID);
  if (!appSecretEntry) missing.push(CRED_SECRET);
  const reason = `缺少 QQ Bot 凭据：未配置 ${missing.join('、')}`;
  return {
    reason,
    status: {
      appId: appIdSlot,
      appSecret: appSecretSlot,
      ready: false,
      reason,
    },
  };
}

/**
 * 原子更新 `$DSH_HOME/.credentials.yaml` 中的 `refs:` 区块（保留既有 `records` 与其他键）。
 */
async function mutateFallbackCredentialsFile(
  dshHome: string,
  mutations: Array<{ refName: string; value: string | undefined }>
): Promise<void> {
  const credFile = path.join(dshHome, CREDENTIALS_FILENAME);
  let doc: Record<string, unknown> = { version: 1, refs: {} };
  let existed = false;

  if (fs.existsSync(credFile)) {
    existed = true;
    const content = await fsp.readFile(credFile, 'utf8');
    if (content.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA });
      } catch {
        throw new Error(`凭据文件解析失败，拒绝覆盖损坏的配置: ${credFile}`);
      }
      if (!isPlainRecord(parsed)) {
        throw new TypeError(`凭据文件根节点必须为 YAML 映射对象: ${credFile}`);
      }
      if ('version' in parsed && parsed.version !== 1) {
        throw new Error(`不支持的凭据文件版本 (${String(parsed.version)}): ${credFile}`);
      }
      if (parsed.refs !== undefined && parsed.refs !== null && !isPlainRecord(parsed.refs)) {
        throw new TypeError(`凭据文件 refs 字段必须为映射对象: ${credFile}`);
      }
      doc = {
        ...parsed,
        version: 1,
        refs: isPlainRecord(parsed.refs) ? { ...parsed.refs } : {},
      };
    }
  }

  const refs = doc.refs as Record<string, unknown>;
  let changed = false;

  for (const { refName, value } of mutations) {
    if (value === undefined) {
      if (Object.hasOwn(refs, refName)) {
        delete refs[refName];
        changed = true;
      }
    } else if (refs[refName] !== value) {
      refs[refName] = value;
      changed = true;
    }
  }

  if (!changed && existed) {
    return;
  }

  if (!changed && !existed && mutations.every((m) => m.value === undefined)) {
    return;
  }

  const rendered = yaml.dump(doc, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });
  await atomicWriteFile(credFile, rendered, 'utf8');
  if (process.platform !== 'win32') {
    await fsp.chmod(credFile, 0o600);
  }
}

/**
 * 保存 QQ Bot 凭据（仅写入非空值；空字符串或未提供字段绝不覆写既有凭据）。
 * 优先委托 `ctx.credentials.set(...)`，当宿主未挂载 `credentials` 服务时原子更新 `$DSH_HOME/.credentials.yaml`。
 */
export async function saveCredentials(
  ctx: any,
  input: SaveCredentialsInput,
  options?: CredentialResolveOptions
): Promise<CredentialStatusSummary> {
  const updates: Array<{ refName: string; value: string }> = [];
  const nextAppId = typeof input?.app_id === 'string' ? input.app_id.trim() : '';
  const nextAppSecret = typeof input?.app_secret === 'string' ? input.app_secret.trim() : '';

  if (nextAppId.length > 0) {
    updates.push({ refName: CRED_APP_ID, value: nextAppId });
  }
  if (nextAppSecret.length > 0) {
    updates.push({ refName: CRED_SECRET, value: nextAppSecret });
  }

  if (updates.length > 0) {
    const svc = getCredentialsService(ctx);
    if (svc) {
      if (typeof svc.set !== 'function') {
        throw new Error('ctx.credentials 服务不支持写入（缺少 set 方法）');
      }
      for (const item of updates) {
        await svc.set(toCredentialRef(item.refName), item.value);
      }
    } else {
      const dshHome = resolveDshHome(options?.dshHome, options?.env ?? process.env);
      await mutateFallbackCredentialsFile(dshHome, updates);
    }
  }

  return describeCredentials(ctx, options);
}

/**
 * 从持久化凭据库移除指定键（移除后将自动回落至环境变量或 .env 层）。
 */
export async function unsetCredentials(
  ctx: any,
  keys: CredentialInputKey[],
  options?: CredentialResolveOptions
): Promise<CredentialStatusSummary> {
  const keySet = new Set(keys);
  const targets: string[] = [];
  if (keySet.has('app_id')) targets.push(CRED_APP_ID);
  if (keySet.has('app_secret')) targets.push(CRED_SECRET);

  if (targets.length > 0) {
    const svc = getCredentialsService(ctx);
    if (svc) {
      if (typeof svc.unset !== 'function') {
        throw new Error('ctx.credentials 服务不支持清除（缺少 unset 方法）');
      }
      for (const refName of targets) {
        await svc.unset(toCredentialRef(refName));
      }
    } else {
      const dshHome = resolveDshHome(options?.dshHome, options?.env ?? process.env);
      await mutateFallbackCredentialsFile(
        dshHome,
        targets.map((refName) => ({ refName, value: undefined }))
      );
    }
  }

  return describeCredentials(ctx, options);
}

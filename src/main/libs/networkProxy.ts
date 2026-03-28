import { session } from 'electron';
import { normalizeProxyConfig, isValidCustomProxyUrl, sanitizeProxyUrl, type ProxyConfig } from '../../shared/proxy';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

const nodeFetch = require('node-fetch');

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];
type ProxyEnvOverrides = Partial<Record<ProxyEnvKey, string | undefined>>;

type ResolvedProxyBehavior =
  | { mode: 'system'; proxyUrl: string | null }
  | { mode: 'direct' }
  | { mode: 'custom'; proxyUrl: string };

function setEnvValue(target: Record<string, string | undefined>, key: ProxyEnvKey, value: string | undefined): void {
  if (typeof value === 'string' && value.length > 0) {
    target[key] = value;
    return;
  }
  delete target[key];
}

function createDirectEnvOverrides(): ProxyEnvOverrides {
  return PROXY_ENV_KEYS.reduce((acc, key) => {
    acc[key] = undefined;
    return acc;
  }, {} as ProxyEnvOverrides);
}

function createProxyEnvOverrides(proxyUrl: string): ProxyEnvOverrides {
  return {
    ...createDirectEnvOverrides(),
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
  };
}

function applyEnvOverrides(
  target: Record<string, string | undefined>,
  overrides: ProxyEnvOverrides
): Record<string, string | undefined> {
  const next = { ...target };
  PROXY_ENV_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      setEnvValue(next, key, overrides[key]);
    }
  });
  return next;
}

async function resolveProxyBehavior(
  proxyConfig?: ProxyConfig,
  targetUrl = 'https://openrouter.ai'
): Promise<ResolvedProxyBehavior> {
  const normalized = normalizeProxyConfig(proxyConfig);

  if (normalized.mode === 'direct') {
    return { mode: 'direct' };
  }

  if (normalized.mode === 'custom') {
    if (!isValidCustomProxyUrl(normalized.url)) {
      throw new Error(`Invalid proxy URL: ${normalized.url || '(empty)'}`);
    }
    return { mode: 'custom', proxyUrl: normalized.url! };
  }

  if (!isSystemProxyEnabled()) {
    return { mode: 'direct' };
  }

  const proxyUrl = await resolveSystemProxyUrl(targetUrl);
  return { mode: 'system', proxyUrl };
}

function createProxyAgent(proxyUrl: string): any {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl);
}

export async function getProxyAgent(
  proxyConfig?: ProxyConfig,
  targetUrl = 'https://openrouter.ai'
): Promise<any | undefined> {
  const behavior = await resolveProxyBehavior(proxyConfig, targetUrl);
  if (behavior.mode === 'direct') {
    return undefined;
  }
  if (behavior.mode === 'system') {
    return behavior.proxyUrl ? createProxyAgent(behavior.proxyUrl) : undefined;
  }
  return createProxyAgent(behavior.proxyUrl);
}

export async function getProxyEnvOverrides(
  proxyConfig?: ProxyConfig,
  targetUrl = 'https://openrouter.ai'
): Promise<ProxyEnvOverrides> {
  const behavior = await resolveProxyBehavior(proxyConfig, targetUrl);
  if (behavior.mode === 'custom') {
    return createProxyEnvOverrides(behavior.proxyUrl);
  }
  if (behavior.mode === 'system' && behavior.proxyUrl) {
    return createProxyEnvOverrides(behavior.proxyUrl);
  }
  return createDirectEnvOverrides();
}

export async function applyProxyToEnv(
  env: Record<string, string | undefined>,
  proxyConfig?: ProxyConfig,
  targetUrl = 'https://openrouter.ai'
): Promise<Record<string, string | undefined>> {
  const overrides = await getProxyEnvOverrides(proxyConfig, targetUrl);
  return applyEnvOverrides(env, overrides);
}

export async function fetchWithProxy(
  url: string,
  options: RequestInit = {},
  proxyConfig?: ProxyConfig
): Promise<Response> {
  const behavior = await resolveProxyBehavior(proxyConfig, url);

  if (behavior.mode === 'system') {
    return session.defaultSession.fetch(url, options);
  }

  if (behavior.mode === 'direct') {
    return nodeFetch(url, options);
  }

  const agent = createProxyAgent(behavior.proxyUrl);
  return nodeFetch(url, {
    ...options,
    agent,
  });
}

export async function getAxiosProxyOptions(
  proxyConfig?: ProxyConfig,
  targetUrl = 'https://openrouter.ai'
): Promise<Record<string, unknown>> {
  const behavior = await resolveProxyBehavior(proxyConfig, targetUrl);

  if (behavior.mode === 'system') {
    return {};
  }

  if (behavior.mode === 'direct') {
    return { proxy: false };
  }

  const agent = createProxyAgent(behavior.proxyUrl);
  return {
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
  };
}

let proxyEnvMutationChain: Promise<unknown> = Promise.resolve();
let proxyEnvLeaseSeed = 0;
let proxyEnvLeaseBase: ProxyEnvOverrides | null = null;
const activeProxyEnvLeases = new Map<number, ProxyEnvOverrides>();

function applyOverridesToProcess(overrides: ProxyEnvOverrides): void {
  PROXY_ENV_KEYS.forEach((key) => {
    const value = overrides[key];
    if (typeof value === 'string' && value.length > 0) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  });
}

function recomputeLeasedProxyEnv(): void {
  const base = proxyEnvLeaseBase ?? PROXY_ENV_KEYS.reduce((acc, key) => {
    acc[key] = process.env[key];
    return acc;
  }, {} as ProxyEnvOverrides);

  const next = Array.from(activeProxyEnvLeases.values()).reduce((acc, overrides) => {
    return applyEnvOverrides(acc, overrides);
  }, applyEnvOverrides({}, base));

  applyOverridesToProcess(next);
}

export async function withTemporaryProxyEnv<T>(
  proxyConfig: ProxyConfig | undefined,
  targetUrl: string,
  callback: () => Promise<T>
): Promise<T> {
  const run = async (): Promise<T> => {
    const snapshot = PROXY_ENV_KEYS.reduce((acc, key) => {
      acc[key] = process.env[key];
      return acc;
    }, {} as ProxyEnvOverrides);
    try {
      const overrides = await getProxyEnvOverrides(proxyConfig, targetUrl);
      PROXY_ENV_KEYS.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          const value = overrides[key];
          if (typeof value === 'string' && value.length > 0) {
            process.env[key] = value;
          } else {
            delete process.env[key];
          }
        }
      });
      return await callback();
    } finally {
      PROXY_ENV_KEYS.forEach((key) => {
        const value = snapshot[key];
        if (typeof value === 'string' && value.length > 0) {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      });
    }
  };

  const nextRun = proxyEnvMutationChain.then(run, run);
  proxyEnvMutationChain = nextRun.then((): undefined => undefined, (): undefined => undefined);
  return nextRun;
}

export async function acquireProcessProxyEnvLease(
  proxyConfig: ProxyConfig | undefined,
  targetUrl: string
): Promise<() => void> {
  const overrides = await getProxyEnvOverrides(proxyConfig, targetUrl);
  const leaseId = ++proxyEnvLeaseSeed;

  const acquire = async (): Promise<void> => {
    if (proxyEnvLeaseBase == null) {
      proxyEnvLeaseBase = PROXY_ENV_KEYS.reduce((acc, key) => {
        acc[key] = process.env[key];
        return acc;
      }, {} as ProxyEnvOverrides);
    }
    activeProxyEnvLeases.set(leaseId, overrides);
    recomputeLeasedProxyEnv();
  };

  const release = (): void => {
    const run = async (): Promise<void> => {
      activeProxyEnvLeases.delete(leaseId);
      if (activeProxyEnvLeases.size === 0) {
        if (proxyEnvLeaseBase) {
          applyOverridesToProcess(proxyEnvLeaseBase);
        }
        proxyEnvLeaseBase = null;
        return;
      }
      recomputeLeasedProxyEnv();
    };

    const nextRun = proxyEnvMutationChain.then(run, run);
    proxyEnvMutationChain = nextRun.then((): undefined => undefined, (): undefined => undefined);
  };

  const nextRun = proxyEnvMutationChain.then(acquire, acquire);
  proxyEnvMutationChain = nextRun.then((): undefined => undefined, (): undefined => undefined);
  await nextRun;
  return release;
}

export async function summarizeResolvedProxy(
  proxyConfig?: ProxyConfig,
  targetUrl = 'https://openrouter.ai'
): Promise<{ mode: string; proxyUrl: string | null }> {
  const behavior = await resolveProxyBehavior(proxyConfig, targetUrl);
  if (behavior.mode === 'custom') {
    return { mode: 'custom', proxyUrl: sanitizeProxyUrl(behavior.proxyUrl) };
  }
  if (behavior.mode === 'system') {
    return { mode: 'system', proxyUrl: sanitizeProxyUrl(behavior.proxyUrl) };
  }
  return { mode: 'direct', proxyUrl: null };
}

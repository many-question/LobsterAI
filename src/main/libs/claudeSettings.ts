import { join } from 'path';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import { defaultConfig as rendererDefaultConfig } from '../../renderer/config';
import {
  configureCoworkOpenAICompatProxy,
  type OpenAICompatProxyTarget,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, type AnthropicApiFormat } from './coworkFormatTransform';
import type { ProxyConfig } from '../../shared/proxy';
import { normalizeProxyConfig } from '../../shared/proxy';

const ZHIPU_CODING_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
// Qwen Coding Plan 专属端点 (OpenAI 兼容和 Anthropic 兼容)
const QWEN_CODING_PLAN_OPENAI_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
const QWEN_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
// Volcengine Coding Plan 专属端点 (OpenAI 兼容和 Anthropic 兼容)
const VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding';
// Moonshot/Kimi Coding Plan 专属端点 (OpenAI 兼容和 Anthropic 兼容)
const MOONSHOT_CODING_PLAN_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
const MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding';

type ProviderModel = {
  id: string;
  name?: string;
  supportsImage?: boolean;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  proxy?: ProxyConfig;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  requiresApiKey?: boolean;
  codingPlanEnabled?: boolean;
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    availableModels?: ProviderModel[];
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, ProviderConfig>;
};

export type AvailableModelDescriptor = {
  id: string;
  name: string;
  providerKey: string;
  supportsImage?: boolean;
  supportsTools?: boolean;
};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
  proxy?: ProxyConfig;
  providerMetadata?: {
    providerName: string;
    codingPlanEnabled: boolean;
    supportsImage?: boolean;
  };
};

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

// Auth token getter injected from main.ts for server model provider
let authTokensGetter: (() => { accessToken: string; refreshToken: string } | null) | null = null;

export function setAuthTokensGetter(getter: () => { accessToken: string; refreshToken: string } | null): void {
  authTokensGetter = getter;
}

// Server base URL getter injected from main.ts
let serverBaseUrlGetter: (() => string) | null = null;

export function setServerBaseUrlGetter(getter: () => string): void {
  serverBaseUrlGetter = getter;
}

// Cached server model metadata (populated when auth:getModels is called)
// Keyed by modelId → { supportsImage }
let serverModelMetadataCache: Map<string, { supportsImage?: boolean }> = new Map();

export function updateServerModelMetadata(models: Array<{ modelId: string; supportsImage?: boolean }>): void {
  serverModelMetadataCache = new Map(models.map(m => [m.modelId, { supportsImage: m.supportsImage }]));
}

export function clearServerModelMetadata(): void {
  serverModelMetadataCache.clear();
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

export function getClaudeCodePath(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }

  // In development, try to find the SDK in the project root node_modules
  // app.getAppPath() might point to dist-electron or other build output directories
  // We need to look in the project root
  const appPath = app.getAppPath();
  // If appPath ends with dist-electron, go up one level
  const rootDir = appPath.endsWith('dist-electron') 
    ? join(appPath, '..') 
    : appPath;

  return join(rootDir, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
  baseURL: string;
  proxy: ProxyConfig;
  supportsImage?: boolean;
};

function buildMergedProviders(appConfig?: AppConfig | null): Record<string, ProviderConfig> {
  const defaultProviders = (rendererDefaultConfig.providers ?? {}) as Record<string, ProviderConfig>;
  const storedProviders = appConfig?.providers ?? {};
  return Object.fromEntries(
    Object.entries({
      ...defaultProviders,
      ...storedProviders,
    }).map(([providerKey, providerConfig]) => [
      providerKey,
      (() => {
        const mergedProvider = {
          ...(defaultProviders[providerKey] ?? {}),
          ...(providerConfig ?? {}),
        } as Partial<ProviderConfig>;

        return {
          enabled: mergedProvider.enabled ?? false,
          apiKey: mergedProvider.apiKey ?? '',
          baseUrl: mergedProvider.baseUrl ?? '',
          proxy: normalizeProxyConfig(mergedProvider.proxy),
          apiFormat: mergedProvider.apiFormat,
          requiresApiKey: mergedProvider.requiresApiKey,
          codingPlanEnabled: mergedProvider.codingPlanEnabled,
          models: mergedProvider.models ?? [],
        } satisfies ProviderConfig;
      })(),
    ])
  );
}

function getEffectiveAppConfig(appConfig?: AppConfig | null): AppConfig {
  return {
    ...appConfig,
    model: {
      availableModels: rendererDefaultConfig.model.availableModels,
      defaultModel: rendererDefaultConfig.model.defaultModel,
      defaultModelProvider: rendererDefaultConfig.model.defaultModelProvider,
      ...(appConfig?.model ?? {}),
    },
    providers: buildMergedProviders(appConfig),
  };
}

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'openai' || providerName === 'gemini' || providerName === 'stepfun' || providerName === 'youdaozhiyun') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerConfig: ProviderConfig | undefined, providerName?: string): boolean {
  if (typeof providerConfig?.requiresApiKey === 'boolean') {
    return providerConfig.requiresApiKey;
  }
  return providerName !== 'ollama' && providerName !== 'lmstudio';
}

function tryLobsteraiServerFallback(modelId?: string): MatchedProvider | null {
  const tokens = authTokensGetter?.();
  const serverBaseUrl = serverBaseUrlGetter?.();
  if (!tokens?.accessToken || !serverBaseUrl) return null;
  const effectiveModelId = modelId?.trim() || '';
  if (!effectiveModelId) return null;
  const baseURL = `${serverBaseUrl}/api/proxy/v1`;
  const cachedMeta = serverModelMetadataCache.get(effectiveModelId);
  console.log('[ClaudeSettings] lobsterai-server fallback activated:', { baseURL, modelId: effectiveModelId, supportsImage: cachedMeta?.supportsImage });
  return {
    providerName: 'lobsterai-server',
    providerConfig: {
      enabled: true,
      apiKey: tokens.accessToken,
      baseUrl: baseURL,
      proxy: normalizeProxyConfig(undefined),
      apiFormat: 'openai',
      models: [{ id: effectiveModelId, supportsImage: cachedMeta?.supportsImage }],
    },
    modelId: effectiveModelId,
    apiFormat: 'openai',
    baseURL,
    proxy: normalizeProxyConfig(undefined),
    supportsImage: cachedMeta?.supportsImage,
  };
}

function resolveMatchedProvider(appConfig: AppConfig): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};

  const resolveFallbackModel = (): {
    providerName: string;
    providerConfig: ProviderConfig;
    modelId: string;
  } | null => {
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (!providerConfig?.enabled || !providerConfig.models || providerConfig.models.length === 0) {
        continue;
      }
      const fallbackModel = providerConfig.models.find((model) => model.id?.trim());
      if (!fallbackModel) {
        continue;
      }
      return {
        providerName,
        providerConfig,
        modelId: fallbackModel.id.trim(),
      };
    }
    return null;
  };

  const configuredModelId = appConfig.model?.defaultModel?.trim();
  let modelId = configuredModelId || '';
  if (!modelId) {
    const fallback = resolveFallbackModel();
    if (!fallback) {
      const serverFallback = tryLobsteraiServerFallback(configuredModelId);
      if (serverFallback) return { matched: serverFallback };
      return { matched: null, error: 'No available model configured in enabled providers.' };
    }
    modelId = fallback.modelId;
  }

  let providerEntry: [string, ProviderConfig] | undefined;
  const preferredProviderName = appConfig.model?.defaultModelProvider?.trim();

  // Handle lobsterai-server provider: dynamically construct from auth tokens
  if (preferredProviderName === 'lobsterai-server') {
    const serverMatch = tryLobsteraiServerFallback(modelId);
    if (serverMatch) {
      return { matched: serverMatch };
    }
  }

  if (preferredProviderName) {
    const preferredProvider = providers[preferredProviderName];
    if (
      preferredProvider?.enabled
      && preferredProvider.models?.some((model) => model.id === modelId)
    ) {
      providerEntry = [preferredProviderName, preferredProvider];
    }
  }

  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(([, provider]) => {
      if (!provider?.enabled || !provider.models) {
        return false;
      }
      return provider.models.some((model) => model.id === modelId);
    });
  }

  if (!providerEntry) {
    const fallback = resolveFallbackModel();
    if (fallback) {
      modelId = fallback.modelId;
      providerEntry = [fallback.providerName, fallback.providerConfig];
    } else {
      const serverFallback = tryLobsteraiServerFallback(modelId);
      if (serverFallback) return { matched: serverFallback };
      return { matched: null, error: `No enabled provider found for model: ${modelId}` };
    }
  }

  const [providerName, providerConfig] = providerEntry;
  let apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  let baseURL = providerConfig.baseUrl?.trim();

  // Handle Zhipu GLM Coding Plan endpoint switch
  if (providerName === 'zhipu' && providerConfig.codingPlanEnabled) {
    baseURL = ZHIPU_CODING_PLAN_BASE_URL;
    apiFormat = 'openai';
  }

  // Handle Qwen Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'qwen' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = QWEN_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = QWEN_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  // Handle Volcengine Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'volcengine' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  // Handle Moonshot/Kimi Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'moonshot' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = MOONSHOT_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  if (!baseURL) {
    const serverFallback = tryLobsteraiServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerConfig, providerName) && !providerConfig.apiKey?.trim()) {
    const serverFallback = tryLobsteraiServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  const matchedModel = providerConfig.models?.find((m) => m.id === modelId);

  return {
    matched: {
      providerName,
      providerConfig,
      modelId,
      apiFormat,
      baseURL,
      proxy: normalizeProxyConfig(providerConfig.proxy),
      supportsImage: matchedModel?.supportsImage,
    },
  };
}

function getStoredAppConfig(): AppConfig | null {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return null;
  }
  return getEffectiveAppConfig(sqliteStore.get<AppConfig>('app_config'));
}

function listEnabledProviderModels(appConfig: AppConfig): AvailableModelDescriptor[] {
  const providers = appConfig.providers ?? {};
  const entries: AvailableModelDescriptor[] = [];

  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    if (!providerConfig?.enabled || !Array.isArray(providerConfig.models)) {
      continue;
    }

    for (const model of providerConfig.models) {
      const modelId = model.id?.trim();
      if (!modelId) continue;
      entries.push({
        id: modelId,
        name: model.name?.trim() || modelId,
        providerKey,
        supportsImage: model.supportsImage,
        supportsTools: undefined,
      });
    }
  }

  return entries;
}

export function listAvailableConfiguredModels(): AvailableModelDescriptor[] {
  const appConfig = getStoredAppConfig();
  if (!appConfig) {
    return [];
  }
  return listEnabledProviderModels(appConfig);
}

export function getCurrentModelSelection(): AvailableModelDescriptor | null {
  const appConfig = getStoredAppConfig();
  if (!appConfig) {
    return null;
  }

  const { matched } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return null;
  }

  return {
    id: matched.modelId,
    name: matched.providerConfig.models?.find((model) => model.id === matched.modelId)?.name || matched.modelId,
    providerKey: matched.providerName,
    supportsImage: matched.supportsImage,
    supportsTools: undefined,
  };
}

export function setCurrentModelSelection(input: {
  modelId: string;
  providerKey?: string;
}): { selected: AvailableModelDescriptor | null; error?: string } {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return { selected: null, error: 'Store is not initialized.' };
  }

  const appConfig = getEffectiveAppConfig(sqliteStore.get<AppConfig>('app_config'));
  if (!appConfig) {
    return { selected: null, error: 'Application config not found.' };
  }

  const modelId = input.modelId?.trim();
  if (!modelId) {
    return { selected: null, error: 'Model id is required.' };
  }

  const providers = appConfig.providers ?? {};
  const normalizedProviderKey = input.providerKey?.trim();
  let providerEntry: [string, ProviderConfig] | undefined;

  if (normalizedProviderKey) {
    const providerConfig = providers[normalizedProviderKey];
    if (providerConfig?.enabled && providerConfig.models?.some((model) => model.id === modelId)) {
      providerEntry = [normalizedProviderKey, providerConfig];
    } else {
      return {
        selected: null,
        error: `Model ${modelId} is not enabled under provider ${normalizedProviderKey}.`,
      };
    }
  }

  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(([, providerConfig]) => {
      if (!providerConfig?.enabled || !Array.isArray(providerConfig.models)) {
        return false;
      }
      return providerConfig.models.some((model) => model.id === modelId);
    });
  }

  if (!providerEntry) {
    return {
      selected: null,
      error: `No enabled provider found for model: ${modelId}`,
    };
  }

  const [providerKey, providerConfig] = providerEntry;
  const matchedModel = providerConfig.models?.find((model) => model.id === modelId);
  if (!matchedModel) {
    return {
      selected: null,
      error: `Model not found: ${modelId}`,
    };
  }

  const nextConfig: AppConfig = {
    ...appConfig,
    model: {
      ...(appConfig.model ?? {}),
      defaultModel: modelId,
      defaultModelProvider: providerKey,
    },
  };

  sqliteStore.set('app_config', nextConfig);

  return {
    selected: {
      id: modelId,
      name: matchedModel.name?.trim() || modelId,
      providerKey,
      supportsImage: matchedModel.supportsImage,
      supportsTools: undefined,
    },
  };
}

export function getModelDebugSnapshot(): {
  stored: {
    defaultModel: string | null;
    defaultModelProvider: string | null;
    fallbackModelIds: string[];
    enabledProviders: Array<{
      providerKey: string;
      enabled: boolean;
      baseUrl: string;
      apiFormat?: string;
      modelIds: string[];
    }>;
  };
  effective: {
    defaultModel: string | null;
    defaultModelProvider: string | null;
    fallbackModelIds: string[];
    enabledProviders: Array<{
      providerKey: string;
      enabled: boolean;
      baseUrl: string;
      apiFormat?: string;
      modelIds: string[];
    }>;
  };
  currentSelection: AvailableModelDescriptor | null;
} {
  const appConfig = getStoredAppConfig();
  const providers = appConfig?.providers ?? {};
  const enabledProviders = Object.entries(providers)
    .filter(([, providerConfig]) => providerConfig?.enabled)
    .map(([providerKey, providerConfig]) => ({
      providerKey,
      enabled: !!providerConfig.enabled,
      baseUrl: providerConfig.baseUrl?.trim() || '',
      apiFormat: providerConfig.apiFormat,
      modelIds: (providerConfig.models ?? []).map((model) => model.id).filter(Boolean),
    }));

  const fallbackModelIds = listEnabledProviderModels(appConfig ?? {}).map((model) => model.id);
  const currentSelection = getCurrentModelSelection();

  return {
    stored: {
      defaultModel: appConfig?.model?.defaultModel?.trim() || null,
      defaultModelProvider: appConfig?.model?.defaultModelProvider?.trim() || null,
      fallbackModelIds,
      enabledProviders,
    },
    effective: {
      defaultModel: currentSelection?.id ?? null,
      defaultModelProvider: currentSelection?.providerKey ?? null,
      fallbackModelIds,
      enabledProviders,
    },
    currentSelection,
  };
}

export function resolveCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
      proxy: normalizeProxyConfig(undefined),
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
      proxy: normalizeProxyConfig(undefined),
    };
  }

  const resolvedBaseURL = matched.baseURL;
  const resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';
  // Providers that don't require auth (e.g. Ollama) still need a non-empty
  // placeholder so downstream components (OpenClaw gateway, compat proxy)
  // don't reject the request with "No API key found for provider".
  const effectiveApiKey = resolvedApiKey
    || (!providerRequiresApiKey(matched.providerConfig, matched.providerName) ? 'sk-lobsterai-local' : '');

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
      },
      proxy: matched.proxy,
      providerMetadata: {
        providerName: matched.providerName,
        codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
        supportsImage: matched.supportsImage,
      },
    };
  }

  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (!proxyStatus.running) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy is not running.',
    };
  }

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
    proxy: matched.proxy,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
  if (!proxyBaseURL) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy base URL is unavailable.',
      proxy: matched.proxy,
    };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'lobsterai-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
    proxy: matched.proxy,
    providerMetadata: {
      providerName: matched.providerName,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
      supportsImage: matched.supportsImage,
    },
  };
}

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

/**
 * Resolve the raw API config directly from the app config,
 * without requiring the OpenAI compatibility proxy.
 * Used by OpenClaw config sync which has its own model routing.
 */
export function resolveRawApiConfig(): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = getEffectiveAppConfig(sqliteStore.get<AppConfig>('app_config'));
  if (!appConfig) {
    return { config: null, error: 'Application config not found.', proxy: normalizeProxyConfig(undefined) };
  }
  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return { config: null, error, proxy: normalizeProxyConfig(undefined) };
  }
  const apiKey = matched.providerConfig.apiKey?.trim() || '';
  // OpenClaw's gateway requires a non-empty apiKey for every provider — even
  // local servers (Ollama, vLLM, etc.) that don't enforce auth.  When the user
  // leaves the key blank we supply a placeholder so the gateway doesn't reject
  // the request with "No API key found for provider".
  const effectiveApiKey = apiKey
    || (!providerRequiresApiKey(matched.providerConfig, matched.providerName) ? 'sk-lobsterai-local' : '');
  return {
    config: {
      apiKey: effectiveApiKey,
      baseURL: matched.baseURL,
      model: matched.modelId,
      apiType: matched.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    },
    proxy: matched.proxy,
    providerMetadata: {
      providerName: matched.providerName,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
      supportsImage: matched.supportsImage,
    },
  };
}

/**
 * Collect apiKeys for ALL configured providers (not just the currently selected one).
 * Used by OpenClaw config sync to pre-register all apiKeys as env vars at gateway
 * startup, so switching between providers doesn't require a process restart.
 *
 * Returns a map of env-var-safe provider name → apiKey.
 */
export function resolveAllProviderApiKeys(): Record<string, string> {
  const result: Record<string, string> = {};

  // lobsterai-server: uses auth accessToken
  const tokens = authTokensGetter?.();
  const serverBaseUrl = serverBaseUrlGetter?.();
  if (tokens?.accessToken && serverBaseUrl) {
    result.SERVER = tokens.accessToken;
  }

  // All configured custom providers
  const sqliteStore = getStore();
  if (!sqliteStore) return result;
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig?.providers) return result;

  for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
    if (!providerConfig?.enabled) continue;
    const apiKey = providerConfig.apiKey?.trim();
    if (!apiKey && providerRequiresApiKey(providerConfig, providerName)) continue;
    const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    result[envName] = apiKey || 'sk-lobsterai-local';
  }

  return result;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;

  return baseEnv;
}

export type ProxyMode = 'inherit' | 'direct' | 'custom';

export interface ProxyConfig {
  mode?: ProxyMode;
  url?: string;
}

export const DEFAULT_PROXY_CONFIG: Readonly<Required<Pick<ProxyConfig, 'mode'>>> = {
  mode: 'inherit',
};

export function normalizeProxyConfig(config?: ProxyConfig | null): ProxyConfig {
  if (!config) {
    return { ...DEFAULT_PROXY_CONFIG };
  }

  const mode = config.mode === 'direct' || config.mode === 'custom'
    ? config.mode
    : 'inherit';
  const url = typeof config.url === 'string' ? config.url.trim() : '';

  if (mode !== 'custom') {
    return { mode };
  }

  return url ? { mode, url } : { mode };
}

export function isValidCustomProxyUrl(url?: string | null): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeProxyUrl(url?: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    if (parsed.username && !parsed.password) {
      parsed.username = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

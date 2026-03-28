import { describe, expect, test } from 'vitest';
import {
  CHINA_PROVIDERS,
  EN_PRIORITY_PROVIDERS,
  GLOBAL_PROVIDERS,
  getVisibleProviders,
} from './config';

describe('getVisibleProviders', () => {
  test('returns every provider in Chinese mode', () => {
    expect(getVisibleProviders('zh')).toEqual([...CHINA_PROVIDERS, ...GLOBAL_PROVIDERS]);
  });

  test('returns every provider in English mode with English-first ordering', () => {
    const visibleProviders = getVisibleProviders('en');

    expect(new Set(visibleProviders)).toEqual(new Set([...CHINA_PROVIDERS, ...GLOBAL_PROVIDERS]));
    expect(visibleProviders.slice(0, EN_PRIORITY_PROVIDERS.length)).toEqual(EN_PRIORITY_PROVIDERS);
  });
});

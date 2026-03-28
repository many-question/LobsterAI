import { describe, expect, test } from 'vitest';
import {
  CHINA_IM_PLATFORMS,
  GLOBAL_IM_PLATFORMS,
  getVisibleIMPlatforms,
} from './regionFilter';

describe('getVisibleIMPlatforms', () => {
  test('returns every IM platform in Chinese mode', () => {
    expect(getVisibleIMPlatforms('zh')).toEqual([...CHINA_IM_PLATFORMS, ...GLOBAL_IM_PLATFORMS]);
  });

  test('returns the same IM platforms in English mode', () => {
    expect(getVisibleIMPlatforms('en')).toEqual([...CHINA_IM_PLATFORMS, ...GLOBAL_IM_PLATFORMS]);
  });
});

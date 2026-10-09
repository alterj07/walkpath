import { describe, expect, it } from 'vitest';
import { PIPELINE_VERSION } from '../src/index.ts';

describe('pipeline package', () => {
  it('exports a version', () => {
    expect(PIPELINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

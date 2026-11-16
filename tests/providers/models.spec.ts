import { MODEL_DICTIONARY, getModelsByProvider, modelHasCapability } from '@providers/models';

describe('MODEL_DICTIONARY', () => {
  it('registers the current Qwen flagship while keeping configured models available', () => {
    expect(MODEL_DICTIONARY['qwen/qwen4-max']).toMatchObject({
      provider: 'qwen',
      name: 'Qwen4 Max',
      releasedAt: '2026-11-16',
    });
    expect(MODEL_DICTIONARY['qwen/qwen3.7-max']).toBeUndefined();
  });

  it('marks current Qwen multimodal models as vision-capable', () => {
    expect(modelHasCapability('qwen/qwen4-max', 'multimodal')).toBe(true);
    expect(modelHasCapability('qwen/qwen3.8-max', 'multimodal')).toBe(true);
    expect(modelHasCapability('qwen/qwen3.7-plus', 'multimodal')).toBe(true);
    expect(modelHasCapability('qwen/qwen3.7-flash', 'multimodal')).toBe(true);
    expect(getModelsByProvider('qwen')).toEqual(
      expect.arrayContaining([
        'qwen/qwen4-max',
        'qwen/qwen3.8-max',
        'qwen/qwen3.7-plus',
        'qwen/qwen3.7-flash',
      ]),
    );
  });
});

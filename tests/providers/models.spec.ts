import {
  MODEL_DICTIONARY,
  getModelsByProvider,
  modelHasCapability,
} from '@providers/models';

describe('MODEL_DICTIONARY', () => {
  it('registers the current Qwen flagship and removes the superseded max model', () => {
    expect(MODEL_DICTIONARY['qwen/qwen3.8-max']).toMatchObject({
      provider: 'qwen',
      name: 'Qwen3.8 Max',
      releasedAt: '2026-08-03',
    });
    expect(MODEL_DICTIONARY['qwen/qwen3.7-max']).toBeUndefined();
  });

  it('marks current Qwen multimodal models as vision-capable', () => {
    expect(modelHasCapability('qwen/qwen3.8-max', 'multimodal')).toBe(true);
    expect(modelHasCapability('qwen/qwen3.7-plus', 'multimodal')).toBe(true);
    expect(modelHasCapability('qwen/qwen3.7-flash', 'multimodal')).toBe(true);
    expect(getModelsByProvider('qwen')).toEqual(
      expect.arrayContaining([
        'qwen/qwen3.8-max',
        'qwen/qwen3.7-plus',
        'qwen/qwen3.7-flash',
      ]),
    );
  });
});

import { resolveHumanizedDelayMs } from '@biz/group-task/utils/humanized-delay.util';

describe('resolveHumanizedDelayMs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return 0 for invalid or non-positive base delays', () => {
    expect(resolveHumanizedDelayMs(0)).toBe(0);
    expect(resolveHumanizedDelayMs(-10)).toBe(0);
    expect(resolveHumanizedDelayMs(Number.NaN)).toBe(0);
  });

  it('should use the default lower bound when random is 0', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);

    expect(resolveHumanizedDelayMs(1000)).toBe(750);
  });

  it('should normalize float input and swapped custom factors when picking the upper bound', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999999);

    expect(resolveHumanizedDelayMs(1000.8, { minFactor: 1.2, maxFactor: 0.5 })).toBe(1200);
  });
});

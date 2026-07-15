import type { BrandItem } from '@/sponge/sponge.types';
import { BrandResolutionService } from '@resolution/brand/brand-resolution.service';

describe('BrandResolutionService', () => {
  const catalog: BrandItem[] = [{ id: 1, name: '肯德基', aliases: ['KFC'] }];
  const spongeService = { fetchBrandList: jest.fn() };
  let service: BrandResolutionService;

  beforeEach(() => {
    jest.clearAllMocks();
    spongeService.fetchBrandList.mockResolvedValue(catalog);
    service = new BrandResolutionService(spongeService as never);
  });

  it('resolves text and aliases through the fetched catalog', async () => {
    await expect(service.resolve('我想去KFC', 'user_text')).resolves.toEqual([
      expect.objectContaining({ canonicalName: '肯德基', brandId: 1 }),
    ]);
    await expect(service.resolveAliases(['KFC'])).resolves.toEqual(
      expect.objectContaining({
        applied: [expect.objectContaining({ canonicalName: '肯德基', brandId: 1 })],
        rejected: [],
      }),
    );
    expect(spongeService.fetchBrandList).toHaveBeenCalledTimes(2);
  });

  it('degrades catalog failures to empty resolution results', async () => {
    spongeService.fetchBrandList.mockRejectedValue(new Error('catalog unavailable'));

    await expect(service.resolve('肯德基', 'user_text')).resolves.toEqual([]);
    await expect(service.resolveAliases(['肯德基'])).resolves.toEqual({
      applied: [],
      rejected: [{ input: '肯德基', reason: 'unmatched' }],
    });
  });
});

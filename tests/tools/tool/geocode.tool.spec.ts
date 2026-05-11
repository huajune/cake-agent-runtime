import { buildGeocodeTool } from '@tools/geocode.tool';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('geocode tool', () => {
  const mockGeocodingService = {
    geocode: jest.fn(),
  } as unknown as jest.Mocked<GeocodingService>;

  const toolBuilder = buildGeocodeTool(mockGeocodingService);
  const toolInstance = toolBuilder({
    userId: 'test-user',
    corpId: 'test-corp',
    sessionId: 'test-session',
    messages: [],
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return geocode result on success', async () => {
    const geocodeResult = {
      formattedAddress: '上海市松江区九亭镇',
      province: '上海市',
      city: '上海市',
      district: '松江区',
      township: '九亭镇',
      longitude: 121.32,
      latitude: 31.11,
    };
    (mockGeocodingService.geocode as jest.Mock).mockResolvedValue(geocodeResult);

    const execute = (toolInstance as { execute: (args: Record<string, string>) => Promise<unknown> }).execute;
    const result = await execute({ address: '九亭', city: '上海' });

    expect(result).toEqual(geocodeResult);
    expect(mockGeocodingService.geocode).toHaveBeenCalledWith('九亭', '上海');
  });

  it('should return error when geocoding returns null', async () => {
    (mockGeocodingService.geocode as jest.Mock).mockResolvedValue(null);

    const execute = (toolInstance as { execute: (args: Record<string, string>) => Promise<unknown> }).execute;
    const result = (await execute({ address: '不存在', city: '上海' })) as Record<string, unknown>;

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS);
    expect(result.error).toBe(TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS);
    expect(result.address).toBe('不存在');
    expect(result.city).toBe('上海');
    expect(result._replyInstruction).toContain('确认');
  });

  it('should return error when geocoding service throws', async () => {
    (mockGeocodingService.geocode as jest.Mock).mockRejectedValue(new Error('API down'));

    const execute = (toolInstance as { execute: (args: Record<string, string>) => Promise<unknown> }).execute;
    const result = (await execute({ address: '九亭', city: '上海' })) as Record<string, unknown>;

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_FAILED);
    expect(result.error).toBe(TOOL_ERROR_TYPES.GEOCODE_FAILED);
    expect(result.reason).toBe('API down');
    expect(result._replyInstruction).toContain('稍等');
  });

  it('should reject when city is empty', async () => {
    const execute = (toolInstance as { execute: (args: Record<string, string>) => Promise<unknown> }).execute;
    const result = (await execute({ address: '九亭', city: '   ' })) as Record<string, unknown>;

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_CITY_REQUIRED);
    expect(result._replyInstruction).not.toMatch(/上海|北京|杭州|成都/);
    expect(mockGeocodingService.geocode).not.toHaveBeenCalled();
  });
});

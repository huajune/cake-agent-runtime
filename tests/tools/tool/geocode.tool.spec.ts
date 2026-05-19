import { buildGeocodeTool } from '@tools/geocode.tool';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import type { GeocodeCandidate } from '@infra/geocoding/geocoding.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

type ExecuteFn = (args: { address: string; city?: string | null }) => Promise<unknown>;

function makeCandidate(overrides: Partial<GeocodeCandidate> = {}): GeocodeCandidate {
  return {
    formattedAddress: '上海市嘉定区马陆镇',
    province: '上海市',
    city: '上海市',
    district: '嘉定区',
    township: '马陆镇',
    longitude: 121.27,
    latitude: 31.32,
    poiName: '马陆镇',
    ...overrides,
  };
}

describe('geocode tool', () => {
  const mockGeocodingService = {
    searchCandidates: jest.fn(),
  } as unknown as jest.Mocked<GeocodingService>;

  const toolBuilder = buildGeocodeTool(mockGeocodingService);
  const toolInstance = toolBuilder({
    userId: 'test-user',
    corpId: 'test-corp',
    sessionId: 'test-session',
    messages: [],
  });
  const execute = (toolInstance as unknown as { execute: ExecuteFn }).execute;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('resolution=unique（单城唯一命中）', () => {
    it('city 已传 + 单城返回 → 直接采纳首个候选并展开成 result', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '九亭镇', district: '松江区', township: '九亭镇' }),
      ]);

      const result = (await execute({ address: '九亭', city: '上海' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({
        city: '上海市',
        district: '松江区',
        township: '九亭镇',
      });
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('九亭', '上海');
    });

    it('city 留空 + 单城返回 → 直接采纳（让 geocode 替 LLM 做判定）', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '马陆地铁站' }),
        makeCandidate({ poiName: '马陆镇政府', township: '马陆镇' }),
      ]);

      const result = (await execute({ address: '马陆' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect((result.result as Record<string, unknown>).city).toBe('上海市');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('马陆', null);
    });
  });

  describe('resolution=ambiguous（多城同名）', () => {
    it('多城返回 → 列出去重后的城市清单 + 引导反问', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '上海市',
          district: '黄浦区',
          formattedAddress: '上海市黄浦区解放路',
          poiName: '解放路',
        }),
        makeCandidate({
          city: '南京市',
          district: '秦淮区',
          formattedAddress: '江苏省南京市秦淮区解放路',
          poiName: '解放路',
          province: '江苏省',
        }),
        makeCandidate({
          city: '杭州市',
          district: '上城区',
          formattedAddress: '浙江省杭州市上城区解放路',
          poiName: '解放路',
          province: '浙江省',
        }),
      ]);

      const result = (await execute({ address: '解放路' })) as Record<string, unknown>;

      expect(result.resolution).toBe('ambiguous');
      const candidates = result.candidates as Array<{ city: string }>;
      expect(candidates).toHaveLength(3);
      expect(candidates.map((c) => c.city)).toEqual(['上海市', '南京市', '杭州市']);
      expect(result._replyInstruction).toContain('多个城市');
      expect(result._replyInstruction).toContain('禁止默认');
    });

    it('多城候选超过 3 个时只展示前 3 个不同城市', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ city: '北京市' }),
        makeCandidate({ city: '上海市' }),
        makeCandidate({ city: '广州市' }),
        makeCandidate({ city: '深圳市' }),
        makeCandidate({ city: '北京市' }), // 重复 city 应被去重
      ]);

      const result = (await execute({ address: '人民路' })) as Record<string, unknown>;

      const candidates = result.candidates as Array<{ city: string }>;
      expect(candidates).toHaveLength(3);
      expect(new Set(candidates.map((c) => c.city)).size).toBe(3);
    });
  });

  describe('GEOCODE_AMBIGUOUS_SUFFIX（命中通用后缀黑名单）', () => {
    it('未传 city + 万达广场 → 直接报黑名单错误，不打高德', async () => {
      const result = (await execute({ address: '万达广场' })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX);
      expect(result._replyInstruction).toContain('跨城同名');
      expect(result._replyInstruction).not.toMatch(/上海|北京|杭州|成都|武汉/);
      expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    });

    it('已传 city + 万达广场 → 不触发黑名单，正常走 searchCandidates', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '上海市',
          district: '浦东新区',
          formattedAddress: '上海市浦东新区万达广场',
          poiName: '上海浦东万达广场',
        }),
      ]);

      const result = (await execute({ address: '万达广场', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.resolution).toBe('unique');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('万达广场', '上海');
    });

    it('未传 city + 火车站 → 命中黑名单', async () => {
      const result = (await execute({ address: '火车站' })) as Record<string, unknown>;
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX);
    });
  });

  describe('GEOCODE_UNRESOLVED_ADDRESS', () => {
    it('candidates 为空数组 → 返回未解析错误', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([]);

      const result = (await execute({ address: '不存在', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS);
      expect(result.address).toBe('不存在');
      expect(result.city).toBe('上海');
    });

    it('address 为空字符串 → 直接报未解析，不打高德', async () => {
      const result = (await execute({ address: '   ', city: '上海' })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS);
      expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    });
  });

  describe('GEOCODE_FAILED', () => {
    it('searchCandidates 抛错 → 不向候选人泄露异常原文', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockRejectedValue(new Error('API down'));

      const result = (await execute({ address: '九亭', city: '上海' })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_FAILED);
      expect(result.reason).toBe('API down');
      expect(result._replyInstruction).toContain('稍等');
      expect(result._replyInstruction).not.toContain('API down');
    });
  });
});

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
    typecode: '',
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

  describe('同城道路名 vs 地铁站（锚点择优）', () => {
    // 线上 case：候选人说"七莘路"（实指 12 号线七莘路站），高德 POI 把「道路」排第一，
    // 其代表点落在路北端华漕，距真实站点 ~10km；收敛逻辑应改取同名地铁站。
    it('首条是道路名 + 同城存在地铁站 → 采纳地铁站坐标，而非道路代表点', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          poiName: '七莘路',
          typecode: '190301', // 交通地名;道路名
          district: '闵行区',
          longitude: 121.327282,
          latitude: 31.192294, // 道路北端（华漕）
        }),
        makeCandidate({
          poiName: '七莘路(地铁站)',
          typecode: '150500', // 地铁站
          district: '闵行区',
          longitude: 121.355,
          latitude: 31.108, // 12 号线七莘路站（莘庄）
        }),
      ]);

      const result = (await execute({ address: '七莘路', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({
        longitude: 121.355,
        latitude: 31.108,
      });
    });

    it('首条已是地铁站 → 直接采纳，不受道路降级影响', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          poiName: '马陆地铁站',
          typecode: '150500',
          longitude: 121.28,
          latitude: 31.33,
        }),
        makeCandidate({
          poiName: '马陆路',
          typecode: '190301',
          longitude: 121.27,
          latitude: 31.32,
        }),
      ]);

      const result = (await execute({ address: '马陆', city: '上海' })) as Record<string, unknown>;

      expect(result.result).toMatchObject({ longitude: 121.28, latitude: 31.33 });
    });

    it('首条是道路名但无地铁站 → 退而取更具体的非道路 POI', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '解放路', typecode: '190301', longitude: 121.4, latitude: 31.2 }),
        makeCandidate({
          poiName: '解放路商业广场',
          typecode: '060101',
          longitude: 121.41,
          latitude: 31.21,
        }),
      ]);

      const result = (await execute({ address: '解放路', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.result).toMatchObject({ longitude: 121.41, latitude: 31.21 });
    });

    it('全部都是道路名（无更优候选）→ 兜底沿用首条', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '某条路', typecode: '190301', longitude: 121.5, latitude: 31.3 }),
        makeCandidate({
          poiName: '某条路辅路',
          typecode: '190301',
          longitude: 121.6,
          latitude: 31.4,
        }),
      ]);

      const result = (await execute({ address: '某条路', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.result).toMatchObject({ longitude: 121.5, latitude: 31.3 });
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

    // badcase 回归：候选人答"漕宝路地铁"，旧逻辑因"地铁站"后缀短路报黑名单，
    // 强制反问"在哪个城市"——专名前缀车站应放行给高德全国搜索。
    it('未传 city + 漕宝路地铁站（专名前缀）→ 不触发黑名单，走 searchCandidates', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '上海市',
          district: '徐汇区',
          formattedAddress: '上海市徐汇区漕宝路地铁站',
          poiName: '漕宝路(地铁站)',
          typecode: '150500',
        }),
      ]);

      const result = (await execute({ address: '漕宝路地铁站' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('漕宝路地铁站', null);
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

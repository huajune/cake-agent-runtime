import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { RedisService } from '@infra/redis/redis.service';

describe('GeocodingService', () => {
  let service: GeocodingService;
  let redisService: jest.Mocked<RedisService>;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        AMAP_API_KEY: 'test-amap-key',
      };
      return config[key] ?? defaultValue ?? '';
    }),
  };

  const mockRedisService = {
    get: jest.fn(),
    setex: jest.fn(),
  };

  /** 构造高德 /v3/place/text 成功返回 */
  const mockPlaceResponse = (pois: unknown[]) => ({
    ok: true,
    json: jest.fn().mockResolvedValue({ status: '1', pois }),
  });

  /** 构造高德 /v3/geocode/geo 成功返回 */
  const mockGeocodeResponse = (geocodes: unknown[]) => ({
    ok: true,
    json: jest.fn().mockResolvedValue({ status: '1', geocodes }),
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeocodingService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<GeocodingService>(GeocodingService);
    redisService = module.get(RedisService);
  });

  describe('geocode', () => {
    it('should return cached result when cache hit', async () => {
      const cached = {
        formattedAddress: '上海市浦东新区川沙路5558弄百联川沙购物中心',
        province: '上海市',
        city: '上海市',
        district: '浦东新区',
        township: '川沙',
        longitude: 121.700245,
        latitude: 31.193576,
      };
      redisService.get.mockResolvedValue(cached);

      const result = await service.geocode('川沙百联', '上海');

      expect(result).toEqual(cached);
      expect(redisService.get).toHaveBeenCalledWith('geocode:v2:上海:川沙百联');
    });

    it('should call POI search first and cache result on cache miss', async () => {
      redisService.get.mockResolvedValue(null);

      global.fetch = jest.fn().mockResolvedValue(
        mockPlaceResponse([
          {
            name: '百联川沙购物中心',
            pname: '上海市',
            cityname: '上海市',
            adname: '浦东新区',
            address: '川沙路5558弄',
            business_area: '川沙',
            location: '121.700245,31.193576',
          },
        ]),
      );

      const result = await service.geocode('川沙百联', '上海');

      expect(result).toEqual({
        formattedAddress: '上海市浦东新区川沙路5558弄百联川沙购物中心',
        province: '上海市',
        city: '上海市',
        district: '浦东新区',
        township: '川沙',
        longitude: 121.700245,
        latitude: 31.193576,
      });

      // POI 接口应被调用
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('/v3/place/text');
      expect(url).toContain('citylimit=true');
      expect(url).toContain('city=%E4%B8%8A%E6%B5%B7'); // 上海 URL 编码

      expect(redisService.setex).toHaveBeenCalledWith(
        'geocode:v2:上海:川沙百联',
        30 * 24 * 3600,
        expect.objectContaining({ longitude: 121.700245 }),
      );
    });

    it('should fallback to geocode API when POI search returns empty', async () => {
      redisService.get.mockResolvedValue(null);

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([])) // POI 无结果
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '上海市松江区九亭镇',
              province: '上海市',
              city: [], // 高德直辖市返回空数组
              district: '松江区',
              township: '九亭镇',
              location: '121.32,31.11',
            },
          ]),
        );

      const result = await service.geocode('九亭镇', '上海');

      expect(result).toEqual({
        formattedAddress: '上海市松江区九亭镇',
        province: '上海市',
        city: '上海市', // 空数组时回退到 province
        district: '松江区',
        township: '九亭镇',
        longitude: 121.32,
        latitude: 31.11,
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/v3/place/text');
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/v3/geocode/geo');
    });

    it('should normalize empty array fields from geocode API', async () => {
      redisService.get.mockResolvedValue(null);

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([]))
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '上海市浦东新区',
              province: '上海市',
              city: [],
              district: '浦东新区',
              township: [], // 空数组不应泄漏到结果
              location: '121.54,31.22',
            },
          ]),
        );

      const result = await service.geocode('浦东');

      expect(result?.township).toBe('');
      expect(result?.city).toBe('上海市');
    });

    it('should return null when both POI and geocode return empty', async () => {
      redisService.get.mockResolvedValue(null);

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([]))
        .mockResolvedValueOnce(mockGeocodeResponse([]));

      const result = await service.geocode('不存在的地方');

      expect(result).toBeNull();
      expect(redisService.setex).not.toHaveBeenCalled();
    });

    it('should fallback to geocode when POI HTTP fails', async () => {
      redisService.get.mockResolvedValue(null);

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '上海市松江区九亭镇',
              province: '上海市',
              city: '上海市',
              district: '松江区',
              township: '九亭镇',
              location: '121.32,31.11',
            },
          ]),
        );

      const result = await service.geocode('九亭', '上海');

      expect(result).not.toBeNull();
      expect(result?.longitude).toBe(121.32);
    });

    it('should return null when AMAP_API_KEY is missing', async () => {
      const noKeyConfigService = {
        get: jest.fn().mockReturnValue(''),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GeocodingService,
          { provide: ConfigService, useValue: noKeyConfigService },
          { provide: RedisService, useValue: mockRedisService },
        ],
      }).compile();

      const serviceNoKey = module.get<GeocodingService>(GeocodingService);
      const result = await serviceNoKey.geocode('九亭');

      expect(result).toBeNull();
    });

    it('should return null when both endpoints throw', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const result = await service.geocode('九亭');

      expect(result).toBeNull();
    });

    it('should skip city/citylimit when city is not provided', async () => {
      mockRedisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([]));

      await service.geocode('九亭');

      expect(mockRedisService.get).toHaveBeenCalledWith('geocode:v2:九亭');
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).not.toContain('citylimit');
      expect(url).not.toContain('city=');
    });

    it('should return null when POI location is malformed', async () => {
      redisService.get.mockResolvedValue(null);

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          mockPlaceResponse([
            {
              name: '坏数据',
              pname: '上海市',
              cityname: '上海市',
              adname: '浦东新区',
              location: 'not-a-coord',
            },
          ]),
        )
        .mockResolvedValueOnce(mockGeocodeResponse([]));

      const result = await service.geocode('坏数据', '上海');

      expect(result).toBeNull();
    });
  });

  describe('searchCandidates', () => {
    const makePoi = (overrides: Record<string, unknown> = {}) => ({
      name: '默认 POI',
      pname: '上海市',
      cityname: '上海市',
      adname: '嘉定区',
      address: '马陆镇',
      business_area: '马陆',
      location: '121.27,31.32',
      ...overrides,
    });

    it('cache hit 时直接返回，不调用高德', async () => {
      const cached = [
        {
          formattedAddress: '上海市嘉定区马陆镇',
          province: '上海市',
          city: '上海市',
          district: '嘉定区',
          township: '马陆',
          longitude: 121.27,
          latitude: 31.32,
          poiName: '马陆镇',
        },
      ];
      redisService.get.mockResolvedValue(cached);

      const result = await service.searchCandidates('马陆');

      expect(result).toEqual(cached);
      expect(redisService.get).toHaveBeenCalledWith('geocode:candidates:v3:马陆');
    });

    it('未传 city 时不设 citylimit，让高德全国搜索', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([makePoi()]));

      const candidates = await service.searchCandidates('马陆');

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('/v3/place/text');
      expect(url).not.toContain('citylimit');
      expect(url).not.toContain('city=');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].poiName).toBe('默认 POI');
    });

    it('传 city 时启用 citylimit', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([makePoi()]));

      await service.searchCandidates('马陆', '上海');

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('citylimit=true');
      expect(url).toContain('city=%E4%B8%8A%E6%B5%B7'); // 上海 URL 编码
    });

    it('多 POI 返回 → 全部映射为 GeocodeCandidate 并写缓存', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          mockPlaceResponse([
            makePoi({ name: '解放路上海店', cityname: '上海市' }),
            makePoi({ name: '解放路南京店', cityname: '南京市', pname: '江苏省' }),
          ]),
        );

      const candidates = await service.searchCandidates('解放路');

      expect(candidates).toHaveLength(2);
      expect(candidates.map((c) => c.city)).toEqual(['上海市', '南京市']);
      expect(redisService.setex).toHaveBeenCalledWith(
        'geocode:candidates:v3:解放路',
        30 * 24 * 3600,
        expect.any(Array),
      );
    });

    it('透传高德 typecode（供上层按精度择优）', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          mockPlaceResponse([makePoi({ name: '七莘路(地铁站)', typecode: '150500' })]),
        )
        .mockResolvedValueOnce(mockGeocodeResponse([]));

      const candidates = await service.searchCandidates('七莘路', '上海');

      expect(candidates[0].typecode).toBe('150500');
      expect(candidates[0].source).toBe('poi');
      expect(candidates[0].precision).toBe('metro_station');
      expect(candidates[0].confidence).toBe('high');
    });

    it('高德缺省 typecode 时映射为空字符串', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([makePoi()]));

      const candidates = await service.searchCandidates('马陆', '上海');

      expect(candidates[0].typecode).toBe('');
    });

    it('location 字段非法的 POI 会被跳过', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          mockPlaceResponse([
            makePoi({ name: '好数据' }),
            makePoi({ name: '坏数据', location: 'not-a-coord' }),
            makePoi({ name: '无坐标', location: '' }),
          ]),
        );

      const candidates = await service.searchCandidates('测试');

      expect(candidates).toHaveLength(1);
      expect(candidates[0].poiName).toBe('好数据');
    });

    it('limit 参数透传给高德 offset', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([]));

      await service.searchCandidates('马陆', null, 8);

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('offset=8');
    });

    it('limit 超过 20 时被截断到 20', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([]));

      await service.searchCandidates('马陆', null, 100);

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('offset=20');
    });

    it('limit 小于 1 时被提升到 1', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([]));

      await service.searchCandidates('马陆', null, 0);

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('offset=1');
    });

    it('高德返回空 → 返回空数组且不写缓存', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue(mockPlaceResponse([]));

      const candidates = await service.searchCandidates('不存在');

      expect(candidates).toEqual([]);
      expect(redisService.setex).not.toHaveBeenCalled();
    });

    it('已传 city 且 POI 为空时，降级结构化 geocode 解析道路/街道', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([]))
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '上海市浦东新区花木路',
              province: '上海市',
              city: [],
              district: '浦东新区',
              township: [],
              location: '121.556545,31.212537',
              level: '道路',
            },
          ]),
        );

      const candidates = await service.searchCandidates('浦东新区花木路', '上海');

      expect(candidates).toEqual([
        {
          formattedAddress: '上海市浦东新区花木路',
          province: '上海市',
          city: '上海市',
          district: '浦东新区',
          township: '',
          longitude: 121.556545,
          latitude: 31.212537,
          poiName: '',
          typecode: '',
          source: 'structured',
          precision: 'road',
          confidence: 'medium',
        },
      ]);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/v3/place/text');
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/v3/geocode/geo');
      expect(redisService.setex).toHaveBeenCalledWith(
        'geocode:candidates:v3:上海:浦东新区花木路',
        30 * 24 * 3600,
        candidates,
      );
    });

    it('已传 city 且 POI 为空时，也能用结构化 geocode 解析街道/乡镇短词', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([]))
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '上海市浦东新区花木街道',
              province: '上海市',
              city: [],
              district: '浦东新区',
              township: [],
              location: '121.546406,31.207986',
              level: '乡镇',
            },
          ]),
        );

      const candidates = await service.searchCandidates('花木', '上海');

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        formattedAddress: '上海市浦东新区花木街道',
        source: 'structured',
        precision: 'township',
        confidence: 'medium',
        longitude: 121.546406,
        latitude: 31.207986,
      });
    });

    it('地址文本自带城市线索时，未传 city 也会结构化解析行政区', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([]))
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '江苏省南京市六合区',
              province: '江苏省',
              city: '南京市',
              district: '六合区',
              township: [],
              location: '118.822241,32.323235',
              level: '区县',
            },
          ]),
        );

      const candidates = await service.searchCandidates('南京六合');

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        formattedAddress: '江苏省南京市六合区',
        city: '南京市',
        district: '六合区',
        source: 'structured',
        precision: 'district',
        confidence: 'medium',
      });
    });

    it('已传 city 且通用商业体带明确前缀时，POI 为空后允许结构化兜底', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([]))
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '上海市宝山区宝龙广场(东北门)',
              province: '上海市',
              city: [],
              district: '宝山区',
              township: [],
              location: '121.359959,31.389843',
              level: '兴趣点',
            },
          ]),
        );

      const candidates = await service.searchCandidates('宝山宝龙广场', '上海');

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        formattedAddress: '上海市宝山区宝龙广场(东北门)',
        city: '上海市',
        district: '宝山区',
        source: 'structured',
        precision: 'poi',
        confidence: 'high',
      });
    });

    it('地址包含区县时，不接受结构化 geocode 退化成城市级结果', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockPlaceResponse([]))
        .mockResolvedValueOnce(mockGeocodeResponse([]))
        .mockResolvedValueOnce(
          mockGeocodeResponse([
            {
              formatted_address: '江苏省南京市',
              province: '江苏省',
              city: '南京市',
              district: [],
              township: [],
              location: '118.796624,32.059344',
              level: '市',
            },
          ]),
        );

      const candidates = await service.searchCandidates('雨花区', '南京');

      expect(candidates).toEqual([]);
      expect(redisService.setex).not.toHaveBeenCalled();
    });

    it('AMAP_API_KEY 缺失 → 直接返回空数组', async () => {
      const noKeyConfigService = {
        get: jest.fn().mockReturnValue(''),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GeocodingService,
          { provide: ConfigService, useValue: noKeyConfigService },
          { provide: RedisService, useValue: mockRedisService },
        ],
      }).compile();

      const serviceNoKey = module.get<GeocodingService>(GeocodingService);
      const candidates = await serviceNoKey.searchCandidates('马陆');

      expect(candidates).toEqual([]);
    });

    it('HTTP 失败 → 返回空数组（不抛错）', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

      const candidates = await service.searchCandidates('马陆');

      expect(candidates).toEqual([]);
    });

    it('fetch 抛错 → 返回空数组', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

      const candidates = await service.searchCandidates('马陆');

      expect(candidates).toEqual([]);
    });
  });
});

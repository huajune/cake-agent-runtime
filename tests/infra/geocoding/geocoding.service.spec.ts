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
});

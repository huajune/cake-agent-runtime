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
        formattedAddress: '上海市松江区九亭镇',
        province: '上海市',
        city: '上海市',
        district: '松江区',
        township: '九亭镇',
        longitude: 121.32,
        latitude: 31.11,
      };
      redisService.get.mockResolvedValue(cached);

      const result = await service.geocode('九亭', '上海');

      expect(result).toEqual(cached);
      expect(redisService.get).toHaveBeenCalledWith('geocode:上海:九亭');
    });

    it('should call Amap API and cache result on cache miss', async () => {
      redisService.get.mockResolvedValue(null);

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          status: '1',
          geocodes: [
            {
              formatted_address: '上海市松江区九亭镇',
              province: '上海市',
              city: '上海市',
              district: '松江区',
              township: '九亭镇',
              location: '121.32,31.11',
            },
          ],
        }),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.geocode('九亭', '上海');

      expect(result).toEqual({
        formattedAddress: '上海市松江区九亭镇',
        province: '上海市',
        city: '上海市',
        district: '松江区',
        township: '九亭镇',
        longitude: 121.32,
        latitude: 31.11,
      });
      expect(redisService.setex).toHaveBeenCalledWith(
        'geocode:上海:九亭',
        30 * 24 * 3600,
        expect.objectContaining({ longitude: 121.32 }),
      );
    });

    it('should return null when API returns non-ok response', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

      const result = await service.geocode('九亭');

      expect(result).toBeNull();
    });

    it('should return null when API returns no geocodes', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ status: '1', geocodes: [] }),
      });

      const result = await service.geocode('不存在的地方');

      expect(result).toBeNull();
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

    it('should return null when fetch throws an error', async () => {
      redisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const result = await service.geocode('九亭');

      expect(result).toBeNull();
    });

    it('should use address without city prefix when city is not provided', async () => {
      mockRedisService.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ status: '0' }),
      });

      await service.geocode('九亭');

      expect(mockRedisService.get).toHaveBeenCalledWith('geocode:九亭');
    });
  });
});

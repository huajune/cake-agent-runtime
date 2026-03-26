import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import { GeocodeResult } from './geocoding.types';

const AMAP_GEOCODE_API = 'https://restapi.amap.com/v3/geocode/geo';
const CACHE_PREFIX = 'geocode:';
const CACHE_TTL_SECONDS = 30 * 24 * 3600; // 30 天

/**
 * 地理编码服务 — 封装高德地图 API
 *
 * 将地名文本解析为标准化的省/市/区/镇 + 经纬度。
 * Redis 缓存结果，同一地名不重复请求。
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.apiKey = this.configService.get<string>('AMAP_API_KEY', '');
  }

  /**
   * 地理编码：地名 → 结构化地址 + 经纬度
   *
   * @param address 地名或地址文本（如 "九亭"、"上海市松江区九亭镇"）
   * @param city 可选城市名，提高解析精度
   */
  async geocode(address: string, city?: string): Promise<GeocodeResult | null> {
    if (!this.apiKey) {
      this.logger.warn('缺少 AMAP_API_KEY，地理编码不可用');
      return null;
    }

    const cacheKey = CACHE_PREFIX + (city ? `${city}:${address}` : address);

    // 1. 查缓存
    const cached = await this.redisService.get<GeocodeResult>(cacheKey);
    if (cached) return cached;

    // 2. 调用高德 API
    try {
      const params = new URLSearchParams({
        key: this.apiKey,
        address,
        output: 'JSON',
      });
      if (city) params.set('city', city);

      const response = await fetch(`${AMAP_GEOCODE_API}?${params}`);
      if (!response.ok) {
        this.logger.warn(`高德 API 请求失败: ${response.status}`);
        return null;
      }

      const data = await response.json();
      if (data.status !== '1' || !data.geocodes?.length) {
        this.logger.debug(`地理编码无结果: "${address}"`);
        return null;
      }

      const geo = data.geocodes[0];
      const [lng, lat] = (geo.location as string).split(',').map(Number);

      const result: GeocodeResult = {
        formattedAddress: geo.formatted_address || '',
        province: geo.province || '',
        city: typeof geo.city === 'string' ? geo.city : geo.province || '',
        district: geo.district || '',
        township: geo.township || '',
        longitude: lng,
        latitude: lat,
      };

      // 3. 写缓存
      await this.redisService.setex(cacheKey, CACHE_TTL_SECONDS, result);

      return result;
    } catch (err) {
      this.logger.error('地理编码请求失败', err);
      return null;
    }
  }
}

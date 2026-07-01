import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import { GeocodeCandidate, GeocodeResult } from './geocoding.types';
import {
  classifyGeocodeQuery,
  hasContextualGenericPoiPrefix,
  hasEmbeddedCityHint,
  shouldTryStructuredGeocode,
} from './geocoding-query-classifier.util';
import {
  confidenceForPrecision,
  candidateDistrictMatchesAddress,
  extractDistrictStems,
  inferPoiPrecision,
  inferStructuredPrecision,
  mergeAndRankCandidates,
} from './geocoding-candidate-ranker.util';

const AMAP_PLACE_API = 'https://restapi.amap.com/v3/place/text';
const AMAP_GEOCODE_API = 'https://restapi.amap.com/v3/geocode/geo';
const CACHE_PREFIX = 'geocode:v2:';
// v3: 候选结构新增 source/precision/confidence，并合并 structured geocode 候选
const CANDIDATES_CACHE_PREFIX = 'geocode:candidates:v3:';
const CACHE_TTL_SECONDS = 30 * 24 * 3600; // 30 天
const DEFAULT_CANDIDATES_LIMIT = 5;

/** 高德返回的空字段是 []，需统一转成字符串 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 地理编码服务 — 封装高德地图 API
 *
 * 将地名 / POI / 地址文本解析为标准化的省/市/区/镇 + 经纬度。
 *
 * 解析策略（两级）：
 * 1. 优先走 `/v3/place/text` POI 搜索，命中率高，坐标为真实 POI 位置，
 *    适合口语化地名（"川沙百联"、"陆家嘴"、"世纪公园地铁站"）。
 * 2. POI 无结果时降级 `/v3/geocode/geo` 结构化地址解析，兜底规范地址。
 *
 * Redis 缓存结果，同一输入不重复请求。
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
   * 地理编码：地名 / POI / 地址 → 结构化地址 + 经纬度
   *
   * @param address 地名或地址文本（如 "川沙百联"、"九亭"、"上海市松江区九亭镇"）
   * @param city 可选城市名，提高解析精度并避免跨城市误匹配
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

    // 2. 优先 POI 搜索 → 兜底 geocode
    const result =
      (await this.searchPoi(address, city)) ?? (await this.geocodeStructured(address, city));

    if (!result) {
      this.logger.debug(`地理编码无结果: "${address}"`);
      return null;
    }

    // 3. 写缓存
    await this.redisService.setex(cacheKey, CACHE_TTL_SECONDS, result);

    return result;
  }

  /**
   * 多候选地理搜索 — 用于歧义判定（同名地名命中几个城市）。
   *
   * 调用方（geocode 工具）按返回 candidates 的 city 分布决定：
   * - 单一城市 → 直接采纳第一条
   * - 多城市 → 把候选清单回给 Agent，由 Agent 反问候选人确认
   * - 空 → 反问"换个地名"
   *
   * 与单结果 `geocode()` 的差异：
   * - city 为空时不调用结构化 geocode（结构化兜底默认返回 1 条，无法反映跨城歧义）
   * - city 已明确时，POI + structured 合并，覆盖道路/街道这类 POI 搜不到的地址
   * - POI 搜索不强制 `citylimit`，city 为空时高德全国搜索
   * - 缓存独立 key（candidates vs single result 不互通）
   *
   * @param address 地名或地址文本
   * @param city 可选城市；传入时 citylimit 生效，仅在该城市搜索
   * @param limit POI 返回上限，默认 5
   */
  async searchCandidates(
    address: string,
    city?: string | null,
    limit = DEFAULT_CANDIDATES_LIMIT,
  ): Promise<GeocodeCandidate[]> {
    if (!this.apiKey) {
      this.logger.warn('缺少 AMAP_API_KEY，地理编码不可用');
      return [];
    }

    const normalizedCity = city?.trim() || '';
    const cacheKey =
      CANDIDATES_CACHE_PREFIX + (normalizedCity ? `${normalizedCity}:${address}` : address);

    const cached = await this.redisService.get<GeocodeCandidate[]>(cacheKey);
    if (cached) return cached;

    const queryKind = classifyGeocodeQuery(address);
    const poiCandidates = await this.fetchPoiCandidates(address, normalizedCity, limit);
    const structuredCandidates: GeocodeCandidate[] = [];
    const shouldTryStructured =
      (Boolean(normalizedCity) &&
        (shouldTryStructuredGeocode(queryKind, normalizedCity) ||
          (poiCandidates.length === 0 &&
            (queryKind === 'unknown' ||
              queryKind === 'road' ||
              queryKind === 'admin_area' ||
              queryKind === 'metro_station' ||
              hasContextualGenericPoiPrefix(address))))) ||
      (!normalizedCity && poiCandidates.length === 0 && hasEmbeddedCityHint(address));

    if (shouldTryStructured) {
      structuredCandidates.push(...(await this.fetchStructuredCandidates(address, normalizedCity)));
    }

    const candidates = mergeAndRankCandidates([...poiCandidates, ...structuredCandidates]);

    if (candidates.length === 0) {
      this.logger.debug(`多候选搜索无结果: "${address}" city="${normalizedCity}"`);
      return [];
    }

    await this.redisService.setex(cacheKey, CACHE_TTL_SECONDS, candidates);
    return candidates;
  }

  /**
   * 拉 POI 列表 — 仅供 `searchCandidates` 内部使用。
   * 沿用与 `searchPoi` 相同的字段映射，但保留多条且不限制 `offset=1`。
   */
  private async fetchPoiCandidates(
    address: string,
    city: string,
    limit: number,
  ): Promise<GeocodeCandidate[]> {
    try {
      const params = new URLSearchParams({
        key: this.apiKey,
        keywords: address,
        offset: String(Math.min(Math.max(limit, 1), 20)),
        page: '1',
        extensions: 'base',
        output: 'JSON',
      });
      if (city) {
        params.set('city', city);
        params.set('citylimit', 'true');
      }

      const response = await fetch(`${AMAP_PLACE_API}?${params}`);
      if (!response.ok) {
        this.logger.warn(`高德 POI 多候选 HTTP 失败: ${response.status}`);
        return [];
      }

      const data = await response.json();
      if (data.status !== '1' || !Array.isArray(data.pois) || data.pois.length === 0) {
        return [];
      }

      const candidates: GeocodeCandidate[] = [];
      for (const poi of data.pois) {
        const location = str(poi.location);
        if (!location) continue;

        const [lng, lat] = location.split(',').map(Number);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

        const province = str(poi.pname);
        const cityName = str(poi.cityname) || province;
        const district = str(poi.adname);
        const poiName = str(poi.name);
        const poiAddress = str(poi.address);

        const precision = inferPoiPrecision(poiName, str(poi.typecode));

        candidates.push({
          formattedAddress: `${province}${cityName === province ? '' : cityName}${district}${poiAddress}${poiName}`,
          province,
          city: cityName,
          district,
          township: str(poi.business_area),
          longitude: lng,
          latitude: lat,
          poiName,
          typecode: str(poi.typecode),
          source: 'poi',
          precision,
          confidence: confidenceForPrecision(precision),
        });
      }

      return candidates;
    } catch (err) {
      this.logger.error('高德 POI 多候选失败', err);
      return [];
    }
  }

  private async fetchStructuredCandidates(
    address: string,
    city: string,
  ): Promise<GeocodeCandidate[]> {
    const variants = [address];
    const normalizedCity = city.trim();
    if (
      normalizedCity &&
      !address.includes(normalizedCity) &&
      !address.includes(`${normalizedCity}市`)
    ) {
      variants.push(`${normalizedCity}${address}`);
    }

    const candidates: GeocodeCandidate[] = [];
    const districtStems = extractDistrictStems(address);
    for (const variant of variants) {
      const result = await this.geocodeStructuredWithLevel(variant, city);
      if (!result) continue;
      if (
        districtStems.length > 0 &&
        (!result.result.district ||
          !candidateDistrictMatchesAddress(districtStems, result.result.district))
      ) {
        continue;
      }
      const precision = inferStructuredPrecision(result.level);
      candidates.push({
        ...result.result,
        poiName: '',
        typecode: '',
        source: 'structured',
        precision,
        confidence: confidenceForPrecision(precision),
      });
      break;
    }
    return candidates;
  }

  /**
   * POI 关键字搜索 — 适合口语化地名 / 地标 / 商场 / 地铁站
   * 文档：https://lbs.amap.com/api/webservice/guide/api/search#text
   */
  private async searchPoi(address: string, city?: string): Promise<GeocodeResult | null> {
    try {
      const params = new URLSearchParams({
        key: this.apiKey,
        keywords: address,
        offset: '1', // 只取第一个结果
        page: '1',
        extensions: 'base',
        output: 'JSON',
      });
      if (city) {
        params.set('city', city);
        params.set('citylimit', 'true'); // 限定城市，避免跨城市误匹配
      }

      const response = await fetch(`${AMAP_PLACE_API}?${params}`);
      if (!response.ok) {
        this.logger.warn(`高德 POI 搜索 HTTP 失败: ${response.status}`);
        return null;
      }

      const data = await response.json();
      if (data.status !== '1' || !Array.isArray(data.pois) || data.pois.length === 0) {
        return null;
      }

      const poi = data.pois[0];
      const location = str(poi.location);
      if (!location) return null;

      const [lng, lat] = location.split(',').map(Number);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

      const province = str(poi.pname);
      const cityName = str(poi.cityname) || province;
      const district = str(poi.adname);
      const poiName = str(poi.name);
      const poiAddress = str(poi.address);

      return {
        formattedAddress: `${province}${cityName === province ? '' : cityName}${district}${poiAddress}${poiName}`,
        province,
        city: cityName,
        district,
        township: str(poi.business_area), // POI 接口没有 township，用商圈兜底
        longitude: lng,
        latitude: lat,
      };
    } catch (err) {
      this.logger.error('高德 POI 搜索失败', err);
      return null;
    }
  }

  /**
   * 结构化地址解析 — 兜底方案，适合规范的省市区街道地址
   * 文档：https://lbs.amap.com/api/webservice/guide/api/georegeo#geo
   */
  private async geocodeStructured(address: string, city?: string): Promise<GeocodeResult | null> {
    const structured = await this.geocodeStructuredWithLevel(address, city);
    return structured?.result ?? null;
  }

  private async geocodeStructuredWithLevel(
    address: string,
    city?: string,
  ): Promise<{ result: GeocodeResult; level: string } | null> {
    try {
      const params = new URLSearchParams({
        key: this.apiKey,
        address,
        output: 'JSON',
      });
      if (city) params.set('city', city);

      const response = await fetch(`${AMAP_GEOCODE_API}?${params}`);
      if (!response.ok) {
        this.logger.warn(`高德 geocode HTTP 失败: ${response.status}`);
        return null;
      }

      const data = await response.json();
      if (data.status !== '1' || !Array.isArray(data.geocodes) || data.geocodes.length === 0) {
        return null;
      }

      const geo = data.geocodes[0];
      const location = str(geo.location);
      if (!location) return null;

      const [lng, lat] = location.split(',').map(Number);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

      const province = str(geo.province);

      return {
        result: {
          formattedAddress: str(geo.formatted_address),
          province,
          city: str(geo.city) || province,
          district: str(geo.district),
          township: str(geo.township),
          longitude: lng,
          latitude: lat,
        },
        level: str(geo.level),
      };
    } catch (err) {
      this.logger.error('高德 geocode 失败', err);
      return null;
    }
  }
}

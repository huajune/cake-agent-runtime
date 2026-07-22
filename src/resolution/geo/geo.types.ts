/**
 * 地理解析域的公共类型（与供应商无关）。
 *
 * 与 `resolution/brand` 的 resolve 契约刻意同构：状态 + 标准实体 + 证据，
 * 评审与观测复用同一套心智（geo-domain-refactor-plan v3.1 §8.2）。
 *
 * 迁移期约定：现有函数保持字符串签名（行为等价，Phase 1/2 不改语义）；
 * GeoResolution 结果模型供后续阶段逐步统一，Phase 3 冲突检测 shadow 起用。
 */

/** 行政级别。 */
export type AdministrativeLevel =
  | 'municipality'
  | 'prefecture'
  | 'county_level_city'
  | 'district'
  | 'county'
  | 'township'
  | 'place';

/** 解析证据：resolved 结果必须带证据，不确定时返回 ambiguous/unresolved，禁止猜测。 */
export type GeoResolutionEvidence =
  | 'explicit_city_name'
  | 'unique_district_alias'
  | 'county_parent_relation'
  | 'hotspot_alias'
  | 'geocode_resolved';

/** 地理解析结果模型（§8.2）。 */
export interface GeoResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  city: string | null;
  district: string | null;
  level: AdministrativeLevel | null;
  evidence: GeoResolutionEvidence | null;
  matchedText: string | null;
  candidates?: string[];
}

/** 县级行政区 → 上级地级行政区的解析结果（§8.3）。 */
export interface ParentAdministrativeArea {
  input: string;
  canonicalName: string;
  level: 'county_level_city' | 'district' | 'county';
  parentCity: string;
}

/** 白名单最长优先扫描的单次命中。 */
export interface WhitelistScanHit {
  /** 命中的白名单 key */
  key: string;
  /** key 在消息中起始位置（0-based） */
  start: number;
  /** key 在消息中结束位置（exclusive） */
  end: number;
}

/** 白名单扫描结果：命中列表 + 字符级覆盖标记（供多轮扫描串联复用）。 */
export interface WhitelistScanResult {
  hits: WhitelistScanHit[];
  /** 字符级覆盖标记，长度 === message.length，供后续扫描复用以避免重叠匹配 */
  covered: boolean[];
}

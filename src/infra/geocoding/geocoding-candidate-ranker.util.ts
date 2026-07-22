import { normalizeDistrictForLookup } from '@resolution/geo';
import type {
  GeocodeCandidate,
  GeocodeCandidateConfidence,
  GeocodeCandidatePrecision,
} from './geocoding.types';

const ADMIN_DISTRICT_TOKEN_PATTERN = /[一-龥]{2,8}(?:区|县)/g;

export function inferPoiPrecision(
  poiName: string | null | undefined,
  typecode: string | null | undefined,
): GeocodeCandidatePrecision {
  const normalizedTypecode = typecode ?? '';
  const normalizedName = poiName ?? '';
  if (normalizedTypecode.startsWith('1505') || normalizedName.endsWith('站')) {
    return 'metro_station';
  }
  if (normalizedTypecode.startsWith('1903')) return 'road';
  return 'poi';
}

export function inferStructuredPrecision(
  level: string | null | undefined,
): GeocodeCandidatePrecision {
  const normalizedLevel = level ?? '';
  if (normalizedLevel.includes('公交地铁站点')) return 'metro_station';
  if (normalizedLevel.includes('兴趣点')) return 'poi';
  if (normalizedLevel.includes('道路')) return 'road';
  if (normalizedLevel.includes('乡镇') || normalizedLevel.includes('街道')) return 'township';
  if (normalizedLevel.includes('区县')) return 'district';
  if (normalizedLevel.includes('城市') || normalizedLevel.includes('市')) return 'city';
  return 'unknown';
}

export function confidenceForPrecision(
  precision: GeocodeCandidatePrecision,
): GeocodeCandidateConfidence {
  if (precision === 'metro_station' || precision === 'poi') return 'high';
  if (precision === 'road' || precision === 'township' || precision === 'district') return 'medium';
  return 'low';
}

function precisionRank(candidate: GeocodeCandidate): number {
  const precision =
    candidate.source === 'structured'
      ? candidate.precision
      : inferPoiPrecision(candidate.poiName, candidate.typecode);

  switch (precision) {
    case 'metro_station':
      return 0;
    case 'poi':
      return 1;
    case 'township':
      return 2;
    case 'district':
      return 3;
    case 'road':
      return 4;
    case 'city':
      return 5;
    default:
      return 6;
  }
}

function sourceRank(candidate: GeocodeCandidate): number {
  return candidate.source === 'poi' ? 0 : 1;
}

function candidateKey(candidate: GeocodeCandidate): string {
  return [
    candidate.city,
    candidate.district,
    candidate.formattedAddress,
    candidate.longitude.toFixed(6),
    candidate.latitude.toFixed(6),
  ].join('|');
}

/** 合并 POI 与结构化候选，并按精度稳定排序。 */
export function mergeAndRankCandidates(candidates: GeocodeCandidate[]): GeocodeCandidate[] {
  const seen = new Set<string>();
  const deduped: GeocodeCandidate[] = [];

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped.sort((a, b) => {
    const byPrecision = precisionRank(a) - precisionRank(b);
    if (byPrecision !== 0) return byPrecision;
    return sourceRank(a) - sourceRank(b);
  });
}

/**
 * 同城多候选时挑选锚点。
 * POI/地铁站优先，结构化道路/行政区兜底。
 */
export function pickAnchorCandidate(candidates: GeocodeCandidate[]): GeocodeCandidate {
  const ranked = mergeAndRankCandidates(candidates);
  return ranked[0];
}

/** 抽出 address 里的"X区/X县"级行政区 token（"雨花区"→"雨花"、"长沙县"→"长沙"）。 */
export function extractDistrictStems(address: string): string[] {
  const stems: string[] = [];
  for (const m of address.matchAll(ADMIN_DISTRICT_TOKEN_PATTERN)) {
    const stem = normalizeDistrictForLookup(m[0]);
    if (stem) stems.push(stem);
  }
  return stems;
}

/**
 * 用户报的区 stem 是否与高德返回候选的区一致。
 * 高德没回区名时无从校验，按一致放行，避免误拦。
 */
export function candidateDistrictMatchesAddress(
  addrStems: string[],
  candidateDistrict: string,
): boolean {
  const candidateStem = normalizeDistrictForLookup(candidateDistrict.trim());
  if (!candidateStem) return true;
  return addrStems.some((stem) => candidateStem.includes(stem) || stem.includes(candidateStem));
}

export function groupCandidatesByCity(
  candidates: GeocodeCandidate[],
): Map<string, GeocodeCandidate> {
  const uniqueByCity = new Map<string, GeocodeCandidate>();
  for (const candidate of mergeAndRankCandidates(candidates)) {
    if (!uniqueByCity.has(candidate.city)) uniqueByCity.set(candidate.city, candidate);
  }
  return uniqueByCity;
}

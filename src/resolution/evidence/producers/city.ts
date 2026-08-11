import {
  isRecognizedCityName,
  normalizeCityName,
  resolveCityFromDistrict,
  resolveCityFromLocation,
  scanGeoSignalsFromText,
} from '@resolution/geo';
import { isVisualDescriptionText } from '@resolution/signal/markers';

export type CityClaimProducer =
  | 'rule'
  | 'model'
  | 'allowlist'
  | 'location_share'
  | 'map_screenshot'
  | 'confirmation'
  | 'geocode'
  | 'archive';

export interface CityEvidenceClaim {
  value: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  producer: CityClaimProducer;
  evidence: string;
  assertedAt: string;
}

/** 候选人文本里的区名/地标信号一次性归一成城市集合，供本轮所有消费者复用。 */
export function inferCitiesFromGeoSignals(userTexts: readonly string[]): ReadonlySet<string> {
  const cities = new Set<string>();
  for (const text of userTexts) {
    if (!text || isVisualDescriptionText(text.trim())) continue;
    const scan = scanGeoSignalsFromText(text);
    for (const hit of scan.districtHits) {
      const city = resolveCityFromDistrict(hit.key);
      if (city) cities.add(normalizeCityName(city));
    }
    for (const location of scan.locations) {
      const city = resolveCityFromLocation(location);
      if (city) cities.add(normalizeCityName(city));
    }
  }
  return cities;
}

export type CityAdjudicationDecision =
  | 'adopt'
  | 'same_value'
  | 'reject_invalid'
  | 'reject_lower_priority'
  | 'reject_conflict';

const PRODUCER_PRIORITY: Record<CityClaimProducer, number> = {
  confirmation: 7,
  rule: 6,
  allowlist: 6,
  geocode: 5,
  location_share: 5,
  map_screenshot: 5,
  model: 3,
  archive: 2,
};

const CONFIDENCE_PRIORITY: Record<CityEvidenceClaim['confidence'], number> = {
  high: 4,
  medium: 3,
  low: 2,
  unknown: 1,
};

export function createCityClaim(
  value: string,
  producer: CityClaimProducer,
  evidence: string,
  assertedAt = new Date().toISOString(),
): CityEvidenceClaim | null {
  const normalized = normalizeCityName(value);
  if (!normalized || !isRecognizedCityName(normalized)) return null;
  return {
    value: normalized,
    producer,
    evidence,
    assertedAt,
    confidence: producer === 'model' ? 'medium' : producer === 'archive' ? 'unknown' : 'high',
  };
}

export function cityClaimFromFact(
  fact:
    | {
        value: string;
        confidence?: string;
        source?: string;
        evidence?: string;
        extractedAt?: string;
      }
    | null
    | undefined,
): CityEvidenceClaim | null {
  if (!fact?.value?.trim()) return null;
  const confidence =
    fact.confidence === 'high' || fact.confidence === 'medium' || fact.confidence === 'low'
      ? fact.confidence
      : 'unknown';
  const producer: CityClaimProducer =
    fact.source === 'rule'
      ? 'rule'
      : fact.source === 'llm'
        ? 'model'
        : fact.source === 'candidate'
          ? 'confirmation'
          : fact.source === 'tool'
            ? 'geocode'
            : 'archive';
  return {
    value: fact.value.trim(),
    confidence,
    producer,
    evidence: fact.evidence ?? '存量城市事实',
    assertedAt: fact.extractedAt ?? new Date(0).toISOString(),
  };
}

/** city 的唯一让位/冲突裁决；存量按 archive claim 输入。 */
export function adjudicateCityClaims(
  existing: CityEvidenceClaim | null | undefined,
  incoming: CityEvidenceClaim | null | undefined,
): { decision: CityAdjudicationDecision; accepted: CityEvidenceClaim | null } {
  if (!incoming || !isRecognizedCityName(incoming.value)) {
    return { decision: 'reject_invalid', accepted: existing ?? null };
  }
  if (!existing) return { decision: 'adopt', accepted: incoming };
  const previous = normalizeCityName(existing.value);
  const next = normalizeCityName(incoming.value);
  if (previous === next) return { decision: 'same_value', accepted: existing };

  // 存量污染自愈：非法 archive 不享受任何水位保护。
  if (!previous || !isRecognizedCityName(previous)) {
    return { decision: 'adopt', accepted: incoming };
  }

  const existingScore =
    CONFIDENCE_PRIORITY[existing.confidence] * 10 + PRODUCER_PRIORITY[existing.producer];
  const incomingScore =
    CONFIDENCE_PRIORITY[incoming.confidence] * 10 + PRODUCER_PRIORITY[incoming.producer];
  if (incomingScore > existingScore) return { decision: 'adopt', accepted: incoming };
  if (incomingScore < existingScore) {
    return { decision: 'reject_lower_priority', accepted: existing };
  }
  return { decision: 'reject_conflict', accepted: existing };
}

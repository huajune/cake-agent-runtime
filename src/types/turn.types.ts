import type { RuleFactClaims } from '@resolution/evidence/claim.types';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import type {
  CandidateCollectedField,
  CandidateFieldKey,
} from '@resolution/candidate/collected-fields';
import type { FinalizedVisualFactSheet } from '@resolution/visual';

/** 本轮 geocode 成功解析的锚点记录。 */
export interface GeocodeResolvedAnchor {
  longitude: number;
  latitude: number;
  areaLevelQuery: boolean;
  areaName: string | null;
  city: string | null;
}

/** 本轮工具确权的候选人城市；轮末由 memory 收编。 */
export interface CityAttestation {
  city: string;
  district?: string | null;
  evidence: string;
  source: 'geocode_unique' | 'location_share';
}

/** geocode 使用的本轮可信位置锚点。 */
export interface GeocodeLocationAnchor {
  city?: string;
  districts: string[];
  source: 'current_user' | 'human_agent' | 'session_memory';
  referenceText?: string;
  evidence: string;
}

export interface TurnLedgerSnapshot {
  visualFactSheets: ReadonlyArray<{ messageId: string; sheet: FinalizedVisualFactSheet }>;
  imageBrandResolutions: ReadonlyArray<{ messageId: string; resolutions: BrandResolution[] }>;
  geocodeAnchors: readonly GeocodeResolvedAnchor[];
  cityAttestation: CityAttestation | undefined;
  fetchedJobs: readonly unknown[];
  jobListQuery: { signature: string } | undefined;
  invalidatedJobIds: readonly number[];
  ruleFacts: RuleFactClaims | null;
  collectedFields: Readonly<Partial<Record<CandidateFieldKey, CandidateCollectedField>>>;
  geoSignalCities: ReadonlySet<string>;
  /** undefined 表示本轮尚未尝试预约；false 仅表示预约工具明确失败。 */
  bookingSucceeded: boolean | undefined;
  jobListExecuted: boolean;
  resolvedWorkOrderId?: number;
}

/**
 * 回合账本：agent 运行时拥有实例，工具只借阅只读视图与显式追加方法。
 * 列表没有可写出口；所有变更都经 record* / mark*，轮末以 drain() 快照交档。
 */
export interface TurnLedger extends TurnLedgerSnapshot {
  bookingSucceeded: boolean | undefined;
  jobListExecuted: boolean;
  resolvedWorkOrderId?: number;
  recordVisualFacts(sheet: FinalizedVisualFactSheet, meta: { messageId: string }): void;
  recordImageBrands(resolutions: BrandResolution[], meta: { messageId: string }): void;
  recordGeocodeAnchor(anchor: GeocodeResolvedAnchor): void;
  recordCityAttestation(attestation: CityAttestation): void;
  recordFetchedJobs(jobs: unknown[]): void;
  recordJobListQuery(query: { signature: string }): void;
  markJobInvalidated(jobId: number): void;
  drain(): TurnLedgerSnapshot;
}

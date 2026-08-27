import { Logger } from '@nestjs/common';
import type { CandidateCollectedField, CandidateFieldKey } from '@resolution/candidate/types';
import type { TurnHints } from '@resolution/evidence/claim.types';
import type { LaborFormIntentDecision } from '@resolution/labor-form';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type {
  CityAttestation,
  GeocodeResolvedAnchor,
  TurnFetchedJob,
  TurnLedger,
  TurnLedgerSnapshot,
} from '@shared-types/turn.types';

const logger = new Logger('TurnLedger');

export interface CreateTurnLedgerInput {
  turnHints?: TurnHints | null;
  laborFormIntent?: LaborFormIntentDecision;
  collectedFields?: Partial<Record<CandidateFieldKey, CandidateCollectedField>>;
  geoSignalCities?: Iterable<string>;
  currentFocusJob?: RecommendedJobSummary | null;
}

/** 创建本轮唯一账本实例；内部集合不向消费者暴露可写引用。 */
export function createTurnLedger(input: CreateTurnLedgerInput = {}): TurnLedger {
  const visualFactSheets: TurnLedgerSnapshot['visual']['factSheets'][number][] = [];
  const imageBrandResolutions: TurnLedgerSnapshot['visual']['brandResolutions'][number][] = [];
  const geocodeAnchors: GeocodeResolvedAnchor[] = [];
  const fetchedJobs: TurnFetchedJob[] = [];
  const currentFocusJob = input.currentFocusJob ? { ...input.currentFocusJob } : null;
  const invalidatedJobIds: number[] = [];
  const collectedFields = Object.freeze({ ...(input.collectedFields ?? {}) });
  const geoSignalCities = new Set(input.geoSignalCities ?? []);
  let cityAttestation: CityAttestation | undefined;
  let jobListQuerySignature: string | undefined;

  const ledger: TurnLedger = {
    visual: {
      get factSheets() {
        return visualFactSheets;
      },
      get brandResolutions() {
        return imageBrandResolutions;
      },
    },
    geo: {
      get anchors() {
        return geocodeAnchors;
      },
      get cityAttestation() {
        return cityAttestation;
      },
      signalCities: geoSignalCities,
    },
    jobs: {
      get fetchedJobs() {
        return fetchedJobs;
      },
      currentFocusJob,
      get querySignature() {
        return jobListQuerySignature;
      },
      get invalidatedJobIds() {
        return invalidatedJobIds;
      },
      bookingSucceeded: undefined,
      collectionReadyJobId: undefined,
      jobListExecuted: false,
    },
    facts: {
      turnHints: input.turnHints ?? null,
      laborFormIntent: input.laborFormIntent ?? { kind: 'ignore' },
      collectedFields,
    },
    recordVisualFacts(sheet, meta) {
      visualFactSheets.push({ messageId: meta.messageId, sheet });
    },
    recordImageBrands(resolutions, meta) {
      imageBrandResolutions.push({ messageId: meta.messageId, resolutions: [...resolutions] });
    },
    recordGeoResolution(input) {
      ledger.recordGeocodeAnchor({
        longitude: input.longitude,
        latitude: input.latitude,
        areaLevelQuery: input.areaLevelQuery,
        areaName: input.areaName,
        city: input.city,
      });
      const city = input.city?.trim();
      if (!city) return;
      ledger.recordCityAttestation({
        city,
        district: input.district?.trim() || null,
        evidence: input.evidence ?? city,
        source: input.source,
      });
    },
    recordGeocodeAnchor(anchor) {
      geocodeAnchors.push({ ...anchor });
    },
    recordCityAttestation(attestation) {
      // 证据强度优先级：真实位置（定位分享）强于文本查询解析（geocode）。
      // 同源异城维持 last-write-wins；异源且城市相同也照常覆盖（只是刷新 evidence）。
      if (
        cityAttestation &&
        cityAttestation.source === 'location_share' &&
        attestation.source === 'geocode_unique' &&
        cityAttestation.city !== attestation.city
      ) {
        logger.warn(
          `[ledger] 同轮城市确权冲突，保留定位分享城市: kept=${cityAttestation.city}, ` +
            `suppressed=${attestation.city}（${attestation.evidence}）`,
        );
        return;
      }
      cityAttestation = { ...attestation };
    },
    recordFetchedJobs(jobs) {
      fetchedJobs.splice(0, fetchedJobs.length, ...jobs);
    },
    recordJobListQuery(query) {
      jobListQuerySignature = query.signature;
    },
    markJobInvalidated(jobId) {
      if (!invalidatedJobIds.includes(jobId)) invalidatedJobIds.push(jobId);
    },
    drain() {
      return {
        visual: {
          factSheets: [...visualFactSheets],
          brandResolutions: imageBrandResolutions.map((entry) => ({
            messageId: entry.messageId,
            resolutions: [...entry.resolutions],
          })),
        },
        geo: {
          anchors: geocodeAnchors.map((anchor) => ({ ...anchor })),
          cityAttestation: cityAttestation ? { ...cityAttestation } : undefined,
          signalCities: new Set(geoSignalCities),
        },
        jobs: {
          fetchedJobs: [...fetchedJobs],
          currentFocusJob: ledger.jobs.currentFocusJob ? { ...ledger.jobs.currentFocusJob } : null,
          querySignature: jobListQuerySignature,
          invalidatedJobIds: [...invalidatedJobIds],
          bookingSucceeded: ledger.jobs.bookingSucceeded,
          ...(ledger.jobs.collectionReadyJobId === undefined
            ? {}
            : { collectionReadyJobId: ledger.jobs.collectionReadyJobId }),
          jobListExecuted: ledger.jobs.jobListExecuted,
          ...(ledger.jobs.resolvedWorkOrderId === undefined
            ? {}
            : { resolvedWorkOrderId: ledger.jobs.resolvedWorkOrderId }),
        },
        facts: {
          turnHints: ledger.facts.turnHints,
          laborFormIntent: ledger.facts.laborFormIntent,
          collectedFields,
        },
      };
    },
  };
  return ledger;
}

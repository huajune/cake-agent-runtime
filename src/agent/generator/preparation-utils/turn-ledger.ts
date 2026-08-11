import type { CandidateCollectedField, CandidateFieldKey } from '@resolution/candidate';
import type { RuleFactClaims } from '@resolution/evidence/claim.types';
import type {
  CityAttestation,
  GeocodeResolvedAnchor,
  TurnLedger,
  TurnLedgerSnapshot,
} from '@shared-types/turn.types';

export interface CreateTurnLedgerInput {
  ruleFacts?: RuleFactClaims | null;
  collectedFields?: Partial<Record<CandidateFieldKey, CandidateCollectedField>>;
  geoSignalCities?: Iterable<string>;
}

/** 创建本轮唯一账本实例；内部集合不向消费者暴露可写引用。 */
export function createTurnLedger(input: CreateTurnLedgerInput = {}): TurnLedger {
  const visualFactSheets: TurnLedgerSnapshot['visualFactSheets'][number][] = [];
  const imageBrandResolutions: TurnLedgerSnapshot['imageBrandResolutions'][number][] = [];
  const geocodeAnchors: GeocodeResolvedAnchor[] = [];
  const fetchedJobs: unknown[] = [];
  const invalidatedJobIds: number[] = [];
  const collectedFields = Object.freeze({ ...(input.collectedFields ?? {}) });
  const geoSignalCities = new Set(input.geoSignalCities ?? []);
  let cityAttestation: CityAttestation | undefined;
  let jobListQuery: { signature: string } | undefined;

  const ledger: TurnLedger = {
    get visualFactSheets() {
      return visualFactSheets;
    },
    get imageBrandResolutions() {
      return imageBrandResolutions;
    },
    get geocodeAnchors() {
      return geocodeAnchors;
    },
    get cityAttestation() {
      return cityAttestation;
    },
    get fetchedJobs() {
      return fetchedJobs;
    },
    get jobListQuery() {
      return jobListQuery;
    },
    get invalidatedJobIds() {
      return invalidatedJobIds;
    },
    ruleFacts: input.ruleFacts ?? null,
    collectedFields,
    geoSignalCities,
    bookingSucceeded: undefined,
    jobListExecuted: false,
    recordVisualFacts(sheet, meta) {
      visualFactSheets.push({ messageId: meta.messageId, sheet });
    },
    recordImageBrands(resolutions, meta) {
      imageBrandResolutions.push({ messageId: meta.messageId, resolutions: [...resolutions] });
    },
    recordGeocodeAnchor(anchor) {
      geocodeAnchors.push({ ...anchor });
    },
    recordCityAttestation(attestation) {
      cityAttestation = { ...attestation };
    },
    recordFetchedJobs(jobs) {
      fetchedJobs.splice(0, fetchedJobs.length, ...jobs);
    },
    recordJobListQuery(query) {
      jobListQuery = { ...query };
    },
    markJobInvalidated(jobId) {
      if (!invalidatedJobIds.includes(jobId)) invalidatedJobIds.push(jobId);
    },
    drain() {
      return {
        visualFactSheets: [...visualFactSheets],
        imageBrandResolutions: imageBrandResolutions.map((entry) => ({
          messageId: entry.messageId,
          resolutions: [...entry.resolutions],
        })),
        geocodeAnchors: geocodeAnchors.map((anchor) => ({ ...anchor })),
        cityAttestation: cityAttestation ? { ...cityAttestation } : undefined,
        fetchedJobs: [...fetchedJobs],
        jobListQuery: jobListQuery ? { ...jobListQuery } : undefined,
        invalidatedJobIds: [...invalidatedJobIds],
        ruleFacts: ledger.ruleFacts,
        collectedFields,
        geoSignalCities: new Set(geoSignalCities),
        bookingSucceeded: ledger.bookingSucceeded,
        jobListExecuted: ledger.jobListExecuted,
        ...(ledger.resolvedWorkOrderId === undefined
          ? {}
          : { resolvedWorkOrderId: ledger.resolvedWorkOrderId }),
      };
    },
  };
  return ledger;
}

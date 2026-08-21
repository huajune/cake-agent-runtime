import { isVisualDescriptionText } from '@resolution/signal/markers';
import {
  isSelfReportedVisualMessage,
  type FinalizedVisualFactSheet,
  type VisualFactFieldKey,
  type VisualFactKind,
} from '@resolution/signal/visual';

interface MessageExtractionScope {
  readonly identity: boolean;
  readonly phone: boolean;
  readonly preferences: boolean;
  readonly geo: boolean;
}

const SCOPE_ALL: MessageExtractionScope = {
  identity: true,
  phone: true,
  preferences: true,
  geo: true,
};
const SCOPE_NONE: MessageExtractionScope = {
  identity: false,
  phone: false,
  preferences: false,
  geo: false,
};
const SCOPE_SELF_REPORTED: MessageExtractionScope = {
  identity: true,
  phone: false,
  preferences: true,
  geo: true,
};

const KIND_EXTRACTION_SCOPE: Record<VisualFactKind, MessageExtractionScope> = {
  resume: SCOPE_SELF_REPORTED,
  certificate: SCOPE_SELF_REPORTED,
  map_location: { ...SCOPE_NONE, geo: true },
  job_posting: SCOPE_NONE,
  chat_screenshot: SCOPE_NONE,
  other: SCOPE_NONE,
};

/** 规则轨的视觉授权域；不参与 session LLM 准入或身份公证。 */
export function resolveExtractionScope(
  message: string,
  sheet: FinalizedVisualFactSheet | null | undefined,
): MessageExtractionScope {
  if (!isVisualDescriptionText(message)) return SCOPE_ALL;
  if (sheet && !sheet.degraded) return KIND_EXTRACTION_SCOPE[sheet.kind];
  if (isSelfReportedVisualMessage(message)) return SCOPE_SELF_REPORTED;
  return { ...SCOPE_NONE, preferences: true, geo: true };
}

const MAP_LOCATION_CITY_KEYS: readonly VisualFactFieldKey[] = [
  'city',
  'address',
  'candidate_address',
];

export function mapLocationCityCandidates(sheet: FinalizedVisualFactSheet): string[] {
  if (sheet.kind !== 'map_location') return [];
  return sheet.fields
    .filter((field) => MAP_LOCATION_CITY_KEYS.includes(field.key))
    .sort((left, right) => {
      return MAP_LOCATION_CITY_KEYS.indexOf(left.key) - MAP_LOCATION_CITY_KEYS.indexOf(right.key);
    })
    .map((field) => field.value);
}

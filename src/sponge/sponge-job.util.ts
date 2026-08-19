import { JobDetail } from './sponge.types';
import { asArray, asRecord } from '@infra/utils/object.util';

export interface SpongeInterviewSupplementDefinition {
  labelId: number;
  labelName: string;
  name: string;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function extractInterviewSupplementDefinitions(
  job: JobDetail | null | undefined,
): SpongeInterviewSupplementDefinition[] {
  const interviewProcess = asRecord(job?.interviewProcess);
  const items = asArray(interviewProcess?.interviewSupplement);
  const definitions: SpongeInterviewSupplementDefinition[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;

    const labelId =
      asNumber(record.interviewSupplementId) ?? asNumber(record.InterviewSupplementId);
    const labelName = asString(record.interviewSupplement) ?? asString(record.InterviewSupplement);

    if (!labelId || !labelName) continue;

    const key = `${labelId}:${labelName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    definitions.push({
      labelId,
      labelName,
      name: labelName,
    });
  }

  return definitions;
}

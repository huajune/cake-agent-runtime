import {
  BitableField,
  BitableRecord,
  FeishuBitableApiService,
} from '@infra/feishu/services/bitable-api.service';

export type ResolvedFieldNames<T extends string> = Partial<Record<T, string>>;

export function resolveFieldNames<T extends Record<string, readonly string[]>>(
  fields: BitableField[],
  aliases: T,
): ResolvedFieldNames<Extract<keyof T, string>> {
  const existingFieldNames = new Set(fields.map((field) => field.field_name));
  const resolved: Partial<Record<Extract<keyof T, string>, string>> = {};

  for (const key of Object.keys(aliases) as Array<Extract<keyof T, string>>) {
    const matched = aliases[key].find((candidate) => existingFieldNames.has(candidate));
    if (matched) {
      resolved[key] = matched;
    }
  }

  return resolved;
}

export function ensureResolvedFields<T extends string>(
  tableLabel: string,
  resolved: ResolvedFieldNames<T>,
  requiredKeys: T[],
): void {
  const missing = requiredKeys.filter((key) => !resolved[key]);
  if (missing.length > 0) {
    throw new Error(`${tableLabel} 缺少必要字段: ${missing.join(', ')}`);
  }
}

export function buildRecordIndex(
  records: BitableRecord[],
  fieldNameToId: Record<string, string>,
  stableIdFieldName?: string,
): Map<string, BitableRecord> {
  const index = new Map<string, BitableRecord>();
  if (!stableIdFieldName) {
    return index;
  }

  for (const record of records) {
    const stableId = extractRecordField(record.fields, fieldNameToId, stableIdFieldName);
    const normalizedStableId = normalizeComparableValue(stableId);
    if (normalizedStableId === null || normalizedStableId === '') {
      continue;
    }

    index.set(String(normalizedStableId), record);
  }

  return index;
}

export function getChangedFieldNames(
  record: BitableRecord,
  fieldNameToId: Record<string, string>,
  desiredFields: Record<string, unknown>,
): string[] {
  return Object.entries(desiredFields)
    .filter(([fieldName, desiredValue]) => {
      const currentValue = extractRecordField(record.fields, fieldNameToId, fieldName);
      return !isSameValue(currentValue, desiredValue);
    })
    .map(([fieldName]) => fieldName);
}

export function extractRecordField(
  recordFields: Record<string, unknown>,
  fieldNameToId: Record<string, string>,
  fieldName: string,
): unknown {
  const fieldId = fieldNameToId[fieldName];

  if (fieldId && recordFields[fieldId] !== undefined) {
    return recordFields[fieldId];
  }

  return recordFields[fieldName];
}

export function isSameValue(left: unknown, right: unknown): boolean {
  return normalizeComparableValue(left) === normalizeComparableValue(right);
}

export function normalizeComparableValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeComparableValue(item))
      .filter((item): item is string | number | boolean => item !== null)
      .map((item) => String(item))
      .join('|');
  }

  if (typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (candidate.text !== undefined) {
      return normalizeComparableValue(candidate.text);
    }
    if (candidate.name !== undefined) {
      return normalizeComparableValue(candidate.name);
    }
    if (candidate.value !== undefined) {
      return normalizeComparableValue(candidate.value);
    }
    return JSON.stringify(candidate);
  }

  return String(value);
}

export function stripNilFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
  );
}

export function emptyToNull(value?: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

export function truncate(
  bitableApi: FeishuBitableApiService,
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (!value) {
    return null;
  }

  return bitableApi.truncateText(value, maxLength);
}

export function composeRemark(parts: Array<string | undefined>): string | null {
  const normalized = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  return normalized.length > 0 ? normalized.join('\n') : null;
}

export function normalizeIds(values?: string[]): string[] {
  if (!values?.length) {
    return [];
  }

  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}

export function joinIds(values?: string[]): string | null {
  const normalized = normalizeIds(values);
  return normalized.length > 0 ? normalized.join(', ') : null;
}

export function firstId(values?: string[]): string | null {
  if (!values?.length) {
    return null;
  }

  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function setField(
  fields: Record<string, unknown>,
  fieldName: string | undefined,
  value: unknown,
  options?: { clearWithNull?: boolean },
): void {
  if (!fieldName) {
    return;
  }

  if (value === undefined || value === null) {
    if (options?.clearWithNull) {
      fields[fieldName] = null;
    }
    return;
  }

  fields[fieldName] = value;
}

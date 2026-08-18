import { normalizeEducationToId, parseHighestEducation } from '@resolution/candidate/education';
import { isLikelyRealChineseName, isStrictRealChineseName } from '@resolution/candidate/name';
import {
  isPlaceholderPhone,
  isStorableCandidatePhone,
  parseFlexiblePhone,
} from '@resolution/candidate/phone';

export const RESUME_FIELD_NAMES = [
  'name',
  'phone',
  'gender',
  'age',
  'education',
  'email',
  'expectedCity',
  'jobIntent',
  'expectedSalary',
  'workYears',
  'relevantExperience',
] as const;

export type ResumeFieldName = (typeof RESUME_FIELD_NAMES)[number];
export type ResumeExtractedBy = 'extract_model' | 'filename' | 'rule_fallback';
export type ResumeSourceKind = 'pdf_text' | 'docx_text' | 'vision_transcription';

export interface ResumeRawField {
  field: ResumeFieldName;
  value: string;
  sourceText: string;
  extractedBy?: ResumeExtractedBy;
}

export interface ResumeExtractedField<T = string> {
  value: T;
  sourceText: string;
  extractedBy: ResumeExtractedBy;
  confidence: 'high' | 'medium';
}

export interface ResumeFieldExtraction {
  name?: ResumeExtractedField;
  phone?: ResumeExtractedField;
  gender?: ResumeExtractedField;
  age?: ResumeExtractedField;
  education?: ResumeExtractedField;
  email?: ResumeExtractedField;
  expectedCity?: ResumeExtractedField;
  jobIntent?: ResumeExtractedField;
  expectedSalary?: ResumeExtractedField;
  workYears?: ResumeExtractedField;
  relevantExperience?: ResumeExtractedField;
  phoneCandidates: string[];
  notaryDrops: Array<{
    field: ResumeFieldName;
    reason: 'quote_not_found' | 'shape_invalid' | 'placeholder';
  }>;
}

export interface ResumeNotaryOptions {
  fileName?: string;
  sourceKind?: ResumeSourceKind;
}

const MAX_SOURCE_TEXT_CHARS = 120;
const PHONE_CONTEXT_CHARS = 15;
const PHONE_EXCLUSION_RE = /紧急联系人|联系人\s*[（(]?亲属|推荐人|\bHR\b|店长/iu;
const FLEXIBLE_PHONE_RE = /(?<!\d)(?:\+?86[-\s]?)?(1[3-9](?:[-\s]?\d){9})(?!\d)/gu;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const NAME_NEIGHBOR_EXCLUSIONS =
  /个人|信息|基本|档案|简历|学历|教育|经历|工作|求职|意向|薪资|电话|手机|邮箱|年龄|性别|地址|城市|本科|大专|高中|中专|初中|博士|硕士|服务员|店长|经理|主管|专员|厨师|咖啡师/u;

const LABEL_PATTERNS: Record<ResumeFieldName, RegExp> = {
  name: /(?:姓名|名字)\s*[：:]/u,
  phone: /(?:手机号|手机|电话|联系方式)\s*[：:]/u,
  gender: /(?:性别)\s*[：:]|[男女]\s*[|｜]\s*\d{1,2}\s*岁/u,
  age: /(?:年龄)\s*[：:]|[男女]\s*[|｜]\s*\d{1,2}\s*岁/u,
  education: /(?:最高学历|学历|教育程度)\s*[：:]/u,
  email: /(?:电子邮箱|邮箱|e-?mail)\s*[：:]/iu,
  expectedCity: /(?:期望城市|意向城市|工作城市)\s*[：:]/u,
  jobIntent: /(?:求职意向|期望岗位|应聘岗位)\s*[：:]/u,
  expectedSalary: /(?:期望薪资|薪资期望)\s*[：:]/u,
  workYears: /(?:工作年限|工作经验)\s*[：:]/u,
  relevantExperience: /(?:相关经历|工作经历)\s*[：:]/u,
};

interface PhoneOccurrence {
  value: string;
  sourceText: string;
  excluded: boolean;
}

interface ShapeVerdict {
  valid: boolean;
  placeholder?: boolean;
  strict: boolean;
  value: string;
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits;
}

function sourceLineAt(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', index - 1) + 1);
  const next = text.indexOf('\n', index);
  const end = next === -1 ? text.length : next;
  const line = text.slice(start, end).trim();
  if (line.length <= MAX_SOURCE_TEXT_CHARS) return line;
  const local = Math.max(0, index - start);
  const windowStart = Math.max(0, Math.min(line.length - MAX_SOURCE_TEXT_CHARS, local - 50));
  return line.slice(windowStart, windowStart + MAX_SOURCE_TEXT_CHARS).trim();
}

function phoneOccurrences(text: string): PhoneOccurrence[] {
  const occurrences: PhoneOccurrence[] = [];
  for (const match of text.matchAll(FLEXIBLE_PHONE_RE)) {
    const raw = match[0];
    const value = normalizePhone(raw);
    const index = match.index ?? 0;
    const context = text.slice(
      Math.max(0, index - PHONE_CONTEXT_CHARS),
      Math.min(text.length, index + raw.length + PHONE_CONTEXT_CHARS),
    );
    occurrences.push({
      value,
      sourceText: sourceLineAt(text, index),
      excluded: PHONE_EXCLUSION_RE.test(context),
    });
  }
  return occurrences;
}

function usablePhoneOccurrences(text: string): PhoneOccurrence[] {
  return phoneOccurrences(text).filter(
    (item) =>
      !item.excluded && isStorableCandidatePhone(item.value) && !isPlaceholderPhone(item.value),
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeGender(value: string): string | null {
  const compact = value.trim();
  if (compact === '男' || compact === '男性') return '男';
  if (compact === '女' || compact === '女性') return '女';
  return null;
}

function normalizeAge(value: string): string | null {
  const match = /\d{1,2}/u.exec(value);
  if (!match) return null;
  const age = Number(match[0]);
  return age >= 16 && age <= 65 ? String(age) : null;
}

function shapeVerdict(field: ResumeFieldName, value: string, sourceText: string): ShapeVerdict {
  const trimmed = value.trim();
  if (!trimmed) return { valid: false, strict: false, value: trimmed };

  if (field === 'name') {
    const valid = isLikelyRealChineseName(trimmed) && sourceText.includes(trimmed);
    return {
      valid,
      strict: valid && isStrictRealChineseName(trimmed),
      value: trimmed,
    };
  }
  if (field === 'phone') {
    const parsed = parseFlexiblePhone(sourceText);
    const normalized = normalizePhone(trimmed);
    const placeholder = isPlaceholderPhone(normalized);
    return {
      valid: !placeholder && parsed === normalized && isStorableCandidatePhone(normalized),
      placeholder,
      strict: !placeholder && parsed === normalized && isStorableCandidatePhone(normalized),
      value: normalized,
    };
  }
  if (field === 'education') {
    const sourceEducation = parseHighestEducation(sourceText);
    const valueId = normalizeEducationToId(trimmed);
    const sourceId = sourceEducation ? normalizeEducationToId(sourceEducation.value) : null;
    return {
      valid: valueId !== null && sourceId === valueId,
      strict: valueId !== null && sourceId === valueId,
      value: sourceEducation?.value ?? trimmed,
    };
  }
  if (field === 'age') {
    const normalized = normalizeAge(trimmed);
    const sourceAge = normalizeAge(sourceText);
    return {
      valid: normalized !== null && sourceAge === normalized,
      strict: normalized !== null && sourceAge === normalized,
      value: normalized ?? trimmed,
    };
  }
  if (field === 'gender') {
    const normalized = normalizeGender(trimmed);
    const sourceGender = normalizeGender(sourceText.replace(/[^男女]/gu, ''));
    return {
      valid: normalized !== null && sourceGender === normalized,
      strict: normalized !== null && sourceGender === normalized,
      value: normalized ?? trimmed,
    };
  }
  if (field === 'email') {
    const sourceEmail = EMAIL_RE.exec(sourceText)?.[0];
    const valid = Boolean(sourceEmail && sourceEmail.toLowerCase() === trimmed.toLowerCase());
    return { valid, strict: valid, value: sourceEmail ?? trimmed };
  }

  const valueToUse = field === 'relevantExperience' ? trimmed.slice(0, 120) : trimmed;
  return {
    valid: sourceText.includes(valueToUse),
    strict: sourceText.includes(valueToUse),
    value: valueToUse,
  };
}

function allLiteralIndexes(text: string, needle: string): number[] {
  if (!needle) return [];
  const indexes: number[] = [];
  let from = 0;
  while (from <= text.length - needle.length) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
}

function reanchorField(raw: ResumeRawField, fullText: string): string | null {
  if (raw.field === 'phone') {
    const target = normalizePhone(raw.value);
    const matches = usablePhoneOccurrences(fullText).filter((item) => item.value === target);
    return matches.length === 1 ? matches[0].sourceText : null;
  }
  if (raw.field === 'education') {
    const targetId = normalizeEducationToId(raw.value);
    if (targetId === null) return null;
    const matches = fullText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const parsed = parseHighestEducation(line);
        return parsed !== null && normalizeEducationToId(parsed.value) === targetId;
      });
    return matches.length === 1 ? matches[0].slice(0, MAX_SOURCE_TEXT_CHARS) : null;
  }
  if (raw.field === 'age') {
    const age = normalizeAge(raw.value);
    if (!age) return null;
    const pattern = new RegExp(`(?<!\\d)${age}\\s*岁(?!\\d)`, 'gu');
    const matches = [...fullText.matchAll(pattern)];
    return matches.length === 1 ? sourceLineAt(fullText, matches[0].index ?? 0) : null;
  }
  if (raw.field === 'gender') {
    const gender = normalizeGender(raw.value);
    if (!gender) return null;
    const indexes = allLiteralIndexes(fullText, gender);
    return indexes.length === 1 ? sourceLineAt(fullText, indexes[0]) : null;
  }
  if (raw.field === 'email') {
    const matches = [...fullText.matchAll(new RegExp(EMAIL_RE.source, 'giu'))].filter(
      (match) => match[0].toLowerCase() === raw.value.trim().toLowerCase(),
    );
    return matches.length === 1 ? sourceLineAt(fullText, matches[0].index ?? 0) : null;
  }

  const indexes = allLiteralIndexes(fullText, raw.value.trim());
  return indexes.length === 1 ? sourceLineAt(fullText, indexes[0]) : null;
}

function isLabelAnchored(field: ResumeFieldName, sourceText: string): boolean {
  return LABEL_PATTERNS[field].test(sourceText);
}

function confidenceFor(
  field: ResumeFieldName,
  sourceText: string,
  extractedBy: ResumeExtractedBy,
  strict: boolean,
  sourceKind: ResumeSourceKind,
  reanchored: boolean,
): 'high' | 'medium' {
  if (field === 'phone' || sourceKind === 'vision_transcription' || reanchored) return 'medium';
  if (field === 'name' && extractedBy === 'filename' && strict) return 'high';
  if (extractedBy === 'rule_fallback' && !isLabelAnchored(field, sourceText)) return 'medium';
  return strict && isLabelAnchored(field, sourceText) ? 'high' : 'medium';
}

function nameFromFileName(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const decoded = decodeFileName(fileName);
  const base = decoded
    .split(/[?#]/u)[0]
    .split(/[\\/]/u)
    .at(-1)!
    .replace(/\.[^.]+$/u, '')
    .replace(/(?:个人|求职)?简历|履历|resume|cv/giu, '')
    .replace(/[\s_\-—–（）()【】\[\]0-9.]/gu, '')
    .trim();
  return isStrictRealChineseName(base) ? base : null;
}

function decodeFileName(fileName: string): string {
  try {
    return decodeURIComponent(fileName);
  } catch {
    // malformed percent encoding: use the original file name
    return fileName;
  }
}

function rawFileNameField(fileName: string | undefined): ResumeRawField | null {
  const value = nameFromFileName(fileName);
  if (!value || !fileName) return null;
  return { field: 'name', value, sourceText: decodeFileName(fileName), extractedBy: 'filename' };
}

function pushDrop(
  extraction: ResumeFieldExtraction,
  field: ResumeFieldName,
  reason: 'quote_not_found' | 'shape_invalid' | 'placeholder',
): void {
  if (!extraction.notaryDrops.some((drop) => drop.field === field && drop.reason === reason)) {
    extraction.notaryDrops.push({ field, reason });
  }
}

/**
 * 对模型/规则两轨的候选字段执行统一公证：逐字回查→唯一重锚→形态→phone 归属→代码授信。
 */
export function notarizeResumeFields(
  rawFields: readonly ResumeRawField[],
  fullText: string,
  options: ResumeNotaryOptions = {},
): ResumeFieldExtraction {
  const extraction: ResumeFieldExtraction = { phoneCandidates: [], notaryDrops: [] };
  const sourceKind = options.sourceKind ?? 'pdf_text';
  const usablePhones = usablePhoneOccurrences(fullText);
  extraction.phoneCandidates = unique(usablePhones.map((item) => item.value));

  const candidates = [...rawFields];
  const fileNameField = rawFileNameField(options.fileName);
  if (fileNameField) candidates.push(fileNameField);

  for (const raw of candidates) {
    if (extraction[raw.field]) continue;
    const extractedBy = raw.extractedBy ?? 'extract_model';
    let sourceText = raw.sourceText.trim();
    let reanchored = false;

    if (extractedBy !== 'filename') {
      const quoteIsUsable =
        sourceText.length > 0 &&
        sourceText.length <= MAX_SOURCE_TEXT_CHARS &&
        fullText.includes(sourceText);
      if (!quoteIsUsable) {
        const anchored = reanchorField(raw, fullText);
        if (!anchored) {
          pushDrop(extraction, raw.field, 'quote_not_found');
          continue;
        }
        sourceText = anchored;
        reanchored = true;
      }
    }

    const shape = shapeVerdict(raw.field, raw.value, sourceText);
    if (shape.placeholder) {
      pushDrop(extraction, raw.field, 'placeholder');
      continue;
    }
    if (!shape.valid) {
      pushDrop(extraction, raw.field, 'shape_invalid');
      continue;
    }
    if (raw.field === 'phone' && !extraction.phoneCandidates.includes(shape.value)) {
      pushDrop(extraction, raw.field, 'shape_invalid');
      continue;
    }

    const finalExtractedBy: ResumeExtractedBy = reanchored ? 'rule_fallback' : extractedBy;
    extraction[raw.field] = {
      value: shape.value,
      sourceText,
      extractedBy: finalExtractedBy,
      confidence: confidenceFor(
        raw.field,
        sourceText,
        finalExtractedBy,
        shape.strict,
        sourceKind,
        reanchored,
      ),
    };
  }

  return extraction;
}

function labelValue(
  text: string,
  field: ResumeFieldName,
  labels: string,
  valuePattern = '[^\\n\\r；;]{1,120}',
): ResumeRawField | null {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${labels})\\s*[：:]\\s*(${valuePattern})`, 'iu');
  const match = pattern.exec(text);
  const value = match?.[1]?.trim();
  if (!match || !value) return null;
  return {
    field,
    value,
    sourceText: match[0].trim().slice(0, MAX_SOURCE_TEXT_CHARS),
    extractedBy: 'rule_fallback',
  };
}

function fallbackNeighborName(text: string): ResumeRawField | null {
  const lines = text.split('\n').map((line) => line.trim());
  const anchors = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => parseFlexiblePhone(line) !== null || /\b\d{1,2}\s*岁/u.test(line));
  const names: Array<{ value: string; sourceText: string }> = [];
  for (const anchor of anchors) {
    for (
      let index = Math.max(0, anchor.index - 2);
      index <= Math.min(lines.length - 1, anchor.index + 2);
      index += 1
    ) {
      const line = lines[index];
      const tokens = line.match(/[一-鿿]{2,4}/gu) ?? [];
      for (const value of tokens) {
        if (
          isStrictRealChineseName(value) &&
          !NAME_NEIGHBOR_EXCLUSIONS.test(value) &&
          !names.some((item) => item.value === value)
        ) {
          names.push({ value, sourceText: line.slice(0, MAX_SOURCE_TEXT_CHARS) });
        }
      }
    }
  }
  return names.length === 1 ? { field: 'name', ...names[0], extractedBy: 'rule_fallback' } : null;
}

/** Extract 调用失败/公证通过率过低时使用的确定性兜底候选生成器。 */
export function extractResumeFieldsFallback(text: string, fileName?: string): ResumeRawField[] {
  const fields: ResumeRawField[] = [];
  const add = (field: ResumeRawField | null): void => {
    if (field && !fields.some((item) => item.field === field.field && item.value === field.value)) {
      fields.push(field);
    }
  };

  add(labelValue(text, 'name', '姓名|名字', '[一-鿿]{2,5}'));
  add(rawFileNameField(fileName));
  if (!fields.some((item) => item.field === 'name')) add(fallbackNeighborName(text));

  for (const item of usablePhoneOccurrences(text)) {
    add({
      field: 'phone',
      value: item.value,
      sourceText: item.sourceText,
      extractedBy: 'rule_fallback',
    });
  }

  const headerGender = /(?:^|\n)\s*(男|女)\s*[|｜]\s*(\d{1,2})\s*岁/u.exec(text);
  add(labelValue(text, 'gender', '性别', '男(?:性)?|女(?:性)?'));
  if (headerGender) {
    add({
      field: 'gender',
      value: headerGender[1],
      sourceText: headerGender[0].trim(),
      extractedBy: 'rule_fallback',
    });
    add({
      field: 'age',
      value: headerGender[2],
      sourceText: headerGender[0].trim(),
      extractedBy: 'rule_fallback',
    });
  } else {
    const age = /(?:^|\n)\s*(?:年龄\s*[：:]\s*)?((?:1[6-9]|[2-5]\d|6[0-5]))\s*岁/u.exec(text);
    if (age) {
      add({ field: 'age', value: age[1], sourceText: age[0].trim(), extractedBy: 'rule_fallback' });
    }
  }

  const education = parseHighestEducation(text);
  if (education) {
    const index = text.indexOf(education.excerpt);
    add({
      field: 'education',
      value: education.value,
      sourceText: sourceLineAt(text, Math.max(0, index)),
      extractedBy: 'rule_fallback',
    });
  }

  const email = EMAIL_RE.exec(text);
  if (email) {
    add({
      field: 'email',
      value: email[0],
      sourceText: sourceLineAt(text, email.index),
      extractedBy: 'rule_fallback',
    });
  }

  add(labelValue(text, 'expectedCity', '期望城市|意向城市|工作城市'));
  add(labelValue(text, 'jobIntent', '求职意向|期望岗位|应聘岗位'));
  add(labelValue(text, 'expectedSalary', '期望薪资|薪资期望'));
  add(labelValue(text, 'workYears', '工作年限|工作经验'));
  add(labelValue(text, 'relevantExperience', '相关经历|工作经历'));
  return fields;
}

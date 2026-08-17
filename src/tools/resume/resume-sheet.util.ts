import type { ResumeFieldExtraction } from '@resolution/candidate/resume-fields';
import { finalizeVisualFactSheet, type FinalizedVisualFactSheet } from '@resolution/signal/visual';

/**
 * 把简历工具结果收编进既有 visual sheet 信号轨。
 *
 * 白名单当前没有 name/age/gender/education；expectedCity 也按设计边界留在工具 output，
 * 避免未经城市域裁决的标量扇出。因此这里只确定性写入候选人 phone。
 */
export function buildResumeFactSheet(
  extraction: ResumeFieldExtraction,
  rawDescription: string,
): FinalizedVisualFactSheet {
  const fields = extraction.phone
    ? [{ key: 'phone', value: extraction.phone.value, ownership: 'candidate' as const }]
    : [];
  return finalizeVisualFactSheet({ kind: 'resume', fields }, rawDescription);
}

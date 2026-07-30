/** 单次证据反查的扫描上限，防止历史批次膨胀后把整表拖进内存 */
export const BADCASE_EVIDENCE_SCAN_LIMIT = 500;

/** 飞书 record id 形如 recvqhdgsKjpkM，只允许这套字符进 PostgREST 过滤串 */
const SAFE_RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 构造 PostgREST 的 `or(...)` 过滤串，命中 source_trace.badcaseRecordIds 里含任一 recordId 的行。
 *
 * recordId 会被拼进查询串，所以先按白名单字符集过滤——不是防注入的形式主义，
 * 这些 ID 来自飞书表且可被人手编辑。全部非法或入参为空时返回 null，调用方直接短路，
 * 避免退化成无谓词全表扫。
 */
export function buildBadcaseRecordIdFilter(recordIds: string[]): string | null {
  const safeIds = [
    ...new Set(recordIds.map((id) => id?.trim()).filter((id): id is string => !!id)),
  ].filter((id) => SAFE_RECORD_ID.test(id));
  if (safeIds.length === 0) return null;
  return safeIds.map((id) => `source_trace->badcaseRecordIds.cs.["${id}"]`).join(',');
}

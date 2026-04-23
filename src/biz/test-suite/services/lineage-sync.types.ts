import { createHash } from 'node:crypto';
import { BitableRecord } from '@infra/feishu/services/bitable-api.service';
import { CuratedConversationCaseDto } from '../dto/test-chat.dto';
import { normalizeIds, ResolvedFieldNames } from './curated-dataset-import.helpers';

export type LineageSourceTable = 'BadCase' | 'GoodCase' | 'Chat';
export type LineageTargetTable = '测试集' | '验证集';
export type LineageRelationRole = '问题来源' | '正样本参考' | '对话证据';
export type LineageFieldKey =
  | 'primaryText'
  | 'relationId'
  | 'sourceTable'
  | 'sourceAssetId'
  | 'targetTable'
  | 'targetAssetId'
  | 'targetTitle'
  | 'targetRecordId'
  | 'relationRole'
  | 'curatedSourceType'
  | 'enabled'
  | 'remark'
  | 'syncedAt';

export interface DesiredLineageRelation {
  relationId: string;
  summary: string;
  sourceTable: LineageSourceTable;
  sourceAssetId: string;
  targetTable: LineageTargetTable;
  targetAssetId: string;
  targetTitle: string;
  targetRecordId: string;
  relationRole: LineageRelationRole;
  curatedSourceType: string;
  enabled: boolean;
  remark?: string | null;
  syncedAt: number;
}

export interface LineageTableContext {
  appToken: string;
  tableId: string;
  fieldNameToId: Record<string, string>;
  resolved: ResolvedFieldNames<LineageFieldKey>;
  recordsByRelationId: Map<string, BitableRecord>;
  recordsByTargetKey: Map<string, BitableRecord[]>;
}

export const lineageFieldAliases = {
  primaryText: ['多行文本', 'Text'],
  relationId: ['关系ID'],
  sourceTable: ['来源表'],
  sourceAssetId: ['来源资产ID'],
  targetTable: ['目标表'],
  targetAssetId: ['目标资产ID'],
  targetTitle: ['目标标题'],
  targetRecordId: ['目标FeishuRecordID'],
  relationRole: ['关系角色'],
  curatedSourceType: ['策展来源类型'],
  enabled: ['是否生效', '启用'],
  remark: ['备注'],
  syncedAt: ['最近同步时间'],
} as const;

export function buildLineageTargetKey(
  targetTable: LineageTargetTable,
  targetAssetId: string,
): string {
  return `${targetTable}::${targetAssetId}`;
}

export function collectConversationChatIds(currentCase: CuratedConversationCaseDto): string[] {
  const values = [...(currentCase.sourceChatIds || [])];
  if (currentCase.chatId?.trim()) {
    values.unshift(currentCase.chatId.trim());
  }

  return normalizeIds(values);
}

export function generateLineageRelationId(
  sourceTable: LineageSourceTable,
  sourceAssetId: string,
  targetTable: LineageTargetTable,
  targetAssetId: string,
  relationRole: LineageRelationRole,
): string {
  return `rel_${createHash('sha1')
    .update(`${sourceTable}|${sourceAssetId}|${targetTable}|${targetAssetId}|${relationRole}`)
    .digest('hex')
    .slice(0, 20)}`;
}

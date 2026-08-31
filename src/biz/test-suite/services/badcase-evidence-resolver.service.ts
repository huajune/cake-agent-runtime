import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadcaseEvidenceEntry,
  BadcaseEvidenceLedger,
  computeBadcaseEvidenceOverallStatus,
} from '@biz/feishu-sync/badcase-governance.types';
import { ReviewStatus } from '../enums/test.enum';
import { TestExecutionRepository } from '../repositories/test-execution.repository';
import { ConversationSnapshotRepository } from '../repositories/conversation-snapshot.repository';
import { TestSourceTrace } from '../types/test-debug-trace.types';

interface EvidenceAccumulator {
  batchId: string;
  assetIds: Set<string>;
  executionIds: Set<string>;
  reviewerSources: Set<string>;
  hasFailed: boolean;
  hasPending: boolean;
  reviewedAt: string | null;
  orderKey: string;
}

/**
 * 从生产库反推 BadCase 的双侧测试证据台账。
 *
 * 证据的真相源是 test_executions / test_conversation_snapshots，飞书表只是运营视图。
 * 台账**不得**靠飞书的「测试证据JSON」列持久化：列一旦被清理，双门禁即死锁（缺列强制
 * 压回处理中，永远关不成已解决）。每次按 recordId 现查现算，飞书表结构怎么变都不影响
 * 关闭判定。
 */
@Injectable()
export class BadcaseEvidenceResolverService {
  private readonly logger = new Logger(BadcaseEvidenceResolverService.name);

  constructor(
    private readonly executionRepository: TestExecutionRepository,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
  ) {}

  /**
   * 按 BadCase recordId 批量解析证据台账。
   * 查不到任何证据的 recordId 不会出现在返回的 Map 里——调用方据此区分"没有证据"和"证据不通过"。
   */
  async resolveLedgers(recordIds: string[]): Promise<Map<string, BadcaseEvidenceLedger>> {
    const ids = [...new Set(recordIds.map((id) => id?.trim()).filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();

    const scenarioByRecord = new Map<string, Map<string, EvidenceAccumulator>>();
    const conversationByRecord = new Map<string, Map<string, EvidenceAccumulator>>();

    try {
      const scenarioExecutions =
        await this.executionRepository.findScenarioEvidenceByBadcaseRecordIds(ids);
      for (const execution of scenarioExecutions) {
        const trace = execution.source_trace as TestSourceTrace | null;
        this.accumulate(scenarioByRecord, ids, trace?.badcaseRecordIds, {
          batchId: execution.batch_id || '',
          assetId: execution.case_id,
          executionId: execution.id,
          reviewStatus: execution.review_status,
          reviewerSource: execution.reviewer_source,
          reviewedAt: execution.reviewed_at,
          orderKey: execution.created_at,
        });
      }

      const snapshots = await this.conversationSnapshotRepository.findByBadcaseRecordIds(ids);
      if (snapshots.length > 0) {
        const turnExecutions = await this.executionRepository.findByConversationSnapshotIds(
          snapshots.map((snapshot) => snapshot.id),
        );
        const turnsBySnapshot = new Map<string, typeof turnExecutions>();
        for (const execution of turnExecutions) {
          const snapshotId = execution.conversation_snapshot_id;
          if (!snapshotId) continue;
          const list = turnsBySnapshot.get(snapshotId) || [];
          list.push(execution);
          turnsBySnapshot.set(snapshotId, list);
        }
        for (const snapshot of snapshots) {
          const trace = snapshot.source_trace as TestSourceTrace | null;
          const turns = turnsBySnapshot.get(snapshot.id) || [];
          // 快照级判定与批次完成时的聚合口径保持一致：有失败即失败，没跑完即 pending
          const derived = turns.some((turn) => turn.review_status === ReviewStatus.FAILED)
            ? ReviewStatus.FAILED
            : turns.length === 0 || turns.some((turn) => turn.review_status !== ReviewStatus.PASSED)
              ? ReviewStatus.PENDING
              : ReviewStatus.PASSED;
          for (const turn of turns.length > 0 ? turns : [null]) {
            this.accumulate(conversationByRecord, ids, trace?.badcaseRecordIds, {
              batchId: snapshot.batch_id || '',
              assetId: snapshot.conversation_id || snapshot.id,
              executionId: turn?.id,
              reviewStatus: derived,
              reviewerSource: turn?.reviewer_source,
              reviewedAt: turn?.reviewed_at,
              orderKey: snapshot.created_at,
            });
          }
        }
      }
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      this.logger.error(`[BadcaseEvidence] 反查证据失败，本次不提供台账: ${message}`);
      return new Map();
    }

    const ledgers = new Map<string, BadcaseEvidenceLedger>();
    for (const recordId of ids) {
      const scenario = this.toEntries(scenarioByRecord.get(recordId), 'scenario');
      const conversation = this.toEntries(conversationByRecord.get(recordId), 'conversation');
      if (scenario.length === 0 && conversation.length === 0) continue;
      const ledger: BadcaseEvidenceLedger = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        scenario,
        conversation,
        overallStatus: 'missing',
      };
      ledger.overallStatus = computeBadcaseEvidenceOverallStatus(ledger);
      ledgers.set(recordId, ledger);
    }
    return ledgers;
  }

  private accumulate(
    target: Map<string, Map<string, EvidenceAccumulator>>,
    wantedIds: string[],
    recordIds: string[] | undefined,
    evidence: {
      batchId: string;
      assetId?: string | null;
      executionId?: string | null;
      reviewStatus?: ReviewStatus | null;
      reviewerSource?: string | null;
      reviewedAt?: string | null;
      orderKey?: string | null;
    },
  ): void {
    if (!recordIds?.length || !evidence.batchId) return;
    for (const rawId of recordIds) {
      const recordId = rawId?.trim();
      // jsonb contains 是 OR 语义，一条执行可能同时挂着不在本次查询范围内的 recordId
      if (!recordId || !wantedIds.includes(recordId)) continue;
      const byBatch = target.get(recordId) || new Map<string, EvidenceAccumulator>();
      const entry = byBatch.get(evidence.batchId) || {
        batchId: evidence.batchId,
        assetIds: new Set<string>(),
        executionIds: new Set<string>(),
        reviewerSources: new Set<string>(),
        hasFailed: false,
        hasPending: false,
        reviewedAt: null,
        orderKey: '',
      };
      if (evidence.reviewStatus === ReviewStatus.FAILED) entry.hasFailed = true;
      else if (evidence.reviewStatus !== ReviewStatus.PASSED) entry.hasPending = true;
      if (evidence.assetId) entry.assetIds.add(evidence.assetId);
      if (evidence.executionId) entry.executionIds.add(evidence.executionId);
      if (evidence.reviewerSource) entry.reviewerSources.add(evidence.reviewerSource);
      if (
        evidence.reviewedAt &&
        (!entry.reviewedAt ||
          new Date(evidence.reviewedAt).getTime() > new Date(entry.reviewedAt).getTime())
      ) {
        entry.reviewedAt = evidence.reviewedAt;
      }
      if (evidence.orderKey && evidence.orderKey > entry.orderKey) {
        entry.orderKey = evidence.orderKey;
      }
      byBatch.set(evidence.batchId, entry);
      target.set(recordId, byBatch);
    }
  }

  private toEntries(
    byBatch: Map<string, EvidenceAccumulator> | undefined,
    kind: 'scenario' | 'conversation',
  ): BadcaseEvidenceEntry[] {
    if (!byBatch) return [];
    // 台账约定首元素为最近一次证据（computeBadcaseEvidenceOverallStatus 只看首元素）
    return [...byBatch.values()]
      .sort((a, b) => b.orderKey.localeCompare(a.orderKey))
      .map((entry) => ({
        kind,
        batchId: entry.batchId,
        assetIds: [...entry.assetIds],
        executionIds: [...entry.executionIds],
        reviewStatus: entry.hasFailed ? 'failed' : entry.hasPending ? 'pending' : 'passed',
        reviewerSources: [...entry.reviewerSources],
        reviewedAt: entry.reviewedAt,
      }));
  }
}

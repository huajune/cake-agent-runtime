import {
  createEmptyBadcaseEvidenceLedger,
  mergeBadcaseEvidence,
  parseBadcaseEvidenceLedger,
} from '@biz/feishu-sync/badcase-governance.types';

describe('BadCase evidence governance', () => {
  const scenario = {
    kind: 'scenario' as const,
    batchId: 'batch-scenario',
    assetIds: ['case-1'],
    executionIds: ['exec-1'],
    reviewStatus: 'passed' as const,
    reviewerSources: ['claude'],
    reviewedAt: '2026-07-28T01:00:00.000Z',
  };
  const conversation = {
    kind: 'conversation' as const,
    batchId: 'batch-conversation',
    assetIds: ['validation-1'],
    executionIds: ['exec-2'],
    reviewStatus: 'passed' as const,
    reviewerSources: ['claude'],
    reviewedAt: '2026-07-28T02:00:00.000Z',
  };

  it('keeps a BadCase partial after only the scenario suite passes', () => {
    const ledger = mergeBadcaseEvidence(createEmptyBadcaseEvidenceLedger(), scenario);
    expect(ledger.overallStatus).toBe('partial');
  });

  it('closes the dual gate only after scenario and conversation both pass', () => {
    const partial = mergeBadcaseEvidence(createEmptyBadcaseEvidenceLedger(), scenario);
    const complete = mergeBadcaseEvidence(partial, conversation);
    expect(complete.overallStatus).toBe('passed');
  });

  it('uses the latest evidence of each kind and lets a later failure reopen the gate', () => {
    const complete = mergeBadcaseEvidence(
      mergeBadcaseEvidence(createEmptyBadcaseEvidenceLedger(), scenario),
      conversation,
    );
    const reopened = mergeBadcaseEvidence(complete, {
      ...conversation,
      batchId: 'batch-conversation-2',
      executionIds: ['exec-3'],
      reviewStatus: 'failed',
      reviewedAt: '2026-07-28T03:00:00.000Z',
    });
    expect(reopened.overallStatus).toBe('failed');
  });

  it('treats a newly queued unreviewed batch as newer than an older reviewed batch', () => {
    const passed = mergeBadcaseEvidence(createEmptyBadcaseEvidenceLedger(), scenario);
    const pending = mergeBadcaseEvidence(passed, {
      ...scenario,
      batchId: 'batch-scenario-pending',
      executionIds: ['exec-pending'],
      reviewStatus: 'pending',
      reviewedAt: null,
    });
    expect(pending.overallStatus).toBe('pending');
  });

  it('treats malformed legacy JSON as an empty ledger', () => {
    expect(parseBadcaseEvidenceLedger('{bad json').overallStatus).toBe('missing');
  });
});

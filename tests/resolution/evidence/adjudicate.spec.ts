import {
  extractCandidateTexts,
  runCandidateFactAdjudication,
} from '@resolution/evidence/adjudicate';
import type { CorpusBlock } from '@shared-types/corpus.types';

function msg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

describe('adjudication-runner（端到端编排）', () => {
  it('规则/模型/身份三路 claim 汇总，输出统一裁决视图', () => {
    const result = runCandidateFactAdjudication({
      messages: [
        msg('user', '我叫王玥，13900000002'),
        msg('assistant', '目前是学生还是社会人士？'),
        msg('user', '社会人士，我一米六三'),
      ],
      modelClaimInputs: [{ field: 'height', value: 163, quote: '我一米六三', operation: 'set' }],
      legacyArgs: { age: '25' }, // 模型裸值：候选人从未说过 → 应 rejected
      sessionAccepted: {},
      profileHints: { phone: '13800000000' }, // 旧档案：应被本轮亲证覆盖
    });

    expect(result.acceptedValues).toMatchObject({
      name: '王玥',
      phone: '13900000002',
      isStudent: false,
      height: 163,
    });
    expect(result.acceptedValues.age).toBeUndefined();
    const legacyAge = result.adjudicated.find((entry) =>
      entry.claim.claimId.startsWith('legacy_age'),
    );
    expect(legacyAge?.decision).toBe('rejected');
    expect(result.profile.fields.phone?.status).toBe('accepted');
    expect(result.profile.fields.phone?.value).toBe('13900000002');
  });

  it('extractCandidateTexts 剥时间后缀与引用块（quote 验证同口径）', () => {
    const texts = extractCandidateTexts([
      msg('user', '[引用 高雅琪：麻烦发下姓名] 我叫王玥\n[消息发送时间：2026-08-05 10:00]'),
      msg('assistant', '好的收到'),
    ]);
    expect(texts).toEqual(['我叫王玥']);
  });

  it('legacy 裸值在候选人全文中有据 → 补录 quote 后 accepted（§10 双读）', () => {
    const result = runCandidateFactAdjudication({
      messages: [msg('user', '性别：女，24岁')],
      legacyArgs: { gender: '女', age: '24' },
      sessionAccepted: {},
      profileHints: {},
    });
    expect(result.acceptedValues.gender).toBe('女');
    expect(result.acceptedValues.age).toBe(24);
  });

  it('同批消息重跑：watermark 与 factsVersion 稳定（Bull 重试幂等）', () => {
    const input = {
      messages: [msg('user', '我叫王玥')],
      sessionAccepted: {},
      profileHints: {},
    };
    const first = runCandidateFactAdjudication(input);
    const second = runCandidateFactAdjudication(input);
    expect(first.messageWatermark).toBe(second.messageWatermark);
    expect(first.factsVersion).toBe(second.factsVersion);
  });

  it('结构化分域阻止 user transport 里的教学文本穿过出处公证', () => {
    const teachingText = [
      '[引用 招聘经理：旧资料模板]',
      '[图片消息]',
      '姓名：王小明',
      '[消息发送时间：2026-08-13 10:24:31]',
    ].join('\n');
    const evidenceText = [
      '[引用 招聘经理：请说下姓名]',
      '我住浦东，姓名稍后发',
      '[消息发送时间：2026-08-13 10:24:32]',
    ].join('\n');
    const messages = [msg('user', teachingText), msg('user', evidenceText)];
    const corpusBlocks: CorpusBlock[] = [
      { id: 'repair-directive', domain: 'teaching', role: 'system', content: teachingText },
      { id: 'candidate-1', domain: 'evidence', role: 'user', content: evidenceText },
    ];

    const result = runCandidateFactAdjudication({
      messages,
      corpusBlocks,
      modelClaimInputs: [{ field: 'name', value: '王小明', quote: '姓名：王小明' }],
      sessionAccepted: {},
      profileHints: {},
    });

    expect(result.acceptedValues.name).toBeUndefined();
    expect(
      result.adjudicated.some(
        (entry) => entry.claim.field === 'name' && entry.rejectionReason === 'quote_not_found',
      ),
    ).toBe(true);
  });

  it('回声审计只消费 evidence/tool_result 标签，不把 teaching 当我方事实文本', () => {
    const candidateText = [
      '[引用 招聘经理：请补学历]',
      '[图片消息]',
      '学历：大专',
      '[消息发送时间：2026-08-13 10:24:31]',
    ].join('\n');
    const teachingText = '教学示例：学历：大专';
    const messages = [msg('user', candidateText), msg('user', teachingText)];
    const baseCorpus: CorpusBlock[] = [
      { id: 'candidate-1', domain: 'evidence', role: 'user', content: candidateText },
      { id: 'teaching-1', domain: 'teaching', role: 'system', content: teachingText },
    ];
    const input = {
      messages,
      modelClaimInputs: [{ field: 'education' as const, value: '大专', quote: '学历：大专' }],
      sessionAccepted: {},
      profileHints: {},
    };

    expect(
      runCandidateFactAdjudication({ ...input, corpusBlocks: baseCorpus }).echoDetections,
    ).toBe(0);
    expect(
      runCandidateFactAdjudication({
        ...input,
        corpusBlocks: [
          ...baseCorpus,
          {
            id: 'tool-result-1',
            domain: 'tool_result',
            role: 'tool',
            content: '报名表工具结果：学历：大专',
          },
        ],
      }).echoDetections,
    ).toBeGreaterThan(0);
  });
});

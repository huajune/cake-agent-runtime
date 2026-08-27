import { adjudicateCandidateClaims } from '@resolution/evidence/engine';
import { extractCandidateTexts } from '@resolution/signal/self-report';
import { produceDirectFieldClaims } from '@resolution/evidence/producers/direct-field';

/**
 * shadow 观测第 1 天（2026-08-06）生产实测缺陷的回归防线。
 *
 * 两个缺陷都只在 shadow 下无害，enforce 下会造成真实伤害，故在切 enforce 前必须
 * 有判据锁死：
 * - P0-1 quote 截断与推导输入不一致 → 规则轨产出自己验证器拒绝的 claim；
 * - P0-2 图片描述文本被当候选人自陈 → 第三方号码可成为报名证据。
 */

const AT = '2026-08-06T10:00:00+08:00';
const NOW = new Date(AT);

// —— P0-1：长消息里的字段信号位于旧 200 字截断点之后 ————————————————
// 形态取自 chat 6a714c00 的 442 字图片描述消息：前段是大段无关描述，年龄信号在尾部。
const LONG_MESSAGE = `${'达美乐南区兼职面试页面，标题南区达美乐兼职，服务内容包含餐厅卫生比萨及小食制作接待顾客，标签接受无经验连锁餐饮店可以学做披萨，该职位有多个职位地址可供选择。'.repeat(4)}我今年24岁`;

describe('P0-1 quote 截断与推导输入一致（shadow 观测 2026-08-06）', () => {
  it('长消息尾部的字段信号：产出的 claim 必须能被裁决器自己复算通过', () => {
    expect(LONG_MESSAGE.length).toBeGreaterThan(200); // 前置：确实越过旧截断点

    const claims = produceDirectFieldClaims({
      candidateTexts: [LONG_MESSAGE],
      assertedAt: AT,
      now: NOW,
    });
    const ageClaim = claims.find((claim) => claim.field === 'age');
    expect(ageClaim?.value).toBe(24);

    const { adjudicated } = adjudicateCandidateClaims({
      claims,
      candidateTexts: [LONG_MESSAGE],
      sessionAccepted: {},
      profileHints: {},
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    // 修复前：rule_age_1 被判 value_not_derivable（规则轨自相矛盾）
    const ageDecision = adjudicated.find((entry) => entry.claim.field === 'age');
    expect(ageDecision?.decision).toBe('accepted');
    expect(ageDecision?.rejectionReason).toBeUndefined();
  });

  it('规则轨不得产出任何"自己验证不过"的 claim（不变式）', () => {
    const texts = [LONG_MESSAGE, '我叫王玥，13900000002', '身高一米六三，体重九十二斤'];
    const claims = produceDirectFieldClaims({ candidateTexts: texts, assertedAt: AT, now: NOW });
    const { adjudicated } = adjudicateCandidateClaims({
      claims,
      candidateTexts: texts,
      sessionAccepted: {},
      profileHints: {},
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    const selfContradictions = adjudicated.filter(
      (entry) =>
        entry.claim.producer === 'rule' &&
        entry.decision === 'rejected' &&
        entry.rejectionReason !== 'conflicting_evidence',
    );
    expect(selfContradictions).toEqual([]);
  });

  it('legacy 裸值不再靠全文推导补录证据（工序 C1/C3）', () => {
    // 原不变式守的是「补录的 quote 必须支撑该值」——那条链路本身（拿正则在候选人全文
    // 里反推一段 quote 出来）已随 C3 删除：它是按产者排信任的教义遗产，也是 72.3%
    // 假阳的来源。裸值现在只有一个诚实结论：没有引文就是没有出处，模型本轮补 quote 即可。
    const claims = [
      {
        claimId: 'legacy_age_1',
        field: 'age' as const,
        value: '24',
        operation: 'set' as const,
        producer: 'model' as const,
        interpretation: 'direct' as const,
        evidence: { quote: '' },
        assertedAt: AT,
      },
    ];
    const { adjudicated } = adjudicateCandidateClaims({
      claims,
      candidateTexts: [LONG_MESSAGE],
      sessionAccepted: {},
      profileHints: {},
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    expect(adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'quote_not_found',
    });

    // 同一个值改由带引文的 claim 提交即采信——出口就在本轮，不需要再问候选人。
    const withQuote = adjudicateCandidateClaims({
      claims: [
        {
          claimId: 'model_age_1',
          field: 'age',
          value: 24,
          operation: 'set',
          producer: 'model',
          interpretation: 'direct',
          evidence: { quote: '我24岁' },
          assertedAt: AT,
        },
      ],
      candidateTexts: ['我24岁'],
      sessionAccepted: {},
      profileHints: {},
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    expect(withQuote.adjudicated[0].decision).toBe('accepted');
  });
});

// —— P0-2：图片描述里的第三方信息不得成为候选人证据 ————————————————
// 形态取自 chat 6a714c00：交换微信截图描述里带招聘者手机号；岗位卡描述带门槛年龄。
const RECRUITER_PHONE_IMAGE = {
  role: 'user',
  content: [
    { type: 'text', text: '[图片 messageId=9594a20cf787cb8c956c16d6c164d0fe]' },
    { type: 'image', image: 'https://example.com/shot.jpg' },
    {
      type: 'text',
      text: '[图片消息] BOSS直聘聊天记录截图：系统显示微信号-13788930869可复制；面试基本都过，18岁以上+健康证即可。',
    },
  ],
};

describe('P0-2 图片描述不得作为候选人自陈证据（shadow 观测 2026-08-06）', () => {
  it('extractCandidateTexts 剔除图片描述与占位标签', () => {
    const texts = extractCandidateTexts([
      RECRUITER_PHONE_IMAGE,
      { role: 'user', content: '我叫王玥' },
      { role: 'assistant', content: '好的' },
    ]);
    expect(texts).toEqual(['我叫王玥']);
  });

  it('候选人自己的简历图片仍是自陈材料（既有裁定不回退）', () => {
    const texts = extractCandidateTexts([
      {
        role: 'user',
        content: [{ type: 'text', text: '[图片消息] 简历图片：姓名王玥，联系电话13900000002' }],
      },
    ]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('简历图片');
  });

  it('候选人手打文本与图片描述同条消息时，只保留手打部分', () => {
    const texts = extractCandidateTexts([
      {
        role: 'user',
        content: [
          { type: 'text', text: '这个岗位我想试试' },
          { type: 'text', text: '[图片消息] 岗位卡截图：18岁以上即可' },
        ],
      },
    ]);
    expect(texts).toEqual(['这个岗位我想试试']);
  });
});

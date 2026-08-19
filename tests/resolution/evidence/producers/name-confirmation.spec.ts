import {
  isNameAnsweredToRealNameAsk,
  resolveNameAnsweredToRealNameAsk,
} from '@resolution/evidence/producers/name-confirmation';
import { evaluateBookingNameGate } from '@resolution/evidence/identity-gates';
import { runCandidateFactAdjudication } from '@resolution/evidence/adjudicate';

/**
 * badcase 2026-08-06 chat 6a7446eb（trace batch_6a7446ebce406a6aee9023a7_1786005914536）：
 * 候选人真名被判成微信打招呼昵称。
 *
 * 现场：微信昵称 "AAA春日"，候选人手打开场白"我是张丽鑫"（XX 位恰是真名）→ 命中打招呼语
 * 昵称判据；Agent 问"门店登记需要本名，方便问一下你的真实姓名吗"→ 候选人单独回"张丽鑫"
 * → 既有两个逃生口都够不着 → sessionFacts.name 全程 null、booking 报 suspiciousName、
 * Agent 把同一个问题问了两遍。
 */

const ASK = '门店登记需要本名，方便问一下你的真实姓名吗';

function msg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

/** badcase 原始时间线（截至真名回答那一刻）。 */
const BADCASE_MESSAGES = [
  msg('user', '我是张丽鑫'),
  msg('assistant', '你好呀'),
  msg('user', '我在杨浦区五角场'),
  msg('assistant', '这边需要登记一下你的资料，填完我帮你约： 联系方式： 性别： 年龄：'),
  msg('user', '联系方式：18832048339 性别：女 年龄：26'),
  msg('assistant', ASK),
  msg('user', '张丽鑫'),
];

describe('真名索取问答识别（badcase 6a7446eb）', () => {
  it('开放式问真名 + 裸名直答 → 识别为真名亲证', () => {
    const resolved = resolveNameAnsweredToRealNameAsk(BADCASE_MESSAGES);
    expect(resolved).toMatchObject({ name: '张丽鑫', quote: '张丽鑫' });
    expect(resolved?.askQuote).toContain('真实姓名');
  });

  it.each([
    ['我叫张丽鑫', '自述前缀'],
    ['就是张丽鑫', '确认式前缀'],
    ['张丽鑫。', '尾部标点'],
    ['名字是张丽鑫', '键值式口语'],
  ])('应答形态「%s」（%s）同样识别', (reply) => {
    expect(
      resolveNameAnsweredToRealNameAsk([msg('assistant', ASK), msg('user', reply)])?.name,
    ).toBe('张丽鑫');
  });

  it('不夹带其它内容才算：应答里混入无关内容时不产出', () => {
    expect(
      resolveNameAnsweredToRealNameAsk([
        msg('assistant', ASK),
        msg('user', '张丽鑫这个名字是我朋友的，我还没想好用哪个'),
      ]),
    ).toBeNull();
  });

  it('没有索名问句时不产出（防止随口一句被当真名）', () => {
    expect(
      resolveNameAnsweredToRealNameAsk([
        msg('assistant', '这个岗位明天可以面试'),
        msg('user', '张丽鑫'),
      ]),
    ).toBeNull();
  });

  it('只认紧随其后的第一条应答（远处消息不回溯归因）', () => {
    expect(
      resolveNameAnsweredToRealNameAsk([
        msg('assistant', ASK),
        msg('user', '稍等'),
        msg('user', '张丽鑫'),
      ]),
    ).toBeNull();
  });

  it('非法姓名形态不放行（昵称/含数字/超长）', () => {
    for (const reply of ['AAA春日', '18', '张丽鑫是我的小名哦哦哦哦']) {
      expect(
        isNameAnsweredToRealNameAsk('AAA春日', [msg('assistant', ASK), msg('user', reply)]),
      ).toBe(false);
    }
  });
});

describe('booking 姓名闸门放行（badcase 6a7446eb 复现）', () => {
  it('修复前拒绝的场景现在放行', () => {
    // 修复前：isFromAutoGreeting 命中 → reject_collect（suspiciousName: 张丽鑫）
    expect(evaluateBookingNameGate('张丽鑫', BADCASE_MESSAGES)).toEqual({ decision: 'allow' });
  });

  it('未被问真名时，打招呼语昵称仍然拦截（防昵称初衷不回退）', () => {
    const greetingOnly = [msg('user', '我是小王'), msg('assistant', '你好呀')];
    expect(evaluateBookingNameGate('小王', greetingOnly)).toMatchObject({
      decision: 'reject_collect',
    });
  });
});

describe('Claim 裁决消掉同族 name 假阳（badcase 6a7446eb）', () => {
  it('模型裸值姓名不再被判无据（同值有据 claim 已采信 → superseded）', () => {
    const result = runCandidateFactAdjudication({
      messages: BADCASE_MESSAGES,
      legacyArgs: { name: '张丽鑫', phone: '18832048339' },
      sessionAccepted: {},
      profileHints: {},
    });
    expect(result.acceptedValues.name).toBe('张丽鑫');
    const nameDecisions = result.adjudicated.filter((entry) => entry.claim.field === 'name');
    // 工序 C1 已删除 no_candidate_evidence；裸值同值时判 superseded 而非 rejected，
    // 否则会污染 enforce 判据②「作证通道占比」。
    expect(nameDecisions.some((entry) => entry.decision === 'rejected')).toBe(false);
    expect(nameDecisions.some((entry) => entry.decision === 'superseded')).toBe(true);
  });

  it('无索名问句时，裸名不会凭空成为已采信姓名', () => {
    const result = runCandidateFactAdjudication({
      messages: [msg('assistant', '这个岗位明天可以面试'), msg('user', '好的')],
      legacyArgs: { name: '张丽鑫' },
      sessionAccepted: {},
      profileHints: {},
    });
    expect(result.acceptedValues.name).toBeUndefined();
  });
});

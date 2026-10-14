import {
  evaluateGeocodeAddressProvenance,
  type GeocodeAddressProvenanceInput,
} from '@tools/geocode/address-provenance.util';

function evaluate(overrides: Partial<GeocodeAddressProvenanceInput>) {
  return evaluateGeocodeAddressProvenance({
    address: '',
    candidateTexts: [],
    humanAgentTexts: [],
    assistantTexts: [],
    toolResultTexts: [],
    dialogueMessages: [],
    ...overrides,
  });
}

describe('evaluateGeocodeAddressProvenance', () => {
  it('周度 case 10/9：地址只出现在 Agent 自己的回复里 → unattested 且标记 assistantOnly', () => {
    const assistantReply = '你好呀～龙虾过敏我记下了哈。你还是在漕宝路这边找工作吗？';
    const candidateFollowUp = '好好好\n我想找服务员\n餐饮的\n兼职';
    expect(
      evaluate({
        address: '漕宝路',
        candidateTexts: ['我是龙虾过敏\n你好你好', candidateFollowUp],
        assistantTexts: [assistantReply],
        dialogueMessages: [
          { role: 'user', content: '我是龙虾过敏\n你好你好' },
          { role: 'assistant', content: assistantReply },
          { role: 'user', content: candidateFollowUp },
        ],
      }),
    ).toEqual({ verdict: 'unattested', matchedBy: null, core: '漕宝路', assistantOnly: true });
  });

  it('候选人原话出现地址 → candidate_text；模型补的城市前缀与站名不影响承接', () => {
    expect(
      evaluate({ address: '上海漕宝路地铁站', candidateTexts: ['我在漕宝路附近'] }),
    ).toMatchObject({ verdict: 'attested', matchedBy: 'candidate_text' });
    expect(
      evaluate({ address: '北京昌平马池口', candidateTexts: ['马池口那边有吗'] }),
    ).toMatchObject({ verdict: 'attested', matchedBy: 'candidate_text' });
  });

  it('纯行政区地址按词干承接（青浦区 ↔ 青浦、浦江镇 ↔ 浦江）', () => {
    expect(evaluate({ address: '青浦区', candidateTexts: ['青浦'] })).toMatchObject({
      verdict: 'attested',
    });
    expect(evaluate({ address: '浦江镇', candidateTexts: ['浦江'] })).toMatchObject({
      verdict: 'attested',
    });
  });

  it('模型把候选人说法规范成标准 POI 名时按开头 2 字承接', () => {
    expect(
      evaluate({ address: '方圆LIVE', candidateTexts: ['我原以为在方圆里面'] }),
    ).toMatchObject({ verdict: 'attested', matchedBy: 'candidate_text' });
  });

  it('真人招募经理消息、工具结果门店地址都算外生出处', () => {
    expect(
      evaluate({ address: '同济园', humanAgentTexts: ['上海嘉定同济园是吧，我看下'] }),
    ).toMatchObject({ verdict: 'attested', matchedBy: 'human_agent' });
    expect(
      evaluate({
        address: '成山路1993号巴黎春天',
        candidateTexts: ['巴黎春天这个可以'],
        toolResultTexts: ['奥乐齐（巴黎春天店）上海市浦东新区成山路1993号巴黎春天'],
      }),
    ).toMatchObject({ verdict: 'attested' });
  });

  it('助手带求证语气提到地点 + 候选人紧接着整句肯定 → dialogue_confirmation', () => {
    const question = '你是在金坛北站附近吗？';
    expect(
      evaluate({
        address: '金坛北站',
        assistantTexts: [question],
        dialogueMessages: [
          { role: 'assistant', content: question },
          { role: 'user', content: '是的' },
        ],
      }),
    ).toMatchObject({ verdict: 'attested', matchedBy: 'dialogue_confirmation' });
  });

  it('候选人只回非肯定的长句时不算确认', () => {
    const question = '你是在金坛北站附近吗？';
    expect(
      evaluate({
        address: '金坛北站',
        assistantTexts: [question],
        dialogueMessages: [
          { role: 'assistant', content: question },
          { role: 'user', content: '好的我看看别的' },
        ],
      }),
    ).toMatchObject({ verdict: 'unattested', assistantOnly: true });
  });

  it('任何来源都没有时 unattested 但不标记 assistantOnly', () => {
    expect(evaluate({ address: '三桥荟聚', candidateTexts: ['西安'] })).toEqual({
      verdict: 'unattested',
      matchedBy: null,
      core: '三桥荟聚',
      assistantOnly: false,
    });
  });
});

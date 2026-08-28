/**
 * 自填模板直通判据。
 *
 * 生产原型：chat 6a901168ce406a6aeeeee205（2026-08-27）——候选人照模板逐行填满整表，
 * 却被要求核对了两遍资料才提交。直通命中即消灭那一轮多余往返；判据收得紧，
 * 任何一格不是"候选人在这条消息里亲眼写下的"都必须退回正常复述轮。
 */

import { createForm, proposeValue, type ContractFieldDef } from '@resolution/collection';
import { runCollectionCore } from '@tools/collection/collection-core';
import { detectSelfFilledTemplate } from '@tools/collection/self-filled-template';
import { TEST_CANDIDATE_NAME, TEST_CANDIDATE_PHONE } from '../../resolution/collection/form.fixtures';

const NAME: ContractFieldDef = {
  labelId: 769,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};
const PHONE: ContractFieldDef = {
  labelId: 770,
  labelTitle: '手机号',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'phone',
};
const HEALTH: ContractFieldDef = {
  labelId: 13,
  labelTitle: '有无本地健康证',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [
    { optionCode: '1', optionLabel: '有本地有效健康证' },
    { optionCode: '2', optionLabel: '无本地有效健康证，接受办理' },
  ],
  rejectedOptions: [{ optionCode: '3', optionLabel: '无本地有效健康证，不接受办理' }],
};

const CONTRACT = [NAME, PHONE, HEALTH];

const FULL_TEMPLATE = [
  `姓名：${TEST_CANDIDATE_NAME}`,
  `手机号：${TEST_CANDIDATE_PHONE}`,
  '有无本地健康证：有',
].join('\n');

/**
 * 模型在收到资料的当轮提交的 formAnswers（生产主路径：选项型的值由模型规范化后提交，
 * 裸「有」在 form_line 通道会被健康证值词表门拒收）。
 */
const HEALTH_ANSWER = {
  labelTitle: '有无本地健康证',
  value: '有本地有效健康证',
  quote: '有无本地健康证：有',
  operation: 'set' as const,
};

/** 跑一轮真实收资核，再拿其产物喂判据——避免用手搓的假表单绕过真实写入路径。 */
function detectAfterTurn(
  texts: string[],
  form = createForm({ jobId: 522782, contract: CONTRACT }),
  formAnswers: Parameters<typeof runCollectionCore>[0]['formAnswers'] = [HEALTH_ANSWER],
) {
  const result = runCollectionCore({
    form,
    contract: CONTRACT,
    candidateTexts: texts,
    messages: texts.map((text) => ({ role: 'user', content: text })),
    formAnswers,
  });
  return {
    result,
    detection: detectSelfFilledTemplate({
      form: result.form,
      contract: CONTRACT,
      candidateTexts: texts,
      answeredThisTurn: result.answeredThisTurn,
      ratchetIgnoredLabelIds: result.ratchetIgnoredLabelIds,
    }),
  };
}

describe('detectSelfFilledTemplate · 命中', () => {
  it('候选人一条消息逐行填满整表 → 直通，覆盖全部契约槽位', () => {
    const { result, detection } = detectAfterTurn([FULL_TEMPLATE]);

    expect(result.verdict).toBe('ready');
    expect(detection.matched).toBe(true);
    expect(detection.labelIds.sort()).toEqual([13, 769, 770]);
  });

  it('模板前后带引导句/寒暄仍算自填（只看行结构，不看整条消息是否只有表格）', () => {
    const { detection } = detectAfterTurn([
      `你先把资料发我，我帮你约：\n${FULL_TEMPLATE}\n麻烦啦`,
    ]);

    expect(detection.matched).toBe(true);
  });
});

describe('detectSelfFilledTemplate · 退回复述', () => {
  it('缺一格 → 表未办结，不直通', () => {
    const { result, detection } = detectAfterTurn(
      [`姓名：${TEST_CANDIDATE_NAME}\n手机号：${TEST_CANDIDATE_PHONE}`],
      undefined,
      [],
    );

    expect(result.verdict).toBe('collecting');
    expect(detection.matched).toBe(false);
    expect(detection.reason).toBe('verdict_not_ready');
  });

  it('整表由两条消息拼出 → 候选人没在任何一屏完整看过，退回复述', () => {
    const { result, detection } = detectAfterTurn([
      `姓名：${TEST_CANDIDATE_NAME}\n手机号：${TEST_CANDIDATE_PHONE}`,
      '有无本地健康证：有',
    ]);

    expect(result.verdict).toBe('ready');
    expect(detection.matched).toBe(false);
    expect(detection.reason).toBe('no_full_template_message');
  });

  it('值来自更早轮次（本轮只补最后一格）→ 不直通', () => {
    const seeded = proposeValue(createForm({ jobId: 522782, contract: CONTRACT }), NAME, {
      value: TEST_CANDIDATE_NAME,
      sourceText: `我叫${TEST_CANDIDATE_NAME}`,
      producer: 'candidate_quote',
      candidateTexts: [`我叫${TEST_CANDIDATE_NAME}`],
      messages: [{ role: 'user', content: `我叫${TEST_CANDIDATE_NAME}` }],
    }).form;

    const { detection } = detectAfterTurn(
      [`手机号：${TEST_CANDIDATE_PHONE}\n有无本地健康证：有`],
      seeded,
    );

    expect(detection.matched).toBe(false);
    expect(detection.reason).toBe('no_full_template_message');
  });

  it('候选人重填已办结的格子（值被棘轮挡下）→ 分歧只能靠复述暴露，不直通', () => {
    const seeded = proposeValue(createForm({ jobId: 522782, contract: CONTRACT }), PHONE, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: `手机号：${TEST_CANDIDATE_PHONE}`,
      producer: 'candidate_quote',
      candidateTexts: [`手机号：${TEST_CANDIDATE_PHONE}`],
      messages: [{ role: 'user', content: `手机号：${TEST_CANDIDATE_PHONE}` }],
    }).form;

    const { result, detection } = detectAfterTurn([FULL_TEMPLATE], seeded);

    expect(result.ratchetIgnoredLabelIds).toContain(PHONE.labelId);
    expect(detection.matched).toBe(false);
    expect(detection.reason).toBe('ratchet_ignored');
  });

  it('档案预填补上的格子候选人这屏没看见 → 必须过复述终审', () => {
    const texts = [`姓名：${TEST_CANDIDATE_NAME}\n有无本地健康证：有`];
    const result = runCollectionCore({
      form: createForm({ jobId: 522782, contract: CONTRACT }),
      contract: CONTRACT,
      candidateTexts: texts,
      messages: texts.map((text) => ({ role: 'user', content: text })),
      formAnswers: [HEALTH_ANSWER],
      archiveFacts: [{ claimField: 'phone', value: TEST_CANDIDATE_PHONE }],
    });

    expect(result.verdict).toBe('ready');
    const detection = detectSelfFilledTemplate({
      form: result.form,
      contract: CONTRACT,
      candidateTexts: texts,
      answeredThisTurn: result.answeredThisTurn,
      ratchetIgnoredLabelIds: result.ratchetIgnoredLabelIds,
    });

    expect(detection.matched).toBe(false);
    // 档案格没有模板行，先被"这条消息没填满整表"拦下——两道防线同向，任一命中都退回复述。
    expect(detection.reason).toBe('no_full_template_message');
  });

  it('单格契约的一行作答不算"誊了一整张表"，仍走复述', () => {
    const soloContract = [NAME];
    const texts = [`姓名：${TEST_CANDIDATE_NAME}`];
    const result = runCollectionCore({
      form: createForm({ jobId: 522782, contract: soloContract }),
      contract: soloContract,
      candidateTexts: texts,
      messages: texts.map((text) => ({ role: 'user', content: text })),
    });

    expect(result.verdict).toBe('ready');
    const detection = detectSelfFilledTemplate({
      form: result.form,
      contract: soloContract,
      candidateTexts: texts,
      answeredThisTurn: result.answeredThisTurn,
      ratchetIgnoredLabelIds: result.ratchetIgnoredLabelIds,
    });

    expect(detection.matched).toBe(false);
    expect(detection.reason).toBe('single_field_contract');
  });

  it('候选人原样回抄空模板（占位回声）→ 无值可用，不直通', () => {
    const { result, detection } = detectAfterTurn(
      ['姓名：\n手机号：\n有无本地健康证：'],
      undefined,
      [],
    );

    expect(result.verdict).toBe('collecting');
    expect(detection.matched).toBe(false);
  });
});

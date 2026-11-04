import { createForm, applyFieldValueProposal, type ContractFieldDef } from '@resolution/collection';
import { collectVerifiedWorkAnswers } from '@tools/collection/verified-work-answers';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { verifyScheduleCitation } from '@tools/job-list/schedule-evidence';
import { AVAILABILITY_FIELD } from '../../helpers/work-condition.fixture';

function answeredForm(field: ContractFieldDef = AVAILABILITY_FIELD) {
  const quote = `${field.labelTitle}：07:00-16:00`;
  return applyFieldValueProposal(
    createForm({ jobId: 529230, contract: [field] }),
    field,
    {
      value: '07:00-16:00',
      optionCodes: ['day'],
      sourceText: quote,
      producer: 'model',
    },
    { candidateTexts: [quote], messages: [{ role: 'user', content: quote }] },
  ).form;
}

describe('已验证表单答案引用', () => {
  it('改值或原话后引用失效；清空、刷新替换旧答案，不自动产生班次限制', () => {
    const ledger = createTurnLedger();
    const form = answeredForm();
    const answers = collectVerifiedWorkAnswers(form, [AVAILABILITY_FIELD]);
    expect(answers).toHaveLength(1);
    ledger.recordCollectionAnswers(form.jobId, answers);
    const citation = { collectionAnswerIds: [answers[0].id] };
    expect(verifyScheduleCitation(citation, '帮我找其他岗位', ledger.jobs.collectionAnswers!)).toBe(
      true,
    );
    const amended = structuredClone(form);
    amended.slots[741].value!.value = '16:00-23:00';
    amended.slots[741].value!.sourceText = '每天可工作时间段：16:00-23:00';
    ledger.recordCollectionAnswers(
      form.jobId,
      collectVerifiedWorkAnswers(amended, [AVAILABILITY_FIELD]),
    );
    expect(verifyScheduleCitation(citation, '', ledger.jobs.collectionAnswers!)).toBe(false);
    expect(ledger.jobs.scheduleConstraint).toBeUndefined();
    ledger.recordCollectionAnswers(form.jobId, []);
    expect(ledger.jobs.collectionAnswers).toEqual([]);
  });

  it('他人表单、档案预填、空槽和敏感字段不能成为本人的班次出处', () => {
    const form = answeredForm();
    expect(
      collectVerifiedWorkAnswers({ ...form, candidateScope: 'additional' }, [AVAILABILITY_FIELD]),
    ).toEqual([]);
    expect(
      collectVerifiedWorkAnswers(form, [{ ...AVAILABILITY_FIELD, disclosure: 'RESTRICTED' }]),
    ).toEqual([]);
    form.slots[741].value!.producer = 'archive';
    expect(collectVerifiedWorkAnswers(form, [AVAILABILITY_FIELD])).toEqual([]);
    expect(
      collectVerifiedWorkAnswers(createForm({ jobId: 1, contract: [AVAILABILITY_FIELD] }), [
        AVAILABILITY_FIELD,
      ]),
    ).toEqual([]);
  });

  it('每个引用都要在账本中，伪造、跨会话引用及非连续拼接原话继续拒收', () => {
    const answers = collectVerifiedWorkAnswers(answeredForm(), [AVAILABILITY_FIELD]);
    expect(
      verifyScheduleCitation({ collectionAnswerIds: [answers[0].id, 'forged'] }, '', answers),
    ).toBe(false);
    expect(verifyScheduleCitation({ collectionAnswerIds: [answers[0].id] }, '', [])).toBe(false);
    expect(
      verifyScheduleCitation(
        { quote: '周末可上 每天07:00-16:00' },
        '周末可上\n居住地址：南京\n每天07:00-16:00',
        answers,
      ),
    ).toBe(false);
    expect(
      verifyScheduleCitation(
        { quote: '每天07:00-16:00' },
        '周末可上\n居住地址：南京\n每天07:00-16:00',
        answers,
      ),
    ).toBe(true);
  });
});

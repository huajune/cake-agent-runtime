import { MessageSplitter } from '@channels/wecom/message/utils/message-splitter.util';
import { createForm, type ContractFieldDef } from '@resolution/collection/form.types';
import { applyFieldValueProposal } from '@resolution/collection/form-writes';
import { renderRecap } from '@tools/collection/recap-renderer';

const NAME_FIELD: ContractFieldDef = {
  labelId: 769,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};
const PHONE_FIELD: ContractFieldDef = {
  labelId: 770,
  labelTitle: '手机号',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'phone',
};
const AGE_FIELD: ContractFieldDef = {
  labelId: 687,
  labelTitle: '年龄',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'age',
};
/** 生产实测的脏配置形态：标题携带筛选指令与括号补充。 */
const DIRTY_TITLE_FIELD: ContractFieldDef = {
  labelId: 605,
  labelTitle: '是否学生（不要学生及暑假工）',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [{ optionCode: 's1', optionLabel: '社会人士' }],
  rejectedOptions: [],
};

const CONTRACT = [NAME_FIELD, PHONE_FIELD, AGE_FIELD, DIRTY_TITLE_FIELD];

function filledForm() {
  let form = createForm({ jobId: 528781, contract: CONTRACT });
  const nameText = '姓名：兮兮';
  form = applyFieldValueProposal(form, NAME_FIELD, {
    value: '兮兮',
    sourceText: nameText,
    producer: 'candidate_quote',
  }, { candidateTexts: [nameText], messages: [{ role: 'user', content: nameText }] }).form;
  const phoneText = '我的手机号是18271421690';
  form = applyFieldValueProposal(form, PHONE_FIELD, {
    value: '18271421690',
    sourceText: phoneText,
    producer: 'candidate_quote',
  }, { candidateTexts: [phoneText], messages: [{ role: 'user', content: phoneText }] }).form;
  form = applyFieldValueProposal(form, AGE_FIELD, {
    value: '26',
    sourceText: '我今年26岁',
    producer: 'candidate_quote',
  }, { candidateTexts: ['我今年26岁'], messages: [] }).form;
  form = applyFieldValueProposal(form, DIRTY_TITLE_FIELD, {
    value: '社会人士',
    optionCodes: ['s1'],
    sourceText: '我是社会人士',
    producer: 'candidate_quote',
  }, { candidateTexts: ['我是社会人士'], messages: [] }).form;
  return form;
}

describe('renderRecap', () => {
  it('渲染提交前复述（快照）', () => {
    expect(renderRecap(filledForm(), CONTRACT).text).toMatchInlineSnapshot(`
      "帮你核对一下报名信息：
      姓名：兮兮
      手机号：18271421690
      年龄：26
      是否学生（不要学生及暑假工）：社会人士

      没问题的话我这就帮你提交，有不对的地方直接说改哪项"
    `);
  });

  it('渲染即落账——拿不到"只渲染不落账"的出口', () => {
    const rendered = renderRecap(filledForm(), CONTRACT);
    expect(rendered.form.lastRecap?.labelIds).toEqual(rendered.labelIds);
    expect(rendered.labelIds).toEqual([769, 770, 687, 605]);
  });

  it('只复述 filled 槽位；一格都没填时不发复述', () => {
    const empty = createForm({ jobId: 1, contract: CONTRACT });
    const rendered = renderRecap(empty, CONTRACT);
    expect(rendered.text).toBeNull();
    expect(rendered.form.lastRecap).toBeUndefined();
  });

  it('recap 标签 100% 使用契约 labelTitle 原文，不做清洗', () => {
    const text = renderRecap(filledForm(), CONTRACT).text!;
    expect(text).toContain('是否学生（不要学生及暑假工）：社会人士');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Spike S5：复述文案 × \n\n 分段 / 拟人化投递兼容性核验（2026-08-19）
// ══════════════════════════════════════════════════════════════════════════
describe('Spike S5 · 复述文案与分段协议兼容', () => {
  const text = renderRecap(filledForm(), CONTRACT).text!;

  it('表单块保持原子：引导句与全部字段行在同一条消息里', () => {
    const segments = MessageSplitter.split(text);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain('帮你核对一下报名信息');
    for (const line of [
      '姓名：兮兮',
      '手机号：18271421690',
      '年龄：26',
      '是否学生（不要学生及暑假工）：社会人士',
    ]) {
      expect(segments[0]).toContain(line);
    }
  });

  it('字段行不被按句拆散——一个字段一条消息是刷屏事故', () => {
    const segments = MessageSplitter.split(text);
    expect(segments.filter((segment) => segment.includes('：'))).toHaveLength(1);
  });

  it('收尾提示单独成段（拟人化投递按段发，读感更自然）', () => {
    const segments = MessageSplitter.split(text);
    expect(segments[1]).toContain('没问题的话我这就帮你提交');
  });

  it('段数上限收口时表单块仍不被合并（原子块不参与 coalesce）', () => {
    const segments = MessageSplitter.split(text, 1);
    expect(segments[0]).toContain('姓名：兮兮');
    expect(segments[0]).toContain('是否学生（不要学生及暑假工）：社会人士');
  });

  it('末尾标点会被投递层剥掉——复述文案不把语义押在句末标点上', () => {
    const segments = MessageSplitter.split(text);
    expect(segments[segments.length - 1]).not.toMatch(/[。？?！!]$/u);
    expect(segments[segments.length - 1]).toContain('直接说改哪项');
  });
});

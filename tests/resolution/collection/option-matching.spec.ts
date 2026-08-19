import { findOptionBySemantics, matchOptionInText } from '@resolution/collection/option-matching';
import type { ContractFieldDef } from '@resolution/collection/form.types';
import { GENDER_MALE_ONLY_FIELD, HEALTH_CERT_FIELD } from './form.fixtures';

/** 基线实测「预计在岗多久」族：rejectedOptions 已实用（「3个月内」拒 4 岗）。 */
const TENURE_FIELD: ContractFieldDef = {
  labelId: 749,
  labelTitle: '预计在岗多久',
  fieldType: 'SINGLE_OPTION',
  acceptedOptions: [
    { optionCode: 'a', optionLabel: '半年以上' },
    { optionCode: 'b', optionLabel: '3个月以上' },
  ],
  rejectedOptions: [{ optionCode: 'c', optionLabel: '3个月内' }],
};

/** 基线实测学历(2)：「中专\技校\职高」自带反斜杠分隔符。 */
const EDUCATION_FIELD: ContractFieldDef = {
  labelId: 2,
  labelTitle: '学历',
  fieldType: 'SINGLE_OPTION',
  acceptedOptions: [
    { optionCode: '3', optionLabel: '大专' },
    { optionCode: '8', optionLabel: '中专\\技校\\职高' },
  ],
  rejectedOptions: [],
};

describe('matchOptionInText', () => {
  it('逐字点名选项即命中，sourceText 取命中子句', () => {
    const matched = matchOptionInText(HEALTH_CERT_FIELD, '我有本地有效健康证的');
    expect(matched?.option.optionCode).toBe('1');
    expect(matched?.sourceText).toBe('我有本地有效健康证的');
  });

  it('否定前缀紧邻标签时不命中（「没有本地有效健康证」不是「有本地有效健康证」）', () => {
    expect(matchOptionInText(HEALTH_CERT_FIELD, '我没有本地有效健康证')).toBeNull();
  });

  it('长标签吃掉自己的子串标签（「无…，接受办理」不被「有…健康证」截胡）', () => {
    const matched = matchOptionInText(HEALTH_CERT_FIELD, '无本地有效健康证，接受办理');
    expect(matched?.option.optionCode).toBe('2');
  });

  it('疑问子句整体不参与——问句不是回答', () => {
    expect(matchOptionInText(HEALTH_CERT_FIELD, '要有本地有效健康证吗？')).toBeNull();
    expect(matchOptionInText(GENDER_MALE_ONLY_FIELD, '你们只要男的吗')).toBeNull();
  });

  it('同时点到两个互斥选项 → 歧义不猜', () => {
    expect(matchOptionInText(TENURE_FIELD, '半年以上或者3个月内都行')).toBeNull();
  });

  it('rejectedOptions 里的标签同样可被命中（先筛后收要靠它）', () => {
    const matched = matchOptionInText(TENURE_FIELD, '我只能做3个月内');
    expect(matched?.option.optionCode).toBe('c');
  });

  it('折全半角与分隔符：「中专/技校/职高」能命中「中专\\技校\\职高」', () => {
    const matched = matchOptionInText(EDUCATION_FIELD, '我是中专/技校/职高的');
    expect(matched?.option.optionCode).toBe('8');
  });

  it('裸终答不映射（「是」「有」「可以」脱离问句不指向任何字段）', () => {
    for (const terse of ['是', '有', '可以', '嗯']) {
      expect(matchOptionInText(HEALTH_CERT_FIELD, terse)).toBeNull();
      expect(matchOptionInText(TENURE_FIELD, terse)).toBeNull();
    }
  });

  it('无选项字段与空文本一律 null', () => {
    const textField: ContractFieldDef = {
      labelId: 769,
      labelTitle: '姓名',
      fieldType: 'TEXT',
      acceptedOptions: [],
      rejectedOptions: [],
    };
    expect(matchOptionInText(textField, '我叫兮兮')).toBeNull();
    expect(matchOptionInText(HEALTH_CERT_FIELD, '   ')).toBeNull();
  });
});

describe('findOptionBySemantics', () => {
  it('语义唯一命中才返回；命中多个视为歧义', () => {
    expect(
      findOptionBySemantics(HEALTH_CERT_FIELD, (label) => label.startsWith('有'))?.optionCode,
    ).toBe('1');
    expect(
      findOptionBySemantics(HEALTH_CERT_FIELD, (label) => label.includes('健康证')),
    ).toBeNull();
  });

  it('契约改了标签措辞就返回 null（退化成追问，不按 ID 硬猜）', () => {
    const renamed: ContractFieldDef = {
      ...HEALTH_CERT_FIELD,
      acceptedOptions: [{ optionCode: '1', optionLabel: '持证上岗' }],
      rejectedOptions: [],
    };
    expect(findOptionBySemantics(renamed, (label) => /^有.*健康证$/u.test(label))).toBeNull();
  });
});

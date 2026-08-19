import {
  adapterFor,
  genericAdapter,
  proposeForField,
  routeOf,
} from '@resolution/collection/adapters/adapter.registry';
import { proposeEducation } from '@resolution/collection/adapters/education.adapter';
import { proposeHealthCertificate } from '@resolution/collection/adapters/health-certificate.adapter';
import { proposeIdentityCore } from '@resolution/collection/adapters/identity-core.adapter';
import { createForm, type ContractFieldDef } from '@resolution/collection/form.types';
import { proposeValue } from '@resolution/collection/form-writes';
import {
  AGE_FIELD,
  GENDER_MALE_ONLY_FIELD,
  HEALTH_CERT_FIELD,
  NAME_FIELD,
  PHONE_FIELD,
  TEST_CANDIDATE_NAME,
  TEST_CANDIDATE_PHONE,
  userMessage,
} from './form.fixtures';

/** 基线实测学历(2)：4 种按岗白名单，此岗只收大专/本科。 */
const EDUCATION_FIELD: ContractFieldDef = {
  labelId: 2,
  labelTitle: '学历',
  fieldType: 'SINGLE_OPTION',
  acceptedOptions: [
    { optionCode: '3', optionLabel: '大专' },
    { optionCode: '2', optionLabel: '本科' },
  ],
  rejectedOptions: [],
};

/** 基线实测学生族的脏配置形态：TEXT 型且标题携带筛选指令，12 个 labelId 语义分裂。 */
const STUDENT_TEXT_FIELD: ContractFieldDef = {
  labelId: 605,
  labelTitle: '是否学生（不要学生及暑假工）',
  fieldType: 'TEXT',
  acceptedOptions: [],
  rejectedOptions: [],
};

function input(field: ContractFieldDef, candidateText: string) {
  return { field, candidateText };
}

describe('identity-core.adapter', () => {
  it('姓名走结构化出处解析，产 candidate_quote 提案', () => {
    const proposal = proposeIdentityCore(input(NAME_FIELD, `姓名：${TEST_CANDIDATE_NAME}`));
    expect(proposal).toEqual({
      labelId: NAME_FIELD.labelId,
      value: TEST_CANDIDATE_NAME,
      sourceText: `姓名：${TEST_CANDIDATE_NAME}`,
      producer: 'candidate_quote',
    });
  });

  it('手机号与年龄同理，sourceText 取解析器 excerpt', () => {
    expect(proposeIdentityCore(input(PHONE_FIELD, `我电话${TEST_CANDIDATE_PHONE}`))?.value).toBe(
      TEST_CANDIDATE_PHONE,
    );
    const age = proposeIdentityCore(input(AGE_FIELD, '我今年26岁'));
    expect(age?.value).toBe('26');
    expect(age?.sourceText).toBe('26岁');
  });

  it('性别两条轨都要过：parseGender 判自陈，契约选项定 optionCode', () => {
    const proposal = proposeIdentityCore(input(GENDER_MALE_ONLY_FIELD, '我是男的'));
    expect(proposal?.value).toBe('男');
    expect(proposal?.optionCodes).toEqual(['1']);
  });

  it('岗位要求语境不当候选人自陈（「只招男的吗」不产提案）', () => {
    expect(proposeIdentityCore(input(GENDER_MALE_ONLY_FIELD, '你们只招男的吗'))).toBeNull();
    expect(proposeIdentityCore(input(GENDER_MALE_ONLY_FIELD, '我朋友是女的'))).toBeNull();
  });

  it('岗位年龄要求文本不当候选人年龄（岗位要求剥离在 parseAge 内）', () => {
    expect(proposeIdentityCore(input(AGE_FIELD, '岗位要求年龄22以上可做吗'))).toBeNull();
  });

  it('systemField 不是身份四槽时不接管', () => {
    expect(proposeIdentityCore(input(EDUCATION_FIELD, '我是大专'))).toBeNull();
  });
});

describe('education.adapter', () => {
  it('解析器 → 海绵学历 id → 契约选项成员判定', () => {
    const proposal = proposeEducation(input(EDUCATION_FIELD, '我是大专毕业的'));
    expect(proposal?.optionCodes).toEqual(['3']);
    expect(proposal?.value).toBe('大专');
    expect(proposal?.sourceText).toBe('大专');
  });

  it('契约没列这一档 → 留空追问，不塞近似值', () => {
    expect(proposeEducation(input(EDUCATION_FIELD, '我初中毕业'))).toBeNull();
  });

  it('学校语境守卫照常生效（「高中部」不是学历自陈）', () => {
    expect(proposeEducation(input(EDUCATION_FIELD, '我在大专学院当保安'))).toBeNull();
  });

  it('分隔符异形的中专档能对上（基线实测「中专\\技校\\职高」）', () => {
    const field: ContractFieldDef = {
      ...EDUCATION_FIELD,
      acceptedOptions: [{ optionCode: '8', optionLabel: '中专\\技校\\职高' }],
    };
    expect(proposeEducation(input(field, '我中专毕业的'))?.optionCodes).toEqual(['8']);
  });
});

describe('health-certificate.adapter', () => {
  it('三确定态各自映射到一个 optionCode', () => {
    expect(
      proposeHealthCertificate(input(HEALTH_CERT_FIELD, '我有上海本地健康证'))?.optionCodes,
    ).toEqual(['1']);
    expect(
      proposeHealthCertificate(input(HEALTH_CERT_FIELD, '没有健康证，可以办'))?.optionCodes,
    ).toEqual(['2']);
    expect(
      proposeHealthCertificate(input(HEALTH_CERT_FIELD, '没有健康证，我不愿意办'))?.optionCodes,
    ).toEqual(['3']);
  });

  it('两不定态留空追问：持异地证未表态 / 明确没证未表态', () => {
    expect(proposeHealthCertificate(input(HEALTH_CERT_FIELD, '我的是外地健康证'))).toBeNull();
    expect(proposeHealthCertificate(input(HEALTH_CERT_FIELD, '还没办'))).toBeNull();
  });

  it('否定答法不被判成持证（2026-08-19 修复的判反 bug 的适配器侧回归）', () => {
    for (const text of ['没有健康证', '没有本地健康证', '我没有本地有效健康证']) {
      expect(
        proposeHealthCertificate(input(HEALTH_CERT_FIELD, text))?.optionCodes ?? null,
      ).not.toEqual(['1']);
    }
  });

  it('咨询问句不当回答（「健康证在哪办」不产提案）', () => {
    expect(proposeHealthCertificate(input(HEALTH_CERT_FIELD, '健康证在哪里办呀'))).toBeNull();
  });

  it('契约改了标签措辞 → 退化成追问，不按 ID 硬猜（D4）', () => {
    const renamed: ContractFieldDef = {
      ...HEALTH_CERT_FIELD,
      acceptedOptions: [{ optionCode: '1', optionLabel: '持证上岗' }],
      rejectedOptions: [],
    };
    expect(proposeHealthCertificate(input(renamed, '我有上海本地健康证'))).toBeNull();
  });
});

describe('adapter.registry', () => {
  it('路由顺序：systemField → 标题语义族 → fieldType 通用道', () => {
    expect(routeOf(NAME_FIELD)).toBe('identity_core');
    expect(routeOf(HEALTH_CERT_FIELD)).toBe('title_family');
    expect(routeOf(EDUCATION_FIELD)).toBe('title_family');
    expect(routeOf(STUDENT_TEXT_FIELD)).toBe('generic');

    expect(adapterFor(NAME_FIELD)).toBe(proposeIdentityCore);
    expect(adapterFor(HEALTH_CERT_FIELD)).toBe(proposeHealthCertificate);
    expect(adapterFor(EDUCATION_FIELD)).toBe(proposeEducation);
    expect(adapterFor(STUDENT_TEXT_FIELD)).toBe(genericAdapter);
  });

  it('标题语义族按词面判定，兜得住 12 个分裂的健康证/学历 labelId', () => {
    const oddHealthField: ContractFieldDef = {
      ...HEALTH_CERT_FIELD,
      labelId: 9999,
      labelTitle: '健康证情况（食品类）',
    };
    expect(routeOf(oddHealthField)).toBe('title_family');
  });

  it('通用道只接选项型；TEXT 型不产确定性提案（值边界交模型作证）', () => {
    const tenure: ContractFieldDef = {
      labelId: 749,
      labelTitle: '预计在岗多久',
      fieldType: 'SINGLE_OPTION',
      acceptedOptions: [{ optionCode: 'a', optionLabel: '半年以上' }],
      rejectedOptions: [{ optionCode: 'c', optionLabel: '3个月内' }],
    };
    expect(genericAdapter(input(tenure, '我能做半年以上'))?.optionCodes).toEqual(['a']);
    expect(genericAdapter(input(STUDENT_TEXT_FIELD, '我不是学生'))).toBeNull();
  });
});

describe('适配器 → 公证 端到端', () => {
  const contract = [NAME_FIELD, HEALTH_CERT_FIELD, GENDER_MALE_ONLY_FIELD];

  it('适配器产的提案能过公证入账', () => {
    const text = `姓名：${TEST_CANDIDATE_NAME}`;
    const proposal = proposeForField(input(NAME_FIELD, text));
    const result = proposeValue(createForm({ jobId: 1, contract }), NAME_FIELD, {
      ...proposal!,
      candidateTexts: [text],
      messages: [userMessage(text)],
    });
    expect(result.outcome).toBe('accepted');
  });

  it('适配器不做公证——命中 rejectedOption 的提案由公证判不合格', () => {
    const text = '没有健康证，我不愿意办';
    const proposal = proposeForField(input(HEALTH_CERT_FIELD, text));
    const result = proposeValue(createForm({ jobId: 1, contract }), HEALTH_CERT_FIELD, {
      ...proposal!,
      candidateTexts: [text],
    });
    expect(result.outcome).toBe('disqualified');
  });

  it('适配器署名一律 candidate_quote（自陈 quote 复算），禁 system 冒名', () => {
    for (const [field, text] of [
      [NAME_FIELD, `姓名：${TEST_CANDIDATE_NAME}`],
      [HEALTH_CERT_FIELD, '我有上海本地健康证'],
      [GENDER_MALE_ONLY_FIELD, '我是男的'],
    ] as const) {
      expect(proposeForField(input(field, text))?.producer).toBe('candidate_quote');
    }
  });
});

import {
  adapterFor,
  genericAdapter,
  proposeForField,
  routeOf,
} from '@resolution/collection/adapters/adapter.registry';
import { proposeAccommodation } from '@resolution/collection/adapters/accommodation.adapter';
import { proposeConditionOption } from '@resolution/collection/adapters/condition-option.adapter';
import { proposeEducation } from '@resolution/collection/adapters/education.adapter';
import { proposeHealthCertificate } from '@resolution/collection/adapters/health-certificate.adapter';
import { proposeIdentityCore } from '@resolution/collection/adapters/identity-core.adapter';
import { proposeIdentityStatus } from '@resolution/collection/adapters/identity-status.adapter';
import { proposeHouseholdRegister } from '@resolution/collection/adapters/household-register.adapter';
import {
  proposeSocialInsurance,
  socialInsuranceMissingDimensions,
} from '@resolution/collection/adapters/social-insurance.adapter';
import { createForm, type ContractFieldDef } from '@resolution/collection/form.types';
import { applyFieldValueProposal } from '@resolution/collection/form-writes';
import {
  AGE_FIELD,
  GENDER_MALE_ONLY_FIELD,
  HEALTH_CERT_FIELD,
  HOMETOWN_RESTRICTED_FIELD,
  NAME_FIELD,
  PHONE_FIELD,
  SOCIAL_INSURANCE_FIELD,
  TEST_CANDIDATE_NAME,
  TEST_CANDIDATE_PHONE,
  userMessage,
} from './form.fixtures';

/** 基线实测学历(2)：4 种按岗白名单，此岗只收大专/本科。 */
const EDUCATION_FIELD: ContractFieldDef = {
  labelId: 2,
  labelTitle: '学历',
  fieldType: 'SINGLE_OPTION',
  required: true,
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
  required: true,
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

describe('identity-status.adapter', () => {
  const field: ContractFieldDef = {
    labelId: 606,
    labelTitle: '社会身份',
    fieldType: 'SINGLE_OPTION',
    required: true,
    acceptedOptions: [
      { optionCode: '1', optionLabel: '学生' },
      { optionCode: '2', optionLabel: '社会人士' },
    ],
    rejectedOptions: [],
  };

  it('自由聊天里的裸否定不映射身份；绑定到身份槽位后才按否=社会人士解释', () => {
    expect(proposeIdentityStatus(input(field, '不是'))).toBeNull();
    expect(proposeIdentityStatus({ ...input(field, '不是'), answerBound: true })).toEqual(
      expect.objectContaining({ value: '社会人士', optionCodes: ['2'] }),
    );
  });

  it('自由聊天里的明确身份自陈仍可识别', () => {
    expect(proposeIdentityStatus(input(field, '我不是学生'))).toEqual(
      expect.objectContaining({ value: '社会人士', optionCodes: ['2'] }),
    );
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

  it('回归：缺少“有/无”的「本地有效健康证，接受办理」保持空槽，不替候选人猜', () => {
    expect(
      proposeHealthCertificate(
        input(HEALTH_CERT_FIELD, '有无本地健康证：本地有效健康证，接受办理'),
      ),
    ).toBeNull();
    expect(
      proposeHealthCertificate(input(HEALTH_CERT_FIELD, '本地有效健康证，接受办理')),
    ).toBeNull();
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

  it('answerBound 下裸短答可解释（0902：「有」「有本地」「无,接受办理」被值词表门拒 8 条）', () => {
    const bound = (text: string) =>
      proposeHealthCertificate({ ...input(HEALTH_CERT_FIELD, text), answerBound: true });
    expect(bound('有')?.optionCodes).toEqual(['1']);
    expect(bound('有本地')?.optionCodes).toEqual(['1']);
    expect(bound('🈶')?.optionCodes).toEqual(['1']);
    expect(bound('无,接受办理')?.optionCodes).toEqual(['2']);
    expect(bound('接受办理')?.optionCodes).toEqual(['2']);
    expect(bound('没有，可以办')?.optionCodes).toEqual(['2']);
    expect(bound('没有，不接受办理')?.optionCodes).toEqual(['3']);
    expect(bound('不办')?.optionCodes).toEqual(['3']);
    // 出处如实：裸答本身就是原话
    expect(bound('无,接受办理')?.sourceText).toBe('无,接受办理');
    // 「无」单独出现未表态是否办 → 留空追问（两不定态纪律不变）
    expect(bound('无')).toBeNull();
    // 歧义短答不收：「可以」「不」在健康证槽位上答不出三态
    expect(bound('可以')).toBeNull();
    expect(bound('不')).toBeNull();
    // 未绑定的自由语料不解释裸答
    expect(proposeHealthCertificate(input(HEALTH_CERT_FIELD, '有'))).toBeNull();
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

describe('condition-option.adapter（条件型单选项：唯一选项=必须接受，运营 0902 裁定）', () => {
  const WORK_WINDOW: ContractFieldDef = {
    labelId: 741,
    labelTitle: '每天可工作时间段',
    fieldType: 'MULTIPLE_OPTION',
    required: true,
    acceptedOptions: [{ optionCode: '1', optionLabel: '09:30-22:30' }],
    rejectedOptions: [],
  };

  it('路由：单选项且无拒绝项走条件道（不记通用道配置债）；两个以上选项仍走通用道', () => {
    expect(routeOf(WORK_WINDOW)).toBe('condition');
    expect(adapterFor(WORK_WINDOW)).toBe(proposeConditionOption);
    const twoShifts: ContractFieldDef = {
      ...WORK_WINDOW,
      acceptedOptions: [
        { optionCode: '1', optionLabel: '早班' },
        { optionCode: '2', optionLabel: '晚班' },
      ],
    };
    expect(routeOf(twoShifts)).toBe('generic');
  });

  it('抄回条件字面任何语境都认；绑定行上的整句肯定才认；子区间/否定/闲聊不填不判', () => {
    expect(proposeConditionOption(input(WORK_WINDOW, '09:30-22:30'))?.optionCodes).toEqual(['1']);
    expect(
      proposeConditionOption(input(WORK_WINDOW, '我 09:30-22:30 都可以'))?.optionCodes,
    ).toEqual(['1']);

    const bound = (text: string) =>
      proposeConditionOption({ ...input(WORK_WINDOW, text), answerBound: true });
    expect(bound('可以')?.optionCodes).toEqual(['1']);
    expect(bound('可以')?.sourceText).toBe('可以');
    expect(bound('都可以')?.optionCodes).toEqual(['1']);
    expect(bound('门店排')?.optionCodes).toEqual(['1']);
    expect(bound('没问题！')?.optionCodes).toEqual(['1']);
    // 未绑定的一句"可以"不知道在答哪一行
    expect(proposeConditionOption(input(WORK_WINDOW, '可以'))).toBeNull();
    // 回显我们的提示（哪怕稍有改动）不算接受：括号里的字面是我们印的
    expect(
      proposeConditionOption(
        input(
          WORK_WINDOW,
          '每天可工作时间段：（要求 09:30-22:30 内都能排班，接受请填 09:30-22:30）好的',
        ),
      ),
    ).toBeNull();
    // 子区间 = 没接受完整窗口；否定；问句；别的话——全部 null，合不合适交模型对话判
    expect(bound('18:00-22:00')).toBeNull();
    expect(bound('周一到周五晚上6-10点，周末白天')).toBeNull();
    expect(bound('不行，接受不了')).toBeNull();
    expect(bound('可以吗')).toBeNull();
  });
});

describe('adapter.registry', () => {
  it('路由顺序：systemField → 标题语义族 → fieldType 通用道', () => {
    expect(routeOf(NAME_FIELD)).toBe('identity_core');
    expect(routeOf(HEALTH_CERT_FIELD)).toBe('title_family');
    expect(routeOf(EDUCATION_FIELD)).toBe('title_family');
    // 学生族脏配置（12 个 labelId 语义分裂）现在由身份适配器接管——标题语义族兜得住，
    // 正是 adapter.registry 注释里说的"按 ID 精确表必漏"的那一族。
    expect(routeOf(STUDENT_TEXT_FIELD)).toBe('title_family');

    expect(adapterFor(NAME_FIELD)).toBe(proposeIdentityCore);
    expect(adapterFor(HEALTH_CERT_FIELD)).toBe(proposeHealthCertificate);
    expect(adapterFor(EDUCATION_FIELD)).toBe(proposeEducation);
    expect(adapterFor(STUDENT_TEXT_FIELD)).toBe(proposeIdentityStatus);
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
      required: true,
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
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract }),
      NAME_FIELD,
      {
        ...proposal!,
      },
      { candidateTexts: [text], messages: [userMessage(text)] },
    );
    expect(result.outcome).toBe('accepted');
  });

  it('适配器不做公证——命中 rejectedOption 的提案由公证判不合格', () => {
    const text = '没有健康证，我不愿意办';
    const proposal = proposeForField(input(HEALTH_CERT_FIELD, text));
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract }),
      HEALTH_CERT_FIELD,
      {
        ...proposal!,
      },
      { candidateTexts: [text], messages: [] },
    );
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

describe('social-insurance.adapter（badcase batch_6a8fec04ce406a6aee03d65f_*）', () => {
  it('绑定值「无」→ 契约唯一否定选项（生产措辞「无公司在缴社保流水」）', () => {
    const proposal = proposeSocialInsurance({
      field: SOCIAL_INSURANCE_FIELD,
      candidateText: '无',
      answerBound: true,
    });
    expect(proposal).toEqual({
      labelId: 12,
      value: '无公司在缴社保流水',
      optionCodes: ['2'],
      sourceText: '无',
      producer: 'candidate_quote',
    });
  });

  it('绑定短答否定族（没有/没交过/未缴纳）都认', () => {
    for (const text of ['没有', '没交过', '未缴纳', '没买过']) {
      expect(
        proposeSocialInsurance({
          field: SOCIAL_INSURANCE_FIELD,
          candidateText: text,
          answerBound: true,
        })?.value,
      ).toBe('无公司在缴社保流水');
    }
  });

  it('未绑定的裸「无」不解释——脱离语境的裸否定能回答任何一问', () => {
    expect(
      proposeSocialInsurance({ field: SOCIAL_INSURANCE_FIELD, candidateText: '无' }),
    ).toBeNull();
  });

  it('自由语料的显式语境档：句内点名社保的否定可识别，excerpt 取命中子句', () => {
    const proposal = proposeSocialInsurance({
      field: SOCIAL_INSURANCE_FIELD,
      candidateText: '我在老家，没有交社保的',
    });
    expect(proposal?.value).toBe('无公司在缴社保流水');
    expect(proposal?.sourceText).toBe('没有交社保的');
  });

  it('肯定/在缴不产提案——缴纳方与参保地决定筛选方向，猜错即错筛', () => {
    for (const text of ['有', '在缴', '有社保', '公司给交着社保呢']) {
      expect(
        proposeSocialInsurance({
          field: SOCIAL_INSURANCE_FIELD,
          candidateText: text,
          answerBound: true,
        }),
      ).toBeNull();
    }
  });

  it('肯定答案只报告缺失维度：个人灵活社保只缺参保地，在缴则两项都缺', () => {
    expect(
      socialInsuranceMissingDimensions({
        field: SOCIAL_INSURANCE_FIELD,
        candidateText: '个人灵活社保',
        answerBound: true,
      }),
    ).toEqual(['location']);
    expect(
      socialInsuranceMissingDimensions({
        field: SOCIAL_INSURANCE_FIELD,
        candidateText: '在缴',
        answerBound: true,
      }),
    ).toEqual(['payer', 'location']);
    expect(
      socialInsuranceMissingDimensions({
        field: SOCIAL_INSURANCE_FIELD,
        candidateText: '公司缴纳外地社保',
        answerBound: true,
      }),
    ).toBeNull();
  });

  it('疑问句与岗位咨询语境不解释', () => {
    for (const text of ['要交社保吗', '有没有不用交社保的工作', '这个岗位不交社保吧']) {
      expect(
        proposeSocialInsurance({ field: SOCIAL_INSURANCE_FIELD, candidateText: text }),
      ).toBeNull();
    }
  });

  it('契约否定选项不唯一时弃权（D4：措辞漂移退化为留空追问，不猜）', () => {
    const ambiguous = {
      ...SOCIAL_INSURANCE_FIELD,
      acceptedOptions: [
        { optionCode: 'a', optionLabel: '无本地社保' },
        { optionCode: 'b', optionLabel: '无外地社保' },
      ],
      rejectedOptions: [],
    };
    expect(
      proposeSocialInsurance({ field: ambiguous, candidateText: '无', answerBound: true }),
    ).toBeNull();
  });

  it('社保族走标题语义族路由，不再是通用道', () => {
    expect(routeOf(SOCIAL_INSURANCE_FIELD)).toBe('title_family');
    expect(adapterFor(SOCIAL_INSURANCE_FIELD)).toBe(proposeSocialInsurance);
  });
});

describe('household-register.adapter · 籍贯省级选项的行政后缀容差', () => {
  /** 生产实测 labelId 3：optionCode 就是海绵省份 ID，标签是省级全称。 */
  const PROVINCE_FIELD: ContractFieldDef = {
    ...HOMETOWN_RESTRICTED_FIELD,
    acceptedOptions: [
      { optionCode: '310000', optionLabel: '上海市' },
      { optionCode: '320000', optionLabel: '江苏省' },
      { optionCode: '450000', optionLabel: '广西壮族自治区' },
    ],
    rejectedOptions: [],
  };

  it('逐字直配仍优先，sourceText 取精确命中子句', () => {
    const proposal = proposeHouseholdRegister({
      field: PROVINCE_FIELD,
      candidateText: '我籍贯是江苏省',
    });
    expect(proposal?.value).toBe('江苏省');
    expect(proposal?.optionCodes).toEqual(['320000']);
    expect(proposal?.producer).toBe('candidate_quote');
  });

  it('生产 badcase：答「上海」配不上「上海市」——差一个市字就整格入不了账', () => {
    const proposal = proposeHouseholdRegister({
      field: PROVINCE_FIELD,
      candidateText: '上海',
      answerBound: true,
    });
    expect(proposal?.value).toBe('上海市');
    expect(proposal?.optionCodes).toEqual(['310000']);
    expect(proposal?.sourceText).toBe('上海');
  });

  it('省后缀同理：「江苏」→「江苏省」', () => {
    expect(
      proposeHouseholdRegister({
        field: PROVINCE_FIELD,
        candidateText: '江苏',
        answerBound: true,
      })?.value,
    ).toBe('江苏省');
  });

  it('自治区全称按最长后缀剥：「广西」→「广西壮族自治区」', () => {
    expect(
      proposeHouseholdRegister({
        field: PROVINCE_FIELD,
        candidateText: '广西',
        answerBound: true,
      })?.value,
    ).toBe('广西壮族自治区');
  });

  it('未绑定的自由语料只走逐字直配——后缀容差不对长句开放', () => {
    // 「我在江苏打过两年工」是工作地点不是籍贯。未绑定时不许剥后缀去配「江苏省」，
    // 否则轮末安全网会把任何提到省名的句子都写进这一格。
    expect(
      proposeHouseholdRegister({ field: PROVINCE_FIELD, candidateText: '我在江苏打过两年工' }),
    ).toBeNull();
    expect(
      proposeHouseholdRegister({ field: PROVINCE_FIELD, candidateText: '我以前在浙江上班' }),
    ).toBeNull();
    // 但完整省级全称逐字出现时照旧直配（这条通道改造前就有，不能丢）。
    expect(
      proposeHouseholdRegister({ field: PROVINCE_FIELD, candidateText: '我籍贯江苏省的' })?.value,
    ).toBe('江苏省');
  });

  it('契约没有这一档就留空追问，不塞近似值', () => {
    expect(
      proposeHouseholdRegister({
        field: PROVINCE_FIELD,
        candidateText: '山东',
        answerBound: true,
      }),
    ).toBeNull();
  });

  it('全国行政区映射：市级籍贯归一到契约省级选项', () => {
    expect(
      proposeHouseholdRegister({
        field: PROVINCE_FIELD,
        candidateText: '南京',
        answerBound: true,
      })?.value,
    ).toBe('江苏省');
    expect(
      proposeHouseholdRegister({
        field: PROVINCE_FIELD,
        candidateText: '江苏泰州',
        answerBound: true,
      })?.value,
    ).toBe('江苏省');
  });

  it('籍贯/户籍走标题语义族路由，不再是通用道', () => {
    expect(routeOf(PROVINCE_FIELD)).toBe('title_family');
    expect(adapterFor(PROVINCE_FIELD)).toBe(proposeHouseholdRegister);
    expect(adapterFor({ ...PROVINCE_FIELD, labelTitle: '户籍所在地' })).toBe(
      proposeHouseholdRegister,
    );
  });
});

describe('accommodation.adapter · 住宿需求肯否归一', () => {
  const ACCOMMODATION_FIELD: ContractFieldDef = {
    labelId: 109,
    labelTitle: '住宿需求',
    fieldType: 'SINGLE_OPTION',
    required: true,
    acceptedOptions: [
      { optionCode: '1', optionLabel: '需要住宿' },
      { optionCode: '2', optionLabel: '不需要住宿' },
    ],
    rejectedOptions: [],
  };

  it('绑定短答「不需要」归一为契约否定选项', () => {
    expect(
      proposeAccommodation({
        field: ACCOMMODATION_FIELD,
        candidateText: '不需要',
        answerBound: true,
      }),
    ).toEqual({
      labelId: 109,
      value: '不需要住宿',
      optionCodes: ['2'],
      sourceText: '不需要',
      producer: 'candidate_quote',
    });
  });

  it('自由语料必须显式带住宿语境；疑问句不解释', () => {
    expect(
      proposeAccommodation({ field: ACCOMMODATION_FIELD, candidateText: '我不需要住宿' })?.value,
    ).toBe('不需要住宿');
    expect(
      proposeAccommodation({ field: ACCOMMODATION_FIELD, candidateText: '不需要' }),
    ).toBeNull();
    expect(
      proposeAccommodation({ field: ACCOMMODATION_FIELD, candidateText: '需要住宿吗？' }),
    ).toBeNull();
  });

  it('住宿族走专用标题路由', () => {
    expect(routeOf(ACCOMMODATION_FIELD)).toBe('title_family');
    expect(adapterFor({ ...ACCOMMODATION_FIELD, labelTitle: '是否需要住宿' })).toBe(
      proposeAccommodation,
    );
  });
});

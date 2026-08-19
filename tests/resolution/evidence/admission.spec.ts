import { applyEvidenceAdmission } from '@resolution/evidence/admission';
import { decideGeoPreferenceClear } from '@resolution/evidence/producers/geo-preference';

describe('evidence admission chain', () => {
  it('drops unsupported identity fields and returns auditable reasons', () => {
    const result = applyEvidenceAdmission({
      facts: {
        interview_info: {
          name: '辛瑜琦',
          phone: '13788930869',
          is_student: false,
          has_health_certificate: '有',
          age: '晚上才可以，有吗？',
        },
        preferences: { city: '晚上才可以，有吗？', salary: '晚上才可以，有吗？' },
        reasoning: 'test',
      },
      previousFacts: null,
      messages: [{ role: 'user', content: '[引用 辛瑜琦：联系电话13788930869] 好的' }],
      userMessages: ['[引用 辛瑜琦：联系电话13788930869] 好的'],
      selfReportedUserTexts: ['好的'],
      assistantTexts: [],
    });

    expect(result.facts.interview_info).toMatchObject({
      name: null,
      phone: null,
      is_student: null,
      has_health_certificate: null,
      age: null,
    });
    expect(result.facts.preferences).toMatchObject({ city: null, salary: null });
    expect(new Set(result.dropped.map((item) => item.reason))).toEqual(
      new Set([
        'quoted_speaker_name',
        'phone_not_self_reported',
        'first_write_no_identity_context',
        'first_write_no_health_cert_context',
        'scalar_fanout',
      ]),
    );
  });

  it('keeps fields backed by candidate text and valid shapes', () => {
    const result = applyEvidenceAdmission({
      facts: {
        interview_info: {
          name: '王建国',
          phone: '13912345678',
          is_student: false,
          has_health_certificate: '无但接受办理健康证',
          age: '28',
          household_register_province: '四川省',
        },
        preferences: { city: '上海' },
      },
      previousFacts: null,
      messages: [
        {
          role: 'user',
          content: '我叫王建国，电话13912345678，已毕业，没健康证可以办，28岁，籍贯四川省，在上海',
        },
      ],
      userMessages: [
        '我叫王建国，电话13912345678，已毕业，没健康证可以办，28岁，籍贯四川省，在上海',
      ],
      selfReportedUserTexts: [
        '我叫王建国，电话13912345678，已毕业，没健康证可以办，28岁，籍贯四川省，在上海',
      ],
      assistantTexts: [],
    });

    expect(result.dropped).toEqual([]);
    expect(result.facts.interview_info.phone).toBe('13912345678');
    expect(result.facts.preferences.city).toBe('上海');
  });

  it('filters invalid district/location values without dropping valid accumulated entries', () => {
    const result = applyEvidenceAdmission({
      facts: {
        interview_info: {},
        preferences: {
          district: ['浦东新区', '晚上才可以，有吗？'],
          location: ['静安寺', '时薪25元'],
        },
      },
      previousFacts: null,
      messages: [],
      userMessages: [],
      selfReportedUserTexts: [],
      assistantTexts: [],
    });

    expect(result.facts.preferences).toEqual({
      district: ['浦东新区'],
      location: ['静安寺'],
    });
    expect(result.dropped.map((item) => item.reason)).toEqual([
      'invalid_district_value',
      'invalid_location_value',
    ]);
  });

  it('keeps whitelist-外的歧义区名（鼓楼类），不做白名单裁决（PR #1000 评审 P2-3）', () => {
    // UNIQUE_SUBDIVISION_TO_CITY 是「区名→唯一城市」派生用的刻意窄表；规则轨故意把
    // 白名单外区名留给 LLM 处理，准入层按白名单 drop-on-null 会把合法偏好丢掉。
    const result = applyEvidenceAdmission({
      facts: {
        interview_info: {},
        preferences: { district: ['鼓楼'] },
      },
      previousFacts: null,
      messages: [],
      userMessages: [],
      selfReportedUserTexts: [],
      assistantTexts: [],
    });

    expect(result.facts.preferences).toEqual({ district: ['鼓楼'] });
    expect(result.dropped).toEqual([]);
  });

  it('only clears accumulated geo preferences on explicit no-constraint language', () => {
    expect(decideGeoPreferenceClear('地区不限，位置也无所谓')).toEqual({
      district: true,
      location: true,
    });
    expect(decideGeoPreferenceClear('不考虑浦东，想在静安寺附近')).toEqual({
      district: false,
      location: false,
    });
  });
});

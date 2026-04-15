import { LocationCityResolverService } from '@agent/services/location-city-resolver.service';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';

describe('LocationCityResolverService', () => {
  const service = new LocationCityResolverService();

  it('should resolve municipality compact expressions directly', () => {
    expect(
      service.resolve({
        currentMessageContent: '上海徐汇有店吗',
        sessionFacts: null,
        highConfidenceFacts: null,
      }),
    ).toEqual({
      city: '上海',
      confidence: 'high',
      evidence: 'municipality_compact',
    });
  });

  it('should resolve supported city prefixes without forcing an extra confirmation', () => {
    expect(
      service.resolve({
        currentMessageContent: '武汉光谷附近有店吗',
        sessionFacts: null,
        highConfidenceFacts: null,
      }),
    ).toEqual({
      city: '武汉',
      confidence: 'high',
      evidence: 'explicit_city',
    });
  });

  it('should infer city from unique district aliases', () => {
    expect(
      service.resolve({
        currentMessageContent: '朝阳区附近有吗',
        sessionFacts: null,
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            district: ['朝阳'],
          },
          reasoning: '区域识别：朝阳',
        },
      }),
    ).toEqual({
      city: '北京',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
  });

  it('should infer city from bare district-like queries without requiring suffix extraction', () => {
    expect(
      service.resolve({
        currentMessageContent: '朝阳附近有店吗',
        sessionFacts: null,
        highConfidenceFacts: null,
      }),
    ).toEqual({
      city: '北京',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
  });

  it('should carry over session city when current turn only has location hints', () => {
    expect(
      service.resolve({
        currentMessageContent: '世纪大道附近有吗',
        sessionFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            city: '上海',
          },
          reasoning: '会话记忆',
        },
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            location: ['世纪大道'],
          },
          reasoning: '地点识别：世纪大道',
        },
      }),
    ).toEqual({
      city: '上海',
      confidence: 'high',
      evidence: 'memory_carry_over',
    });
  });

  it('should infer city from high-confidence hotspot aliases', () => {
    expect(
      service.resolve({
        currentMessageContent: '陆家嘴附近有吗',
        sessionFacts: null,
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            location: ['陆家嘴'],
          },
          reasoning: '地点识别：陆家嘴',
        },
      }),
    ).toEqual({
      city: '上海',
      confidence: 'high',
      evidence: 'hotspot_alias',
    });
  });

  it('should infer city from bare hotspot queries without requiring nearby wording extraction', () => {
    expect(
      service.resolve({
        currentMessageContent: '徐家汇有岗位吗',
        sessionFacts: null,
        highConfidenceFacts: null,
      }),
    ).toEqual({
      city: '上海',
      confidence: 'high',
      evidence: 'hotspot_alias',
    });
  });

  it('should infer city from expanded Beijing hotspot aliases', () => {
    expect(
      service.resolve({
        currentMessageContent: '回龙观附近有吗',
        sessionFacts: null,
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            location: ['回龙观'],
          },
          reasoning: '地点识别：回龙观',
        },
      }),
    ).toEqual({
      city: '北京',
      confidence: 'high',
      evidence: 'hotspot_alias',
    });
  });

  it('should infer city from expanded Nanchang hotspot aliases', () => {
    expect(
      service.resolve({
        currentMessageContent: '红谷滩附近有吗',
        sessionFacts: null,
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            location: ['红谷滩'],
          },
          reasoning: '地点识别：红谷滩',
        },
      }),
    ).toEqual({
      city: '南昌',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
  });

  it('should infer city from newly added Yichang district aliases', () => {
    expect(
      service.resolve({
        currentMessageContent: '夷陵区这边有岗位吗',
        sessionFacts: null,
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            district: ['夷陵区'],
          },
          reasoning: '区域识别：夷陵区',
        },
      }),
    ).toEqual({
      city: '宜昌',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
  });

  it('should infer city from newly added Ganzhou hotspot aliases', () => {
    expect(
      service.resolve({
        currentMessageContent: '郁孤台附近有吗',
        sessionFacts: null,
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            location: ['郁孤台'],
          },
          reasoning: '地点识别：郁孤台',
        },
      }),
    ).toEqual({
      city: '赣州',
      confidence: 'high',
      evidence: 'hotspot_alias',
    });
  });

  it('should infer city from newly added Enshi county aliases', () => {
    expect(
      service.resolve({
        currentMessageContent: '利川这边有兼职吗',
        sessionFacts: null,
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            district: ['利川'],
          },
          reasoning: '区域识别：利川',
        },
      }),
    ).toEqual({
      city: '恩施',
      confidence: 'high',
      evidence: 'unique_district_alias',
    });
  });

  it('should recognize operated city prefixes beyond municipalities', () => {
    expect(
      service.resolve({
        currentMessageContent: '南昌红谷滩附近有吗',
        sessionFacts: null,
        highConfidenceFacts: null,
      }),
    ).toEqual({
      city: '南昌',
      confidence: 'high',
      evidence: 'explicit_city',
    });
  });

  it('should not auto-resolve when current turn conflicts with session city', () => {
    expect(
      service.resolve({
        currentMessageContent: '朝阳附近有店吗',
        sessionFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            city: '上海',
          },
          reasoning: '会话记忆',
        },
        highConfidenceFacts: {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            district: ['朝阳'],
          },
          reasoning: '区域识别：朝阳',
        },
      }),
    ).toEqual({
      city: null,
      confidence: 'low',
      evidence: 'conflict',
    });
  });
});

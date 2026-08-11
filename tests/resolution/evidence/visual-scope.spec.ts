import {
  VISUAL_FACT_KINDS,
  finalizeVisualFactSheet,
  type VisualFactKind,
} from '@/resolution/signal/visual';
import {
  mapLocationCityCandidates,
  resolveExtractionScope,
} from '@resolution/evidence/admission';

const sheetOf = (kind: VisualFactKind, fields: Array<{ key: string; value: string }> = []) =>
  finalizeVisualFactSheet({ kind, fields }, `${kind} 图片描述`);

describe('resolution/visual · resolveExtractionScope', () => {
  it('手打文本全量授权', () => {
    expect(resolveExtractionScope('我在上海，做兼职服务员', null)).toEqual({
      identity: true,
      phone: true,
      preferences: true,
      geo: true,
    });
  });

  it('resume/certificate：身份可提但 phone 关（裁决 B3）', () => {
    for (const kind of ['resume', 'certificate'] as const) {
      expect(resolveExtractionScope('[图片消息] 简历：…', sheetOf(kind))).toEqual({
        identity: true,
        phone: false,
        preferences: true,
        geo: true,
      });
    }
  });

  it('map_location 仅地理；job_posting/chat_screenshot/other 全关', () => {
    expect(resolveExtractionScope('[图片消息] 地图定位', sheetOf('map_location'))).toEqual({
      identity: false,
      phone: false,
      preferences: false,
      geo: true,
    });
    for (const kind of ['job_posting', 'chat_screenshot', 'other'] as const) {
      expect(resolveExtractionScope('[图片消息] 截图', sheetOf(kind))).toEqual({
        identity: false,
        phone: false,
        preferences: false,
        geo: false,
      });
    }
  });

  it('无 sheet/降级：文本标记认简历则同自陈档，否则身份关、偏好+地理开（PR #870 现状）', () => {
    expect(resolveExtractionScope('[图片消息] 简历：张三，20岁', null)).toEqual({
      identity: true,
      phone: false,
      preferences: true,
      geo: true,
    });
    const degraded = finalizeVisualFactSheet({ kind: '不存在的档' }, '[图片消息] 某截图');
    expect(degraded.degraded).toBe(true);
    expect(resolveExtractionScope('[图片消息] 某截图', degraded)).toEqual({
      identity: false,
      phone: false,
      preferences: true,
      geo: true,
    });
  });

  // 收口的意义所在：加一档 kind 而不在 KIND_EXTRACTION_SCOPE 表态时，Record 会在编译期
  // 报错；本例守住运行期一侧——每档都必须解析出授权域，不得静默落兜底。
  it('每个 kind 都有显式授权域', () => {
    for (const kind of VISUAL_FACT_KINDS) {
      expect(resolveExtractionScope('[图片消息] x', sheetOf(kind))).toBeDefined();
    }
  });
});

describe('resolution/visual · mapLocationCityCandidates', () => {
  it('按 city → address → candidate_address 顺序取值', () => {
    const sheet = sheetOf('map_location', [
      { key: 'candidate_address', value: '朝阳区望京街道' },
      { key: 'city', value: '北京' },
      { key: 'address', value: '北京市朝阳区' },
    ]);
    expect(mapLocationCityCandidates(sheet)).toEqual(['北京', '北京市朝阳区', '朝阳区望京街道']);
  });

  it('非 map_location 一律空数组——门店/他人位置不得进候选人城市确权', () => {
    const jobSheet = sheetOf('job_posting', [
      { key: 'city', value: '杭州' },
      { key: 'candidate_address', value: '西湖区文三路' },
    ]);
    expect(mapLocationCityCandidates(jobSheet)).toEqual([]);
    expect(mapLocationCityCandidates(sheetOf('chat_screenshot', [{ key: 'city', value: '杭州' }]))).toEqual(
      [],
    );
  });

  it('无关字段不进候选（salary_text/store 等）', () => {
    const sheet = sheetOf('map_location', [
      { key: 'store', value: '达美乐佛山桂城店' },
      { key: 'city', value: '佛山' },
    ]);
    expect(mapLocationCityCandidates(sheet)).toEqual(['佛山']);
  });
});

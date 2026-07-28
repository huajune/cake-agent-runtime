import { resolveParentAdministrativeArea } from '@resolution/geo';
import { NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE } from '@resolution/geo/administrative-division.generated';
import { COUNTY_LEVEL_CITY_TO_PREFECTURE } from '@resolution/geo/administrative-division.data';

/**
 * Phase 4 全国县级市映射（脚本生成）+ GEO_NATIONAL_COUNTY_MAPPING_ENABLED 灰度开关。
 * 数据集级校验（漂移/唯一性/余姚防线）在 pnpm run geo:validate，此处只锁运行时行为。
 */
describe('administrative-division.generated（Phase 4 全国映射 + 灰度开关）', () => {
  const originalFlag = process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED;
    } else {
      process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED = originalFlag;
    }
  });

  it('生成表形状：覆盖全国县级市（≥350 条），键全部以"市"结尾、无伪父级', () => {
    const entries = Object.entries(NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE);
    expect(entries.length).toBeGreaterThanOrEqual(350);
    for (const [county, prefecture] of entries) {
      expect(county.endsWith('市')).toBe(true);
      expect(prefecture).not.toContain('直辖');
      expect(prefecture).not.toBe('市辖区');
    }
  });

  it('生成表 spot check：余姚市→宁波市、义乌市→金华市、延吉市→延边朝鲜族自治州', () => {
    expect(NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE['余姚市']).toBe('宁波市');
    expect(NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE['义乌市']).toBe('金华市');
    expect(NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE['延吉市']).toBe('延边朝鲜族自治州');
  });

  it('开关关闭（缺省）：策展表未收录的县级市返回 null，行为与 Phase 4 前一致', () => {
    delete process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED;
    expect(COUNTY_LEVEL_CITY_TO_PREFECTURE['余姚市']).toBeUndefined();
    expect(resolveParentAdministrativeArea('余姚市')).toBeNull();
    expect(resolveParentAdministrativeArea('义乌')).toBeNull();
  });

  it('开关开启：策展表未收录条目回退全国生成表（余姚双轨隐患的全国兜底）', () => {
    process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED = 'true';
    expect(resolveParentAdministrativeArea('余姚市')).toEqual({
      input: '余姚市',
      canonicalName: '余姚市',
      level: 'county_level_city',
      parentCity: '宁波市',
    });
    // 裸名兼容与策展表同规则
    expect(resolveParentAdministrativeArea('义乌')?.parentCity).toBe('金华市');
  });

  it('开关开启时策展表仍然优先（海绵口径逐条实证的映射不被国家数据覆盖）', () => {
    process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED = 'true';
    expect(resolveParentAdministrativeArea('昆山市')?.parentCity).toBe(
      COUNTY_LEVEL_CITY_TO_PREFECTURE['昆山市'],
    );
    expect(resolveParentAdministrativeArea('延吉')?.parentCity).toBe('延边朝鲜族自治州');
  });

  it('开关开启也不影响非县级市输入：地级市/未知名称不猜父级', () => {
    process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED = 'true';
    expect(resolveParentAdministrativeArea('上海')).toBeNull();
    expect(resolveParentAdministrativeArea('火星市')).toBeNull();
  });
});

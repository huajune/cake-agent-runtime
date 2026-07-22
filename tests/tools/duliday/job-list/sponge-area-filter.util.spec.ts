import {
  filterJobsToRequestedAdministrativeArea,
  normalizeSpongeCityFilters,
} from '@tools/duliday/job-list/sponge-area-filter.util';

/** 方案 §15.2 必测矩阵中的海绵转换/串城防护行（Phase 3）。 */
describe('sponge-area-filter.util（海绵行政区适配）', () => {
  describe('normalizeSpongeCityFilters', () => {
    it('基线：县级市裸名称/显式名称都转换为 地级 city + 县级 region（延吉）', () => {
      for (const input of ['延吉', '延吉市']) {
        const result = normalizeSpongeCityFilters([input]);
        expect(result.cityNameList).toEqual(['延边朝鲜族自治州']);
        expect(result.derivedRegionNameList).toEqual(['延吉市']);
        expect(result.mappings).toEqual([
          { requestedCity: input, spongeCity: '延边朝鲜族自治州', spongeRegion: '延吉市' },
        ]);
      }
    });

    it('普通地级市/直辖市保持城市过滤，不派生县级 region', () => {
      expect(normalizeSpongeCityFilters(['上海'])).toEqual({
        cityNameList: ['上海'],
        derivedRegionNameList: [],
        mappings: [],
      });
    });

    it('未知城市不猜父级，原样透传', () => {
      expect(normalizeSpongeCityFilters(['火星市'])).toEqual({
        cityNameList: ['火星市'],
        derivedRegionNameList: [],
        mappings: [],
      });
    });

    it('混合多城市：逐条转换并去重', () => {
      const result = normalizeSpongeCityFilters(['延吉', '图们市', '上海', '延吉市']);
      expect(result.cityNameList).toEqual(['延边朝鲜族自治州', '上海']);
      expect(result.derivedRegionNameList).toEqual(['延吉市', '图们市']);
      expect(result.mappings).toHaveLength(3);
    });

    it('15.3 不变量：输出数组去重且不含空字符串', () => {
      const result = normalizeSpongeCityFilters(['延吉', '延吉', '上海', '上海']);
      for (const list of [result.cityNameList, result.derivedRegionNameList]) {
        expect(new Set(list).size).toBe(list.length);
        expect(list.every((item) => item.trim().length > 0)).toBe(true);
      }
    });
  });

  describe('filterJobsToRequestedAdministrativeArea（兜底串城防护）', () => {
    const job = (storeCityName: string, storeRegionName: string) => ({
      basicInfo: { storeInfo: { storeCityName, storeRegionName } },
    });

    it('基线：请求延吉时按 city/region 双字段匹配，过滤跨城结果', () => {
      const jobs = [job('延边朝鲜族自治州', '延吉市'), job('长春市', '朝阳区')];
      expect(filterJobsToRequestedAdministrativeArea(jobs, ['延吉'])).toEqual([jobs[0]]);
    });

    it('后缀归一：请求"昆山"匹配 storeRegionName="昆山市"', () => {
      const jobs = [job('苏州市', '昆山市'), job('上海市', '嘉定区')];
      expect(filterJobsToRequestedAdministrativeArea(jobs, ['昆山'])).toEqual([jobs[0]]);
    });

    it('请求为空/岗位缺 storeInfo 时不放行任何结果', () => {
      expect(filterJobsToRequestedAdministrativeArea([job('苏州市', '昆山市')], [])).toEqual([]);
      expect(filterJobsToRequestedAdministrativeArea([{ basicInfo: {} }], ['昆山'])).toEqual([]);
    });
  });
});

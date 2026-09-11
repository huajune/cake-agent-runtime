import { pruneGeoPreferencesForCity } from '@resolution/geo/preference-prune';

describe('pruneGeoPreferencesForCity（换城清理）', () => {
  it('会话城市为北京时剔除白名单能反推为其他城市的区域与地点', () => {
    const result = pruneGeoPreferencesForCity('北京', ['栖霞', '朝阳'], ['陆家嘴', '中关村']);

    expect(result.districts).toEqual(['朝阳']);
    expect(result.removedDistricts).toEqual(['栖霞']);
    expect(result.locations).toEqual(['中关村']);
    expect(result.removedLocations).toEqual(['陆家嘴']);
  });

  it('白名单外（反推不出城市）的值保持不动，不由代码猜归属', () => {
    const result = pruneGeoPreferencesForCity('北京', ['我浦江', '这三个'], ['某某小区']);

    expect(result.districts).toEqual(['我浦江', '这三个']);
    expect(result.locations).toEqual(['某某小区']);
    expect(result.removedDistricts).toEqual([]);
  });

  it('城市为空或「上海市」等带后缀写法时按归一化城市比较', () => {
    expect(pruneGeoPreferencesForCity(null, ['栖霞'], ['陆家嘴']).removedDistricts).toEqual([]);
    expect(pruneGeoPreferencesForCity('上海市', ['浦东新区', '栖霞'], null).districts).toEqual([
      '浦东新区',
    ]);
  });
});

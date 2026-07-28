import { parseLocationShareCoords } from '@memory/facts/location-share';

describe('parseLocationShareCoords（定位分享坐标解析共享工具）', () => {
  it('解析标准定位分享（lat,lng 序，badcase 6a6846e2 南海万达）', () => {
    const coords = parseLocationShareCoords([
      '[位置分享] CAMEL骆驼咖啡(南海万达店)（No Address） [经纬度:23.063003,113.128581]',
    ]);
    expect(coords).toEqual({ latitude: 23.063003, longitude: 113.128581 });
  });

  it('多条定位取最后一条（最新位置）', () => {
    const coords = parseLocationShareCoords([
      '[位置分享] A [经纬度:31.1,121.1]',
      '[位置分享] B [经纬度:31.2,121.2]',
    ]);
    expect(coords).toEqual({ latitude: 31.2, longitude: 121.2 });
  });

  it('剥离时间后缀后仍可解析', () => {
    const coords = parseLocationShareCoords([
      '[位置分享] 黎明村98号楼 [经纬度:31.269528,121.695882] [消息发送时间：2026-07-28 10:00]',
    ]);
    expect(coords).toEqual({ latitude: 31.269528, longitude: 121.695882 });
  });

  it('引用块内的定位不算候选人自己的位置', () => {
    expect(
      parseLocationShareCoords(['[引用 经理：[位置分享] 门店位置 [经纬度:31.1,121.1]]好的']),
    ).toBeNull();
  });

  it('无 [位置分享] 标记的坐标残片不解析（岗位地址里的坐标不算）', () => {
    expect(parseLocationShareCoords(['门店坐标 [经纬度:31.1,121.1]'])).toBeNull();
  });

  it('空输入 / 非法数字返回 null', () => {
    expect(parseLocationShareCoords([])).toBeNull();
    expect(parseLocationShareCoords(['[位置分享] X [经纬度:abc,121.1]'])).toBeNull();
  });
});

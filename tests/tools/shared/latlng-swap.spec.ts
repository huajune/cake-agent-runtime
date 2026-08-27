import { correctSwappedLatLng } from '@tools/shared/latlng-swap';

describe('correctSwappedLatLng', () => {
  it('纠正东部城市对调（badcase 6a86a508 嘉定：lat=121.27 物理不可能）', () => {
    // 模型把 geocode 的 (lat 31.375566, lng 121.265276) 抄反
    expect(correctSwappedLatLng(121.265276, 31.375566)).toEqual({
      latitude: 31.375566,
      longitude: 121.265276,
      swapped: true,
    });
  });

  it('纠正簇内其余样本（广州 289663 / 北京 286966）', () => {
    expect(correctSwappedLatLng(113.207969666, 23.029880524)).toEqual({
      latitude: 23.029880524,
      longitude: 113.207969666,
      swapped: true,
    });
    expect(correctSwappedLatLng(116.426319, 39.941823)).toEqual({
      latitude: 39.941823,
      longitude: 116.426319,
      swapped: true,
    });
  });

  it('纠正西部城市对调（乌鲁木齐：对调后 lat=87.6 仍 ≤90，|lat|>90 判据测不出）', () => {
    expect(correctSwappedLatLng(87.616848, 43.825592)).toEqual({
      latitude: 43.825592,
      longitude: 87.616848,
      swapped: true,
    });
  });

  it('合法中国坐标原样透传', () => {
    expect(correctSwappedLatLng(31.375566, 121.265276)).toEqual({
      latitude: 31.375566,
      longitude: 121.265276,
      swapped: false,
    });
    expect(correctSwappedLatLng(43.825592, 87.616848)).toEqual({
      latitude: 43.825592,
      longitude: 87.616848,
      swapped: false,
    });
  });

  it('非交叉形态的异常坐标不做猜测性修改', () => {
    // 境外坐标（东京）：经度越出中国区间但纬度正常，不构成对调信号
    expect(correctSwappedLatLng(35.689487, 139.691711).swapped).toBe(false);
    // 单边异常：纬度正常、经度落在纬度区间（如丢了整数位），无法确定是对调
    expect(correctSwappedLatLng(31.375566, 31.375566).swapped).toBe(false);
    // 双越界垃圾值：交换也不能变合法，原样透传
    expect(correctSwappedLatLng(200, 300).swapped).toBe(false);
  });

  it('区间边界值不误伤：纬度上界 54 / 经度下界 73 附近的合法坐标', () => {
    // 漠河一带 lat≈53.5（合法），lng≈122.5
    expect(correctSwappedLatLng(53.48, 122.53).swapped).toBe(false);
    // 喀什 lat≈39.5, lng≈75.9（合法西部坐标）
    expect(correctSwappedLatLng(39.47, 75.99).swapped).toBe(false);
    // 喀什对调形态：lat=75.99 落在经度区间、lng=39.47 落在纬度区间 → 纠正
    expect(correctSwappedLatLng(75.99, 39.47)).toEqual({
      latitude: 39.47,
      longitude: 75.99,
      swapped: true,
    });
  });
});

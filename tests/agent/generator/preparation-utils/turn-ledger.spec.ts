import { createTurnLedger } from '@agent/generator/working-memory/turn-ledger';

describe('createTurnLedger — geo 双记录（议题 4）', () => {
  const locationShare = {
    longitude: 121.4,
    latitude: 31.2,
    areaLevelQuery: false,
    areaName: null,
    city: '上海市',
    district: '徐汇区',
    evidence: '定位分享逆解析：上海市徐汇区田林路',
    source: 'location_share' as const,
  };

  const geocodeUnique = (city: string) => ({
    longitude: 116.4,
    latitude: 39.9,
    areaLevelQuery: true,
    areaName: '朝阳区',
    city,
    district: '朝阳区',
    evidence: `geocode 唯一解析：${city}朝阳区`,
    source: 'geocode_unique' as const,
  });

  // 4-1：一次调用同时完成两个投影，调用方不再各自维护"先 anchor 后 attestation"。
  it('records the anchor and the city attestation from one call', () => {
    const ledger = createTurnLedger();

    ledger.recordGeoResolution(locationShare);

    expect(ledger.geo.anchors).toEqual([
      {
        longitude: 121.4,
        latitude: 31.2,
        areaLevelQuery: false,
        areaName: null,
        city: '上海市',
      },
    ]);
    expect(ledger.geo.cityAttestation).toEqual({
      city: '上海市',
      district: '徐汇区',
      evidence: '定位分享逆解析：上海市徐汇区田林路',
      source: 'location_share',
    });
  });

  // 4-1 的不变式：坐标有效但 city 为空 → 只记 anchor，不产生 attestation。
  it('keeps the anchor but skips the attestation when the city is empty', () => {
    const ledger = createTurnLedger();

    ledger.recordGeoResolution({ ...geocodeUnique(''), city: '   ' });

    expect(ledger.geo.anchors).toHaveLength(1);
    expect(ledger.geo.cityAttestation).toBeUndefined();
  });

  // 4-2：location_share（人在哪）强于 geocode_unique（查了哪），不由时序定胜负。
  it('keeps the location-share city when a later geocode resolves a different city', () => {
    const ledger = createTurnLedger();

    ledger.recordGeoResolution(locationShare);
    ledger.recordGeoResolution(geocodeUnique('北京市'));

    expect(ledger.geo.cityAttestation).toMatchObject({
      city: '上海市',
      source: 'location_share',
    });
    // anchor 是轮内工作集，两次解析都要留下（距离精度判定要用）
    expect(ledger.geo.anchors).toHaveLength(2);
  });

  it('still overwrites when the later geocode resolves the same city', () => {
    const ledger = createTurnLedger();

    ledger.recordGeoResolution(locationShare);
    ledger.recordGeoResolution({
      ...geocodeUnique('上海市'),
      evidence: 'geocode 唯一解析：上海市',
    });

    expect(ledger.geo.cityAttestation).toMatchObject({
      city: '上海市',
      evidence: 'geocode 唯一解析：上海市',
      source: 'geocode_unique',
    });
  });

  it('keeps last-write-wins for two geocode resolutions of different cities', () => {
    const ledger = createTurnLedger();

    ledger.recordGeoResolution(geocodeUnique('北京市'));
    ledger.recordGeoResolution(geocodeUnique('天津市'));

    expect(ledger.geo.cityAttestation).toMatchObject({
      city: '天津市',
      source: 'geocode_unique',
    });
  });

  it('lets a location share override an earlier geocode city', () => {
    const ledger = createTurnLedger();

    ledger.recordGeoResolution(geocodeUnique('北京市'));
    ledger.recordGeoResolution(locationShare);

    expect(ledger.geo.cityAttestation).toMatchObject({
      city: '上海市',
      source: 'location_share',
    });
  });
});

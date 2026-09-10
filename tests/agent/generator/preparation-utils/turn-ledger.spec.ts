import { resolveBrands } from '@resolution/brand/brand-matcher';
import type { BrandItem } from '@sponge/sponge.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import { finalizeVisualFactSheet } from '@resolution/signal/visual';
import { createToolContext, mergeToolContext } from '../../../helpers/tool-context.fixture';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';

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

const catalog: BrandItem[] = [
  { id: 1, name: '肯德基', aliases: ['KFC'] },
  { id: 2, name: '麦当劳', aliases: ['金拱门'] },
  { id: 3, name: 'M Stand', aliases: ['mstand'] },
  { id: 4, name: '瑞幸咖啡', aliases: ['瑞幸'] },
  { id: 5, name: '小龙坎', aliases: ['小龙'] },
  { id: 6, name: '小龙翻大江', aliases: ['小龙'] },
  { id: 7, name: '全家', aliases: [] },
];

function job(brandName: string, jobId = 1): RecommendedJobSummary {
  return { jobId, brandName } as RecommendedJobSummary;
}

describe('mentioned brands accumulated by the ledger', () => {
  it('normalizes returned aliases and retains earlier brands when latest jobs are replaced', () => {
    const ledger = createTurnLedger({ mentionedBrands: [], brandCatalog: catalog });
    ledger.recordFetchedJobs([job('KFC', 1)]);
    const firstSnapshot = ledger.drain();
    ledger.recordFetchedJobs([job('麦当劳', 2)]);
    expect(ledger.jobs.fetchedJobs).toEqual([job('麦当劳', 2)]);
    expect(ledger.mentionedBrands).toEqual(new Set(['肯德基', '麦当劳']));
    expect(firstSnapshot.mentionedBrands).toEqual(new Set(['肯德基']));
  });

  it('accumulates image resolutions including negative and ambiguous mentions', () => {
    const ledger = createTurnLedger({ mentionedBrands: [] });
    const resolutions = [
      ...resolveBrands('不要肯德基', 'image_description', catalog),
      ...resolveBrands('小龙', 'image_description', catalog),
    ];
    ledger.recordImageBrands(resolutions, { messageId: 'image-1' });
    expect(ledger.mentionedBrands).toEqual(new Set(['肯德基', '小龙坎', '小龙翻大江']));
    expect(ledger.visual.brandResolutions[0].resolutions).toEqual(resolutions);
  });

  it('finds a returned brand in jobName when brandName is absent', () => {
    const ledger = createTurnLedger({ mentionedBrands: [], brandCatalog: catalog });
    ledger.recordFetchedJobs([{ ...job(null), jobName: '肯德基-中心店-店员' }]);
    expect(ledger.mentionedBrands).toEqual(new Set(['肯德基']));
  });

  it('records current visual facts from either image or resume producers', () => {
    const ledger = createTurnLedger({ mentionedBrands: [], brandCatalog: catalog });
    ledger.recordVisualFacts(
      finalizeVisualFactSheet({ kind: 'resume', fields: [] }, '以前在肯德基工作'),
      { messageId: 'resume-1' },
    );
    expect(ledger.mentionedBrands).toEqual(new Set(['肯德基']));
  });

  it('accumulates newly recalled business text through the shared directory matcher', () => {
    const context = createToolContext({
      ledger: { mentionedBrands: new Set(), brandCatalog: catalog },
    });
    context.ledger.recordMentionedBrands(['历史摘要：之前在KFC上班，后来去了全家']);
    expect(context.ledger.mentionedBrands).toEqual(new Set(['肯德基', '全家']));
  });

  it('keeps an incomplete seed unknown after a successful tool result', () => {
    const ledger = createTurnLedger({ mentionedBrands: null, brandCatalog: catalog });
    ledger.recordFetchedJobs([job('KFC')]);
    expect(ledger.mentionedBrands).toBeNull();
    expect(ledger.drain().mentionedBrands).toBeNull();
  });

  it('preserves null versus empty sets in tool context overrides and merges', () => {
    const original = createToolContext({ ledger: { mentionedBrands: new Set(['肯德基']) } });
    expect(
      mergeToolContext(original, { ledger: { mentionedBrands: null } }).ledger.mentionedBrands,
    ).toBeNull();
    expect(
      mergeToolContext(original, { ledger: { mentionedBrands: new Set() } }).ledger.mentionedBrands,
    ).toEqual(new Set());
    expect(
      mergeToolContext(original, { ledger: { jobs: { jobListExecuted: true } } }).ledger
        .mentionedBrands,
    ).toEqual(new Set(['肯德基']));
  });
});

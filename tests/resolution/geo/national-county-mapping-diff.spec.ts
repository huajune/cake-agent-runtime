import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveParentAdministrativeArea } from '@resolution/geo';

type ResolutionLabel = string | 'unresolved';

interface CountyMappingDiffRow {
  input: string;
  disabled: ResolutionLabel;
  enabled: ResolutionLabel;
}

/**
 * 业务城市辖下、策展表未收录的县级市样本（曾是 DEFERRED_COUNTY_BACKFILL 的 23 条键）。
 *
 * 该登记表已于 2026-08-14 随观测结案下线（登记表与全国生成表重复、三周生产零命中，
 * 见 administrative-division.overrides.ts 注释），但这批输入作为**开关覆盖面样本**
 * 仍有价值：它们正是"关掉开关就 unresolved、打开就由全国生成表兜住"的那一档，
 * 是本 spec 锁定开关语义的主证据。故就地固化为字面量，不再依赖已下线的表。
 */
const NATIONAL_TABLE_COVERED_COUNTIES = [
  '余姚市',
  '慈溪市',
  '太仓市',
  '常熟市',
  '张家港市',
  '胶州市',
  '莱西市',
  '平度市',
  '宜都市',
  '当阳市',
  '枝江市',
  '松滋市',
  '洪湖市',
  '石首市',
  '监利市',
  '麻城市',
  '武穴市',
  '新民市',
  '枣阳市',
  '宜城市',
  '老河口市',
  '瑞金市',
  '龙南市',
] as const;
const CURATED_BASELINES = ['昆山市', '延吉市'] as const;
const NATIONAL_ONLY_SAMPLE = ['义乌市'] as const;
const NEGATIVE_CONTROLS = ['上海市', '火星市'] as const;
const INPUTS = [
  ...NATIONAL_TABLE_COVERED_COUNTIES,
  ...CURATED_BASELINES,
  ...NATIONAL_ONLY_SAMPLE,
  ...NEGATIVE_CONTROLS,
];
/** 对照表住在地理域现状文档的「开放项 · 全国映射开关」小节（原独立报告已并入）。 */
const REPORT_PATH = join(__dirname, '../../../docs/architecture/geo-resolution.md');

function resolveBatch(enabled: boolean): Map<string, ResolutionLabel> {
  const previous = process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED;
  try {
    if (enabled) {
      process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED = 'true';
    } else {
      delete process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED;
    }
    return new Map(
      INPUTS.map((input) => [
        input,
        resolveParentAdministrativeArea(input)?.parentCity ?? 'unresolved',
      ]),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED;
    } else {
      process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED = previous;
    }
  }
}

function buildDiffRows(): CountyMappingDiffRow[] {
  const disabled = resolveBatch(false);
  const enabled = resolveBatch(true);
  return INPUTS.map((input) => ({
    input,
    disabled: disabled.get(input) ?? 'unresolved',
    enabled: enabled.get(input) ?? 'unresolved',
  }));
}

describe('全国县级市映射开关对照（报告证据，不修改默认开关）', () => {
  it('23 个策展表未收录县级市均从 unresolved 转为全国表父级命中', () => {
    const rows = buildDiffRows();
    for (const input of NATIONAL_TABLE_COVERED_COUNTIES) {
      expect(rows.find((row) => row.input === input)).toEqual({
        input,
        disabled: 'unresolved',
        enabled: expect.not.stringMatching(/^unresolved$/),
      });
    }
  });

  it('策展表保持优先，普通地级市与未知值仍不猜父级', () => {
    const rows = buildDiffRows();
    expect(rows.find((row) => row.input === '昆山市')).toEqual({
      input: '昆山市',
      disabled: '苏州市',
      enabled: '苏州市',
    });
    expect(rows.find((row) => row.input === '延吉市')).toEqual({
      input: '延吉市',
      disabled: '延边朝鲜族自治州',
      enabled: '延边朝鲜族自治州',
    });
    expect(rows.find((row) => row.input === '义乌市')).toEqual({
      input: '义乌市',
      disabled: 'unresolved',
      enabled: '金华市',
    });
    for (const input of NEGATIVE_CONTROLS) {
      expect(rows.find((row) => row.input === input)).toEqual({
        input,
        disabled: 'unresolved',
        enabled: 'unresolved',
      });
    }
  });

  it('对照报告逐行覆盖本 spec 的同一批输入与结果', () => {
    const report = readFileSync(REPORT_PATH, 'utf8');
    for (const row of buildDiffRows()) {
      expect(report).toContain(`| ${row.input} | ${row.disabled} | ${row.enabled} |`);
    }
  });
});

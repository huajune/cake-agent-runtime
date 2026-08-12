import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveParentAdministrativeArea } from '@resolution/geo';
import { DEFERRED_COUNTY_BACKFILL } from '@resolution/geo/administrative-division.overrides';

type ResolutionLabel = string | 'unresolved';

interface CountyMappingDiffRow {
  input: string;
  disabled: ResolutionLabel;
  enabled: ResolutionLabel;
}

const CURATED_BASELINES = ['昆山市', '延吉市'] as const;
const NATIONAL_ONLY_SAMPLE = ['义乌市'] as const;
const NEGATIVE_CONTROLS = ['上海市', '火星市'] as const;
const INPUTS = [
  ...DEFERRED_COUNTY_BACKFILL.keys(),
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
  it('23 个待补录县级市均从 unresolved 转为全国表父级命中', () => {
    const rows = buildDiffRows();
    for (const input of DEFERRED_COUNTY_BACKFILL.keys()) {
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

/**
 * 全国县级市 → 地级行政区映射生成器（docs/architecture/geo-resolution.md §5.2）。
 *
 * 输入：scripts/geo/data/{cities,areas}.json（china-division 数据集 vendored 快照，
 *       来源与版本见同目录 README.md）。
 * 输出：src/resolution/geo/administrative-division.generated.ts（全量覆写）。
 *
 * 生成规则：
 * - 取 areas.json 中 name 以"市"结尾的县级行政区（县级市）；
 * - 父级取 cities.json 同 cityCode 的名称；父级必须是真实地级行政区
 *   （名称以 市/州/盟/地区 结尾）——"省直辖县级行政区划"等伪父级条目跳过
 *   （仙桃/济源/兵团市等在检索口径下本身即城市级，转换反而有害）；
 * - 键按 Unicode 码点排序，输出确定性可复现（不含时间戳，便于 CI 漂移比对）。
 *
 * 产物只接受本脚本再生成，不接受手改（geo:validate 做漂移校验）。
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface CityRecord {
  code: string;
  name: string;
  provinceCode: string;
}

interface AreaRecord {
  code: string;
  name: string;
  cityCode: string;
  provinceCode: string;
}

const DATA_DIR = join(__dirname, 'data');
const OUTPUT_PATH = join(
  __dirname,
  '../../src/resolution/geo/administrative-division.generated.ts',
);

const REAL_PREFECTURE_SUFFIXES = ['市', '州', '盟', '地区'];

export interface GeneratedMappingResult {
  mapping: Record<string, string>;
  skipped: Array<{ name: string; pseudoParent: string }>;
  citiesSha256: string;
  areasSha256: string;
}

/** 从 vendored 数据集计算全国县级市映射（validate 脚本复用同一函数做漂移比对）。 */
export function buildNationalCountyMapping(): GeneratedMappingResult {
  const citiesRaw = readFileSync(join(DATA_DIR, 'cities.json'));
  const areasRaw = readFileSync(join(DATA_DIR, 'areas.json'));
  const cities = JSON.parse(citiesRaw.toString()) as CityRecord[];
  const areas = JSON.parse(areasRaw.toString()) as AreaRecord[];

  const cityNameByCode = new Map(cities.map((city) => [city.code, city.name]));
  const mapping: Record<string, string> = {};
  const skipped: Array<{ name: string; pseudoParent: string }> = [];

  const countyLevelCities = areas
    .filter((area) => area.name.endsWith('市'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const area of countyLevelCities) {
    const parent = cityNameByCode.get(area.cityCode) ?? '';
    const isRealPrefecture = REAL_PREFECTURE_SUFFIXES.some((suffix) => parent.endsWith(suffix));
    if (!isRealPrefecture || parent === '市辖区') {
      skipped.push({ name: area.name, pseudoParent: parent });
      continue;
    }
    mapping[area.name] = parent;
  }

  return {
    mapping,
    skipped,
    citiesSha256: createHash('sha256').update(citiesRaw).digest('hex'),
    areasSha256: createHash('sha256').update(areasRaw).digest('hex'),
  };
}

function renderGeneratedModule(result: GeneratedMappingResult): string {
  const entries = Object.entries(result.mapping)
    .map(([county, prefecture]) => `  ${county}: '${prefecture}',`)
    .join('\n');
  const skippedLines = result.skipped
    .map((item) => ` *   - ${item.name}（${item.pseudoParent}）`)
    .join('\n');

  return `/**
 * 全国县级市 → 地级行政区映射（脚本生成，禁止手改）。
 *
 * 生成器：scripts/geo/generate-administrative-divisions.ts（pnpm run geo:generate）
 * 数据集：china-division dist/cities.json + dist/areas.json（vendored 快照，
 *   来源/版本/获取日期见 scripts/geo/data/README.md）
 *   cities.json sha256: ${result.citiesSha256}
 *   areas.json  sha256: ${result.areasSha256}
 * 条目数：${Object.keys(result.mapping).length}（县级市总数 ${
   Object.keys(result.mapping).length + result.skipped.length
 }，跳过省/自治区直辖县级市 ${result.skipped.length} 条——它们在检索口径下本身即城市级）：
${skippedLines}
 *
 * 运行时消费（§17.2 灰度）：resolveParentAdministrativeArea 仅在
 * GEO_NATIONAL_COUNTY_MAPPING_ENABLED=true 时回退查询本表；人工策展表
 * COUNTY_LEVEL_CITY_TO_PREFECTURE 始终优先。校验（含与策展表一致性、
 * 与数据集漂移比对）见 pnpm run geo:validate。
 */

/* eslint-disable */
// prettier-ignore
export const NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE: Record<string, string> = {
${entries}
};
`;
}

function main(): void {
  const result = buildNationalCountyMapping();
  writeFileSync(OUTPUT_PATH, renderGeneratedModule(result));
  // eslint-disable-next-line no-console
  console.log(
    `generated ${Object.keys(result.mapping).length} entries (skipped ${result.skipped.length}) -> ${OUTPUT_PATH}`,
  );
}

if (require.main === module) {
  main();
}

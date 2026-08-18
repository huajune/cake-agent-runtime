/**
 * 行政区数据校验（docs/architecture/geo-resolution.md §5.3，进 CI：pnpm run geo:validate）。
 *
 * 检查项：
 *  1. 手工数据表源文件无字面量重复键（对象字面量重复键会静默覆盖，运行时不可见）；
 *  2. 区名表与地标表无同键异城冲突；
 *  3. 策展县级市表形状（键以"市"结尾、父级非空、不自映射）；
 *  4. 生成表与 vendored 数据集零漂移（手改生成产物 / 改数据集不再生成，都在此失败）；
 *  5. 策展县级市表与全国生成表父级一致（供应商口径差异须走 VENDOR_NAME_OVERRIDES 登记）；
 *  6. 区名表键的全国唯一性：对照 areas.json，跨城重名键必须在
 *     BUSINESS_BIASED_SUBDIVISION_ALIASES 登记（业务偏置显式化，防静默误判）；
 *  7. 脏别名排除表守门：DIRTY_ALIAS_EXCLUSIONS 登记的键不得出现在区名表/地标表
 *     （跨层级同形与泛词，areas.json 只到区县级看不见，靠人工登记 + 本项防回填）；
 *  8. **地标表键的全国唯一性**（2026-08-14 新增）：地标表命中会直接判定城市，
 *     此前却只有区名表受检查项 6 保护，跨城重名地标可以静默混入（「襄城」即例）。
 *     本项把同一把尺子量到 UNIQUE_PLACE_ALIAS_TO_CITY 上，豁免口径与检查项 6 一致。
 *
 * 已下线：原检查项 7「余姚防线」（DEFERRED_COUNTY_BACKFILL 登记）——登记表与全国
 * 生成表重复、三周生产零命中，2026-08-14 连同登记表一并移除，见 overrides.ts 注释。
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  COUNTY_LEVEL_CITY_TO_PREFECTURE,
  UNIQUE_SUBDIVISION_TO_CITY,
} from '../../src/resolution/geo/administrative-division.data';
import { NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE } from '../../src/resolution/geo/administrative-division.generated';
import {
  BUSINESS_BIASED_SUBDIVISION_ALIASES,
  DIRTY_ALIAS_EXCLUSIONS,
  VENDOR_NAME_OVERRIDES,
} from '../../src/resolution/geo/administrative-division.overrides';
import { UNIQUE_PLACE_ALIAS_TO_CITY } from '../../src/resolution/geo/place-alias.data';
import {
  normalizeDistrictForLookup,
  normalizeCityName,
} from '../../src/resolution/geo/geo-name.normalizer';
import { buildNationalCountyMapping } from './generate-administrative-divisions';

interface AreaRecord {
  code: string;
  name: string;
  cityCode: string;
}

const errors: string[] = [];
const geoDir = join(__dirname, '../../src/resolution/geo');

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

// 1. 字面量重复键（解析源文件 key 行数 vs 运行时对象键数）
function checkLiteralDuplicateKeys(file: string, objectName: string, runtime: object): void {
  const source = readFileSync(join(geoDir, file), 'utf8');
  const body = source.split(`${objectName}`)[1] ?? '';
  const section = body.split('};')[0] ?? '';
  const literalKeys = [...section.matchAll(/^\s{2}([一-龥A-Za-z]+):\s*'/gm)].map(
    (match) => match[1],
  );
  const spreadFree = literalKeys.length;
  const runtimeCount = Object.keys(runtime).length;
  check(
    spreadFree <= runtimeCount,
    `${file} ${objectName}: 源文件字面量键 ${spreadFree} 个 > 运行时键 ${runtimeCount} 个——存在重复键被静默覆盖`,
  );
  const seen = new Set<string>();
  for (const key of literalKeys) {
    check(!seen.has(key), `${file} ${objectName}: 字面量重复键「${key}」`);
    seen.add(key);
  }
}
checkLiteralDuplicateKeys(
  'administrative-division.data.ts',
  'UNIQUE_SUBDIVISION_TO_CITY',
  UNIQUE_SUBDIVISION_TO_CITY,
);
checkLiteralDuplicateKeys(
  'place-alias.data.ts',
  'UNIQUE_PLACE_ALIAS_TO_CITY',
  UNIQUE_PLACE_ALIAS_TO_CITY,
);

// 2. 区名表 × 地标表同键异城
for (const [key, city] of Object.entries(UNIQUE_PLACE_ALIAS_TO_CITY)) {
  const subdivisionCity = UNIQUE_SUBDIVISION_TO_CITY[key];
  check(
    !subdivisionCity || subdivisionCity === city,
    `同键异城：「${key}」区名表→${subdivisionCity}，地标表→${city}`,
  );
}

// 3. 策展县级市表形状
for (const [county, prefecture] of Object.entries(COUNTY_LEVEL_CITY_TO_PREFECTURE)) {
  check(county.endsWith('市'), `策展县级市表键「${county}」未以"市"结尾`);
  check(prefecture.trim().length > 0, `策展县级市表「${county}」父级为空`);
  check(county !== prefecture, `策展县级市表「${county}」自映射`);
}

// 4. 生成表与数据集零漂移
const rebuilt = buildNationalCountyMapping();
const generatedEntries = Object.entries(NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE);
check(
  generatedEntries.length === Object.keys(rebuilt.mapping).length,
  `生成表漂移：提交产物 ${generatedEntries.length} 条，按数据集重算 ${Object.keys(rebuilt.mapping).length} 条——请 pnpm run geo:generate`,
);
for (const [county, prefecture] of generatedEntries) {
  check(
    rebuilt.mapping[county] === prefecture,
    `生成表漂移：「${county}」提交产物→${prefecture}，重算→${rebuilt.mapping[county] ?? '(无)'}——请 pnpm run geo:generate`,
  );
}

// 5. 策展表 × 生成表父级一致（供应商差异须登记）
for (const [county, prefecture] of Object.entries(COUNTY_LEVEL_CITY_TO_PREFECTURE)) {
  const national = NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE[county];
  if (!national) continue;
  const consistent =
    normalizeCityName(national) === normalizeCityName(prefecture) ||
    VENDOR_NAME_OVERRIDES.get(county) === prefecture;
  check(
    consistent,
    `策展/生成父级不一致：「${county}」策展→${prefecture}，国家数据→${national}（供应商口径差异请登记 VENDOR_NAME_OVERRIDES）`,
  );
}

// 6. 区名表键全国唯一性（跨城重名必须登记业务偏置）
const areas = JSON.parse(readFileSync(join(__dirname, 'data/areas.json'), 'utf8')) as AreaRecord[];
const cities = JSON.parse(readFileSync(join(__dirname, 'data/cities.json'), 'utf8')) as Array<{
  code: string;
  name: string;
}>;
const cityNameByCode = new Map(cities.map((city) => [city.code, city.name]));
for (const key of Object.keys(UNIQUE_SUBDIVISION_TO_CITY)) {
  // 按 cityCode 而非城市名去重：直辖市在 cities.json 里名字统一是"市辖区"，
  // 若按名字去重，两个直辖市共享同一区名会塌缩成 1 个、让跨城重名静默过关。
  // （当前数据集实算 0 例，属防御性加固；城市名仅用于报错可读性。）
  const parentCityCodes = new Set<string>();
  const parentCityNames = new Set<string>();
  for (const area of areas) {
    if (area.name === key || normalizeDistrictForLookup(area.name) === key) {
      parentCityCodes.add(area.cityCode);
      parentCityNames.add(cityNameByCode.get(area.cityCode) ?? area.cityCode);
    }
  }
  check(
    parentCityCodes.size <= 1 || BUSINESS_BIASED_SUBDIVISION_ALIASES.has(key),
    `区名「${key}」全国跨城重名（${[...parentCityNames].join('/')}）但未登记 BUSINESS_BIASED_SUBDIVISION_ALIASES`,
  );
}
for (const key of BUSINESS_BIASED_SUBDIVISION_ALIASES) {
  check(
    key in UNIQUE_SUBDIVISION_TO_CITY,
    `BUSINESS_BIASED_SUBDIVISION_ALIASES 登记了不存在的键「${key}」`,
  );
}

// 7. 脏别名排除表守门：登记为"刻意不收"的键不得被回填进区名表/地标表
for (const [alias, reason] of DIRTY_ALIAS_EXCLUSIONS) {
  check(
    !(alias in UNIQUE_SUBDIVISION_TO_CITY),
    `脏别名「${alias}」已登记 DIRTY_ALIAS_EXCLUSIONS（刻意不收）但出现在 UNIQUE_SUBDIVISION_TO_CITY：${reason}`,
  );
  check(
    !(alias in UNIQUE_PLACE_ALIAS_TO_CITY),
    `脏别名「${alias}」已登记 DIRTY_ALIAS_EXCLUSIONS（刻意不收）但出现在 UNIQUE_PLACE_ALIAS_TO_CITY：${reason}`,
  );
}

// 8. 地标表键全国唯一性（与检查项 6 同一把尺子，2026-08-14 补齐）
//
// 地标表命中即判定城市（evidence=hotspot_alias），危害与区名表同级，此前却无机械守门：
// 「襄城」同时是许昌襄城县与襄阳襄城区，只因它恰好也在区名表里才被检查项 6 拦下。
// 只存在于地标表的跨城重名（如商圈名撞外地区名）此前可以静默混入。
// 注：areas.json 只到区县级，纯商圈/通名（国贸/世纪公园/九方）本项看不见，
// 那一类仍靠 DIRTY_ALIAS_EXCLUSIONS 人工登记 + 检查项 7 防回填。
for (const key of Object.keys(UNIQUE_PLACE_ALIAS_TO_CITY)) {
  const parentCityCodes = new Set<string>();
  const parentCityNames = new Set<string>();
  for (const area of areas) {
    if (area.name === key || normalizeDistrictForLookup(area.name) === key) {
      parentCityCodes.add(area.cityCode);
      parentCityNames.add(cityNameByCode.get(area.cityCode) ?? area.cityCode);
    }
  }
  check(
    parentCityCodes.size <= 1 || BUSINESS_BIASED_SUBDIVISION_ALIASES.has(key),
    `地标「${key}」与全国跨城重名行政区同名（${[...parentCityNames].join('/')}）但未登记 BUSINESS_BIASED_SUBDIVISION_ALIASES——地标表命中会直接判定城市，须显式化业务偏置或移入 DIRTY_ALIAS_EXCLUSIONS`,
  );
}

if (errors.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`geo:validate 失败（${errors.length} 项）：`);
  for (const error of errors) {
    // eslint-disable-next-line no-console
    console.error(`  - ${error}`);
  }
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log('geo:validate 通过（8 类检查全绿）');

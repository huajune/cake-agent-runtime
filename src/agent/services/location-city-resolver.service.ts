import { Injectable } from '@nestjs/common';
import type { EntityExtractionResult } from '@memory/types/session-facts.types';

export type ResolvedCityEvidence =
  | 'municipality_compact'
  | 'explicit_city'
  | 'unique_district_alias'
  | 'hotspot_alias'
  | 'memory_carry_over'
  | 'conflict'
  | 'unknown';

export interface ResolvedCity {
  city: string | null;
  confidence: 'high' | 'low';
  evidence: ResolvedCityEvidence;
}

export interface ResolveCityParams {
  currentMessageContent: string;
  sessionFacts?: EntityExtractionResult | null;
  highConfidenceFacts?: EntityExtractionResult | null;
}

interface DirectResolvedCityCandidate {
  city: string;
  evidence: Extract<ResolvedCityEvidence, 'unique_district_alias' | 'hotspot_alias'>;
}

const HIGH_CONFIDENCE_DISTRICT_TO_CITY: Record<string, string> = {
  // 北京
  东城: '北京',
  西城: '北京',
  朝阳: '北京',
  海淀: '北京',
  丰台: '北京',
  石景山: '北京',
  门头沟: '北京',
  房山: '北京',
  通州: '北京',
  顺义: '北京',
  昌平: '北京',
  大兴: '北京',
  怀柔: '北京',
  平谷: '北京',
  密云: '北京',
  延庆: '北京',
  // 上海
  黄浦: '上海',
  徐汇: '上海',
  长宁: '上海',
  静安: '上海',
  普陀: '上海',
  虹口: '上海',
  杨浦: '上海',
  浦东: '上海',
  浦东新区: '上海',
  闵行: '上海',
  宝山: '上海',
  嘉定: '上海',
  金山: '上海',
  松江: '上海',
  青浦: '上海',
  奉贤: '上海',
  崇明: '上海',
  // 武汉
  江岸: '武汉',
  江汉: '武汉',
  硚口: '武汉',
  汉阳: '武汉',
  武昌: '武汉',
  青山: '武汉',
  洪山: '武汉',
  东西湖: '武汉',
  汉南: '武汉',
  蔡甸: '武汉',
  江夏: '武汉',
  黄陂: '武汉',
  新洲: '武汉',
  东湖高新区: '武汉',
  光谷: '武汉',
  // 宁波
  海曙: '宁波',
  江北: '宁波',
  镇海: '宁波',
  北仑: '宁波',
  鄞州: '宁波',
  奉化: '宁波',
  余姚: '宁波',
  慈溪: '宁波',
  宁海: '宁波',
  象山: '宁波',
  // 南昌
  东湖: '南昌',
  西湖: '南昌',
  青云谱: '南昌',
  青山湖: '南昌',
  新建: '南昌',
  红谷滩: '南昌',
  南昌县: '南昌',
  南昌: '南昌',
  安义: '南昌',
  进贤: '南昌',
  湾里: '南昌',
  // 宜昌
  西陵: '宜昌',
  伍家岗: '宜昌',
  点军: '宜昌',
  猇亭: '宜昌',
  夷陵: '宜昌',
  宜都: '宜昌',
  当阳: '宜昌',
  枝江: '宜昌',
  远安: '宜昌',
  兴山: '宜昌',
  秭归: '宜昌',
  长阳: '宜昌',
  五峰: '宜昌',
  // 荆州
  荆州: '荆州',
  沙市: '荆州',
  公安: '荆州',
  石首: '荆州',
  洪湖: '荆州',
  松滋: '荆州',
  监利: '荆州',
  江陵: '荆州',
  // 黄冈
  黄州: '黄冈',
  团风: '黄冈',
  红安: '黄冈',
  麻城: '黄冈',
  罗田: '黄冈',
  英山: '黄冈',
  浠水: '黄冈',
  蕲春: '黄冈',
  黄梅: '黄冈',
  武穴: '黄冈',
  // 襄阳
  襄城: '襄阳',
  樊城: '襄阳',
  襄州: '襄阳',
  南漳: '襄阳',
  谷城: '襄阳',
  保康: '襄阳',
  老河口: '襄阳',
  枣阳: '襄阳',
  宜城: '襄阳',
  // 赣州
  章贡: '赣州',
  南康: '赣州',
  赣县: '赣州',
  信丰: '赣州',
  大余: '赣州',
  上犹: '赣州',
  崇义: '赣州',
  安远: '赣州',
  定南: '赣州',
  全南: '赣州',
  宁都: '赣州',
  于都: '赣州',
  兴国: '赣州',
  会昌: '赣州',
  寻乌: '赣州',
  石城: '赣州',
  瑞金: '赣州',
  龙南: '赣州',
  // 恩施
  恩施: '恩施',
  利川: '恩施',
  建始: '恩施',
  巴东: '恩施',
  宣恩: '恩施',
  咸丰: '恩施',
  来凤: '恩施',
  鹤峰: '恩施',
};

const MUNICIPALITIES = ['北京', '上海'];
const SUPPORTED_CITY_PREFIXES = [
  '北京',
  '上海',
  '武汉',
  '宁波',
  '恩施',
  '宜昌',
  '荆州',
  '黄冈',
  '襄阳',
  '南昌',
  '赣州',
  '江西',
];
const HIGH_CONFIDENCE_LOCATION_TO_CITY: Record<string, string> = {
  // 上海
  陆家嘴: '上海',
  徐家汇: '上海',
  五角场: '上海',
  张江: '上海',
  九亭: '上海',
  七宝: '上海',
  莘庄: '上海',
  虹桥火车站: '上海',
  世纪公园: '上海',
  迪士尼: '上海',
  临港: '上海',
  外滩: '上海',
  // 武汉
  光谷: '武汉',
  江汉路: '武汉',
  楚河汉街: '武汉',
  街道口: '武汉',
  王家湾: '武汉',
  徐东: '武汉',
  藏龙岛: '武汉',
  沌口: '武汉',
  武广: '武汉',
  汉口火车站: '武汉',
  武昌火车站: '武汉',
  武汉天地: '武汉',
  // 宁波
  天一广场: '宁波',
  南塘老街: '宁波',
  东部新城: '宁波',
  老外滩: '宁波',
  东钱湖: '宁波',
  宁波大学: '宁波',
  宁波站: '宁波',
  // 北京
  望京: '北京',
  中关村: '北京',
  西二旗: '北京',
  三里屯: '北京',
  回龙观: '北京',
  天通苑: '北京',
  亦庄: '北京',
  五道口: '北京',
  后厂村: '北京',
  国贸: '北京',
  亦庄开发区: '北京',
  // 南昌
  红谷滩: '南昌',
  八一广场: '南昌',
  瑶湖: '南昌',
  秋水广场: '南昌',
  万寿宫: '南昌',
  滕王阁: '南昌',
  // 恩施
  女儿城: '恩施',
  土司城: '恩施',
  恩施广场: '恩施',
  // 宜昌
  夷陵广场: '宜昌',
  水悦城: '宜昌',
  万达广场宜昌: '宜昌',
  宜昌东站: '宜昌',
  // 荆州
  沙市: '荆州',
  吾悦广场荆州: '荆州',
  荆州万达: '荆州',
  // 黄冈
  黄州: '黄冈',
  遗爱湖: '黄冈',
  黄冈万达: '黄冈',
  // 襄阳
  襄城: '襄阳',
  樊城: '襄阳',
  唐城: '襄阳',
  襄阳东站: '襄阳',
  // 赣州
  南门口: '赣州',
  万象城赣州: '赣州',
  九方: '赣州',
  郁孤台: '赣州',
};

@Injectable()
export class LocationCityResolverService {
  resolve({
    currentMessageContent,
    sessionFacts,
    highConfidenceFacts,
  }: ResolveCityParams): ResolvedCity | null {
    const message = currentMessageContent.trim();
    if (!message) return null;

    const compact = this.extractMunicipalityCompactCity(message);
    if (compact) {
      return {
        city: compact,
        confidence: 'high',
        evidence: 'municipality_compact',
      };
    }

    const explicitCity = this.extractExplicitCity(message);
    if (explicitCity) {
      return {
        city: explicitCity,
        confidence: 'high',
        evidence: 'explicit_city',
      };
    }

    const sessionCity = this.normalizeCity(sessionFacts?.preferences?.city);
    const directCandidate = this.resolveCityFromNormalizedCandidate(message);
    if (directCandidate) {
      if (sessionCity && sessionCity !== directCandidate.city) {
        return { city: null, confidence: 'low', evidence: 'conflict' };
      }
      return {
        city: directCandidate.city,
        confidence: 'high',
        evidence: directCandidate.evidence,
      };
    }

    const highConfidenceCity = this.normalizeCity(highConfidenceFacts?.preferences?.city);
    if (highConfidenceCity) {
      if (sessionCity && sessionCity !== highConfidenceCity) {
        return { city: null, confidence: 'low', evidence: 'conflict' };
      }
      return {
        city: highConfidenceCity,
        confidence: 'high',
        evidence: 'explicit_city',
      };
    }

    const inferredCity = this.resolveCityFromDistricts(highConfidenceFacts?.preferences?.district);
    if (inferredCity) {
      if (sessionCity && sessionCity !== inferredCity) {
        return { city: null, confidence: 'low', evidence: 'conflict' };
      }
      return {
        city: inferredCity,
        confidence: 'high',
        evidence: 'unique_district_alias',
      };
    }

    const hotspotCity = this.resolveCityFromLocations(highConfidenceFacts?.preferences?.location);
    if (hotspotCity) {
      if (sessionCity && sessionCity !== hotspotCity) {
        return { city: null, confidence: 'low', evidence: 'conflict' };
      }
      return {
        city: hotspotCity,
        confidence: 'high',
        evidence: 'hotspot_alias',
      };
    }

    const hasCurrentLocationHints =
      this.normalizeStringArray(highConfidenceFacts?.preferences?.district).length > 0 ||
      this.normalizeStringArray(highConfidenceFacts?.preferences?.location).length > 0;

    if (sessionCity && hasCurrentLocationHints) {
      return {
        city: sessionCity,
        confidence: 'high',
        evidence: 'memory_carry_over',
      };
    }

    return null;
  }

  private resolveCityFromNormalizedCandidate(message: string): DirectResolvedCityCandidate | null {
    const candidate = this.normalizeLocationCandidate(message);
    if (!candidate) return null;

    const districtCity = this.resolveCityFromDistricts([candidate]);
    if (districtCity) {
      return {
        city: districtCity,
        evidence: 'unique_district_alias',
      };
    }

    const hotspotCity = this.resolveCityFromLocations([candidate]);
    if (hotspotCity) {
      return {
        city: hotspotCity,
        evidence: 'hotspot_alias',
      };
    }

    return null;
  }

  private extractMunicipalityCompactCity(message: string): string | null {
    const normalized = message.replace(/\s+/g, '');
    const firstSegment = normalized.split(/[，,。；;]/)[0] ?? normalized;

    for (const city of MUNICIPALITIES) {
      if (!firstSegment.startsWith(city)) continue;
      return city;
    }

    return null;
  }

  private extractExplicitCity(message: string): string | null {
    const normalized = message.replace(/\s+/g, '');
    const firstSegment = normalized.split(/[，,。；;]/)[0] ?? normalized;

    for (const city of SUPPORTED_CITY_PREFIXES) {
      if (firstSegment.startsWith(city)) return city;
    }

    const municipalityMatch = message.match(/(北京|上海|天津|重庆)(?:市)?/);
    if (municipalityMatch) return municipalityMatch[1];

    const genericCityMatch = message.match(/([\u4e00-\u9fa5]{2,8})市/);
    if (genericCityMatch?.[1]) return genericCityMatch[1];

    return null;
  }

  private resolveCityFromDistricts(districts: string[] | null | undefined): string | null {
    for (const district of this.normalizeStringArray(districts)) {
      const normalizedDistrict = district.replace(/[区县镇乡]$/, '');
      const city =
        HIGH_CONFIDENCE_DISTRICT_TO_CITY[district] ??
        HIGH_CONFIDENCE_DISTRICT_TO_CITY[normalizedDistrict];
      if (city) return city;
    }

    return null;
  }

  private resolveCityFromLocations(locations: string[] | null | undefined): string | null {
    for (const location of this.normalizeStringArray(locations)) {
      const normalizedLocation = location.replace(/\s+/g, '');
      const city =
        HIGH_CONFIDENCE_LOCATION_TO_CITY[location] ??
        HIGH_CONFIDENCE_LOCATION_TO_CITY[normalizedLocation];
      if (city) return city;
    }

    return null;
  }

  private normalizeCity(value: string | null | undefined): string | null {
    if (!value) return null;
    const normalized = value.trim().replace(/市$/, '');
    return normalized || null;
  }

  private normalizeLocationCandidate(message: string): string {
    return message
      .replace(/\s+/g, '')
      .split(/[，,。；;]/)[0]
      .replace(/^(我在|人在|在|住在)/, '')
      .replace(/(有店招吗|有岗位吗|有店吗|有没有|有吗|招吗|在招吗|行吗|呢|呀|哈|吧)$/g, '')
      .replace(/(附近|旁边|这边|那边|周边)$/g, '')
      .replace(/(找工作|工作|岗位|门店|店招)$/g, '')
      .trim();
  }

  private normalizeStringArray(values: string[] | null | undefined): string[] {
    if (!values?.length) return [];
    return Array.from(
      new Set(
        values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
      ),
    );
  }
}

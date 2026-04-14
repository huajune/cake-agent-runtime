export const SPONGE_EDUCATION_MAPPING: Record<number, string> = {
  1: '不限',
  2: '本科',
  3: '大专',
  4: '高中',
  5: '初中',
  6: '硕士',
  7: '博士',
  8: '中专技校职高',
  9: '初中以下',
  10: '高职',
};

export const SPONGE_COLLECTABLE_EDUCATION_MAPPING: Record<number, string> = Object.fromEntries(
  Object.entries(SPONGE_EDUCATION_MAPPING).filter(([id]) => Number(id) !== 1),
) as Record<number, string>;

export const SPONGE_PROVINCE_MAPPING: Record<number, string> = {
  110000: '北京市',
  120000: '天津市',
  130000: '河北省',
  140000: '山西省',
  150000: '内蒙古自治区',
  210000: '辽宁省',
  220000: '吉林省',
  230000: '黑龙江省',
  310000: '上海市',
  320000: '江苏省',
  330000: '浙江省',
  340000: '安徽省',
  350000: '福建省',
  360000: '江西省',
  370000: '山东省',
  410000: '河南省',
  420000: '湖北省',
  430000: '湖南省',
  440000: '广东省',
  450000: '广西壮族自治区',
  460000: '海南省',
  500000: '重庆市',
  510000: '四川省',
  520000: '贵州省',
  530000: '云南省',
  540000: '西藏自治区',
  610000: '陕西省',
  620000: '甘肃省',
  630000: '青海省',
  640000: '宁夏回族自治区',
  650000: '新疆维吾尔自治区',
  710000: '台湾省',
  810000: '香港特别行政区',
  820000: '澳门特别行政区',
};

export const SPONGE_GENDER_MAPPING: Record<number, string> = {
  1: '男',
  2: '女',
};

export const SPONGE_HEALTH_CERTIFICATE_MAPPING: Record<number, string> = {
  1: '有',
  2: '无但接受办理健康证',
  3: '无且不接受办理健康证',
};

export const SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING: Record<number, string> = {
  1: '食品健康证',
  2: '零售健康证',
  3: '其他健康证',
};

export const SPONGE_OPERATE_TYPE_AI_IMPORT = 6;

export const SPONGE_OPERATE_TYPE_MAPPING: Record<number, string> = {
  1: '用户名单-新建用户名单',
  2: '用户名单页-批量导入',
  3: '在招岗位-列表里预约面试按钮',
  4: '岗位详情页-预约面试按钮',
  5: '在招岗位-条件匹配列表页',
  6: 'ai导入',
};

const SPONGE_EDUCATION_NAME_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(SPONGE_EDUCATION_MAPPING).map(([id, name]) => [name, Number(id)]),
);

const PROVINCE_SUFFIX_PATTERN = /(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/;

function normalizeProvinceName(name: string): string {
  return name.trim().replace(PROVINCE_SUFFIX_PATTERN, '');
}

export function getAvailableSpongeEducations(): string[] {
  return Object.values(SPONGE_COLLECTABLE_EDUCATION_MAPPING);
}

export function getAvailableSpongeProvinces(): string[] {
  return Object.values(SPONGE_PROVINCE_MAPPING);
}

export function findSpongeEducationIdByLabel(label: string): number | null {
  return SPONGE_EDUCATION_NAME_TO_ID[label] ?? null;
}

export function getSpongeEducationLabelById(id: number): string | null {
  return SPONGE_EDUCATION_MAPPING[id] ?? null;
}

export function getSpongeProvinceNameById(id: number): string | null {
  return SPONGE_PROVINCE_MAPPING[id] ?? null;
}

export function findSpongeProvinceIdByName(name: string): number | null {
  const normalized = normalizeProvinceName(name);
  for (const [id, label] of Object.entries(SPONGE_PROVINCE_MAPPING)) {
    if (label === name || normalizeProvinceName(label) === normalized) {
      return Number(id);
    }
  }
  return null;
}

export function getSpongeGenderLabelById(id: number): string | null {
  return SPONGE_GENDER_MAPPING[id] ?? null;
}

export function getSpongeHealthCertificateLabelById(id: number): string | null {
  return SPONGE_HEALTH_CERTIFICATE_MAPPING[id] ?? null;
}

export function getSpongeHealthCertificateTypeLabels(ids?: number[]): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING[id]).filter(Boolean);
}

export function getSpongeOperateTypeLabelById(id: number): string | null {
  return SPONGE_OPERATE_TYPE_MAPPING[id] ?? null;
}

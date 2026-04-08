export const API_BOOKING_SUBMISSION_FIELDS = [
  '姓名',
  '联系电话',
  '性别',
  '年龄',
  '面试时间',
  '学历',
  '健康证情况',
] as const;

export const EDUCATION_MAPPING: Record<number, string> = {
  1: '小学',
  2: '初中',
  3: '高中',
  4: '中专',
  5: '大专',
  6: '本科',
  7: '硕士',
  8: '博士',
};

const EDUCATION_NAME_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(EDUCATION_MAPPING).map(([id, name]) => [name, Number(id)]),
);

export function getEducationIdByName(name: string): number | null {
  return EDUCATION_NAME_TO_ID[name] ?? null;
}

export function getAvailableEducations(): string[] {
  return Object.values(EDUCATION_MAPPING);
}

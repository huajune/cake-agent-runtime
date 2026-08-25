import type { GeoTextScanCity } from '@resolution/geo';

/**
 * 本轮提示经字段策略裁决后的消费视图。
 *
 * 这是 evidence 域对外返回的结构契约，不是 memory 存储类型的别名：实例由
 * projectTurnHints 在 resolution 内创建，memory/agent/tools 只消费该视图。
 * 字段形状刻意与当前实体提取结果同构，避免 resolution 为了投影事实反向依赖
 * memory 的 Zod schema 与存储实例。
 */
export interface TurnHintCity extends GeoTextScanCity {
  confidence: 'high' | 'medium';
}

export interface TurnHintScheduleConstraint {
  onlyWeekends: boolean | null;
  onlyEvenings: boolean | null;
  onlyMornings: boolean | null;
  maxDaysPerWeek: number | null;
}

export interface TurnHintProjection {
  interview_info: {
    name: string | null;
    phone: string | null;
    gender: string | null;
    gender_source: 'candidate' | 'system' | null;
    age: string | null;
    is_student: boolean | null;
    education: string | null;
    has_health_certificate: string | null;
    experience: string | null;
    upload_resume: string | null;
    height: string | null;
    weight: string | null;
    household_register_province: string | null;
  };
  preferences: {
    brands: string[] | null;
    brand_ids: number[] | null;
    salary: string | null;
    position: string[] | null;
    schedule: string | null;
    city: TurnHintCity | null;
    district: string[] | null;
    location: string[] | null;
    labor_form: string | null;
    delayed_intent: { until: string; raw: string } | null;
    short_term: boolean | null;
    open_position: boolean | null;
    time_windows: string[] | null;
    schedule_constraint: TurnHintScheduleConstraint | null;
    available_after: { date: string; raw: string } | null;
  };
  reasoning: string;
}

export type TurnHintInterviewFieldKey = keyof TurnHintProjection['interview_info'];
export type TurnHintPreferenceFieldKey = keyof TurnHintProjection['preferences'];

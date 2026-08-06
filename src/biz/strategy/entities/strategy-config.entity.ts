import {
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
  StrategyIndustrySkills,
  StrategyRoleSetting,
} from '../types/strategy.types';

/**
 * 策略配置数据库记录
 * @table strategy_config
 */
export const STRATEGY_CONFIG_STATUSES = ['testing', 'released', 'archived'] as const;
export type StrategyConfigStatus = (typeof STRATEGY_CONFIG_STATUSES)[number];

export interface StrategyConfigRecord {
  id: string;
  name: string;
  description: string | null;
  role_setting: StrategyRoleSetting;
  persona: StrategyPersona;
  stage_goals: StrategyStageGoals;
  red_lines: StrategyRedLines;
  industry_skills: StrategyIndustrySkills;
  is_active: boolean;
  status: StrategyConfigStatus;
  version: number;
  version_note: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

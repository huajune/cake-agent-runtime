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
  created_at: string;
  updated_at: string;
}

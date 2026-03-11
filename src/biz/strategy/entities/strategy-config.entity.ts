import {
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
  StrategyIndustrySkills,
} from '../types';

/**
 * 策略配置数据库记录
 * @table strategy_config
 */
export interface StrategyConfigRecord {
  id: string;
  name: string;
  description: string | null;
  persona: StrategyPersona;
  stage_goals: StrategyStageGoals;
  red_lines: StrategyRedLines;
  industry_skills: StrategyIndustrySkills;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

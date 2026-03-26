export interface PersonaTextDimension {
  key: string;
  label: string;
  value: string;
  placeholder: string;
  group: 'style';
}

export interface StrategyPersona {
  textDimensions: PersonaTextDimension[];
}

export interface StageGoalConfig {
  stage: string;
  label: string;
  description: string;
  primaryGoal: string;
  successCriteria: string[];
  ctaStrategy: string[];
  disallowedActions: string[];
}

export interface StrategyStageGoals {
  stages: StageGoalConfig[];
}

export interface Threshold {
  flag: string;
  label: string;
  rule: string;
  min?: number;
  max?: number;
  unit?: string;
}

export interface StrategyRedLines {
  rules: string[];
  thresholds?: Threshold[];
}

export interface StrategyRoleSetting {
  content: string;
}

export interface StrategyIndustrySkills {
  skills: unknown[];
}

export interface StrategyChangelogRecord {
  id: string;
  config_id: string;
  field: 'role_setting' | 'persona' | 'stage_goals' | 'red_lines';
  old_value: unknown;
  new_value: unknown;
  changed_at: string;
  changed_by?: string;
}

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

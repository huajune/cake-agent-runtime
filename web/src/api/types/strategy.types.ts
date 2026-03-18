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

export interface RiskScenario {
  flag: string;
  label: string;
  signals: string;
  strategy: string;
}

export interface StrategyRedLines {
  rules: string[];
  riskScenarios?: RiskScenario[];
}

export interface StrategyIndustrySkills {
  skills: unknown[];
}

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

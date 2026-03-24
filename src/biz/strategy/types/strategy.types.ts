// ==================== 人格配置 ====================

export interface PersonaTextDimension {
  /** 维度标识（如 'tone'、'expressionStyle'） */
  key: string;
  /** 维度显示名（如 '语气'、'表达方式'） */
  label: string;
  /** 文本值（运营可编辑） */
  value: string;
  /** 占位符文本 */
  placeholder: string;
  /** 分组 */
  group: 'style';
}

export interface StrategyPersona {
  textDimensions: PersonaTextDimension[];
}

// ==================== 阶段目标 ====================

export interface StageGoalConfig {
  /** 阶段标识（如 'trust_building'） */
  stage: string;
  /** 阶段中文名 */
  label: string;
  /** 阶段定义 */
  description: string;
  /** 主要目标 */
  primaryGoal: string;
  /** 成功标准列表 */
  successCriteria: string[];
  /** CTA 策略列表 */
  ctaStrategy: string[];
  /** 禁止行为列表 */
  disallowedActions: string[];
}

export interface StrategyStageGoals {
  stages: StageGoalConfig[];
}

// ==================== 红线规则 ====================

export interface RiskScenario {
  /** 风险标识 */
  flag: string;
  /** 显示名称 */
  label: string;
  /** 识别信号描述 */
  signals: string;
  /** 应对策略 */
  strategy: string;
}

export interface StrategyRedLines {
  rules: string[];
  /** 风险场景定义（运营可配） */
  riskScenarios?: RiskScenario[];
}

// ==================== 角色设定 ====================

export interface StrategyRoleSetting {
  /** 角色定义文本（注入到系统提示词的 ## 角色 段落） */
  content: string;
}

// ==================== 行业 Skill（预留） ====================

export interface StrategyIndustrySkills {
  skills: unknown[];
}

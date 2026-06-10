/**
 * 规则提取误捕回归集（data-driven）。
 *
 * 用途：把"打地鼠式"的 pattern 修补变成回归网——每修一个生产误捕，在这里
 * 追加一条负样本（shouldNotExtract）；每个关键正向能力也固定一条正样本，
 * 防止收紧 pattern 时误伤。
 *
 * 约定：input 是单条候选人消息（规则层视角）；shouldExtract 的值是 unwrap 后
 * 的字段值；shouldNotExtract 列出的字段必须为 null/缺失。
 */
export interface ExtractionBadcaseFixture {
  description: string;
  input: string;
  shouldExtract?: Record<string, unknown>;
  shouldNotExtract?: string[];
}

export const EXTRACTION_BADCASES: ExtractionBadcaseFixture[] = [
  // ==================== gender：自述 vs 谈论他人/询问 ====================
  {
    description: 'gender：独立短语自述「我25岁，男的，本科」应提取',
    input: '我25岁，男的，本科，有健康证',
    shouldExtract: { 'interview_info.gender': '男' },
  },
  {
    description: 'gender：谈论朋友「我朋友是男的」不得提取',
    input: '我朋友是男的，他也想找工作',
    shouldNotExtract: ['interview_info.gender'],
  },
  {
    description: 'gender：询问岗位要求「你们要男的女的」不得提取',
    input: '你们这个岗位要男的女的？',
    shouldNotExtract: ['interview_info.gender'],
  },
  {
    description: 'gender：岗位限制转述「只招女的」不得提取',
    input: '上次那家说只招女的',
    shouldNotExtract: ['interview_info.gender'],
  },
  {
    description: 'gender：表单回填「性别：女」应提取',
    input: '姓名：张三\n性别：女\n年龄：30',
    shouldExtract: { 'interview_info.gender': '女' },
  },

  // ==================== salary：候选人意向 vs 岗位广告 ====================
  {
    description: 'salary：引用块里的岗位薪资不得提取（badcase：引用招募经理岗位介绍）',
    input: '[引用 李经理：时薪25元/时，做六休一] 这个班次能换吗',
    shouldNotExtract: ['preferences.salary'],
  },
  {
    description: 'salary：候选人自述期望薪资应提取',
    input: '我想找时薪20以上的',
    shouldExtract: { 'preferences.salary': '时薪20' },
  },

  // ==================== age：候选人年龄 vs 岗位年龄要求 ====================
  {
    description: 'age：岗位要求范围「18-40岁」不得当候选人年龄',
    input: '上面写要求18-40岁，我能报吗',
    shouldNotExtract: ['interview_info.age'],
  },
  {
    description: 'age：表单回填「年龄：37」应提取',
    input: '姓名：张漪\n年龄：37',
    shouldExtract: { 'interview_info.age': '37' },
  },

  // ==================== location：泛指词停用 ====================
  {
    description: 'location：「公司附近」是泛指不得提取',
    input: '有没有公司附近的活',
    shouldNotExtract: ['preferences.location'],
  },
  {
    description: 'location：「我家附近」是泛指不得提取',
    input: '我家附近有吗',
    shouldNotExtract: ['preferences.location'],
  },
  {
    description: 'location：真实地标「人民广场附近」应提取',
    input: '人民广场附近有吗',
    shouldExtract: { 'preferences.location': ['人民广场'] },
  },

  // ==================== name：昵称/引用防线 ====================
  {
    description: 'name：打招呼语「我是粪叉」不得提取为姓名',
    input: '我是粪叉',
    shouldNotExtract: ['interview_info.name'],
  },
  {
    description: 'name：引用块前缀的招募经理名不得提取',
    input: '[引用 李宇杭：先把资料补一下] 好的',
    shouldNotExtract: ['interview_info.name'],
  },
  {
    description: 'name：表单回填「姓名：张漪」应提取',
    input: '姓名：张漪\n联系方式：13512183050',
    shouldExtract: { 'interview_info.name': '张漪', 'interview_info.phone': '13512183050' },
  },

  // ==================== labor_form：平台语义 ====================
  {
    description: 'labor_form：「找兼职」无筛选价值不得提取',
    input: '我想找个兼职',
    shouldNotExtract: ['preferences.labor_form'],
  },
  {
    description: 'labor_form：「小时工」细分值应提取',
    input: '有小时工吗',
    shouldExtract: { 'preferences.labor_form': '小时工' },
  },
];

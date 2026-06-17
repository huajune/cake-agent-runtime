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
    description: 'labor_form：「找兼职」应提取（全职放开后兼职是筛选维度）',
    input: '我想找个兼职',
    shouldExtract: { 'preferences.labor_form': '兼职' },
  },
  {
    description: 'labor_form：「找全职」应提取',
    input: '我想找全职',
    shouldExtract: { 'preferences.labor_form': '全职' },
  },
  {
    description: 'labor_form：「小时工」细分值应提取',
    input: '有小时工吗',
    shouldExtract: { 'preferences.labor_form': '小时工' },
  },

  // ==================== height：表单回填 vs 岗位要求 ====================
  {
    description: 'height：表单回填「身高：170」应提取',
    input: '姓名：张三\n身高：170\n体重：60',
    shouldExtract: { 'interview_info.height': '170' },
  },
  {
    description: 'height：自述「身高175cm」应提取',
    input: '我身高175cm，体重68kg',
    shouldExtract: { 'interview_info.height': '175' },
  },
  {
    description: 'height：岗位要求「身高要求165以上」不得提取',
    input: '这个岗位身高要求165以上吗',
    shouldNotExtract: ['interview_info.height'],
  },

  // ==================== weight：表单回填 vs 岗位要求 ====================
  {
    description: 'weight：表单回填「体重：60」应提取',
    input: '姓名：张三\n体重：60',
    shouldExtract: { 'interview_info.weight': '60' },
  },
  {
    description: 'weight：自述「体重 68kg」应提取',
    input: '我身高175cm，体重68kg',
    shouldExtract: { 'interview_info.weight': '68' },
  },
  {
    description: 'weight：岗位要求「体重不低于50」不得提取',
    input: '岗位体重不低于50公斤',
    shouldNotExtract: ['interview_info.weight'],
  },

  // ==================== household_register_province：仅表单键值对 ====================
  {
    description: 'household_register_province：表单回填「户籍：安徽」应提取',
    input: '姓名：张三\n户籍：安徽',
    shouldExtract: { 'interview_info.household_register_province': '安徽' },
  },
  {
    description: 'household_register_province：表单回填「籍贯：四川省」应提取省份',
    input: '姓名：李四\n籍贯：四川省',
    shouldExtract: { 'interview_info.household_register_province': '四川省' },
  },
  {
    description: 'household_register_province：自由文本「我是安徽人」不做推断不得提取',
    input: '我是安徽人，想在上海找工作',
    shouldNotExtract: ['interview_info.household_register_province'],
  },
];

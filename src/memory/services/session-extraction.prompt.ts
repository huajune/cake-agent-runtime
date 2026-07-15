import type { BrandItem } from '@/sponge/sponge.types';
import type { BrandAliasHint } from '../facts/high-confidence-facts';
import { formatExtractionFactLines } from '../formatters/fact-lines.formatter';
import type {
  EntityExtractionResult,
  HighConfidenceFacts,
  SessionFacts,
} from '../types/session-facts.types';

/** 结构化事实提取的系统提示词。 */
export const SESSION_EXTRACTION_SYSTEM_PROMPT = `你是结构化事实提取引擎，从招募经理与候选人的对话历史中提取结构化事实信息。

## 提取原则
- 增量式：[已确认事实] 是此前轮次已提取的结果，无需重复输出未变化的字段；你只需从本轮对话窗口中**补充新信息、纠正已确认事实中的错误**（用户改口/纠正时以最新表述为准）。没有 [已确认事实] 时按全量提取处理
- 保留原话：除非有特殊说明，字段值保留用户的原始表述
- 合理推理：可以根据上下文语境和常识知识进行合理推断，但不要凭空编造
- 省略缺失：对话中未提及且无法合理推断的字段省略
- **时间锚定**：每条消息末尾带有 [消息发送时间：…]，[当前时间] 段给出现在的日期。所有时间类字段（interview_time、available_after、delayed_intent.until）中的相对表述（"明天/后天/周五/下周一"）必须以**该消息的发送时间**为基准换算成绝对日期（如 "6月4日 14:00"），禁止原样存相对表述——相对时间一旦跨天就会失真
- **旧会话事务字段不复活**：对话历史可能跨多天。更早日期的会话里确认过的 applied_store / applied_position / interview_time 属于已了结的旧报名流程；只有**最近一段连续会话**（与当前消息同日或紧密衔接）中确认/重申过的值才能提取，旧会话的不要带出来
- **转发文案不是候选人意向**：用户转发/粘贴的招聘广告或岗位介绍（含【薪资待遇】【岗位职责】等标记、或明显是宣传文案的整段内容）里的薪资/年龄/班次/地点是**岗位要求**，不是候选人自己的条件或意向，不得提取为 salary / age / schedule 等字段；候选人转发岗位仅可作为对该岗位感兴趣的品牌意向线索
- **规则线索供参考**：[规则模式匹配线索] 中列出的字段是通过正则/白名单初步提取的结果，字段会标注 confidence/source/evidence。请结合置信度与对话上下文做最终判断；confidence=low/medium 不应当成已确认事实，若上下文能确认则由你提取，否则留空。规则线索不具备完整语义理解能力（无法识别否定、纠正、指代等语境），若上下文显示用户纠正了某个信息，以用户最新表述为准
- **来源声明（explicit_provenance）**：对 interview_info 中**候选人明确提供**的字段，在 explicit_provenance 数组声明 { field, quote }。判定标准（满足任一）：①结构化表单回填（「年龄：37」「健康证：有」等键值对）；②候选人直接自陈（"我有健康证""我今年37岁"）。quote 必须是**候选人消息中的逐字片段**（系统会按原文校验，对不上则声明无效）。**严禁**列入：由上下文/常识推断的字段、助手提及后候选人仅以"嗯/好的"附和的字段、转发文案里的信息；name 字段不需要声明（有独立校验通道）

## 提取字段定义

interview_info（面试信息 —— 预约面试所需，需收集候选人的姓名、联系方式、性别、年龄、应聘门店与岗位、面试时间、是否学生、学历、健康证情况、过往工作经历、身高、体重及户籍省份）:
- name: 真实姓名（如："张三"）
  禁止来源：微信加好友时的自动打招呼语 —— 整条消息是"我是xx"、"你好我是xx"这类纯打招呼句式时，xx 通常是微信昵称而非真实姓名，不要提取
  禁止来源：引用块前缀 —— 候选人消息以 [引用 XXX：...] 或 引用 XXX：... 开头时，XXX 是被引用方（通常是招募经理）的名字，不是候选人自己。引用块本身的内容也是别人发的，不可作为候选人的姓名/电话/年龄等个人信息来源。
  触发提取的明确语境（满足任一即可）：
    1) 候选人被明确询问"真实姓名/叫什么名字"后答复
    2) 自我介绍出现"我叫 xxx"、"我的全名是 xxx"等明确句式
    3) **结构化收资模板回填**：候选人按助手发的资料 checklist 回填，行内出现「姓名：xxx」「姓名:xxx」「姓名 xxx」等键值对（key 为"姓名/名字"，value 为合法真名）。这是 booking 表单回填语境，可信度高于打招呼语。
- phone: 联系方式（如："13800138000"）
- gender: 性别（如："男"、"女"）
- age: 年龄（保留原话，如："18"、"25岁"）
- applied_store: 应聘门店（如："人民广场店"）
- applied_position: 应聘岗位（如："服务员"）
- interview_time: 面试时间。必须按消息发送时间换算成绝对日期表述（如消息发送于 6月3日、用户说"明天下午2点" → "6月4日 14:00"）；禁止存"明天/后天/下周X"等相对表述
- is_student: 是否是学生（true/false）。触发：
  - true：候选人原话出现"我是学生/在读/本科在读/读大几/读高中/还在上学/上学的/校园/考上研究生/准研究生/待入学/准备读研/读研"等在校或即将入学语境，或被问"学生还是社会人士"时答"学生"
  - false：候选人原话出现"社会人士/上班族/已经工作/工作过/我在 X 公司/原本/原职/已就业/已毕业/在职/待岗/失业/全职妈妈/带娃/退休"等已离开校园的语境，或被问"学生还是社会人士"时答"社会人士/工作的/上班的/不是学生"
  - **身份粘性**：已确认的学生身份只能被候选人第一人称明确改口（如"我不是学生了/我已经毕业/我是社会人士"）覆盖。"社会人士岗位会影响读书吗""那就社会人士的早班吧""不是有招社会人士岗吗""可以用社会人士身份入职吗"都只是在讨论岗位或询问能否改身份，**不得**提取为 is_student=false，也不得在 explicit_provenance 中声明为候选人自报
- experience: 过往工作经历。候选人被问"之前做过哪些公司、什么岗位、做了多久/年限"或按收资模板回填"过往公司+岗位+年限"时提取，尽量合并为"公司/门店 + 岗位 + 时长"的短句（如"肯德基服务员4个多月"、"河南烤肉自助服务员3个月"）。如果公司、岗位、时长分散在连续几条消息里，结合上下文合并；不要把岗位招聘要求里的经验要求当成候选人经历。
- height: 身高，保留数字（如 "170"、"175cm" → "175"）。仅当候选人主动给出或按收资模板回填「身高：xxx」时提取
- weight: 体重，保留数字（如 "60"、"60kg" → "60"）。仅当候选人主动给出或按收资模板回填「体重：xxx」时提取
- household_register_province: 户籍/籍贯所在省份（如 "安徽"、"安徽省"、"四川"）。**敏感字段**：只在候选人**主动透露**或按收资模板回填「户籍：xxx」「籍贯：xxx」时提取，不要据"常驻城市/现居地"推断户籍

preferences（意向信息）:
- labor_form: 用工形式，仅允许以下合法值之一："全职"、"兼职"、"小时工"、"寒假工"、"暑假工"。
  业务前提：平台同时有全职、兼职及细分岗位（岗位轴是 用工形式=全职/兼职 + 兼职类型=寒假工/暑假工/小时工 两级，候选人表达时不区分两级，偏好统一记扁平单值）；候选人明确表达任一合法用工形式时都应提取。
  提取规则：
  - 候选人说"找兼职"/"有没有兼职" → labor_form: "兼职"
  - 候选人说"要全职"/"找全职" → labor_form: "全职"
  - 候选人明确提到"小时工"/"寒假工"/"暑假工" → 按对应值提取
  - "暑期工"/"暑期工作"/"暑期兼职"/"暑假兼职"统一归一为 labor_form: "暑假工"
  - 明确否定/排除（如"不是暑假工"、"暑假工我做不了"、"不要给我推荐暑假工"、"除了暑假工都可以"）时，不得提取为"暑假工"；若同句另有明确用工形式，提取后者
  - 不确定（如"不知道是不是暑假工"、"不确定是暑假工还是小时工"）不代表改口，不能用句中任一用工形式覆盖此前明确偏好
  - 同时明确接受多种形式（如"暑假工或者小时工都可以"）不等于只要暑假工；当前字段只能存一个值时，按句中最后一个明确接受的合法值提取
  - 询问当前岗位类型（如"这个是小时工吗"、"就是小时工是吗，一天9个小时？"）只是核对岗位事实，不是候选人改口接受小时工，不得据此更新 labor_form
  - 只有日工时/工作周期等特征能映射到某个具体细分类型时才提取；含糊时留空
- brands: 意向品牌（数组，必须使用[可用品牌信息]中的标准品牌名）
  来源约束：**只有候选人原话主动提及品牌意向**（如"我想找奥乐齐""肯德基还招吗""我要去瑞幸做"）才提取；若品牌只出现在助手消息里，候选人仅以"好""可以""嗯嗯""然后呢""继续补资料"等方式跟进，不视为候选人品牌意向，**brands 字段不提取**
- brand_ids: 意向品牌ID（数组）。候选人转发/粘贴 Boss 直聘岗位标题时，标题末尾或标题内可能带形如 "[10239]" 的方括号纯数字；这是 Boss 岗位标题里约定的品牌ID，必须提取为 brand_ids: [10239]，后续查岗优先用于 duliday_job_list.brandIdList。不要把这个数字当 jobId、手机号、薪资或年龄。
- salary: 意向薪资（如："时薪20"、"4000-5000"）
- position: 意向岗位（如："服务员"、"收银员"）
  注意区分**品类/行业词**与**工种**：候选人说"咖啡""奶茶""火锅"等是**品类/行业**（想去该品类的品牌门店），指的是相关品牌，应作为 brands 处理（参考[可用品牌信息]与[品牌别名命中提示]选对应品牌），**不要据此推断具体工种**——例如"咖啡兼职"不要提取为 position "咖啡师"，除非候选人明确说"我想做咖啡师/想当咖啡师"
- schedule: 意向班次/时间/出勤硬约束（如："周末"、"晚班"、"每周最多两天"、"做一休一"、"不上夜班"、"下班后"）
- city: 意向城市（如："上海"、"杭州"）
- district: 意向区域（如："浦东"、"徐汇"）
- location: 意向地点/商圈（如："人民广场"、"陆家嘴"）
- delayed_intent: 推迟意向。**仅当候选人原话明确出现"推迟/再说/不急/晚点/X后/下周/周末后"等延期信号**时，写入对象 { until: 推迟到何时, raw: 触发原话片段 }；含糊或仅是情绪表达不要填。例：候选人说"五一回来再面试" → { until: "五一后", raw: "五一回来再面试" }
- short_term: 是否短期工。**仅在候选人原话出现"做几天/几天/临时/短期"等明确短期信号**时填 true；只是询问"能不能短期/可以做几天吗"等开放问题不算确认意向，留 null
- open_position: 岗位开放标记。候选人说"什么都可以/X都行/什么工作都行/什么都能做"等宽口径句式时填 true；**此时 position 字段必须留空**，禁止把 X 锁定为单一岗位
- time_windows: 可用时间窗口数组（保留原话，如 ["17点后"、"14点前"、"早上11点之前"]）；候选人明确给出某时间段才填，泛指"白天/晚上"等抽象表达不要填

## 推理指导

你不仅要提取对话中明确提到的信息，还需要结合上下文理解和常识知识推理出相关事实。

推理示例：
- 用户说"我在读大三" → is_student: true, education: "本科在读"
- 用户说"今年考上研究生了/准研究生/准备读研" → is_student: true, education: "硕士待入学"
- 用户说"社会人士，目前待岗" / "已经工作了" / "上班族" / "在 X 公司做过" / "已毕业" / "宝妈带娃" / "退休了" → is_student: false
- 用户按表单回填"姓名：赵堤 / 联系电话：18xxx / 年龄：24" → name: "赵堤", phone: "18xxx", age: "24"（结构化键值对回填，全字段一次性提取）
- 用户说"我只有周末有空" → schedule: "周末"（不要仅凭可用时间推理 labor_form）
- 用户说"每周最多也就能干两天" → schedule: "每周最多两天"
- 用户说"另一份工作是做一休一" → schedule: "做一休一"
- 用户说"我六点才下班" → schedule: "下班后", time_windows: ["6点后"]
- 用户说"我刚高考完想找暑期工作" → is_student: true, labor_form: "暑假工"（明确提到"暑期"才能映射到"暑假工"细分）
- 用户说"寒假想打个工" → labor_form: "寒假工"
- 用户说"我想找兼职" / "有兼职吗" → labor_form: "兼职"
- 用户提到具体学校名 → 可推断 city/district（如果你知道学校所在地）
- 用户说"洗碗工什么都可以做" / "什么工作都行" / "服务员都行随便都可以" → open_position: true，position **必须留空**（候选人是宽口径表达，不是锁定为某岗位）
- 用户说"五一回来面试可以吗" / "下周再说吧" / "不急晚点联系" / "我想晚点再约" → delayed_intent: { until: "五一后" / "下周" / "晚点", raw: 原话片段 }
- 用户说"我就做五一这几天" / "做几天就行" / "临时干个一周" → short_term: true
- 用户说"早上 11 点之前都有空" / "17点之后才下班" → time_windows: ["11点前"] 或 ["17点后"]

**禁止推断入事实的红线**：
- 候选人未明示的"班次/休息日/可用时间"绝不能凭"看起来像/可能是"等理由写入 schedule 或 time_windows。例：候选人只说"明天 9 点到 18 点上班"——不得据此推断"明天休息"或"对方明天有空面试"。这是事实层，不是 reasoning 层。

推理要求：
- 推理必须有合理依据，在 reasoning 字段中说明推理链
- 直接提取的事实和推理得出的事实都要记录
- 推理冲突时以用户明确陈述为准
- 不确定的推理不要填入字段，但可以在 reasoning 中提及

## 地名识别原则

地名涉及 city / district / location 三个字段，且存在多种歧义场景，必须按下列原则取舍：

- **公认唯一对应某城市的著名地标**（如著名风景区、有明确城市标识的地点、具有唯一城市归属的特色街区）：可基于通识补 city
- **区/镇/街道/小区级地名**：单独出现时通常无法唯一对应某城市，**city 留 null**，只填 district 或 location；让下游 Agent 决定是反问候选人还是结合上下文已明示的城市再 geocode
- **连锁地标名陷阱**：商圈/广场/购物中心/地铁站常常在多个城市同名（如带"广场/天街/汇/中心"等通用后缀的连锁地标）。这类地名**严禁基于通识推断城市**，必须依赖会话中已明示的城市或反问；只填 location，city 留 null
- **学校/校区**：通常唯一对应所在城市，可推断 city；但"附小/校区/学院"等只是位置标识，不可据此推断学历
- **品牌名含地名 ≠ 门店位置**（最末红线已强调）：全国连锁品牌名里包含地名时，不可据此推断地理

## 品牌匹配规则

- 用户提到的品牌名可能是别称（如"KFC"→"肯德基"），必须通过[可用品牌信息]的别称列表映射为标准品牌名
- 用户转发/粘贴 Boss 岗位标题中出现形如 "[10239]" 的方括号纯数字时，直接提取 brand_ids: [10239]；即使标题里的品牌名/客户公司没有匹配到[可用品牌信息]，brand_ids 仍可作为高稳定主键保留
- 如果 [品牌别名命中提示] 中给出了“用户原话 → 标准品牌”的命中结果，可将其视为高置信品牌归一化线索
- brands 字段只能填写[可用品牌信息]中存在的标准品牌名
- 如果用户提到的品牌在列表中找不到匹配，保留用户原话

## 品牌意图极性（brand_intents）

对**本轮**候选人消息中的品牌意图输出 brand_intents 数组（历史轮已表达过的不复读）：
- polarity 三值：positive（意向/询问/回应推荐/提及，默认档——候选人在求职对话里主动提到品牌就是兴趣信号）；negative（明确排斥："不要X""X就算了""X干过了不去了""除了X都行"）；browse_all（明确不限品牌："品牌不限""什么牌子都行"）
- **指代链接（本字段的核心职责）**：候选人说"这个不考虑""第一个可以""你说的那家算了"时，必须结合图片描述与此前助手推荐，把指代链接到**实际品牌名**再输出（如图片是 M Stand 海报、配文"这个不考虑" → { brand: "M Stand", polarity: "negative" }）；确实无法链接到具体品牌的排斥表达输出 { brand: null, polarity: "negative" }
- "换个品牌/换一家" → { brand: null, polarity: "negative" }（排斥当前主品牌）
- brand 尽量使用[可用品牌信息]中的标准名（系统会做目录校验，对不上库的整条丢弃）
- 助手提到品牌而候选人仅以"嗯/好的"泛泛附和、或品牌只出现在转发文案里 → 不输出该品牌的 brand_intents

## 提取来源约束（applied_position / applied_store）

- 用户主动提出 → 直接提取（如用户说"我想做分拣"→ applied_position: "分拣"）
- 助手推荐后，用户表示感兴趣/确认/认可（如"嗯嗯"、"好的"、"可以"、继续追问该岗位详情）→ 应提取助手推荐的岗位/门店
- 助手推荐后，用户未回应、话题转移、或明确拒绝 → 不提取
- 助手为挽留用户而推荐备选岗位、兼职群、或说"我再帮你留意"时，不得把这些备选内容覆盖为 applied_store / applied_position，除非用户明确选择了新的具体岗位/门店
- 同一段历史里出现多个岗位/门店时，applied_store / applied_position 只记录用户当前正在报名、约面或明确追问详情的那个；不能因为助手最后提到了另一个备选岗位就改写当前焦点
- 用户说"那个店/这家/那边/宝龙"等指代词时，优先承接上一轮已确认的当前焦点岗位；若无法唯一确定，保持 null，不要从较晚出现的备选推荐里猜
- 提取值应为标准岗位名/门店名，去掉口语化后缀（如"的岗位"、"那个店"等）
- 红线：不可从品牌名称中包含的地名推断意向城市/区域。品牌名中的地名是品牌标识，不代表地理限制（如"成都你六姐"是全国连锁，不可推断城市为成都）`;

/**
 * 将规则提取结果格式化为 prompt 注入段落。
 *
 * 只输出有值的字段，避免大段"无"干扰 LLM 注意力。
 * LLM 将这些线索作为参考依据，结合对话上下文做最终判断。
 */
function formatRuleFactsSection(
  ruleFacts: EntityExtractionResult | HighConfidenceFacts | null,
): string {
  if (!ruleFacts) return '无';

  // 这里是提取 LLM 的判断依据，evidence（"手机号识别：135xx"等短线索）需要保留；
  // Agent prompt 注入侧（fact-lines 默认）不带 evidence。
  const lines = formatExtractionFactLines(ruleFacts, { includeEvidence: true });
  return lines.length > 0 ? lines.join('\n') : '无';
}

/**
 * 品牌信息注入瘦身：命中别名的品牌列全量条目（含别名，归一化需要），
 * 其余品牌只列名称（保留"全量品牌词典"的归一化能力，砍掉别名占的大头——
 * 全量含别名注入曾是单次提取 prompt 里最大的固定成本块，估 3-8K tokens）。
 */
function formatBrandSection(brandData: BrandItem[], aliasHints: BrandAliasHint[]): string {
  if (brandData.length === 0) return '暂无品牌数据';

  const hintBrandNames = new Set(aliasHints.map((hint) => hint.brandName));
  const detailed = brandData.filter((b) => hintBrandNames.has(b.name));
  const namesOnly = brandData.filter((b) => !hintBrandNames.has(b.name)).map((b) => b.name);

  const parts: string[] = [];
  if (detailed.length > 0) {
    parts.push(
      detailed
        .map((b) => `- ${b.name}${b.aliases.length > 0 ? `（别称：${b.aliases.join('、')}）` : ''}`)
        .join('\n'),
    );
  }
  if (namesOnly.length > 0) {
    parts.push(
      `其余合作品牌（仅名称，brands 字段只能填这些标准名或上面的命中品牌）：${namesOnly.join('、')}`,
    );
  }
  return parts.join('\n');
}

/** 已确认事实注入：让增量提取真正"在已知事实基础上补充/纠正"，而不是盲提。 */
function formatKnownFactsSection(previousFacts: SessionFacts | null): string | null {
  if (!previousFacts) return null;
  const lines = formatExtractionFactLines(previousFacts);
  return lines.length > 0 ? lines.join('\n') : null;
}

/** 组装结构化事实提取的用户提示词。 */
export function buildSessionExtractionPrompt(
  brandData: BrandItem[],
  message: string,
  history: string[],
  aliasHints: BrandAliasHint[] = [],
  ruleFacts: EntityExtractionResult | HighConfidenceFacts | null = null,
  currentTime?: string,
  previousFacts: SessionFacts | null = null,
): string {
  const brandInfo = formatBrandSection(brandData, aliasHints);

  const aliasHintInfo =
    aliasHints.length > 0
      ? aliasHints
          .map(
            (hint) =>
              `- 用户原话「${hint.sourceText}」命中别名「${hint.matchedAlias}」=> 标准品牌「${hint.brandName}」`,
          )
          .join('\n')
      : '无';

  const knownFacts = formatKnownFactsSection(previousFacts);

  return [
    ...(currentTime ? ['[当前时间]', currentTime, ''] : []),
    '[可用品牌信息]',
    brandInfo,
    '',
    '[品牌别名命中提示]',
    aliasHintInfo,
    '',
    ...(knownFacts
      ? ['[已确认事实（此前轮次提取，沿用即可；本轮只需补充新信息或纠正错误）]', knownFacts, '']
      : []),
    '[规则模式匹配线索（供参考，结合上下文判断是否准确）]',
    formatRuleFactsSection(ruleFacts),
    '',
    '[历史对话]',
    history.join('\n') || '无',
    '',
    '[当前消息]',
    message,
  ].join('\n');
}

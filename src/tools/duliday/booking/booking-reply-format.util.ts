/**
 * 把 booking 工具结果格式化成 Agent 直接照实复述的回复字段。
 *
 * 历史 badcase 三件套：
 * - waugdoxa / 2za5e0ek：约面成功后 Agent 只说"周三 13:30-16:30 都行"区间话术，候选人不知道几点到
 * - keciu6u6：Agent 漏说"到店跟前台说独立客招聘介绍来的"，候选人到店被店长当陌生人推托
 *
 * 把"精确时间点"和"到店脚本"作为工具事实输出（`_confirmedInterviewTimeHuman` / `_onSiteScript`），
 * Agent 看到结构化字段就会照实复述，不依赖 prompt 文字约束。
 */

/**
 * 把 "YYYY-MM-DD HH:mm:ss" 格式的 interviewTime 转成候选人能直接读的自然时间。
 *
 * 示例：'2026-05-19 13:30:00' → '5月19日（周三）13:30'
 *
 * 输入不符合预期格式时原样返回，让上游 Agent 至少有兜底信息。
 */
export function formatInterviewTimeForReply(interviewTime: string): string {
  const match = interviewTime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):\d{2}$/);
  if (!match) return interviewTime;
  const [, , mm, dd, hh, min] = match;
  const date = new Date(interviewTime.replace(' ', 'T'));
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = Number.isNaN(date.getDay()) ? '' : `（${weekdays[date.getDay()]}）`;
  return `${Number(mm)}月${Number(dd)}日${weekday}${hh}:${min}`;
}

/**
 * 判断岗位是否为线上（非到店）面试，用于决定预约成功后要不要附带到店脚本。
 *
 * badcase chat 6a5f3080（佛山必胜客）：岗位面试备注写明"线上面试、群里发腾讯会议链接"，
 * 但 booking 成功结果无条件附带 _onSiteScript，Agent 同一轮既说"线上腾讯会议"又说
 * "到店跟前台说……"，自相矛盾。
 *
 * 判定口径刻意保守：只有面试方式或面试备注出现**明确线上信号**才判线上；
 * 空值/未知一律按到店处理，避免回归 badcase keciu6u6（漏发到店脚本，候选人
 * 到店被当陌生人）。面试方式明确写"线下/到店/现场"时，即便备注含"线上"字样
 * （如混合流程）也按到店处理。
 */
// badcase 6a608ad4/6a607170（2026-07-23 沈阳必胜客双面投诉）：岗位面试说明是
// "面试官先电话沟通，合适的会通知线下门店面试"——先电话后到店的两段式流程，初始
// 环节不应发到店脚本；但旧正则只认字面"电话面试"，"先电话沟通"漏网，booking 成功后
// 照发 _onSiteScript，候选人没等电话直接到店。只收强电话初面信号，"保持电话畅通/
// 有变动会电话联系"这类到店岗常见措辞不收，避免误伤回归 keciu6u6。
const ONLINE_INTERVIEW_SIGNAL_PATTERN =
  /线上面试|线上形式|线上进行|视频面试|电话面试|电话初面|电话初试|先电话沟通|电话沟通后|先电话联系|远程面试|腾讯会议|会议链接|入会|钉钉会议|飞书会议/;
const OFFLINE_INTERVIEW_METHOD_PATTERN = /线下|到店|现场|当面|门店面试/;

export function isOnlineInterview(params: {
  interviewType?: string | null;
  interviewRemark?: string | null;
  flowDescription?: string | null;
}): boolean {
  const type = params.interviewType?.trim() ?? '';
  if (OFFLINE_INTERVIEW_METHOD_PATTERN.test(type)) return false;
  if (/线上|视频|电话|远程/.test(type)) return true;
  const freeText = [params.interviewRemark, params.flowDescription]
    .filter((text): text is string => Boolean(text?.trim()))
    .join('\n');
  return ONLINE_INTERVIEW_SIGNAL_PATTERN.test(freeText);
}

/**
 * 构造候选人到店报到时的自报家门脚本。
 *
 * 包含三要素：(1) "独立客招聘介绍来的"（badcase wcyayxpf：必须用「独立客」不能用变体），
 * (2) 候选人真实姓名，(3) 应聘岗位名。任一缺失时跳过该要素，保持脚本可读。
 */
export function buildOnSiteScript(params: {
  candidateName: string | null | undefined;
  jobName: string | null | undefined;
}): string {
  const parts: string[] = ['独立客招聘介绍来的'];
  if (params.candidateName?.trim()) parts.push(`姓名 ${params.candidateName.trim()}`);
  if (params.jobName?.trim()) parts.push(`应聘 ${params.jobName.trim()}`);
  return `到店跟前台/店长说"${parts.join('，')}"`;
}

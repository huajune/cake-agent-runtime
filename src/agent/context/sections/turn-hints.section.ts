import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import {
  type AvailableAfterFact,
  type CityFact,
  type DelayedIntent,
  type EntityExtractionResult,
  type HighConfidenceFacts,
  type HighConfidenceValue,
  type ScheduleConstraintFact,
  type SessionFacts,
  unwrapSessionFacts,
} from '@memory/types/session-facts.types';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 本轮线索段落
 *
 * 把本轮前置高置信识别结果拆成两部分：
 *  - 普通线索：当前轮新增、或与会话记忆不冲突的识别结果；
 *  - 待确认线索：与会话记忆已知信息存在冲突的识别结果。
 *
 * 普通线索可直接辅助 LLM 理解本轮意图；待确认线索提醒 LLM 需要澄清而非覆盖记忆。
 * 城市字段是结构化 CityFact（含 evidence/confidence），渲染时会附上证据信息，
 * Agent 可据此自主决定是否直接采用或需要澄清。
 */
export class TurnHintsSection implements PromptSection {
  readonly name = 'turn-hints';

  build(ctx: PromptContext): string {
    const { normalHints, pendingHints } = this.partition(
      ctx.sessionFacts ?? null,
      ctx.highConfidenceFacts ?? null,
    );

    const parts: string[] = [];
    if (normalHints) parts.push(this.renderHighConfidence(normalHints));
    if (pendingHints) parts.push(this.renderPendingConfirmation(pendingHints));
    return parts.join('\n\n');
  }

  /** 把本轮前置高置信识别渲染成单独的 runtime hints。 */
  private renderHighConfidence(facts: EntityExtractionResult | HighConfidenceFacts): string {
    const lines = formatExtractionFactLines(facts);
    if (lines.length === 0) return '';

    return [
      '[本轮高置信线索]',
      '',
      '以下内容由当前消息前置识别得到，仅用于理解本轮意图，不视为跨轮已确认的会话记忆。',
      '若与[用户档案]、[会话记忆]或候选人当前明示信息冲突，以候选人当前明示信息为准。',
      '若识别出地点线索，行政区域可直接查岗；但商圈、地标、街道、详细地址这类自由位置线索不能直接当区域。只要本轮准备做具体岗位或门店推荐，就应优先先 geocode 获取经纬度，"附近/离我近"只是最明显场景。',
      '城市字段带有 confidence 与 evidence：confidence=high 的结果来自明确规则匹配（如直辖市紧凑、显式城市、唯一区名映射、热门地标映射），可直接采用；若与候选人本轮新表述冲突，优先相信候选人当前明示信息。',
      '',
      '## 当前消息识别结果',
      lines.join('\n'),
    ].join('\n');
  }

  /** 把与会话记忆冲突的当前轮识别结果渲染成待确认线索。 */
  private renderPendingConfirmation(facts: EntityExtractionResult | HighConfidenceFacts): string {
    const lines = formatExtractionFactLines(facts);
    if (lines.length === 0) return '';

    return [
      '[本轮待确认线索]',
      '',
      '以下内容由当前消息前置识别得到，但与[会话记忆]中的已知信息存在冲突。',
      '这些内容只用于帮助你判断是否需要澄清，不得直接覆盖已确认的会话记忆。',
      '若候选人本轮表达明确，可按当前表达继续；若表达仍有歧义，先做一次简短确认。',
      '',
      '## 当前消息待确认结果',
      lines.join('\n'),
    ].join('\n');
  }

  /** 把当前轮高置信识别拆成"普通线索"和"待确认线索"。 */
  private partition(
    sessionFacts: EntityExtractionResult | SessionFacts | null,
    highConfidenceFacts: HighConfidenceFacts | null,
  ): {
    normalHints: HighConfidenceFacts | null;
    pendingHints: HighConfidenceFacts | null;
  } {
    if (!highConfidenceFacts) {
      return { normalHints: null, pendingHints: null };
    }

    const comparableSessionFacts = unwrapSessionFacts(sessionFacts, { minConfidence: 'medium' });
    if (!comparableSessionFacts) {
      return { normalHints: highConfidenceFacts, pendingHints: null };
    }

    const normalHints = this.createEmptyHighConfidenceFacts();
    const pendingHints = this.createEmptyHighConfidenceFacts();
    const highInfo = highConfidenceFacts.interview_info;
    const highPref = highConfidenceFacts.preferences;

    this.partitionHighValue(
      comparableSessionFacts.interview_info.name,
      highInfo.name,
      (value) => {
        normalHints.interview_info.name = value;
      },
      (value) => {
        pendingHints.interview_info.name = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.phone,
      highInfo.phone,
      (value) => {
        normalHints.interview_info.phone = value;
      },
      (value) => {
        pendingHints.interview_info.phone = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.gender,
      highInfo.gender,
      (value) => {
        normalHints.interview_info.gender = value;
        normalHints.interview_info.gender_source = highInfo.gender_source;
      },
      (value) => {
        pendingHints.interview_info.gender = value;
        pendingHints.interview_info.gender_source = highInfo.gender_source;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.age,
      highInfo.age,
      (value) => {
        normalHints.interview_info.age = value;
      },
      (value) => {
        pendingHints.interview_info.age = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.applied_store,
      highInfo.applied_store,
      (value) => {
        normalHints.interview_info.applied_store = value;
      },
      (value) => {
        pendingHints.interview_info.applied_store = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.applied_position,
      highInfo.applied_position,
      (value) => {
        normalHints.interview_info.applied_position = value;
      },
      (value) => {
        pendingHints.interview_info.applied_position = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.interview_time,
      highInfo.interview_time,
      (value) => {
        normalHints.interview_info.interview_time = value;
      },
      (value) => {
        pendingHints.interview_info.interview_time = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.is_student,
      highInfo.is_student,
      (value) => {
        normalHints.interview_info.is_student = value;
      },
      (value) => {
        pendingHints.interview_info.is_student = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.education,
      highInfo.education,
      (value) => {
        normalHints.interview_info.education = value;
      },
      (value) => {
        pendingHints.interview_info.education = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.has_health_certificate,
      highInfo.has_health_certificate,
      (value) => {
        normalHints.interview_info.has_health_certificate = value;
      },
      (value) => {
        pendingHints.interview_info.has_health_certificate = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.interview_info.upload_resume,
      highInfo.upload_resume,
      (value) => {
        normalHints.interview_info.upload_resume = value;
      },
      (value) => {
        pendingHints.interview_info.upload_resume = value;
      },
    );

    this.partitionHighArrayValue(
      comparableSessionFacts.preferences.brands,
      highPref.brands,
      (value) => {
        normalHints.preferences.brands = value;
      },
      (value) => {
        pendingHints.preferences.brands = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.preferences.salary,
      highPref.salary,
      (value) => {
        normalHints.preferences.salary = value;
      },
      (value) => {
        pendingHints.preferences.salary = value;
      },
    );
    this.partitionHighArrayValue(
      comparableSessionFacts.preferences.position,
      highPref.position,
      (value) => {
        normalHints.preferences.position = value;
      },
      (value) => {
        pendingHints.preferences.position = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.preferences.schedule,
      highPref.schedule,
      (value) => {
        normalHints.preferences.schedule = value;
      },
      (value) => {
        pendingHints.preferences.schedule = value;
      },
    );
    this.partitionHighCityValue(
      comparableSessionFacts.preferences.city,
      highPref.city,
      (value) => {
        normalHints.preferences.city = value;
      },
      (value) => {
        pendingHints.preferences.city = value;
      },
    );
    this.partitionHighArrayValue(
      comparableSessionFacts.preferences.district,
      highPref.district,
      (value) => {
        normalHints.preferences.district = value;
      },
      (value) => {
        pendingHints.preferences.district = value;
      },
    );
    this.partitionHighArrayValue(
      comparableSessionFacts.preferences.location,
      highPref.location,
      (value) => {
        normalHints.preferences.location = value;
      },
      (value) => {
        pendingHints.preferences.location = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.preferences.labor_form,
      highPref.labor_form,
      (value) => {
        normalHints.preferences.labor_form = value;
      },
      (value) => {
        pendingHints.preferences.labor_form = value;
      },
    );
    this.partitionHighValue<DelayedIntent>(
      comparableSessionFacts.preferences.delayed_intent,
      highPref.delayed_intent,
      (value) => {
        normalHints.preferences.delayed_intent = value;
      },
      (value) => {
        pendingHints.preferences.delayed_intent = value;
      },
      this.isSameJsonValue,
    );
    this.partitionHighValue(
      comparableSessionFacts.preferences.short_term,
      highPref.short_term,
      (value) => {
        normalHints.preferences.short_term = value;
      },
      (value) => {
        pendingHints.preferences.short_term = value;
      },
    );
    this.partitionHighValue(
      comparableSessionFacts.preferences.open_position,
      highPref.open_position,
      (value) => {
        normalHints.preferences.open_position = value;
      },
      (value) => {
        pendingHints.preferences.open_position = value;
      },
    );
    this.partitionHighArrayValue(
      comparableSessionFacts.preferences.time_windows,
      highPref.time_windows,
      (value) => {
        normalHints.preferences.time_windows = value;
      },
      (value) => {
        pendingHints.preferences.time_windows = value;
      },
    );
    this.partitionHighValue<ScheduleConstraintFact>(
      comparableSessionFacts.preferences.schedule_constraint,
      highPref.schedule_constraint,
      (value) => {
        normalHints.preferences.schedule_constraint = value;
      },
      (value) => {
        pendingHints.preferences.schedule_constraint = value;
      },
      this.isSameJsonValue,
    );
    this.partitionHighValue<AvailableAfterFact>(
      comparableSessionFacts.preferences.available_after,
      highPref.available_after,
      (value) => {
        normalHints.preferences.available_after = value;
      },
      (value) => {
        pendingHints.preferences.available_after = value;
      },
      this.isSameJsonValue,
    );

    return {
      normalHints: this.hasAnyFactLines(normalHints) ? normalHints : null,
      pendingHints: this.hasAnyFactLines(pendingHints) ? pendingHints : null,
    };
  }

  private partitionHighValue<T>(
    previousValue: T | null | undefined,
    currentFact: HighConfidenceValue<T> | null,
    onNormal: (value: HighConfidenceValue<T>) => void,
    onPending: (value: HighConfidenceValue<T>) => void,
    isSameValue: (previousValue: T, currentValue: T) => boolean = this.isSameScalarOrJsonValue,
  ): void {
    if (!currentFact) return;
    if (!this.hasValue(currentFact.value)) return;
    if (!this.hasValue(previousValue)) {
      onNormal(currentFact);
      return;
    }
    if (isSameValue(previousValue as T, currentFact.value)) {
      // Keep current-round confirmations visible in [本轮线索]; sessionFacts stays the durable memory,
      // while this section tells the model what the candidate just said.
      onNormal(currentFact);
      return;
    }
    onPending(currentFact);
  }

  private partitionHighCityValue(
    previousValue: CityFact | null,
    currentFact: HighConfidenceValue<string> | null,
    onNormal: (value: HighConfidenceValue<string>) => void,
    onPending: (value: HighConfidenceValue<string>) => void,
  ): void {
    if (!currentFact || !currentFact.value.trim()) return;
    if (!previousValue || !previousValue.value) {
      onNormal(currentFact);
      return;
    }
    if (previousValue.value.trim() === currentFact.value.trim()) {
      onNormal(currentFact);
      return;
    }
    onPending(currentFact);
  }

  private partitionHighArrayValue(
    previousValue: string[] | null,
    currentFact: HighConfidenceValue<string[]> | null,
    onNormal: (value: HighConfidenceValue<string[]>) => void,
    onPending: (value: HighConfidenceValue<string[]>) => void,
  ): void {
    if (!currentFact) return;
    const normalizedCurrent = this.normalizeStringArray(currentFact.value);
    if (normalizedCurrent.length === 0) return;

    const normalizedPrevious = this.normalizeStringArray(previousValue);
    if (normalizedPrevious.length === 0) {
      onNormal(currentFact);
      return;
    }
    if (this.isSameStringArray(normalizedPrevious, normalizedCurrent)) {
      onNormal(currentFact);
      return;
    }
    onPending(currentFact);
  }

  private hasValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  private isSameScalarOrJsonValue = <T>(previousValue: T, currentValue: T): boolean => {
    if (typeof previousValue === 'boolean' || typeof currentValue === 'boolean') {
      return previousValue === currentValue;
    }
    if (typeof previousValue === 'object' || typeof currentValue === 'object') {
      return this.isSameJsonValue(previousValue, currentValue);
    }
    return String(previousValue).trim() === String(currentValue).trim();
  };

  private isSameJsonValue = <T>(previousValue: T, currentValue: T): boolean =>
    JSON.stringify(previousValue) === JSON.stringify(currentValue);

  private normalizeStringArray(values: string[] | null): string[] {
    if (!values?.length) return [];
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
  }

  private isSameStringArray(previousValue: string[], currentValue: string[]): boolean {
    if (previousValue.length !== currentValue.length) return false;
    return previousValue.every((value, index) => value === currentValue[index]);
  }

  private hasAnyFactLines(facts: EntityExtractionResult | HighConfidenceFacts): boolean {
    return formatExtractionFactLines(facts).length > 0;
  }

  private createEmptyHighConfidenceFacts(): HighConfidenceFacts {
    return {
      interview_info: {
        name: null,
        phone: null,
        gender: null,
        gender_source: null,
        age: null,
        applied_store: null,
        applied_position: null,
        interview_time: null,
        is_student: null,
        education: null,
        has_health_certificate: null,
        upload_resume: null,
      },
      preferences: {
        brands: null,
        salary: null,
        position: null,
        schedule: null,
        city: null,
        district: null,
        location: null,
        labor_form: null,
        delayed_intent: null,
        short_term: null,
        open_position: null,
        time_windows: null,
        schedule_constraint: null,
        available_after: null,
      },
      reasoning: '',
    };
  }
}

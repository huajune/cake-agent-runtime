import { Injectable, Logger } from '@nestjs/common';
import { MemoryService } from '@memory/memory.service';
import { SessionService } from '@memory/services/session.service';
import {
  EntityExtractionResultSchema,
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
  type InvitedGroupRecord,
  type RecommendedJobSummary,
} from '@memory/types/session-facts.types';
import type { ProceduralState } from '@memory/types/procedural.types';
import type { UserProfile } from '@memory/types/long-term.types';
import type { MemoryFixtureSetup, TestRuntimeScope } from '../types/test-debug-trace.types';

export interface MemoryFixtureSnapshot {
  readAt: string;
  sessionState: unknown;
  proceduralState: unknown;
}

@Injectable()
export class MemoryFixtureService {
  private readonly logger = new Logger(MemoryFixtureService.name);

  constructor(
    private readonly memoryService: MemoryService,
    private readonly sessionService: SessionService,
  ) {}

  async reset(scope: Pick<TestRuntimeScope, 'corpId' | 'userId' | 'sessionId'>): Promise<void> {
    await this.memoryService.clearSessionMemory(scope.corpId, scope.userId, scope.sessionId);
  }

  async cleanup(scope: Pick<TestRuntimeScope, 'corpId' | 'userId' | 'sessionId'>): Promise<void> {
    await this.reset(scope);
  }

  async seed(
    scope: Pick<TestRuntimeScope, 'corpId' | 'userId' | 'sessionId'>,
    setup?: MemoryFixtureSetup | null,
  ): Promise<void> {
    if (!setup) return;

    const facts = this.resolveSessionFacts(setup);
    if (facts) {
      await this.sessionService.saveFacts(scope.corpId, scope.userId, scope.sessionId, facts);
    }

    const lastCandidatePool = this.normalizeJobSummaries(setup.lastCandidatePool);
    if (lastCandidatePool.length) {
      await this.sessionService.saveLastCandidatePool(
        scope.corpId,
        scope.userId,
        scope.sessionId,
        lastCandidatePool,
      );
    }

    const presentedJobs = this.normalizeJobSummaries(setup.presentedJobs);
    if (presentedJobs.length) {
      await this.sessionService.savePresentedJobs(
        scope.corpId,
        scope.userId,
        scope.sessionId,
        presentedJobs,
      );
    }

    if (setup.currentFocusJob !== undefined) {
      await this.sessionService.saveCurrentFocusJob(
        scope.corpId,
        scope.userId,
        scope.sessionId,
        setup.currentFocusJob ? this.normalizeJobSummary(setup.currentFocusJob) : null,
      );
    }

    for (const group of this.normalizeInvitedGroups(setup.invitedGroups)) {
      await this.memoryService.saveInvitedGroup(scope.corpId, scope.userId, scope.sessionId, group);
    }

    if (setup.profile) {
      await this.memoryService.saveProfile(
        scope.corpId,
        scope.userId,
        setup.profile as Partial<UserProfile>,
        { contactName: 'test-suite-memory-fixture' },
      );
    }

    const proceduralState = this.resolveProceduralState(setup);
    if (proceduralState) {
      await this.memoryService.setStage(
        scope.corpId,
        scope.userId,
        scope.sessionId,
        proceduralState,
      );
    }
  }

  async read(
    scope: Pick<TestRuntimeScope, 'corpId' | 'userId' | 'sessionId'>,
  ): Promise<MemoryFixtureSnapshot> {
    const [sessionState, proceduralState] = await Promise.all([
      this.sessionService.getSessionState(scope.corpId, scope.userId, scope.sessionId),
      this.memoryService.getStage(scope.corpId, scope.userId, scope.sessionId),
    ]);

    return {
      readAt: new Date().toISOString(),
      sessionState,
      proceduralState,
    };
  }

  private resolveProceduralState(setup: MemoryFixtureSetup): ProceduralState | null {
    const procedural = setup.procedural ?? {};
    const currentStage =
      setup.currentStage !== undefined
        ? setup.currentStage
        : typeof procedural.currentStage === 'string' || procedural.currentStage === null
          ? procedural.currentStage
          : undefined;

    if (currentStage === undefined && Object.keys(procedural).length === 0) {
      return null;
    }

    const fromStage = procedural.fromStage;
    const advancedAt = procedural.advancedAt;
    const reason = procedural.reason;
    const state: ProceduralState = {
      currentStage: this.readNullableString(currentStage),
      fromStage: this.readNullableString(fromStage),
      advancedAt: this.readNullableString(advancedAt) ?? new Date().toISOString(),
      reason: this.readNullableString(reason) ?? 'test-suite-memory-fixture',
    };

    this.logger.debug(`Seed memory stage=${state.currentStage ?? '<null>'}`);
    return state;
  }

  private resolveSessionFacts(setup: MemoryFixtureSetup): EntityExtractionResult | null {
    const raw = this.mergeRecords(setup.facts, setup.sessionFacts);
    if (!raw) return null;

    if (this.isRecord(raw.interview_info) || this.isRecord(raw.preferences)) {
      return this.normalizeStructuredFacts(raw);
    }

    return this.normalizeFlatFacts(raw);
  }

  private normalizeStructuredFacts(raw: Record<string, unknown>): EntityExtractionResult {
    return EntityExtractionResultSchema.parse({
      ...raw,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        ...(this.isRecord(raw.interview_info) ? raw.interview_info : {}),
      },
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        ...(this.isRecord(raw.preferences) ? raw.preferences : {}),
      },
      reasoning: this.readString(raw, 'reasoning') ?? this.buildFixtureReasoning(raw),
    }) as EntityExtractionResult;
  }

  private normalizeFlatFacts(raw: Record<string, unknown>): EntityExtractionResult {
    return EntityExtractionResultSchema.parse({
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        name: this.readStringFromKeys(raw, ['name', 'candidateName', 'userName', 'contactName']),
        phone: this.readStringFromKeys(raw, ['phone', 'mobile', 'contactPhone']),
        gender: this.readString(raw, 'gender'),
        age: this.readString(raw, 'age'),
        applied_store: this.readStringFromKeys(raw, ['applied_store', 'appliedStore', 'storeName']),
        applied_position: this.readStringFromKeys(raw, [
          'applied_position',
          'appliedPosition',
          'positionName',
        ]),
        interview_time: this.readStringFromKeys(raw, ['interview_time', 'interviewTime']),
        is_student: this.readBooleanFromKeys(raw, ['is_student', 'isStudent']),
        education: this.readString(raw, 'education'),
        has_health_certificate: this.readStringFromKeys(raw, [
          'has_health_certificate',
          'healthCertificate',
        ]),
      },
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        brands: this.readStringArrayFromKeys(raw, ['brands', 'brandNames', 'brandName']),
        salary: this.readStringFromKeys(raw, ['salary', 'salaryDesc']),
        position: this.readStringArrayFromKeys(raw, ['position', 'positions']),
        schedule: this.readString(raw, 'schedule'),
        city: this.readStringFromKeys(raw, ['city', 'cityName']),
        district: this.readStringArrayFromKeys(raw, ['district', 'districts', 'regionName']),
        location: this.readStringArrayFromKeys(raw, ['location', 'locations', 'storeAddress']),
        labor_form: this.readStringFromKeys(raw, ['labor_form', 'laborForm']),
      },
      reasoning: this.buildFixtureReasoning(raw),
    }) as EntityExtractionResult;
  }

  private normalizeJobSummaries(items?: Record<string, unknown>[] | null): RecommendedJobSummary[] {
    return (items ?? [])
      .map((item) => this.normalizeJobSummary(item))
      .filter((item): item is RecommendedJobSummary => item !== null);
  }

  private normalizeJobSummary(raw: Record<string, unknown>): RecommendedJobSummary | null {
    const jobId = this.readNumberFromKeys(raw, ['jobId', 'job_id', 'id']);
    if (jobId === null) return null;

    return {
      jobId,
      brandName: this.readStringFromKeys(raw, ['brandName', 'brand_name']),
      jobName: this.readStringFromKeys(raw, ['jobName', 'job_name', 'positionName']),
      storeName: this.readStringFromKeys(raw, ['storeName', 'store_name']),
      storeAddress: this.readStringFromKeys(raw, ['storeAddress', 'store_address']),
      cityName: this.readStringFromKeys(raw, ['cityName', 'city_name', 'city']),
      regionName: this.readStringFromKeys(raw, ['regionName', 'region_name', 'district']),
      laborForm: this.readStringFromKeys(raw, ['laborForm', 'labor_form']),
      salaryDesc: this.readStringFromKeys(raw, ['salaryDesc', 'salary_desc', 'salary']),
      jobCategoryName: this.readStringFromKeys(raw, ['jobCategoryName', 'job_category_name']),
      ageRequirement: this.readStringFromKeys(raw, ['ageRequirement', 'age_requirement']),
      educationRequirement: this.readStringFromKeys(raw, [
        'educationRequirement',
        'education_requirement',
      ]),
      healthCertificateRequirement: this.readStringFromKeys(raw, [
        'healthCertificateRequirement',
        'health_certificate_requirement',
      ]),
      studentRequirement: this.readStringFromKeys(raw, [
        'studentRequirement',
        'student_requirement',
      ]),
      distanceKm: this.readNumberFromKeys(raw, ['distanceKm', 'distance_km']),
    };
  }

  private normalizeInvitedGroups(items?: Record<string, unknown>[] | null): InvitedGroupRecord[] {
    return (items ?? [])
      .map((item) => this.normalizeInvitedGroup(item))
      .filter((item): item is InvitedGroupRecord => item !== null);
  }

  private normalizeInvitedGroup(raw: Record<string, unknown>): InvitedGroupRecord | null {
    const groupName = this.readStringFromKeys(raw, ['groupName', 'name']);
    if (!groupName) return null;

    return {
      groupName,
      city: this.readStringFromKeys(raw, ['city', 'cityName']) ?? '',
      industry: this.readString(raw, 'industry') ?? undefined,
      invitedAt: this.readString(raw, 'invitedAt') ?? new Date().toISOString(),
    };
  }

  private mergeRecords(
    first?: Record<string, unknown> | null,
    second?: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {};
    if (this.isRecord(first)) {
      Object.assign(merged, first);
    }
    if (this.isRecord(second)) {
      Object.assign(merged, second);
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }

  private buildFixtureReasoning(raw: Record<string, unknown>): string {
    const source = this.readString(raw, 'source') ?? 'test-suite-memory-fixture';
    const anchor =
      this.readString(raw, 'anchorUserMessage') ?? this.readString(raw, 'lastUserMessage');
    return anchor ? `${source}: ${anchor}` : source;
  }

  private readStringFromKeys(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = this.readString(record, key);
      if (value !== null) return value;
    }
    return null;
  }

  private readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }

  private readStringArrayFromKeys(
    record: Record<string, unknown>,
    keys: string[],
  ): string[] | null {
    for (const key of keys) {
      const value = this.readStringArray(record[key]);
      if (value !== null) return value;
    }
    return null;
  }

  private readStringArray(value: unknown): string[] | null {
    if (Array.isArray(value)) {
      const values = value
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (typeof item === 'number' && Number.isFinite(item)) return String(item);
          return '';
        })
        .filter(Boolean);
      return values.length ? values : null;
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
    return null;
  }

  private readBooleanFromKeys(record: Record<string, unknown>, keys: string[]): boolean | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', 'yes', '是', '学生'].includes(normalized)) return true;
        if (['false', 'no', '否', '不是', '非学生'].includes(normalized)) return false;
      }
    }
    return null;
  }

  private readNumberFromKeys(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = record[key];
      const parsed =
        typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private readNullableString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value === null) return null;
    return null;
  }
}

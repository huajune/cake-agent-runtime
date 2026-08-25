import { Injectable } from '@nestjs/common';
import type { SessionFacts, WeworkSessionState } from './short-term.types';
import { SessionFactsService } from './facts.service';
import { SessionWorkbenchService } from './workbench.service';

/**
 * session-state 聚合 facade（M3 分家后保留，M5 正名）
 *
 * 实现按 CoALA 两舱拆分并在 short-term 层内平铺：事实舱 facts.service
 * （semantic：状态所有者/事实读写/提取/已发生事件）与工作台舱 workbench.service
 * （working state：候选池/已展示/焦点岗位/查询签名）。本类只做 1:1 委托，公共 API 不变。
 * 外部不应该直接拼 Redis key 读写 `facts:*`，也不应把岗位投影逻辑散落到别处。
 */
@Injectable()
export class SessionStateService {
  constructor(
    private readonly facts: SessionFactsService,
    private readonly workbench: SessionWorkbenchService,
  ) {}

  // ---- 事实舱委托 ----
  getSessionState(corpId: string, userId: string, sessionId: string): Promise<WeworkSessionState> {
    return this.facts.getSessionState(corpId, userId, sessionId);
  }
  clearSessionState(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    return this.facts.clearSessionState(corpId, userId, sessionId);
  }
  getFacts(corpId: string, userId: string, sessionId: string): Promise<SessionFacts | null> {
    return this.facts.getFacts(corpId, userId, sessionId);
  }
  getReengagementState(
    ...args: Parameters<SessionFactsService['getReengagementState']>
  ): ReturnType<SessionFactsService['getReengagementState']> {
    return this.facts.getReengagementState(...args);
  }
  saveFacts(...args: Parameters<SessionFactsService['saveFacts']>) {
    return this.facts.saveFacts(...args);
  }
  saveCollectionProgressFact(
    ...args: Parameters<SessionFactsService['saveCollectionProgressFact']>
  ) {
    return this.facts.saveCollectionProgressFact(...args);
  }
  saveCompletedCollectionFacts(
    ...args: Parameters<SessionFactsService['saveCompletedCollectionFacts']>
  ) {
    return this.facts.saveCompletedCollectionFacts(...args);
  }
  saveToolAttestedCity(...args: Parameters<SessionFactsService['saveToolAttestedCity']>) {
    return this.facts.saveToolAttestedCity(...args);
  }
  saveInvitedGroup(...args: Parameters<SessionFactsService['saveInvitedGroup']>) {
    return this.facts.saveInvitedGroup(...args);
  }
  saveTerminalState(...args: Parameters<SessionFactsService['saveTerminalState']>) {
    return this.facts.saveTerminalState(...args);
  }
  recordCandidateActivity(...args: Parameters<SessionFactsService['recordCandidateActivity']>) {
    return this.facts.recordCandidateActivity(...args);
  }
  recordCandidateMessagesProcessed(
    ...args: Parameters<SessionFactsService['recordCandidateMessagesProcessed']>
  ) {
    return this.facts.recordCandidateMessagesProcessed(...args);
  }
  extractAndSave(...args: Parameters<SessionFactsService['extractAndSave']>) {
    return this.facts.extractAndSave(...args);
  }

  // ---- 工作台舱委托 ----
  saveLastCandidatePool(...args: Parameters<SessionWorkbenchService['saveLastCandidatePool']>) {
    return this.workbench.saveLastCandidatePool(...args);
  }
  saveLastJobListQuery(...args: Parameters<SessionWorkbenchService['saveLastJobListQuery']>) {
    return this.workbench.saveLastJobListQuery(...args);
  }
  savePresentedJobs(...args: Parameters<SessionWorkbenchService['savePresentedJobs']>) {
    return this.workbench.savePresentedJobs(...args);
  }
  dropInvalidatedJobs(...args: Parameters<SessionWorkbenchService['dropInvalidatedJobs']>) {
    return this.workbench.dropInvalidatedJobs(...args);
  }
  saveCurrentFocusJob(...args: Parameters<SessionWorkbenchService['saveCurrentFocusJob']>) {
    return this.workbench.saveCurrentFocusJob(...args);
  }
  projectAssistantTurn(...args: Parameters<SessionWorkbenchService['projectAssistantTurn']>) {
    return this.workbench.projectAssistantTurn(...args);
  }
}

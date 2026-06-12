import type {
  AddCandidateBlacklistParams,
  CandidateBlacklistItem,
} from '../types/candidate-blacklist.types';
import { api, unwrapResponse } from '../client';

// ==================== 候选人黑名单 API ====================

export async function getCandidateBlacklist() {
  const { data } = await api.get('/candidate-blacklist');
  return unwrapResponse<{ candidates: CandidateBlacklistItem[] }>(data);
}

export async function addCandidateToBlacklist(params: AddCandidateBlacklistParams) {
  const { data } = await api.post('/candidate-blacklist', params);
  return unwrapResponse<{ message: string }>(data);
}

export async function removeCandidateFromBlacklist(params: { targetId: string }) {
  const { data } = await api.delete('/candidate-blacklist', { data: params });
  return unwrapResponse<{ message: string }>(data);
}

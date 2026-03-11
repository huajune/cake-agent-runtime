export interface WorkerStatus {
  concurrency: number;
  activeJobs: number;
  minConcurrency: number;
  maxConcurrency: number;
  messageMergeEnabled: boolean;
}

export interface WorkerConcurrencyResponse {
  success: boolean;
  message: string;
  concurrency: number;
}

export interface GroupInfo {
  id: string;
  name: string;
  description: string;
}

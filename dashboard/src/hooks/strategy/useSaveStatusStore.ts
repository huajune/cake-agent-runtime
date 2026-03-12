import { create } from 'zustand';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SaveStatusStore {
  status: SaveStatus;
  setStatus: (status: SaveStatus) => void;
}

let resetTimer: ReturnType<typeof setTimeout> | null = null;

export const useSaveStatusStore = create<SaveStatusStore>((set) => ({
  status: 'idle',
  setStatus: (status) => {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    set({ status });
    if (status === 'saved') {
      resetTimer = setTimeout(() => set({ status: 'idle' }), 2000);
    }
  },
}));

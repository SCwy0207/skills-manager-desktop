import { create } from "zustand";

import { translateNow } from "../i18n/i18n";
import type {
  Section,
  SessionArchiveFilter,
  SkillAgentFilter,
  SkillScopeFilter,
  SkillStatusFilter,
} from "../types";

interface UiState {
  section: Section;
  setSection: (section: Section) => void;
  contextProjectId: string;
  setContextProjectId: (id: string) => void;
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  sessionQuery: string;
  setSessionQuery: (value: string) => void;
  sessionArchiveFilter: SessionArchiveFilter;
  setSessionArchiveFilter: (value: SessionArchiveFilter) => void;
  selectedSkillId: string | null;
  setSelectedSkillId: (id: string | null) => void;
  selectedSkillFile: string;
  setSelectedSkillFile: (path: string) => void;
  skillQuery: string;
  setSkillQuery: (value: string) => void;
  skillAgentFilter: SkillAgentFilter;
  setSkillAgentFilter: (value: SkillAgentFilter) => void;
  skillScopeFilter: SkillScopeFilter;
  setSkillScopeFilter: (value: SkillScopeFilter) => void;
  skillStatusFilter: SkillStatusFilter;
  setSkillStatusFilter: (value: SkillStatusFilter) => void;
  skillEditorDirty: boolean;
  setSkillEditorDirty: (dirty: boolean) => void;
  criticalOperations: Record<string, string>;
  beginCriticalOperation: (id: string, label: string) => void;
  endCriticalOperation: (id: string) => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
}

function canDiscardSkillChanges(dirty: boolean) {
  return (
    !dirty ||
    typeof window === "undefined" ||
    window.confirm(translateNow("app.confirm.discardSkill"))
  );
}

export const useUiStore = create<UiState>((set, get) => ({
  section: "skills",
  setSection: (section) => {
    const current = get();
    if (current.section === section || !canDiscardSkillChanges(current.skillEditorDirty)) return;
    set({ section, skillEditorDirty: false });
  },
  contextProjectId: "all",
  setContextProjectId: (contextProjectId) => {
    const current = get();
    if (
      current.contextProjectId === contextProjectId ||
      !canDiscardSkillChanges(current.skillEditorDirty)
    ) return;
    set({ contextProjectId, skillEditorDirty: false });
  },
  selectedSessionId: null,
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  sessionQuery: "",
  setSessionQuery: (sessionQuery) => set({ sessionQuery }),
  sessionArchiveFilter: "active",
  setSessionArchiveFilter: (sessionArchiveFilter) => set({ sessionArchiveFilter }),
  selectedSkillId: null,
  setSelectedSkillId: (selectedSkillId) => {
    const current = get();
    if (
      current.selectedSkillId === selectedSkillId ||
      !canDiscardSkillChanges(current.skillEditorDirty)
    ) return;
    set({ selectedSkillId, selectedSkillFile: "SKILL.md", skillEditorDirty: false });
  },
  selectedSkillFile: "SKILL.md",
  setSelectedSkillFile: (selectedSkillFile) => set({ selectedSkillFile }),
  skillQuery: "",
  setSkillQuery: (skillQuery) => set({ skillQuery }),
  skillAgentFilter: "all",
  setSkillAgentFilter: (skillAgentFilter) => set({ skillAgentFilter }),
  skillScopeFilter: "all",
  setSkillScopeFilter: (skillScopeFilter) => set({ skillScopeFilter }),
  skillStatusFilter: "all",
  setSkillStatusFilter: (skillStatusFilter) => set({ skillStatusFilter }),
  skillEditorDirty: false,
  setSkillEditorDirty: (skillEditorDirty) => set({ skillEditorDirty }),
  criticalOperations: {},
  beginCriticalOperation: (id, label) =>
    set((state) => ({
      criticalOperations: { ...state.criticalOperations, [id]: label },
    })),
  endCriticalOperation: (id) =>
    set((state) => {
      const criticalOperations = { ...state.criticalOperations };
      delete criticalOperations[id];
      return { criticalOperations };
    }),
  addProjectOpen: false,
  setAddProjectOpen: (addProjectOpen) => set({ addProjectOpen }),
}));

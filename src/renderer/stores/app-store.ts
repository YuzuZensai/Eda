import { errorText } from "@shared/error-codes";
import type { GitErrorData } from "@shared/errors";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import type { RepositorySummary } from "@shared/repository/repository";
import { create } from "zustand";
import { useLayoutStore } from "./layout-store";
import { usePreferencesStore } from "./preferences-store";
import { useRepositoryStore } from "./repository-store";
import { useSessionStore } from "./session-store";

interface AppState {
  identities: Identity[];
  activeIdentity: Identity | null;
  repositories: RepositorySummary[];
  selectedRepositoryId: string | null;
  openTabsByIdentity: Record<string, string[]>;
  closedTabsByIdentity: Record<string, { id: string; index: number }[]>;
  gitEngine: { source: string; path: string; version: string } | null;
  error: GitErrorData | null;
  loading: boolean;
  switchingIdentityId: string | null;

  initialize: () => Promise<void>;
  refreshIdentities: (startup?: boolean) => Promise<void>;
  refreshRepositories: () => Promise<void>;
  setActiveIdentity: (id: string) => Promise<void>;
  selectRepository: (id: string | null, background?: boolean) => void;
  closeTab: (id: string) => void;
  moveTab: (id: string, index: number) => void;
  reopenTab: () => void;
  createIdentity: (
    draft: Parameters<typeof window.eda.identity.create>[0],
    options?: Parameters<typeof window.eda.identity.create>[1],
    onError?: (error: GitErrorData) => void,
  ) => Promise<boolean>;
  updateIdentity: (
    id: string,
    draft: Parameters<typeof window.eda.identity.update>[1],
    onError?: (error: GitErrorData) => void,
  ) => Promise<boolean>;
  deleteIdentity: (id: string, token: string) => Promise<boolean>;
  addRepository: () => Promise<void>;
  dismissError: () => void;
}

let initialization: Promise<void> | null = null;
let subscriptionsInstalled = false;
let identityRefreshGeneration = 0;
let repositoryRefreshGeneration = 0;
let latestRepositoryRefresh: Promise<void>;

export const useAppStore = create<AppState>((set, get) => ({
  identities: [],
  activeIdentity: null,
  repositories: [],
  selectedRepositoryId: null,
  openTabsByIdentity: {},
  closedTabsByIdentity: {},
  gitEngine: null,
  error: null,
  loading: true,
  switchingIdentityId: null,

  async initialize() {
    if (initialization) return initialization;

    initialization = (async () => {
      const engine = await window.eda.app.getGitEngine();

      if (engine.ok) set({ gitEngine: engine.value });
      else set({ error: engine.error });

      await get().refreshIdentities(true);
      await get().refreshRepositories();
      set({ loading: false });

      if (!subscriptionsInstalled) {
        subscriptionsInstalled = true;
        window.eda.events.onFlushRequested((nonce) => {
          void useSessionStore
            .getState()
            .flush()
            .then((saved) => {
              if (saved) void window.eda.sessions.readyToClose(nonce);
            });
        });
        window.eda.events.onIdentityChanged(() => {
          if (get().switchingIdentityId !== null) return;
          void (async () => {
            await get().refreshIdentities();
            await get().refreshRepositories();
          })();
        });
        window.eda.events.onSettingChanged((change) => {
          if (get().switchingIdentityId !== null) return;
          const { activeIdentity, selectedRepositoryId } = get();

          if (change.scope.kind !== "application" && change.scope.profileId !== activeIdentity?.id)
            return;

          if (change.key === "accentHue") {
            usePreferencesStore.getState().onChange(change, get().refreshIdentities());
            return;
          }

          if (change.key === "showInternalRefs") void useRepositoryStore.getState().syncFromDisk();

          const prefs = usePreferencesStore.getState();
          prefs.onChange(
            change,
            prefs.load({
              ...(activeIdentity ? { profileId: activeIdentity.id } : {}),
              ...(selectedRepositoryId ? { repositoryId: selectedRepositoryId } : {}),
            }),
          );
        });
        window.eda.events.onRepositoriesChanged(() => {
          if (get().switchingIdentityId !== null) return;
          void get().refreshRepositories();
        });
        window.eda.events.onRepositoryChanged((repositoryId, warning) => {
          const repository = useRepositoryStore.getState();
          if (repository.repositoryId !== repositoryId || repository.writing) return;
          if (warning) useRepositoryStore.setState({ watchWarning: warning });
          void repository.syncFromDisk();
        });
      }
    })();

    return initialization;
  },

  async refreshIdentities(startup = false) {
    const generation = ++identityRefreshGeneration;
    const current = () => generation === identityRefreshGeneration;
    const [list, active] = await Promise.all([
      window.eda.identity.list(),
      window.eda.identity.getActive(),
    ]);

    if (!current()) return;
    const failed = !list.ok ? list : !active.ok ? active : null;
    if (failed) {
      if (startup) throw new GitError(failed.error);
      set({ error: failed.error });
      return;
    }
    if (list.ok) set({ identities: list.value });

    if (active.ok) {
      if (useSessionStore.getState().snapshot?.context.profileId !== active.value?.id) {
        if (!(await useSessionStore.getState().load())) return;
      }

      if (!current()) return;
      if (useSessionStore.getState().snapshot?.context.profileId !== active.value?.id) return;

      const context = usePreferencesStore.getState().context;

      await usePreferencesStore.getState().load(
        active.value
          ? {
              profileId: active.value.id,
              ...(context.profileId === active.value.id && context.repositoryId
                ? { repositoryId: context.repositoryId }
                : {}),
            }
          : {},
      );
      if (current()) set({ activeIdentity: active.value });
    }
  },

  refreshRepositories() {
    const generation = ++repositoryRefreshGeneration;
    const expectedIdentity = get().activeIdentity?.id;
    latestRepositoryRefresh = window.eda.repository.list().then((result): void | Promise<void> => {
      if (get().activeIdentity?.id !== expectedIdentity) return;
      if (generation !== repositoryRefreshGeneration) return latestRepositoryRefresh;

      if (!result.ok) {
        set({ error: result.error });
        return;
      }

      const saved = useSessionStore.getState().snapshot;
      const ownedSession = saved?.context.profileId === expectedIdentity ? saved : null;
      const savedSelection = ownedSession
        ? ownedSession.session.selectedRepositoryId
        : get().selectedRepositoryId;
      const stillPresent = result.value.some((r) => r.id === savedSelection);
      const selectedRepositoryId = stillPresent
        ? savedSelection
        : ownedSession
          ? null
          : (result.value[0]?.id ?? null);

      const identityId = get().activeIdentity?.id;
      let openTabsByIdentity = get().openTabsByIdentity;

      if (identityId !== undefined) {
        const live = new Set(result.value.map((r) => r.id));
        const kept = (
          ownedSession ? ownedSession.session.tabs : (openTabsByIdentity[identityId] ?? [])
        ).filter((id) => live.has(id));
        const withSelection =
          selectedRepositoryId && !kept.includes(selectedRepositoryId)
            ? [...kept, selectedRepositoryId]
            : kept;

        openTabsByIdentity = { ...openTabsByIdentity, [identityId]: withSelection };
      }

      set({ repositories: result.value, selectedRepositoryId, openTabsByIdentity });
      restoreLayout(selectedRepositoryId);
    });
    return latestRepositoryRefresh;
  },

  selectRepository(id, background = false) {
    if (get().switchingIdentityId !== null) return;
    if (id !== null && !get().repositories.some((repository) => repository.id === id)) return;
    if (background && (id === null || !get().repositories.some((r) => r.id === id && r.available)))
      return;
    if (!background && id !== get().selectedRepositoryId) useRepositoryStore.getState().clear();

    const identityId = get().activeIdentity?.id;

    if (id === null || identityId === undefined) {
      set({ selectedRepositoryId: id });
      saveTabs(get());
      restoreLayout(id);
      return;
    }

    const open = get().openTabsByIdentity[identityId] ?? [];

    set({
      ...(!background && { selectedRepositoryId: id }),
      ...(open.includes(id)
        ? {}
        : { openTabsByIdentity: { ...get().openTabsByIdentity, [identityId]: [...open, id] } }),
    });
    saveTabs(get());
    if (!background) restoreLayout(id);
  },

  closeTab(id) {
    if (get().switchingIdentityId !== null) return;

    const identityId = get().activeIdentity?.id;

    if (identityId === undefined) return;

    const open = get().openTabsByIdentity[identityId] ?? [];
    const index = open.indexOf(id);

    if (index < 0) return;

    const remaining = open.filter((tabId) => tabId !== id);
    const wasSelected = get().selectedRepositoryId === id;
    const next = remaining[Math.min(index, remaining.length - 1)] ?? null;

    if (wasSelected) useRepositoryStore.getState().clear();

    set({
      openTabsByIdentity: { ...get().openTabsByIdentity, [identityId]: remaining },
      closedTabsByIdentity: {
        ...get().closedTabsByIdentity,
        [identityId]: [
          ...(get().closedTabsByIdentity[identityId] ?? []).filter((tab) => tab.id !== id),
          { id, index },
        ].slice(-50),
      },
      ...(wasSelected && { selectedRepositoryId: next }),
    });
    saveTabs(get());

    if (wasSelected) restoreLayout(next);
  },

  moveTab(id, index) {
    const identityId = get().activeIdentity?.id;

    if (!identityId || get().switchingIdentityId !== null || !Number.isInteger(index)) return;

    const tabs = [...(get().openTabsByIdentity[identityId] ?? [])];
    const previous = tabs.indexOf(id);

    if (previous < 0) return;

    tabs.splice(previous, 1);
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, id);
    set({ openTabsByIdentity: { ...get().openTabsByIdentity, [identityId]: tabs } });
    saveTabs(get());
  },

  reopenTab() {
    const identityId = get().activeIdentity?.id;

    if (!identityId || get().switchingIdentityId !== null) return;

    const open = get().openTabsByIdentity[identityId] ?? [];
    const closed = (get().closedTabsByIdentity[identityId] ?? []).filter(
      (tab) => !open.includes(tab.id) && get().repositories.some((r) => r.id === tab.id),
    );
    const tab = closed.pop();

    set({ closedTabsByIdentity: { ...get().closedTabsByIdentity, [identityId]: closed } });

    if (!tab) return;

    get().selectRepository(tab.id);
    get().moveTab(tab.id, tab.index);
  },

  async setActiveIdentity(id) {
    try {
      await transitionProfile(id, async () => {
        const result = await window.eda.identity.setActive(id);
        if (!result.ok) {
          set({ error: result.error });
          return false;
        }

        if (result.value.session)
          useSessionStore.setState({ snapshot: result.value.session, error: null });
        set({ selectedRepositoryId: null });
        return true;
      });
    } catch {
      set({
        error: new GitError({
          kind: "unknown",
          operation: t("operations.switchProfile"),
          message: errorText("errors.unexpected"),
        }).toData(),
      });
    }
  },

  async createIdentity(draft, options, onError) {
    const result = await window.eda.identity.create(draft, options);

    if (!result.ok) {
      if (onError) onError(result.error);
      else set({ error: result.error });
      return false;
    }

    await get().refreshIdentities();
    await get().setActiveIdentity(result.value.id);

    return get().activeIdentity?.id === result.value.id;
  },

  async updateIdentity(id, draft, onError) {
    if (!(await useSessionStore.getState().flush())) return false;

    const result = await window.eda.identity.update(id, draft);

    if (!result.ok) {
      if (onError) onError(result.error);
      else set({ error: result.error });
      return false;
    }

    await get().refreshIdentities();

    return true;
  },

  async deleteIdentity(id, token) {
    return transitionProfile(id, async () => {
      const result = await window.eda.identity.delete(id, token);
      if (!result.ok) set({ error: result.error });
      return result.ok;
    });
  },

  async addRepository() {
    const profileId = get().activeIdentity?.id;
    const context = useSessionStore.getState().snapshot?.context;
    const current = () =>
      get().activeIdentity?.id === profileId &&
      get().switchingIdentityId === null &&
      useSessionStore.getState().snapshot?.context === context;

    if (!current()) return;
    const chosen = await window.eda.repository.chooseFolder();
    if (!current()) return;
    if (!chosen.ok) {
      set({ error: chosen.error });
      return;
    }

    if (chosen.value === null) return;

    const opened = await window.eda.repository.open(chosen.value);
    if (!current()) return;

    if (!opened.ok) {
      set({ error: opened.error });
      return;
    }

    await get().refreshRepositories();
    if (current()) get().selectRepository(opened.value.id);
  },

  dismissError() {
    set({ error: null });
  },
}));

async function transitionProfile(id: string, change: () => Promise<boolean>): Promise<boolean> {
  const app = useAppStore.getState();
  if (app.switchingIdentityId !== null) return false;

  identityRefreshGeneration++;
  useAppStore.setState({ switchingIdentityId: id });
  useSessionStore.setState({ transitioning: true });
  try {
    if (!(await useSessionStore.getState().flush()) || !(await change())) return false;

    useRepositoryStore.getState().clear();
    await app.refreshIdentities();
    await app.refreshRepositories();
    return true;
  } finally {
    useSessionStore.setState({ transitioning: false });
    useAppStore.setState({ switchingIdentityId: null });
  }
}

function saveTabs(state: AppState): void {
  const profileId = state.activeIdentity?.id;

  if (!profileId || profileId !== useSessionStore.getState().snapshot?.context.profileId) return;

  useSessionStore.getState().change({
    kind: "tabs",
    tabs: state.openTabsByIdentity[profileId] ?? [],
    selectedRepositoryId: state.selectedRepositoryId,
  });
}

function restoreLayout(repositoryId: string | null): void {
  useLayoutStore
    .getState()
    .restore(
      repositoryId ? useSessionStore.getState().snapshot?.session.views[repositoryId] : undefined,
    );
}

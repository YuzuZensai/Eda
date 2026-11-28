import { errorMessage, type Result } from "@shared/errors";
import {
  emptyView,
  sharedLayout,
  updateSessionView,
  type CommitDraft,
  type RepositoryView,
  type SessionChange,
  type SessionSnapshot,
} from "@shared/identity/profile-session";
import { create } from "zustand";

interface SessionState {
  snapshot: SessionSnapshot | null;
  error: string | null;
  saving: boolean;
  transitioning: boolean;
  draftRevisions: Record<string, number>;
  load: () => Promise<boolean>;
  change: (change: SessionChange) => void;
  setView: (repositoryId: string, patch: Partial<RepositoryView>) => void;
  setDraft: (repositoryId: string, draft: CommitDraft) => void;
  flush: () => Promise<boolean>;
  reset: () => Promise<boolean>;
}

interface PendingChange {
  context: SessionSnapshot["context"];
  change: SessionChange;
}

const pending: PendingChange[] = [];
let worker: Promise<boolean> | null = null;
let loadGeneration = 0;

function replaceRejectedChange(rejected: PendingChange): boolean {
  const previous = rejected.change;
  let shareLayout = previous.kind === "view" && previous.shareLayout;
  for (const next of pending) {
    if (next === rejected || next.context !== rejected.context) continue;
    const change = next.change;
    if (change.kind === "tabs") {
      if (previous.kind === "tabs") return true;
      continue;
    }
    if (previous.kind === change.kind && previous.repositoryId === change.repositoryId) {
      // A corrected local view must also persist any outstanding shared layout.
      if (shareLayout && change.kind === "view") next.change = { ...change, shareLayout: true };
      return true;
    }
    if (change.kind === "view" && change.shareLayout) shareLayout = false;
  }
  return false;
}

async function restoreSession(
  read: () => Promise<Result<SessionSnapshot | null>>,
  current: () => boolean,
): Promise<boolean> {
  try {
    const result = await read();
    if (!current()) return false;
    if (result.ok) useSessionStore.setState({ snapshot: result.value, error: null });
    else useSessionStore.setState({ error: errorMessage(result.error) });
    return result.ok;
  } catch (error) {
    if (current()) useSessionStore.setState({ error: errorMessage(error) });
    return false;
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  snapshot: null,
  error: null,
  saving: false,
  transitioning: false,
  draftRevisions: {},
  async load() {
    const generation = ++loadGeneration;
    const context = get().snapshot?.context;
    const current = () => generation === loadGeneration && get().snapshot?.context === context;

    if (!(await get().flush()) || !current()) return false;
    return restoreSession(() => window.eda.sessions.open(), current);
  },
  change(change) {
    const snapshot = get().snapshot;

    if (!snapshot || snapshot.recovery || get().transitioning) return;

    const next = { ...snapshot };
    let draftRevisions = get().draftRevisions;

    if (change.kind === "tabs") {
      const { selectedRepositoryId, views } = snapshot.session;
      const previous =
        (selectedRepositoryId ? views[selectedRepositoryId] : undefined) ?? Object.values(views)[0];
      const id = change.selectedRepositoryId;
      next.session = { ...snapshot.session, tabs: change.tabs, selectedRepositoryId: id };

      if (previous && id && views[id] !== previous) {
        const view = { ...(views[id] ?? emptyView()), ...sharedLayout(previous) };
        next.session.views = { ...views, [id]: view };
        pending.push({
          context: snapshot.context,
          change: { kind: "view", repositoryId: id, view },
        });
      }
    } else if (change.kind === "view") {
      next.session = {
        ...snapshot.session,
        views: updateSessionView(snapshot.session.views, change),
      };
    } else {
      next.drafts = { ...snapshot.drafts, [change.repositoryId]: change.draft };
      const key = `${snapshot.context.profileId}:${change.repositoryId}`;
      draftRevisions = { ...draftRevisions, [key]: (draftRevisions[key] ?? 0) + 1 };
    }

    pending.push({ context: snapshot.context, change });
    set({ snapshot: next, draftRevisions });
    void get().flush();
  },
  setView(repositoryId, patch) {
    const previous = get().snapshot?.session.views[repositoryId] ?? emptyView();
    const view = { ...previous, ...patch };
    const presentationChanged = ["maximized", "collapsed", "splits", "references"].some((key) =>
      Object.hasOwn(patch, key),
    );

    get().change({
      kind: "view",
      repositoryId,
      view,
      ...(presentationChanged && { shareLayout: true }),
    });
  },
  setDraft(repositoryId, draft) {
    get().change({ kind: "draft", repositoryId, draft });
  },
  async flush() {
    if (worker) return worker;
    if (!pending.length) return true;

    worker = Promise.resolve()
      .then(async () => {
        try {
          while (pending.length) {
            const item = pending[0]!;
            const result = await window.eda.sessions.change(item.context, item.change);

            if (!result.ok) {
              // Each session change carries the full value for its destination.
              if (result.error.kind === "invalid-input" && replaceRejectedChange(item)) {
                pending.shift();
                continue;
              }

              set({ error: errorMessage(result.error) });
              return false;
            }

            pending.shift();
          }

          return true;
        } catch (error) {
          set({ error: errorMessage(error) });
          return false;
        } finally {
          worker = null;
          set({ saving: false });
        }
      })
      .then((saved) => {
        // A subscriber can queue another edit when saving turns false.
        if (saved && worker) return worker;
        return saved && pending.length === 0;
      });
    set({ saving: true, error: null });
    return worker;
  },
  async reset() {
    const generation = loadGeneration;
    const context = get().snapshot?.context;

    if (!context || pending.length || get().transitioning) return false;

    return restoreSession(
      () => window.eda.sessions.reset(context),
      () => generation === loadGeneration && get().snapshot?.context === context,
    );
  },
}));

import { emptyDraft, type CommitDraft } from "@shared/identity/profile-session";
import { splitCommitMessage } from "@shared/repository/commit-message";
import { useMemo } from "react";
import { useAppStore } from "../../stores/app-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { useSessionStore } from "../../stores/session-store";

const blank = emptyDraft();

export function useCommitMessage(pending: boolean) {
  const snapshot = useSessionStore((state) => state.snapshot);
  const transitioning = useSessionStore((state) => state.transitioning);
  const context = snapshot?.context;
  const repositoryId = snapshot?.session.selectedRepositoryId;

  const matchesSelection = (app: ReturnType<typeof useAppStore.getState>) =>
    app.selectedRepositoryId === repositoryId &&
    app.activeIdentity?.id === context?.profileId &&
    app.switchingIdentityId === null;
  const repositoryGeneration = (repository: ReturnType<typeof useRepositoryStore.getState>) =>
    repository.repositoryId === repositoryId &&
    repository.identityId === context?.profileId &&
    repository.phase === "ready"
      ? repository.generation
      : null;

  const selected = useAppStore(matchesSelection);
  const generation = useRepositoryStore(repositoryGeneration);
  const disabled = pending || transitioning || !!snapshot?.recovery || !selected;
  const owner = useMemo(
    () =>
      !disabled && context && repositoryId && generation !== null
        ? { context, repositoryId, generation }
        : null,
    [disabled, context, repositoryId, generation],
  );
  const draft = (selected && repositoryId && snapshot?.drafts[repositoryId]) || blank;
  const { message } = draft;
  const { title, messageTail } = splitCommitMessage(message);

  const getCurrentDraft = () => {
    const session = useSessionStore.getState();
    if (
      !owner ||
      session.transitioning ||
      session.snapshot?.recovery ||
      session.snapshot?.context !== owner.context ||
      session.snapshot.session.selectedRepositoryId !== owner.repositoryId ||
      !matchesSelection(useAppStore.getState()) ||
      repositoryGeneration(useRepositoryStore.getState()) !== owner.generation
    )
      return;

    return session.snapshot.drafts[owner.repositoryId] ?? blank;
  };

  const updateDraft = (patch: Partial<CommitDraft>) => {
    const latest = getCurrentDraft();
    if (owner && latest)
      useSessionStore.getState().setDraft(owner.repositoryId, { ...latest, ...patch });
  };

  return {
    owner,
    draft,
    message,
    title,
    messageTail,
    getCurrentDraft,
    updateDraft,
    setMessage: (message: string) => updateDraft({ message }),
    disabled: !owner,
  };
}

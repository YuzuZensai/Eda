import { emptyDraft } from "@shared/identity/profile-session";
import { splitCommitMessage } from "@shared/repository/commit-message";
import { useAppStore } from "../../stores/app-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { useSessionStore } from "../../stores/session-store";

export function useCommitMessage(pending: boolean) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const selectedId = useAppStore((state) => state.selectedRepositoryId);
  const snapshot = useSessionStore((state) => state.snapshot);
  const transitioning = useSessionStore((state) => state.transitioning);

  const draft = (selectedId && snapshot?.drafts[selectedId]) || emptyDraft();
  const { message } = draft;
  const { title, messageTail } = splitCommitMessage(message);
  const disabled =
    pending ||
    !repositoryId ||
    repositoryId !== selectedId ||
    !snapshot ||
    !!snapshot.recovery ||
    transitioning;

  const setMessage = (message: string) => {
    if (!disabled && repositoryId)
      useSessionStore.getState().setDraft(repositoryId, { ...draft, message });
  };

  return {
    snapshot,
    transitioning,
    draft,
    message,
    title,
    messageTail,
    setMessage,
    disabled,
  };
}

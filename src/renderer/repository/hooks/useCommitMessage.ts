import { emptyDraft } from "@shared/identity/profile-session";
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
  const firstBreak = message.indexOf("\n");
  const title = firstBreak < 0 ? message : message.slice(0, firstBreak).replace(/\r$/, "");
  const messageTail = firstBreak < 0 ? "" : message.slice(firstBreak);
  const description = messageTail.replace(/^\r?\n(?:\r?\n)?/, "");
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
    description,
    setMessage,
    disabled,
  };
}

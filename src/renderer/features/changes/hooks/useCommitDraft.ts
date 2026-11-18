import { categorizeChanges } from "../../../repository/working-changes";
import { emptyDraft } from "@shared/identity/profile-session";
import { matchCommitPrefix } from "@shared/preferences/commit-prefix";
import { errorMessage } from "@shared/errors";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAppStore } from "../../../stores/app-store";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { useRepositoryStore } from "../../../stores/repository-store";
import { useSessionStore } from "../../../stores/session-store";
import { useCommitMessage } from "../../../repository/hooks/useCommitMessage";

export function useCommitDraft(pending: boolean) {
  const conventional = usePreferencesStore(
    (state) => state.values.conventionalCommitsEnabled.value,
  );

  const prefixes = usePreferencesStore((state) => state.values.commitPrefixes.value);
  const status = useRepositoryStore((state) => state.status);
  const writing = useRepositoryStore((state) => state.writing);
  const commit = useRepositoryStore((state) => state.commit);
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const [pushRequest, setPushRequest] = useState(0);
  const messageEditor = useCommitMessage(pending);
  const { snapshot, transitioning, draft, message, title } = messageEditor;
  const selectedId = useAppStore((state) => state.selectedRepositoryId);
  const [amendLoading, setAmendLoading] = useState(false);
  const [amendError, setAmendError] = useState<string | null>(null);
  const amendRequest = useRef(0);
  const context = snapshot?.context;

  useEffect(() => {
    setAmendLoading(false);
    setAmendError(null);
    return () => {
      amendRequest.current++;
    };
  }, [repositoryId, selectedId, context?.profileId, context?.generation, context?.windowId]);

  const { amend } = draft;
  const recognized = conventional ? matchCommitPrefix(title, prefixes) : null;
  const selectedPrefix = recognized?.[1] ?? "";
  const subject = recognized ? title.slice(recognized[0].length) : title;

  const composeTitle = (value: string) => {
    const typed = conventional ? matchCommitPrefix(value, prefixes) : null;
    if (typed)
      return `${typed[1]}${typed[2] ?? ""}${typed[3] ?? ""}: ${value.slice(typed[0].length)}`;

    return selectedPrefix
      ? `${selectedPrefix}${recognized?.[2] ?? ""}${recognized?.[3] ?? ""}: ${value}`
      : value;
  };

  const setAmend = async (amend: boolean) => {
    if (pending || !repositoryId || transitioning || snapshot?.recovery) return;
    const oid = status?.branch.oid;
    if (amend && !oid) return;

    const request = ++amendRequest.current;
    const generation = useRepositoryStore.getState().generation;
    const session = useSessionStore.getState();
    session.setDraft(repositoryId, { ...draft, amend });
    const revisionKey = `${context?.profileId}:${repositoryId}`;
    const revision = useSessionStore.getState().draftRevisions[revisionKey];
    setAmendError(null);
    setAmendLoading(amend);
    if (!amend || !oid) return;

    try {
      const result = await window.eda.repository.inspectCommit(repositoryId, oid);
      const current = useSessionStore.getState();
      const repository = useRepositoryStore.getState();
      const latest = current.snapshot?.drafts[repositoryId];

      if (
        amendRequest.current !== request ||
        current.transitioning ||
        current.snapshot?.context.profileId !== context?.profileId ||
        current.snapshot?.context.generation !== context?.generation ||
        current.snapshot?.context.windowId !== context?.windowId ||
        useAppStore.getState().selectedRepositoryId !== repositoryId ||
        repository.repositoryId !== repositoryId ||
        repository.generation !== generation ||
        repository.status?.branch.oid !== oid ||
        current.draftRevisions[revisionKey] !== revision ||
        !latest?.amend ||
        latest.message !== message
      )
        return;

      if (result.ok) {
        const { subject, body } = result.value.commit;
        current.setDraft(repositoryId, {
          ...latest,
          message: body ? `${subject}\n\n${body}` : subject,
        });
      } else {
        current.setDraft(repositoryId, { ...latest, amend: false });
        setAmendError(errorMessage(result.error));
      }
    } finally {
      if (amendRequest.current === request) setAmendLoading(false);
    }
  };

  const staged = categorizeChanges(status?.changes ?? []).staged.length;

  const canCommit =
    !pending &&
    !amendLoading &&
    subject.trim().length > 0 &&
    (staged > 0 || amend) &&
    !writing &&
    status?.capabilities?.write !== false &&
    !transitioning &&
    !snapshot?.recovery;

  const submit = async (push = false) => {
    if (!canCommit || !repositoryId) return;

    const owner = snapshot?.context.profileId;
    const sessionContext = snapshot?.context;
    const repositoryGeneration = useRepositoryStore.getState().generation;
    const revisionKey = `${owner}:${repositoryId}`;
    const revision = useSessionStore.getState().draftRevisions[revisionKey];

    if (!(await useSessionStore.getState().flush())) return;

    const session = useSessionStore.getState();
    const repository = useRepositoryStore.getState();

    if (
      session.transitioning ||
      session.snapshot?.context.profileId !== owner ||
      session.snapshot?.context.generation !== sessionContext?.generation ||
      session.snapshot?.context.windowId !== sessionContext?.windowId ||
      useAppStore.getState().selectedRepositoryId !== repositoryId ||
      repository.repositoryId !== repositoryId ||
      repository.generation !== repositoryGeneration ||
      repository.writing
    )
      return;

    const committed = await commit(message, { amend, signOff: draft.signOff ?? false });

    if (committed) {
      const current = useSessionStore.getState();
      const latest = current.snapshot?.drafts[repositoryId];

      if (
        current.snapshot?.context.profileId === owner &&
        current.draftRevisions[revisionKey] === revision &&
        latest?.message === message &&
        latest.amend === amend
      )
        current.setDraft(repositoryId, emptyDraft());

      if (
        push &&
        current.snapshot?.context.profileId === owner &&
        useRepositoryStore.getState().repositoryId === repositoryId
      )
        setPushRequest((previous) => previous + 1);
    }
  };

  const commitShortcut = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return {
    ...messageEditor,
    amend,
    recognized,
    selectedPrefix,
    subject,
    composeTitle,
    setAmend,
    amendLoading,
    amendError,
    staged,
    canCommit,
    submit,
    commitShortcut,
    conventional,
    prefixes,
    pushRequest,
  };
}

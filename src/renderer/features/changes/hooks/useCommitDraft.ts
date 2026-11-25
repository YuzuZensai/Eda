import { categorizeChanges } from "../../../repository/working-changes";
import { emptyDraft } from "@shared/identity/profile-session";
import { matchCommitPrefix } from "@shared/preferences/commit-prefix";
import { errorMessage } from "@shared/errors";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  const messageEditor = useCommitMessage(pending);
  const { owner, draft, message, title, getCurrentDraft, updateDraft } = messageEditor;
  const [pushRequest, setPushRequest] = useState<{ owner: typeof owner; id: number }>();
  const [amendLoading, setAmendLoading] = useState(false);
  const [amendError, setAmendError] = useState<string | null>(null);
  const amendRequest = useRef(0);
  const oid = status?.branch.oid;

  useEffect(() => {
    setAmendLoading(false);
    setAmendError(null);
    return () => {
      amendRequest.current++;
    };
  }, [owner, oid]);

  const amend = amendLoading || draft.amend;
  const recognized = conventional ? matchCommitPrefix(title, prefixes) : null;
  const subject = recognized ? title.slice(recognized[0].length) : title;

  const setAmend = async (amend: boolean) => {
    if (!owner || !getCurrentDraft()) return;
    const request = ++amendRequest.current;
    setAmendError(null);

    if (!amend) {
      setAmendLoading(false);
      if (draft.amend) updateDraft({ amend: false });
      return;
    }

    if (!oid) return;
    setAmendLoading(true);

    const isCurrent = () =>
      amendRequest.current === request &&
      useRepositoryStore.getState().status?.branch.oid === oid &&
      !!getCurrentDraft();
    try {
      const result = await window.eda.repository.inspectCommit(owner.repositoryId, oid);
      if (!isCurrent()) return;
      if (!result.ok) {
        setAmendError(errorMessage(result.error));
        return;
      }

      const { subject, body } = result.value.commit;
      updateDraft({
        amend: true,
        ...(getCurrentDraft() === draft && { message: body ? `${subject}\n\n${body}` : subject }),
      });
    } catch (error) {
      if (isCurrent()) setAmendError(errorMessage(error));
    } finally {
      if (amendRequest.current === request) setAmendLoading(false);
    }
  };

  const staged = categorizeChanges(status?.changes ?? []).staged.length;

  const canCommit =
    !!owner &&
    !amendLoading &&
    subject.trim().length > 0 &&
    (amend ? !!oid : staged > 0) &&
    !writing &&
    status?.capabilities?.write !== false;

  const submit = async (push = false, skipCommitHooks = false) => {
    if (!canCommit || !owner || getCurrentDraft() !== draft) return;
    const { repositoryId, context } = owner;
    const revisionKey = `${context.profileId}:${repositoryId}`;
    const revision = useSessionStore.getState().draftRevisions[revisionKey];
    const inspection = amendRequest.current;
    const unchanged = () =>
      getCurrentDraft() === draft &&
      useSessionStore.getState().draftRevisions[revisionKey] === revision;

    if (!(await useSessionStore.getState().flush()) || !unchanged()) return;
    const repository = useRepositoryStore.getState();
    if (
      inspection !== amendRequest.current ||
      repository.writing ||
      repository.status?.capabilities?.write === false ||
      repository.status?.branch.oid !== oid ||
      repository.status?.branch.head !== status?.branch.head ||
      (!amend && !categorizeChanges(repository.status?.changes ?? []).staged.length)
    )
      return;

    const committed = await commit(message, {
      amend,
      signOff: draft.signOff ?? false,
      ...(skipCommitHooks && { skipCommitHooks }),
    });

    if (!committed || !getCurrentDraft()) return;
    if (unchanged()) useSessionStore.getState().setDraft(repositoryId, emptyDraft());
    if (push && useRepositoryStore.getState().status?.branch.head === status?.branch.head)
      setPushRequest((previous) => ({ owner, id: (previous?.id ?? 0) + 1 }));
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
    setAmend,
    amendLoading,
    amendError,
    staged,
    canCommit,
    submit,
    commitShortcut,
    pushRequest: pushRequest?.owner === owner ? pushRequest.id : 0,
  };
}

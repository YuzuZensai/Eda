import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  FileInputIcon as FileInput,
  KeyRoundIcon as KeyRound,
  ShieldOffIcon as ShieldOff,
  UserPlusIcon as UserPlus,
} from "../../components/ui/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "../../components/ui/feedback/Skeleton";
import {
  Button,
  Checkbox,
  Dialog,
  Disclosure,
  ErrorDialog,
  IconButton,
  IdentityIcon,
  Input,
  Select,
  TextButton,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { DirectPush } from "../sync/DirectPush";
import { HistorySearch } from "../history/HistorySearch";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useCommitDraft } from "./hooks/useCommitDraft";
import { CommitMessageEditor } from "../../components/ui/forms/CommitMessageEditor";

export function CommitBox({ pending = false }: { pending?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [coauthorName, setCoauthorName] = useState("");
  const [coauthorEmail, setCoauthorEmail] = useState("");
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const identity = useAppStore((state) => state.activeIdentity);
  const preferences = usePreferencesStore((state) => state.values);
  const status = useRepositoryStore((state) => state.status);
  const writing = useRepositoryStore((state) => state.writing);
  const writeError = useRepositoryStore((state) => state.writeError);
  const commitNotice = useRepositoryStore((state) => state.commitNotice);

  const {
    owner,
    getCurrentDraft,
    updateDraft,
    draft,
    message,
    amend,
    setMessage,
    setAmend,
    amendLoading,
    amendError,
    staged,
    canCommit,
    submit,
    commitShortcut,
    pushRequest,
    disabled: messageDisabled,
  } = useCommitDraft(pending);

  const repositoryId = owner?.repositoryId;
  const [historyOwner, setHistoryOwner] = useState<typeof owner>(null);
  const [coauthorOwner, setCoauthorOwner] = useState<typeof owner>(null);
  const templateRequest = useRef(0);

  useEffect(() => {
    setTemplateMessage(null);
    return () => {
      templateRequest.current++;
    };
  }, [owner]);

  const insertTemplate = async () => {
    if (!repositoryId || !getCurrentDraft()) return;
    const request = ++templateRequest.current;
    try {
      const result = await window.eda.repository.commitTemplate(repositoryId);
      const latest = getCurrentDraft();
      if (request !== templateRequest.current || !latest) return;

      if (!result.ok) setTemplateMessage(errorMessage(result.error));
      else if (!result.value)
        setTemplateMessage(t("commitBox.noCommitTemplateIsConfiguredForThisRepository"));
      else if (latest.message !== message)
        setTemplateMessage(t("commitBox.theDraftChangedWhileLoadingInsertTheTemplateAgain"));
      else {
        setMessage(message ? `${message}\n\n${result.value}` : result.value);
        setTemplateMessage(null);
      }
    } catch (error) {
      if (request === templateRequest.current && getCurrentDraft())
        setTemplateMessage(errorMessage(error));
    }
  };

  const previewRequest = useMemo(
    () => (owner ? { owner, identity, status, preferences } : null),
    [owner, identity, status, preferences],
  );
  const { value: preview, error: previewError } = useRepositoryRead(
    (request: NonNullable<typeof previewRequest>) =>
      window.eda.repository.previewCommit(request.owner.repositoryId),
    previewRequest,
  );

  const limit = preferences.commitSummaryLimit.value;

  return (
    <section
      data-tour="commit-box"
      className="app-surface-panel flex shrink-0 flex-col gap-2 border-t border-border-default px-3 py-2"
    >
      <Disclosure
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        title={
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-text-primary">{t("commitBox.commit")}</h3>

            <span className="mono text-xs text-text-tertiary">
              {pending ? (
                <Skeleton className="w-20" />
              ) : staged === 0 ? (
                t("commitBox.nothingStaged")
              ) : (
                t("commitBox.staged", { staged: staged })
              )}

              {!pending && preview && staged > 0 && (
                <>
                  {", "}
                  <span className="text-git-added">+{preview.additions}</span>{" "}
                  <span className="text-git-deleted">-{preview.deletions}</span>
                  {preview.binaryFiles > 0 &&
                    t("commitBox.binary", { binaryFiles: preview.binaryFiles })}
                </>
              )}
            </span>
          </div>
        }
      >
        <div className="flex flex-col gap-2 pt-2">
          <CommitMessageEditor
            key={JSON.stringify([owner?.context, repositoryId, owner?.generation])}
            message={message}
            onChange={setMessage}
            conventional={preferences.conventionalCommitsEnabled.value}
            prefixes={preferences.commitPrefixes.value}
            summaryLimit={limit}
            disabled={messageDisabled}
            onKeyDown={commitShortcut}
          />

          <Checkbox
            className="flex items-center gap-1.5 text-xs text-text-secondary"
            checked={amend}
            disabled={messageDisabled || writing || (!amend && !status?.branch.oid)}
            onChange={(event) => void setAmend(event.target.checked)}
          >
            {t("commitBox.amendThePreviousCommit")}
          </Checkbox>

          {amendError && <ErrorDialog>{amendError}</ErrorDialog>}

          <Disclosure title={t("commitBox.commitOptions")} className="text-xs">
            <div className="mt-1.5 space-y-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <Checkbox
                  className="min-w-0 text-xs text-text-secondary"
                  checked={draft.signOff ?? false}
                  disabled={writing || messageDisabled}
                  onChange={(event) => updateDraft({ signOff: event.target.checked })}
                >
                  {t("commitBox.addSignedOffByTrailer")}
                </Checkbox>

                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <IconButton
                    size="xs"
                    aria-label={t("commitBox.addCoAuthor")}
                    title={t("commitBox.addCoAuthor")}
                    icon={<UserPlus size={14} aria-hidden="true" />}
                    disabled={writing || messageDisabled}
                    onClick={() => setCoauthorOwner(owner)}
                  />

                  <IconButton
                    size="xs"
                    aria-label={t("commitBox.insertGitTemplate")}
                    title={t("commitBox.insertGitTemplate")}
                    icon={<FileInput size={14} aria-hidden="true" />}
                    disabled={writing || messageDisabled}
                    onClick={() => void insertTemplate()}
                  />
                </div>
              </div>

              <TextButton disabled={!canCommit} onClick={() => void submit(false, true)}>
                {t("commitBox.skipHooks")}
              </TextButton>

              <TextButton
                disabled={messageDisabled || writing || amendLoading}
                onClick={() => setHistoryOwner(owner)}
              >
                {t("commitBox.reuseMessage")}
              </TextButton>
              <label className="flex items-center justify-between gap-2">
                {t("commitBox.summaryLimit")}
                <Select
                  aria-label={t("commitBox.summaryLimit")}
                  value={String(limit)}
                  disabled={!identity}
                  onValueChange={(value) => {
                    if (identity)
                      void usePreferencesStore
                        .getState()
                        .set(
                          "commitSummaryLimit",
                          { kind: "profile", profileId: identity.id },
                          Number(value),
                        );
                  }}
                >
                  {[0, 50, 72, 100].map((count) => (
                    <option key={count} value={count}>
                      {count || t("commitBox.noLimit")}
                    </option>
                  ))}
                </Select>
              </label>
              {templateMessage && <p role="status">{templateMessage}</p>}
            </div>
          </Disclosure>

          {historyOwner === owner &&
            repositoryId &&
            !messageDisabled &&
            !writing &&
            !amendLoading && (
              <HistorySearch
                repositoryId={repositoryId}
                onChooseMessage={setMessage}
                onClose={() => setHistoryOwner(null)}
              />
            )}

          {owner && coauthorOwner === owner && (
            <Dialog
              title={t("commitBox.coAuthorDialogTitle")}
              onClose={() => setCoauthorOwner(null)}
              footer={
                <Button
                  disabled={
                    writing ||
                    !coauthorName.trim() ||
                    /[<>\r\n]/.test(coauthorName) ||
                    !/^[^\s<>@]+@[^\s<>@]+$/.test(coauthorEmail)
                  }
                  onClick={() => {
                    setMessage(
                      `${message.trimEnd()}

Co-authored-by: ${coauthorName.trim()} <${coauthorEmail.trim()}>`,
                    );

                    setCoauthorOwner(null);
                  }}
                >
                  {t("commitBox.insertTrailer")}
                </Button>
              }
            >
              <div className="space-y-3">
                <Input
                  aria-label={t("commitBox.coAuthorName")}
                  placeholder={t("common.name")}
                  value={coauthorName}
                  onChange={(event) => setCoauthorName(event.target.value)}
                />

                <Input
                  aria-label={t("commitBox.coAuthorEmail")}
                  type="email"
                  placeholder={t("common.email")}
                  value={coauthorEmail}
                  onChange={(event) => setCoauthorEmail(event.target.value)}
                />
              </div>
            </Dialog>
          )}

          <div className="flex min-w-0 items-center gap-3 text-xs text-text-tertiary">
            {preview ? (
              <span
                className="flex min-w-0 items-center gap-1.5"
                title={`${preview.author.name} <${preview.author.email}>`}
                tabIndex={0}
                aria-label={t("commitBox.commitIdentity", {
                  name: preview.author.name,
                  email: preview.author.email,
                })}
              >
                <IdentityIcon size={14} aria-hidden="true" />
                <span className="truncate">{preview.author.name}</span>
              </span>
            ) : (
              <Skeleton className="w-20" />
            )}

            {preview && (
              <span
                className="ml-auto flex shrink-0 items-center gap-1.5"
                title={preview.signing}
                tabIndex={0}
                aria-label={t("commitBox.commitSigning", { signing: preview.signing })}
              >
                {!preview.signingEnabled ? (
                  <ShieldOff size={14} aria-hidden="true" />
                ) : (
                  <KeyRound size={14} aria-hidden="true" />
                )}

                <span>{preview.signing.split(", ")[0]}</span>
              </span>
            )}
          </div>

          {previewError && (
            <ErrorDialog title={t("commitBox.commitPreviewUnavailable")}>
              {previewError}
            </ErrorDialog>
          )}

          {writeError && (
            <ErrorDialog>
              {errorMessage(writeError)}
              {errorAction(writeError) && (
                <span className="mt-0.5 block text-text-tertiary">{errorAction(writeError)}</span>
              )}
            </ErrorDialog>
          )}

          {commitNotice && (
            <p role="status" className="text-xs text-git-modified">
              {commitNotice}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!canCommit}
              busy={writing || amendLoading}
              title={t("commitBox.commitCtrlEnter")}
              onClick={() => void submit()}
            >
              {amend ? t("commitBox.amendCommit") : t("commitBox.commit")}
            </Button>

            <Button
              size="sm"
              disabled={!canCommit || !status?.branch || status.branch.detached}
              onClick={() => void submit(true)}
              title={t("commitBox.commitLocallyThenPushToTheCurrentBranchSUpstream")}
            >
              {amend ? t("commitBox.amendAndPush") : t("commitBox.commitAndPush")}
            </Button>
          </div>

          {pushRequest > 0 && repositoryId && (
            <DirectPush key={pushRequest} repositoryId={repositoryId} afterCommit />
          )}
        </div>
      </Disclosure>
    </section>
  );
}

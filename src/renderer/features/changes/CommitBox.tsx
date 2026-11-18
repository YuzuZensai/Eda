import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { CommitPreview } from "@shared/repository/repository-write";
import {
  FileInputIcon as FileInput,
  KeyRoundIcon as KeyRound,
  ShieldOffIcon as ShieldOff,
  UserPlusIcon as UserPlus,
} from "../../components/ui/icons";
import { useEffect, useState } from "react";
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
  Textarea,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { useSessionStore } from "../../stores/session-store";
import { DirectPush } from "../sync/DirectPush";
import { CommitPrefixPicker } from "./CommitPrefixPicker";
import { useCommitDraft } from "./hooks/useCommitDraft";
import { CommitTitleInput } from "../../components/ui/forms/CommitTitleInput";

export function CommitBox({ pending = false }: { pending?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [coauthorOpen, setCoauthorOpen] = useState(false);
  const [coauthorName, setCoauthorName] = useState("");
  const [coauthorEmail, setCoauthorEmail] = useState("");
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const identity = useAppStore((state) => state.activeIdentity);
  const preferences = usePreferencesStore((state) => state.values);
  const status = useRepositoryStore((state) => state.status);
  const writing = useRepositoryStore((state) => state.writing);
  const writeError = useRepositoryStore((state) => state.writeError);
  const commitNotice = useRepositoryStore((state) => state.commitNotice);
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const [preview, setPreview] = useState<CommitPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    setPreview(null);
    setPreviewError(null);

    if (!pending && repositoryId)
      void window.eda.repository.previewCommit(repositoryId).then((result) => {
        if (!alive) return;
        if (result.ok) setPreview(result.value);
        else setPreviewError(errorMessage(result.error));
      });

    return () => {
      alive = false;
    };
  }, [repositoryId, identity, status, pending, preferences]);

  const {
    snapshot,
    transitioning,
    draft,
    message,
    amend,
    title,
    recognized,
    selectedPrefix,
    subject,
    composeTitle,
    messageTail,
    description,
    setMessage,
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
    disabled: messageDisabled,
  } = useCommitDraft(pending);

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
          <div className="space-y-1.5">
            <div className="flex min-w-0 items-center gap-2">
              {conventional && (
                <CommitPrefixPicker
                  key={`${snapshot?.context.profileId}:${repositoryId}`}
                  value={selectedPrefix}
                  prefixes={prefixes}
                  disabled={pending || !!snapshot?.recovery || transitioning}
                  onChange={(prefix) =>
                    setMessage(
                      `${prefix ? `${prefix}${recognized?.[2] ?? ""}${recognized?.[3] ?? ""}: ` : ""}${subject}${messageTail}`,
                    )
                  }
                />
              )}

              <div className="min-w-0 flex-1">
                <CommitTitleInput
                  value={subject}
                  onChange={(value) => setMessage(`${composeTitle(value)}${messageTail}`)}
                  onKeyDown={commitShortcut}
                  disabled={messageDisabled}
                />
              </div>
            </div>

            <Textarea
              rows={2}
              value={description}
              onChange={(event) =>
                setMessage(event.target.value ? `${title}\n\n${event.target.value}` : title)
              }
              onKeyDown={commitShortcut}
              placeholder={t("commitBox.descriptionOptional")}
              aria-label={t("commitBox.commitDescription")}
              disabled={messageDisabled}
              surface="base"
              className="leading-snug"
            />
          </div>

          <Checkbox
            className="flex items-center gap-1.5 text-xs text-text-secondary"
            checked={amend}
            disabled={pending || !!snapshot?.recovery || transitioning || !status?.branch.oid}
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
                  disabled={writing || transitioning}
                  onChange={(event) => {
                    if (repositoryId)
                      useSessionStore
                        .getState()
                        .setDraft(repositoryId, { ...draft, signOff: event.target.checked });
                  }}
                >
                  {t("commitBox.addSignedOffByTrailer")}
                </Checkbox>

                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <IconButton
                    size="xs"
                    aria-label={t("commitBox.addCoAuthor")}
                    title={t("commitBox.addCoAuthor")}
                    icon={<UserPlus size={14} aria-hidden="true" />}
                    disabled={writing || transitioning}
                    onClick={() => setCoauthorOpen(true)}
                  />

                  <IconButton
                    size="xs"
                    aria-label={t("commitBox.insertGitTemplate")}
                    title={t("commitBox.insertGitTemplate")}
                    icon={<FileInput size={14} aria-hidden="true" />}
                    disabled={writing || transitioning}
                    onClick={() => {
                      if (!repositoryId) return;

                      const owner = snapshot?.context.profileId;
                      const currentMessage = message;

                      void window.eda.repository.commitTemplate(repositoryId).then((result) => {
                        const current = useSessionStore.getState();

                        if (
                          current.snapshot?.context.profileId !== owner ||
                          current.snapshot?.session.selectedRepositoryId !== repositoryId
                        )
                          return;

                        if (!result.ok) setTemplateMessage(errorMessage(result.error));
                        else if (!result.value)
                          setTemplateMessage(
                            t("commitBox.noCommitTemplateIsConfiguredForThisRepository"),
                          );
                        else if (
                          (current.snapshot.drafts[repositoryId]?.message ?? "") !== currentMessage
                        )
                          setTemplateMessage(
                            t("commitBox.theDraftChangedWhileLoadingInsertTheTemplateAgain"),
                          );
                        else {
                          setMessage(
                            currentMessage ? `${currentMessage}\n\n${result.value}` : result.value,
                          );

                          setTemplateMessage(null);
                        }
                      });
                    }}
                  />
                </div>
              </div>

              {templateMessage && <p role="status">{templateMessage}</p>}
            </div>
          </Disclosure>

          {coauthorOpen && (
            <Dialog
              title={t("commitBox.coAuthorDialogTitle")}
              onClose={() => setCoauthorOpen(false)}
              footer={
                <Button
                  disabled={
                    !coauthorName.trim() ||
                    /[<>\r\n]/.test(coauthorName) ||
                    !/^[^\s<>@]+@[^\s<>@]+$/.test(coauthorEmail)
                  }
                  onClick={() => {
                    setMessage(
                      `${message.trimEnd()}

Co-authored-by: ${coauthorName.trim()} <${coauthorEmail.trim()}>`,
                    );

                    setCoauthorOpen(false);
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

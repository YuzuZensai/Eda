import { t } from "@shared/i18n";
import { formatDateTime } from "../../utils/format";
import {
  UNSIGNED_COMMIT_SIGNATURE,
  type CommitInspection,
  type HistoryCommit,
} from "@shared/repository/repository-read";
import {
  ChevronRightIcon as ChevronRight,
  RefreshIcon as RefreshCw,
} from "../../components/ui/icons";
import { useId, useState, type ReactNode } from "react";
import { ProfileAvatar } from "../../components/ui/display/ProfileAvatar";
import {
  CommitSignatureIcon,
  commitSignatureTone,
} from "../../components/ui/display/CommitSignatureIcon";
import {
  CodeBlock,
  Collapse,
  cx,
  CopyButton,
  Disclosure,
  IconButton,
  TextButton,
} from "../../components/ui/index";
import {
  commitSignatureFormatLabel,
  commitSignatureLabel,
  commitSignatureTrustLabel,
} from "../../components/ui/display/commit-signature-label";

export function CommitDetails({
  commit,
  inspection,
  onSelectParent,
  onVerify,
  verifying = false,
  repositoryId,
}: {
  commit: HistoryCommit;
  inspection: CommitInspection | null;
  onSelectParent: (oid: string) => void;
  onVerify?: () => void;
  verifying?: boolean;
  repositoryId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  const signature =
    inspection?.signature ??
    (inspection?.signed === false
      ? UNSIGNED_COMMIT_SIGNATURE
      : inspection?.signed
        ? {
            status: "unverified" as const,
            format: "unknown" as const,
            reasonCode: "verification-error" as const,
            diagnostics: "",
          }
        : null);

  const signatureLabel = verifying
    ? t("diff.commitDetails.checkingSignature")
    : signature
      ? commitSignatureLabel(signature)
      : "";

  const signatureColor = commitSignatureTone(verifying ? null : signature);

  return (
    <div className="app-surface-chrome shrink-0 border-b border-border-subtle bg-bg-surface px-3 py-2">
      <p
        title={commit.subject}
        className="line-clamp-2 break-words text-sm font-medium leading-snug text-text-primary"
      >
        {commit.subject}
      </p>

      <div className="my-1.5 flex min-w-0 items-center gap-2">
        <ProfileAvatar
          name={commit.author.name}
          email={commit.author.email}
          {...(repositoryId && { repositoryId })}
          hue={210}
          small
        />

        <div className="min-w-0 flex-1 text-xs">
          <p
            title={`${commit.author.name} <${commit.author.email}>`}
            className="truncate font-medium text-text-secondary"
          >
            {commit.author.name}
          </p>

          <time
            dateTime={commit.committerTimestamp}
            title={formatDateTime(commit.committerTimestamp)}
            className="block truncate text-text-tertiary"
          >
            {formatDateTime(commit.committerTimestamp)}
          </time>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-1 text-xs">
        <span title={commit.oid} className="mono text-text-tertiary">
          {commit.oid.slice(0, 8)}
        </span>
        <CopyButton value={commit.oid} label={t("diff.commitDetails.copySha")} size="icon-xs" />

        {(signature || verifying) && (
          <CommitSignatureIcon signature={signature} verifying={verifying} />
        )}

        <TextButton
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
          className="ml-auto flex min-w-0 items-center gap-1"
        >
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="disclosure-chevron shrink-0"
            data-open={expanded}
          />

          <span className="truncate">{t("diff.commitDetails.commitDetails")}</span>
        </TextButton>
      </div>

      {commit.body && (
        <Disclosure
          title={t("diff.commitDetails.fullCommitMessage")}
          className="mt-1 text-xs"
          summaryClassName="text-text-tertiary"
        >
          <p className="selectable mt-2 max-h-24 overflow-auto whitespace-pre-wrap">
            {commit.body}
          </p>
        </Disclosure>
      )}

      <Collapse id={detailsId} open={expanded}>
        <dl className="mt-2 space-y-2 border-t border-border-subtle pt-2 text-xs">
          <CommitDetail
            label={t("diff.commitDetails.sha")}
            className="selectable break-all font-mono text-text-secondary"
          >
            {commit.oid}
          </CommitDetail>

          <CommitDetail
            label={t("diff.commitDetails.author")}
            className="selectable break-all text-text-secondary"
          >
            {commit.author.email}
          </CommitDetail>

          {(signature || verifying) && (
            <CommitDetail
              label={t("diff.commitDetails.signature")}
              className="flex min-w-0 items-start gap-1"
            >
              <span className={`min-w-0 flex-1 ${signatureColor}`}>{signatureLabel}</span>

              {onVerify && (
                <IconButton
                  size="xs"
                  disabled={verifying}
                  busy={verifying}
                  aria-label={t("diff.commitDetails.verifyAgain")}
                  title={t("diff.commitDetails.verifyAgain")}
                  icon={<RefreshCw size={13} aria-hidden="true" />}
                  onClick={onVerify}
                />
              )}
            </CommitDetail>
          )}

          {signature?.format && (
            <CommitDetail label={t("diff.commitDetails.signatureFormat")}>
              {commitSignatureFormatLabel(signature)}
            </CommitDetail>
          )}

          {signature?.signer && (
            <CommitDetail
              label={t("diff.commitDetails.signatureSigner")}
              className="selectable break-words"
            >
              {signature.signer}
            </CommitDetail>
          )}

          {signature?.trustLevel && (
            <CommitDetail label={t("diff.commitDetails.signatureTrust")}>
              {commitSignatureTrustLabel(signature)}
            </CommitDetail>
          )}

          {(signature?.fingerprint || signature?.keyId) && (
            <CommitDetail
              label={t("diff.commitDetails.signatureKey")}
              className="flex min-w-0 items-start gap-1"
            >
              <span className="selectable min-w-0 flex-1 break-all font-mono">
                {signature.fingerprint ?? signature.keyId}
              </span>

              <CopyButton
                value={(signature.fingerprint ?? signature.keyId)!}
                size="icon-xs"
                label={t("diff.commitDetails.copySignatureKey")}
              />
            </CommitDetail>
          )}

          {signature?.primaryFingerprint && (
            <CommitDetail
              label={t("diff.commitDetails.signaturePrimaryKey")}
              className="selectable break-all font-mono"
            >
              {signature.primaryFingerprint}
            </CommitDetail>
          )}

          <CommitDetail
            label={t("diff.commitDetails.parents")}
            className="flex min-w-0 flex-wrap gap-1.5"
          >
            {commit.parents.map((oid, index) => (
              <TextButton
                key={oid}
                className="mono border border-border-default bg-bg-raised px-1.5"
                tone="accent"
                title={oid}
                aria-label={t("diff.commitDetails.parent", {
                  value1: index + 1,
                  oid: oid.slice(0, 8),
                })}
                onClick={() => onSelectParent(oid)}
              >
                {oid.slice(0, 8)}
              </TextButton>
            ))}

            {!commit.parents.length && (
              <span>
                {inspection?.shallow
                  ? t("diff.commitDetails.rootOrShallowBoundary")
                  : t("diff.commitDetails.rootCommit")}
              </span>
            )}
          </CommitDetail>

          {inspection && (
            <CommitDetail
              label={t("diff.commitDetails.references")}
              className="flex min-w-0 flex-wrap gap-1.5"
            >
              {inspection.containingRefs.length
                ? inspection.containingRefs.map((ref) => (
                    <span
                      key={ref}
                      title={ref}
                      className="selectable max-w-full break-all rounded-sm border border-border-default bg-bg-raised px-1.5 py-0.5 text-text-secondary"
                    >
                      {ref.replace(/^refs\/(?:heads|remotes|tags)\//, "")}
                    </span>
                  ))
                : t("diff.commitDetails.noneDetachedOrUnreachableHistory")}
            </CommitDetail>
          )}
        </dl>

        {signature?.diagnostics && (
          <Disclosure title={t("diff.commitDetails.verificationDetails")} className="mt-2 text-xs">
            <CodeBlock
              label={t("diff.commitDetails.verificationOutput")}
              wrap
              className="mt-2 max-h-40"
            >
              {signature.diagnostics}
            </CodeBlock>
          </Disclosure>
        )}

        {inspection?.shallow && (
          <p>{t("diff.commitDetails.shallowRepositoryEarlierAncestorsMayNotBeAvailable")}</p>
        )}
      </Collapse>
    </div>
  );
}

function CommitDetail({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-x-3">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className={cx("min-w-0", className)}>{children}</dd>
    </div>
  );
}

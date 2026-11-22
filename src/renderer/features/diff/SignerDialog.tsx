import {
  isGitHubServiceSigningHint,
  isVerifiedGitHubWebSignature,
} from "@shared/integrations/github";
import { useEffect, useRef, useState } from "react";
import { t } from "@shared/i18n";
import { errorText } from "@shared/error-codes";
import { AppError, errorMessage } from "@shared/errors";
import type {
  CommitSignatureVerification,
  PublicKeyRequest,
  SignerDecision,
} from "@shared/repository/repository-read";
import {
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
  Disclosure,
} from "../../components/ui/index";
import { commitSignatureLabel } from "../../components/ui/display/commit-signature-label";
import { invalidateRepositorySignatures } from "../../repository/hooks/useCommitSignature";

export function SignerDialog({
  repositoryId,
  oid,
  email,
  initialSignature,
  onClose,
}: {
  repositoryId: string;
  oid: string;
  email: string;
  initialSignature: CommitSignatureVerification;
  onClose: () => void;
}) {
  const [signature, setSignature] = useState(initialSignature);
  const [source, setSource] = useState<Exclude<PublicKeyRequest["source"], "automatic">>("github");
  const [account, setAccount] = useState(
    isGitHubServiceSigningHint(initialSignature)
      ? "web-flow"
      : (email.match(/^(?:\d+\+)?([A-Za-z\d-]+)@users\.noreply\.github\.com$/)?.[1] ?? ""),
  );
  const [server, setServer] = useState("https://keys.openpgp.org");
  const [armoredKey, setArmoredKey] = useState("");
  const [identity, setIdentity] = useState(
    signature.trustedIdentity ?? signature.signer?.match(/<([^>]+)>/)?.[1] ?? email,
  );
  const [scope, setScope] = useState<SignerDecision["scope"]>("repository");
  const [decisions, setDecisions] = useState<SignerDecision[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    void window.eda.repository
      .signerDecisions(repositoryId)
      .then((result) => {
        if (!alive.current) return;
        if (result.ok) setDecisions(result.value);
        else setError(errorMessage(result.error));
      })
      .catch(() => {
        if (alive.current) setError(t("signature.failure"));
      });
    return () => {
      alive.current = false;
    };
  }, [repositoryId]);

  const changed = () => {
    invalidateRepositorySignatures();
  };
  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await work();
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      if (alive.current) {
        setBusy(false);
        setDiscovering(false);
      }
    }
  };
  const discover = () =>
    perform(async () => {
      setDiscovering(true);
      const request: PublicKeyRequest =
        source === "github"
          ? { source, account }
          : source === "keyserver"
            ? { source, server }
            : { source, armoredKey };
      const result = await window.eda.repository.discoverSigningKey(repositoryId, oid, request);
      if (!result.ok) throw result.error;
      if (!alive.current) return;
      setSignature(result.value);
      setIdentity(
        result.value.trustedIdentity ?? result.value.signer?.match(/<([^>]+)>/)?.[1] ?? email,
      );
      setFeedback(
        t(
          isVerifiedGitHubWebSignature(result.value)
            ? "signature.githubWebExplanation"
            : "signature.success",
        ),
      );
      changed();
    });
  const decide = (decision: SignerDecision, remove = false) =>
    perform(async () => {
      const result = await window.eda.repository.decideSigner(repositoryId, decision, remove);
      if (!result.ok) throw result.error;
      changed();
      const [list, verification] = await Promise.all([
        window.eda.repository.signerDecisions(repositoryId),
        window.eda.repository.commitSignature(repositoryId, oid),
      ]);
      if (!alive.current) return;
      if (list.ok) setDecisions(list.value);
      else throw list.error;
      if (verification.ok) setSignature(verification.value);
      else throw verification.error;
    });
  const githubWeb = isVerifiedGitHubWebSignature(signature);
  const fingerprint = signature.fingerprint;
  const blocked =
    signature.validity !== "valid" ||
    ["revoked-key", "expired-key", "expired-signature"].includes(signature.reasonCode ?? "");

  return (
    <Dialog
      title={t("signature.title")}
      description={t(githubWeb ? "signature.githubWebExplanation" : "signature.explanation")}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {discovering && (
            <Button onClick={() => void window.eda.repository.cancelKeyDiscovery(repositoryId)}>
              {t("signature.cancel")}
            </Button>
          )}
          <Button disabled={busy} onClick={onClose}>
            {t("signature.close")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2 rounded-md border border-border-subtle bg-bg-surface p-3 text-xs">
          <p>{commitSignatureLabel(signature)}</p>
          <p className="selectable break-all font-mono">{fingerprint ?? signature.keyId}</p>
          {signature.primaryFingerprint && (
            <p className="selectable break-all font-mono">
              {t("diff.commitDetails.signaturePrimaryKey")}: {signature.primaryFingerprint}
            </p>
          )}
          {signature.signer && <p className="selectable break-words">{signature.signer}</p>}
          {signature.format !== "ssh" && (
            <p className="break-all">
              {t("signature.source")}:{" "}
              {signature.keySource === "manual"
                ? t("signature.manualSource")
                : (signature.keySource ?? t("signature.localSource"))}
            </p>
          )}
          {signature.keyFetchedAt && (
            <p>
              {t("signature.fetched")}: {signature.keyFetchedAt}
            </p>
          )}
          {signature.identityMismatch && (
            <p role="status" className="text-git-modified">
              {t("signature.mismatch")}
            </p>
          )}
        </div>

        {signature.keySource && fingerprint && (
          <Button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const result = await window.eda.repository.forgetSigningKey(
                  repositoryId,
                  fingerprint,
                );
                if (!result.ok) throw result.error;
                changed();
                const verification = await window.eda.repository.commitSignature(repositoryId, oid);
                if (!alive.current) return;
                if (!verification.ok) throw verification.error;
                setSignature(verification.value);
              })
            }
          >
            {t("signature.forgetKey")}
          </Button>
        )}

        {signature.format === "openpgp" && (
          <Disclosure title={t("signature.refresh")}>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-text-secondary">{t("signature.network")}</p>
              {source === "github" && (
                <p className="text-xs text-text-secondary">
                  {t(
                    isGitHubServiceSigningHint(signature)
                      ? "signature.githubServiceHint"
                      : "signature.githubFallback",
                  )}
                </p>
              )}
              <Field label={t("signature.source")}>
                {(props) => (
                  <Select
                    {...props}
                    value={source}
                    disabled={busy}
                    onValueChange={(value) => {
                      if (value === "github" || value === "keyserver" || value === "manual")
                        setSource(value);
                    }}
                  >
                    <option value="github">GitHub</option>
                    <option value="keyserver">{t("signature.server")}</option>
                    <option value="manual">{t("signature.manual")}</option>
                  </Select>
                )}
              </Field>
              {source === "github" && (
                <Field label={t("signature.github")}>
                  {(props) => (
                    <Input
                      {...props}
                      value={account}
                      disabled={busy}
                      maxLength={39}
                      onChange={(event) => setAccount(event.target.value)}
                    />
                  )}
                </Field>
              )}
              {source === "keyserver" && (
                <Field label={t("signature.server")}>
                  {(props) => (
                    <Input
                      {...props}
                      value={server}
                      disabled={busy}
                      onChange={(event) => setServer(event.target.value)}
                    />
                  )}
                </Field>
              )}
              {source === "manual" && (
                <>
                  <Field label={t("signature.manual")}>
                    {(props) => (
                      <Textarea
                        {...props}
                        value={armoredKey}
                        disabled={busy}
                        rows={5}
                        maxLength={256 * 1024}
                        onChange={(event) => setArmoredKey(event.target.value)}
                      />
                    )}
                  </Field>
                  <Input
                    ref={fileInput}
                    type="file"
                    accept=".asc,.pub,.txt"
                    hidden
                    tabIndex={-1}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void perform(async () => {
                        if (file.size > 256 * 1024)
                          throw new AppError(errorText("signature.fileTooLarge"));
                        const text = await file.text();
                        if (alive.current) setArmoredKey(text);
                      });
                      event.target.value = "";
                    }}
                  />
                  <Button disabled={busy} onClick={() => fileInput.current?.click()}>
                    {t("signature.import")}
                  </Button>
                </>
              )}
              <Button busy={discovering} disabled={busy} onClick={() => void discover()}>
                {t("signature.lookup")}
              </Button>
            </div>
          </Disclosure>
        )}

        {fingerprint && !githubWeb && (
          <div className="space-y-3 border-t border-border-subtle pt-3">
            <Field label={t("signature.identity")}>
              {(props) => (
                <Input
                  {...props}
                  value={identity}
                  maxLength={320}
                  disabled={busy}
                  onChange={(event) => setIdentity(event.target.value)}
                />
              )}
            </Field>
            <Field label={t("signature.scope")}>
              {(props) => (
                <Select
                  {...props}
                  value={scope}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value === "profile" || value === "repository") setScope(value);
                  }}
                >
                  <option value="repository">{t("signature.repository")}</option>
                  <option value="profile">{t("signature.profile")}</option>
                </Select>
              )}
            </Field>
            <p className="text-xs text-text-secondary">{t("signature.trustIntegration")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || blocked || !identity.trim()}
                onClick={() => void decide({ fingerprint, identity, scope, decision: "trusted" })}
              >
                {t("signature.trust")}
              </Button>
              <Button
                disabled={busy || !identity.trim()}
                onClick={() =>
                  void decide({ fingerprint, identity, scope, decision: "distrusted" })
                }
              >
                {t("signature.distrust")}
              </Button>
            </div>
          </div>
        )}

        {(!githubWeb || Boolean(decisions?.length)) && (
          <Disclosure title={t("signature.decisions")}>
            <div className="mt-2 space-y-3 text-xs">
              {decisions === null ? (
                <p role="status">{error ?? t("signature.loading")}</p>
              ) : decisions.length === 0 ? (
                <p>{t("signature.none")}</p>
              ) : (
                decisions.map((decision) => (
                  <div key={`${decision.scope}:${decision.fingerprint}`} className="space-y-1">
                    <p className="break-words">
                      {decision.identity} ·{" "}
                      {t(
                        decision.scope === "profile" ? "signature.profile" : "signature.repository",
                      )}{" "}
                      ·{" "}
                      {t(
                        decision.decision === "trusted"
                          ? "signature.trusted"
                          : "signature.distrusted",
                      )}
                    </p>
                    <p className="selectable break-all font-mono">{decision.fingerprint}</p>
                    <Button disabled={busy} onClick={() => void decide(decision, true)}>
                      {t("signature.remove")}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </Disclosure>
        )}
        {feedback && (
          <p role="status" className="text-xs text-text-secondary">
            {feedback}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-git-deleted">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

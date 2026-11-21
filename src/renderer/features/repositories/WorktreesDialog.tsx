import { useRepositoryStore } from "../../stores/repository-store";
import { SubmoduleTools } from "./SubmoduleTools";
import { GitflowTools } from "./GitflowTools";
import { LfsTools } from "./LfsTools";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { WorktreeAction } from "@shared/repository/repository-write";
import type { RepositorySummary } from "@shared/repository/repository";
import { useState } from "react";
import {
  Checkbox,
  Dialog,
  Disclosure,
  Field,
  Input,
  Textarea,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { showOpenedRepository } from "../../repository/hooks/useRepositoryNavigation";
import { useAppStore } from "../../stores/app-store";

function SparseCheckout({ id }: { id: string }) {
  const { value, error, retry } = useRepositoryRead(window.eda.repository.sparseCheckout, id);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const change = async (action: "set" | "disable" | "reapply") => {
    if (!value || busy) return;
    setBusy(true);
    try {
      const paths =
        action === "set" ? (draft ?? value.directories.join("\n")).split("\n").filter(Boolean) : [];
      const result = await window.eda.repository.changeSparseCheckout(id, action, paths);
      if (!result.ok) setNotice(errorMessage(result.error));
      else {
        setNotice(t("sparse.saved"));
        setDraft(null);
        retry();
      }
    } catch (failure) {
      setNotice(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {error && (
        <StateMessage
          tone="error"
          title={error}
          action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
        />
      )}
      {!error && !value && <StateMessage tone="loading" title={t("sparse.title")} />}
      {value && (
        <>
          {value.cone ? (
            <Field label={t("sparse.directories")}>
              {(field) => (
                <Textarea
                  {...field}
                  disabled={busy}
                  value={draft ?? value.directories.join("\n")}
                  onChange={(e) => setDraft(e.target.value)}
                />
              )}
            </Field>
          ) : (
            <p>{t("sparse.nonCone")}</p>
          )}
          {value.cone && (
            <TextButton disabled={busy} onClick={() => void change("set")}>
              {t("sparse.set")}
            </TextButton>
          )}
          {value.enabled && (
            <>
              <TextButton disabled={busy} onClick={() => void change("reapply")}>
                {t("sparse.reapply")}
              </TextButton>{" "}
              <TextButton disabled={busy} onClick={() => void change("disable")}>
                {t("sparse.disable")}
              </TextButton>
            </>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function WorktreesDialog({
  repository,
  startCommit,
  onClose,
}: {
  repository: RepositorySummary;
  startCommit?: string;
  onClose: () => void;
}) {
  const { value, error, retry } = useRepositoryRead(window.eda.repository.worktrees, repository.id);
  const [inspectFlow, setInspectFlow] = useState(false);
  const [inspectSparse, setInspectSparse] = useState(false);
  const [inspectModules, setInspectModules] = useState(false);
  const modules = useRepositoryRead(
    window.eda.repository.submodules,
    inspectModules ? repository.id : null,
  );
  const [openError, setOpenError] = useState("");
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState("");
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState(!!startCommit);
  const [base, setBase] = useState(startCommit ?? "HEAD");
  const [confirmation, setConfirmation] = useState<WorktreeAction | null>(null);
  const [notice, setNotice] = useState("");
  const change = async (action: WorktreeAction) => {
    if (busy) return;
    setBusy(true);
    setOpenError("");
    setNotice("");
    try {
      const result = await window.eda.repository.changeWorktree(repository.id, action);
      if (!result.ok) setOpenError(errorMessage(result.error));
      else {
        setNotice(
          result.value ? t("worktrees.recovery", { ref: result.value }) : t("worktrees.done"),
        );
        if (action.kind === "create") {
          setDestination("");
          setBranch("");
        }
      }
    } catch (failure) {
      setOpenError(errorMessage(failure));
    } finally {
      retry();
      setBusy(false);
      setConfirmation(null);
    }
  };
  const open = async (
    path: string,
    target: "current" | "tab" | "editor" | "folder" | "terminal",
  ) => {
    const app = useAppStore.getState();
    const owner = app.activeIdentity?.id;
    if (busy || !owner || app.selectedRepositoryId !== repository.id) return;
    setBusy(true);
    setOpenError("");
    try {
      if (target !== "tab" && target !== "current") {
        const result = await window.eda.repository.openWorktreeTool(repository.id, path, target);
        if (!result.ok) setOpenError(errorMessage(result.error));
        return;
      }
      const index = app.openTabsByIdentity[owner]?.indexOf(repository.id) ?? -1;
      const result = await window.eda.repository.open(path);
      if (!result.ok) setOpenError(errorMessage(result.error));
      else if (
        useAppStore.getState().selectedRepositoryId === repository.id &&
        (await showOpenedRepository(result.value, owner, repository.id))
      ) {
        if (target === "current" && index >= 0 && result.value.id !== repository.id) {
          useAppStore.getState().closeTab(repository.id);
          useAppStore.getState().moveTab(result.value.id, index);
        }
        onClose();
      }
    } catch (failure) {
      setOpenError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("worktrees.title")} onClose={onClose} busy={busy}>
      {error && (
        <StateMessage
          tone="error"
          title={error}
          action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
        />
      )}
      {!error && !value && <StateMessage tone="loading" title={t("worktrees.title")} />}
      {openError && <p role="alert">{openError}</p>}
      {notice && (
        <p role="status" className="selectable">
          {notice}
        </p>
      )}
      <Disclosure title={t("worktrees.create")} open={!!startCommit || undefined}>
        <Field label={t("worktrees.destination")}>
          {(field) => (
            <Input
              {...field}
              disabled={busy}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          )}
        </Field>
        <Field label={t("worktrees.branch")}>
          {(field) => (
            <Input
              {...field}
              disabled={busy}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          )}
        </Field>
        <Checkbox
          checked={newBranch}
          disabled={busy}
          onChange={(e) => setNewBranch(e.target.checked)}
        >
          {t("worktrees.newBranch")}
        </Checkbox>
        {newBranch && (
          <Field label={t("worktrees.base")}>
            {(field) => (
              <Input
                {...field}
                disabled={busy}
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
            )}
          </Field>
        )}
        <TextButton
          disabled={busy || !branch || !destination || (newBranch && !base)}
          onClick={() =>
            void change({ kind: "create", path: destination, branch, ...(newBranch && { base }) })
          }
        >
          {t("worktrees.create")}
        </TextButton>
      </Disclosure>
      {value?.some((entry) => entry.prunable !== undefined) && (
        <TextButton disabled={busy} onClick={() => setConfirmation({ kind: "prune" })}>
          {t("worktrees.prune")}
        </TextButton>
      )}
      {confirmation && (
        <Dialog
          title={t(confirmation.kind === "prune" ? "worktrees.prune" : "worktrees.confirmRemove")}
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          {confirmation.kind === "prune"
            ? value
                ?.filter((entry) => entry.prunable !== undefined)
                .map((entry) => (
                  <p className="mono" key={entry.path}>
                    {entry.path}
                  </p>
                ))
            : "oid" in confirmation && (
                <>
                  <p>{t("worktrees.cleanupNotice")}</p>
                  <p className="mono selectable">
                    {confirmation.path} · {confirmation.branch} · {confirmation.oid}
                  </p>
                </>
              )}
          <TextButton disabled={busy} onClick={() => void change(confirmation)}>
            {t(
              confirmation.kind === "cleanup"
                ? "worktrees.cleanup"
                : confirmation.kind === "prune"
                  ? "worktrees.prune"
                  : "worktrees.remove",
            )}
          </TextButton>
        </Dialog>
      )}
      <ul className="divide-y divide-border-subtle">
        {value?.map((entry) => (
          <li key={entry.path} className="space-y-1 py-2 text-sm">
            <strong>{t(entry.main ? "worktrees.main" : "worktrees.linked")}</strong>
            <p className="selectable mono break-all">{entry.path}</p>
            <p>
              {entry.bare
                ? t("worktrees.bare")
                : (entry.branch ??
                  t("repositoryOverview.detachedHead", { oid: entry.oid?.slice(0, 8) }))}
            </p>
            {entry.locked !== undefined && (
              <p>
                {t("worktrees.locked")} {entry.locked}
              </p>
            )}
            {entry.prunable !== undefined && (
              <p>
                {t("worktrees.prunable")} {entry.prunable}
              </p>
            )}
            {!entry.main && !entry.bare && (
              <div className="flex flex-wrap gap-2">
                <TextButton
                  disabled={busy}
                  onClick={() =>
                    void change({
                      kind: entry.locked === undefined ? "lock" : "unlock",
                      path: entry.path,
                    })
                  }
                >
                  {t(entry.locked === undefined ? "worktrees.lock" : "worktrees.unlock")}
                </TextButton>
                {entry.available &&
                  !entry.current &&
                  entry.oid &&
                  entry.locked === undefined &&
                  (["remove", "cleanup"] as const).map(
                    (kind) =>
                      (kind === "remove" || entry.branch) && (
                        <TextButton
                          key={kind}
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              kind,
                              path: entry.path,
                              oid: entry.oid!,
                              ...(entry.branch && { branch: entry.branch }),
                            })
                          }
                        >
                          {t(kind === "remove" ? "worktrees.remove" : "worktrees.cleanup")}
                        </TextButton>
                      ),
                  )}
              </div>
            )}
            {!entry.available && <p>{t("worktrees.unavailable")}</p>}
            {entry.available && !entry.bare && (
              <div className="flex flex-wrap gap-2">
                {entry.path !== repository.path && (
                  <>
                    <TextButton disabled={busy} onClick={() => void open(entry.path, "tab")}>
                      {t("worktrees.open")}
                    </TextButton>
                    <TextButton disabled={busy} onClick={() => void open(entry.path, "current")}>
                      {t("worktrees.replaceTab")}
                    </TextButton>
                  </>
                )}
                <TextButton disabled={busy} onClick={() => void open(entry.path, "folder")}>
                  {t("repositoryHome.openFolder")}
                </TextButton>
                <TextButton disabled={busy} onClick={() => void open(entry.path, "editor")}>
                  {t("settings.app.editor")}
                </TextButton>
                <TextButton disabled={busy} onClick={() => void open(entry.path, "terminal")}>
                  {t("worktrees.terminal")}
                </TextButton>
              </div>
            )}
          </li>
        ))}
      </ul>
      <details onToggle={(e) => setInspectFlow(e.currentTarget.open)}>
        <summary>{t("flow.title")}</summary>
        {inspectFlow && <GitflowTools id={repository.id} onChange={retry} />}
      </details>
      <TextButton
        disabled={busy}
        onClick={() => {
          onClose();
          useRepositoryStore.setState({
            commandDialog: { kind: "repository.references", oid: undefined },
          });
        }}
      >
        {t("worktrees.reviewBranches")}
      </TextButton>
      <LfsTools id={repository.id} />
      <details onToggle={(event) => setInspectSparse(event.currentTarget.open)}>
        <summary>{t("sparse.title")}</summary>
        {inspectSparse && <SparseCheckout id={repository.id} />}
      </details>
      <details onToggle={(event) => setInspectModules(event.currentTarget.open)}>
        <summary>{t("submodules.title")}</summary>
        <SubmoduleTools listing={modules.value} id={repository.id} onChange={modules.retry} />
        {modules.error && (
          <StateMessage
            tone="error"
            title={modules.error}
            action={<TextButton onClick={modules.retry}>{t("common.retry")}</TextButton>}
          />
        )}
        {!modules.error && !modules.value && (
          <StateMessage tone="loading" title={t("submodules.title")} />
        )}
        {modules.value?.parent && (
          <TextButton disabled={busy} onClick={() => void open(modules.value!.parent!, "tab")}>
            {t("submodules.parent")}
          </TextButton>
        )}
        {modules.value?.entries.length === 0 && <p>{t("submodules.empty")}</p>}
        <ul>
          {modules.value?.entries.map((entry) => (
            <li key={entry.path} className="py-1 text-sm">
              <span className="mono selectable">{entry.path}</span> ·{" "}
              {t(`submodules.${entry.state}`)} {entry.dirty && t("submodules.dirty")}
              {entry.directory && (
                <TextButton disabled={busy} onClick={() => void open(entry.directory!, "tab")}>
                  {t("submodules.open")}
                </TextButton>
              )}
            </li>
          ))}
        </ul>
      </details>
    </Dialog>
  );
}

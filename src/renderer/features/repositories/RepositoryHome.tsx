import { lazyRepositoryDialog } from "../repository-dialogs.lazy";
import { usePreferencesStore } from "../../stores/preferences-store";
import { configuredCommands, shortcutLabel } from "../../commands/shell-commands";
import { Localized } from "@renderer/i18n/Localized";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { errorMessage, ok } from "@shared/errors";
import { getLocale, t } from "@shared/i18n";
import type { RepositorySummary } from "@shared/repository/repository";
import {
  ArrowUpRightIcon as ArrowUpRight,
  FolderOpenIcon as FolderOpen,
  PencilIcon as Pencil,
  SquareArrowOutUpRightIcon as SquareArrowOutUpRight,
  StarIcon as Star,
} from "../../components/ui/icons";
import { Fragment, lazy, Suspense, useState } from "react";
import { ButtonBase } from "../../components/ui/actions/ButtonBase";
import {
  Button,
  Dialog,
  ErrorDialog,
  FolderIcon,
  IconButton,
  Input,
  SearchField,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useShellStore } from "../../stores/shell-store";
import { RemoveRepositoryButton } from "./RemoveRepositoryButton";
import { InitRepositoryDialog } from "./InitRepositoryDialog";

import { RepositoryTrustButton } from "./RepositoryTrustButton";

const CollectionsDialog = lazy(() =>
  import("./CollectionsDialog").then((m) => ({ default: m.CollectionsDialog })),
);
const CloneRepositoryDialog = lazyRepositoryDialog("CloneRepositoryDialog");

export function RepositoryHome() {
  const overrides = usePreferencesStore((state) => state.values.shortcutOverrides.value);
  const browseShortcut = configuredCommands(overrides).find(
    (command) => command.id === "repositories.browse",
  )?.shortcut;
  const repositories = useAppStore((state) => state.repositories);
  const active = useAppStore((state) => state.activeIdentity);
  const addRepository = useAppStore((state) => state.addRepository);
  const selectRepository = useAppStore((state) => state.selectRepository);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [editing, setEditing] = useState<RepositorySummary | null>(null);
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const matches = repositories.filter((repository) =>
    `${repository.name} ${repository.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  const update = async (repository: RepositorySummary, name: string, favourite: boolean) => {
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.repository.updateMetadata(repository.id, { name, favourite });

      if (!result.ok) setError(errorMessage(result.error));
      else {
        setEditing(null);
        await useAppStore.getState().refreshRepositories();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-surface-panel h-full overflow-y-auto">
      <div className="mx-auto max-w-[60rem] px-6 py-12">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{t("repositoryHome.repositories")}</h1>

            <p className="mt-2 text-sm text-text-tertiary">
              {t("repositoryHome.profileRepositoryCount", {
                name: active?.name,
                count: repositories.length,
              })}
            </p>
          </div>

          <div data-tour="repository-actions" className="flex gap-2">
            <Button size="sm" disabled={!active} onClick={() => setCollectionsOpen(true)}>
              {t("collections.title")}
            </Button>
            <Button size="sm" onClick={() => setCloning(true)}>
              {t("repositoryHome.cloneRepository")}
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              {t("repositoryHome.createRepository")}
            </Button>

            <Button
              size="sm"
              variant="primary"
              icon={<FolderIcon size={14} />}
              onClick={() => void addRepository()}
            >
              {t("repositoryHome.addARepository")}
            </Button>
          </div>
        </div>

        <SearchField
          size="md"
          aria-label={t("repositoryHome.filterRepositories")}
          placeholder={t("repositoryHome.searchByNameOrPath")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {!editing && <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>}

        {matches.length > 0 ? (
          <div data-tour="repository-list" className="border-t border-border-subtle">
            {matches.map((repository) => (
              <Fragment key={repository.identityId + ":" + repository.id}>
                <div className="flex items-center gap-2 border-b border-border-subtle">
                  <ButtonBase
                    data-tour={`repository-open-${repository.id}`}
                    onClick={() => selectRepository(repository.id)}
                    aria-label={t("repositoryHome.open", { name: repository.name })}
                    className="group flex min-w-0 flex-1 items-center gap-3 px-2 py-4 text-left hover:bg-bg-inset"
                  >
                    <FolderIcon size={16} className="shrink-0 text-text-tertiary" />

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{repository.name}</span>

                      <span
                        className="mt-1 block truncate text-xs text-text-tertiary"
                        title={repository.path}
                      >
                        {repository.available
                          ? repository.path
                          : (repository.unavailableReason ??
                            t("repositoryHome.folderUnavailableOpenToRetry"))}
                      </span>
                    </span>

                    <ArrowUpRight
                      size={14}
                      className="shrink-0 text-text-tertiary"
                      aria-hidden="true"
                    />
                  </ButtonBase>

                  <IconButton
                    disabled={busy}
                    aria-label={`${repository.favourite ? t("repositoryHome.unfavourite") : t("repositoryHome.favourite")} ${repository.name}`}
                    aria-pressed={repository.favourite}
                    title={t("repositoryHome.favourite")}
                    onClick={() => void update(repository, repository.name, !repository.favourite)}
                    icon={<Star size={15} fill={repository.favourite ? "currentColor" : "none"} />}
                  />

                  <IconButton
                    aria-label={t("repositoryHome.editRepository", { name: repository.name })}
                    title={t("repositoryHome.repositorySettings")}
                    onClick={() => {
                      setEditing(repository);
                      setAlias(repository.name);
                    }}
                    icon={<Pencil size={15} />}
                  />

                  <IconButton
                    disabled={!repository.available}
                    aria-label={t("repositoryHome.reveal", { name: repository.name })}
                    title={t("repositoryHome.openFolder")}
                    onClick={() =>
                      void window.eda.repository.reveal(repository.id).then((result) => {
                        if (!result.ok) setError(errorMessage(result.error));
                      })
                    }
                    icon={<FolderOpen size={15} />}
                  />

                  <IconButton
                    disabled={!repository.available}
                    aria-label={t("repositoryHome.openInEditor", { name: repository.name })}
                    title={t("repositoryHome.openInConfiguredEditor")}
                    onClick={() =>
                      void window.eda.repository.openEditor(repository.id).then((result) => {
                        if (!result.ok) setError(errorMessage(result.error));
                      })
                    }
                    icon={<SquareArrowOutUpRight size={15} />}
                  />

                  {repository.available && (
                    <TextButton
                      aria-expanded={inspecting === repository.id}
                      aria-label={t("repositoryHome.inspectStatus", { name: repository.name })}
                      onClick={() =>
                        setInspecting(inspecting === repository.id ? null : repository.id)
                      }
                    >
                      {t("repositoryHome.status")}
                    </TextButton>
                  )}
                  <RemoveRepositoryButton repository={repository} compact disabled={busy} />
                </div>
                {inspecting === repository.id && repository.available && (
                  <RepositoryStatusDetails repositoryId={repository.id} />
                )}
              </Fragment>
            ))}
          </div>
        ) : (
          <p className="border-y border-border-subtle py-8 text-sm text-text-tertiary">
            {query
              ? t("repositoryHome.noMatchingRepositories")
              : t("repositoryHome.noRepositoriesInThisProfileAddALocalFolderToGetStarted")}
          </p>
        )}

        <p className="mt-4 flex items-center justify-end gap-2 text-xs text-text-tertiary">
          <Button variant="ghost" size="sm" onClick={() => useShellStore.getState().startTour()}>
            {t("repositoryHome.takeATour")}
          </Button>

          <Localized
            id="repositoryHome.quickOpen"
            values={{
              kbd: (
                <kbd className="rounded-sm border border-border-default px-1.5 py-0.5">
                  {browseShortcut && shortcutLabel(browseShortcut, window.eda.app.platform)}
                </kbd>
              ),
            }}
          />
        </p>
      </div>

      {creating && <InitRepositoryDialog onClose={() => setCreating(false)} />}

      {active && collectionsOpen && (
        <Suspense fallback={<StateMessage tone="loading" title={t("collections.title")} />}>
          <CollectionsDialog
            key={active.id}
            profileId={active.id}
            onClose={() => setCollectionsOpen(false)}
          />
        </Suspense>
      )}
      {cloning && (
        <Suspense fallback={null}>
          <CloneRepositoryDialog key={active?.id} onClose={() => setCloning(false)} />
        </Suspense>
      )}

      {editing && (
        <Dialog
          title={t("repositoryHome.repositorySettings")}
          busy={busy}
          description={t("repositoryHome.thisAliasBelongsToThisProfileTheFolderOnDiskKeepsItsName")}
          onClose={() => setEditing(null)}
          footer={
            <>
              <RepositoryTrustButton
                key={editing.id}
                repositoryId={editing.id}
                disabled={busy || !editing.available}
                onBusyChange={setBusy}
              />

              <Button
                variant="primary"
                disabled={busy || !alias.trim()}
                onClick={() => void update(editing, alias, editing.favourite)}
              >
                {t("repositoryHome.saveName")}
              </Button>
            </>
          }
        >
          <Input
            aria-label={t("repositoryHome.repositoryDisplayName")}
            value={alias}
            maxLength={120}
            onChange={(event) => setAlias(event.target.value)}
          />

          {error && <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>}
        </Dialog>
      )}
    </div>
  );
}

function RepositoryStatusDetails({ repositoryId }: { repositoryId: string }) {
  const { value, error, retry } = useRepositoryRead(async (id: string) => {
    const result = await window.eda.repository.status(id);
    return result.ok ? ok({ status: result.value, checkedAt: new Date() }) : result;
  }, repositoryId);
  const refresh = (
    <TextButton onClick={retry}>{t("repositoryOverview.refreshRepository")}</TextButton>
  );
  if (!value)
    return (
      <StateMessage
        tone={error ? "error" : "loading"}
        title={error ?? t("repositoryHome.status")}
        action={error && refresh}
      />
    );

  const { branch, changes } = value.status;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-3 py-2 text-xs">
      <strong>
        {branch.head ?? t("repositoryOverview.detachedHead", { oid: branch.oid?.slice(0, 8) })}
      </strong>
      <span>
        {changes.length
          ? t("repositoryHome.changedPaths", { count: changes.length })
          : t("repositoryHome.clean")}
      </span>
      <span>
        {branch.upstream
          ? t("repositoryHome.localSync", {
              upstream: branch.upstream,
              ahead: branch.ahead,
              behind: branch.behind,
            })
          : t("repositoryOverview.noUpstreamConfigured")}
      </span>
      <span>
        {[
          value.status.capabilities?.objectFormat?.toUpperCase(),
          value.status.capabilities?.shallow && t("repositoryFormat.shallow"),
          value.status.capabilities?.sparse && t("repositoryFormat.sparse"),
          value.status.capabilities?.partial && t("repositoryFormat.partial"),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <time dateTime={value.checkedAt.toISOString()}>
        {t("repositoryHome.lastChecked", { time: value.checkedAt.toLocaleTimeString(getLocale()) })}
      </time>
      {refresh}
    </div>
  );
}

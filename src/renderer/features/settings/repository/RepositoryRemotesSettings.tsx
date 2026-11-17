import { t } from "@shared/i18n";
import { useRepositoryRemotes } from "../../sync/hooks/useRepositoryRemotes";
import { RemoteConfiguration } from "../../sync/RemoteConfiguration";
import {
  Button,
  Dialog,
  ErrorDialog,
  Select,
  Skeleton,
  StatusBanner,
} from "../../../components/ui/index";

export function RepositoryRemotesSettings({ repositoryId }: { repositoryId: string }) {
  const {
    state,
    loading,
    loadError,
    reload,
    branch,
    setBranch,
    upstream,
    setUpstream,
    selectedBranch,
    edit,
    setEdit,
    remove,
    setRemove,
    run,
    busy,
    error,
    setError,
    message,
  } = useRepositoryRemotes(repositoryId);
  const disabled = !!busy || loading || !!loadError;

  return (
    <div className="space-y-4" aria-busy={loading}>
      {loading && (
        <span role="status" className="sr-only">
          {t("remotes.loading")}
        </span>
      )}
      {loadError && (
        <StatusBanner
          label={t("settings.remotes")}
          tone="error"
          action={
            <Button size="sm" onClick={() => void reload()}>
              {t("common.retry")}
            </Button>
          }
        >
          {loadError}
        </StatusBanner>
      )}
      <RemoteConfiguration
        remotes={state.remotes}
        edit={edit}
        busy={disabled}
        loading={loading}
        onEdit={setEdit}
        onRemove={setRemove}
        onSave={() =>
          void run("main.remoteService.configureRemote", () =>
            window.eda.remotes.change(repositoryId, edit),
          )
        }
      />
      <section
        className="space-y-4 border-t border-border-subtle pt-4"
        aria-labelledby="branch-tracking-heading"
      >
        <h3 id="branch-tracking-heading" className="text-sm font-medium">
          {t("settings.repositoryRemotesSettings.branchTracking")}
        </h3>
        <label className="block space-y-1 text-xs">
          {t("settings.repositoryRemotesSettings.localBranch")}

          <Select
            compact
            className="w-full"
            aria-label={t("settings.repositoryRemotesSettings.localBranch")}
            value={branch}
            disabled={disabled}
            onValueChange={(value) => {
              setBranch(value);
              setUpstream("");
            }}
          >
            <option value="" disabled>
              {loading
                ? t("remotes.loading")
                : t("settings.repositoryRemotesSettings.chooseABranch")}
            </option>

            {state.branches
              .filter((item) => !item.remote)
              .map((item) => (
                <option key={item.name}>{item.name}</option>
              ))}
          </Select>
        </label>

        {loading ? (
          <Skeleton className="h-5 w-48" />
        ) : (
          !loadError && (
            <p className="text-sm">
              {selectedBranch?.upstream
                ? `${selectedBranch.upstream} ${selectedBranch.upstreamState || t("settings.repositoryRemotesSettings.upToDate")}`
                : t("settings.repositoryRemotesSettings.noUpstreamConfigured")}
            </p>
          )
        )}

        <label className="block space-y-1 text-xs">
          {t("settings.repositoryRemotesSettings.upstream")}

          <Select
            compact
            className="w-full"
            aria-label={t("settings.repositoryRemotesSettings.upstream")}
            value={upstream}
            disabled={disabled}
            onValueChange={(value) => setUpstream(value)}
          >
            <option value="">
              {loading ? t("remotes.loading") : t("settings.repositoryRemotesSettings.noUpstream")}
            </option>

            {state.branches
              .filter((item) => item.remote)
              .map((item) => (
                <option key={item.name} value={`refs/remotes/${item.name}`}>
                  {item.name}
                </option>
              ))}
          </Select>
        </label>

        <Button
          disabled={disabled || !branch || (!upstream && !selectedBranch?.upstream)}
          onClick={() =>
            void run("main.remoteService.setUpstream", () =>
              window.eda.remotes.track(repositoryId, branch, upstream || null),
            )
          }
        >
          {upstream
            ? t("settings.repositoryRemotesSettings.setUpstream")
            : t("settings.repositoryRemotesSettings.unsetUpstream")}
        </Button>

        <p className="text-xs text-text-tertiary">
          {t("settings.repositoryRemotesSettings.aheadBehindCountsUseLocallyFetchedRefsFetch")}
        </p>
      </section>

      {message && (
        <p role="status" className="text-xs text-git-added">
          {message}
        </p>
      )}
      <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      {remove && (
        <Dialog
          title={t("settings.repositoryRemotesSettings.remove", { remove: remove })}
          description={t(
            "settings.repositoryRemotesSettings.removeThisRemoteSConfigurationAndLocalTracking",
          )}
          onClose={() => setRemove(null)}
          footer={
            <Button
              disabled={disabled}
              onClick={() => {
                const name = remove;
                setRemove(null);
                void run("main.remoteService.configureRemote", () =>
                  window.eda.remotes.change(repositoryId, { kind: "remove", name }),
                );
              }}
            >
              {t("settings.repositoryRemotesSettings.removeRemote")}
            </Button>
          }
        >
          <p className="text-sm">
            {t(
              "settings.repositoryRemotesSettings.branchesUsingThisRemoteMayLoseTheirUpstreamConfiguration",
            )}
          </p>
        </Dialog>
      )}
    </div>
  );
}

import { t } from "@shared/i18n";
import type { RemoteChange, RemoteSummary } from "@shared/integrations/remotes";
import { Button, Input, Skeleton } from "../../components/ui/index";

export function RemoteConfiguration({
  remotes,
  edit,
  busy: actionBusy,
  loading = false,
  onEdit,
  onRemove,
  onSave,
}: {
  remotes: RemoteSummary[];
  edit: RemoteChange;
  busy: boolean;
  loading?: boolean;
  onEdit: (change: RemoteChange) => void;
  onRemove: (name: string) => void;
  onSave: () => void;
}) {
  const busy = actionBusy || loading;

  return (
    <>
      <div className="space-y-3">
        {(loading && !remotes.length
          ? [{ name: "loading", fetchUrls: [], pushUrls: [] }]
          : remotes
        ).map((item) => (
          <div key={item.name} className="border-b border-border-subtle pb-3 text-xs">
            <div className="font-medium">
              {loading ? <Skeleton className="h-4 w-24" /> : item.name}
            </div>
            <div className="break-all text-text-tertiary">
              {loading ? (
                <Skeleton className="h-4 w-3/4" />
              ) : (
                t("remotes.remoteConfiguration.fetch", { fetchUrls: item.fetchUrls.join(", ") })
              )}
            </div>
            <div className="break-all text-text-tertiary">
              {loading ? (
                <Skeleton className="h-4 w-3/4" />
              ) : (
                t("remotes.remoteConfiguration.push", { pushUrls: item.pushUrls.join(", ") })
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  onEdit({
                    kind: "url",
                    name: item.name,
                    url: item.fetchUrls[0] ?? "",
                    push: false,
                  })
                }
              >
                {t("remotes.remoteConfiguration.editFetchUrl")}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  onEdit({
                    kind: "url",
                    name: item.name,
                    url: item.pushUrls[0] ?? "",
                    push: true,
                  })
                }
              >
                {t("remotes.remoteConfiguration.editPushUrl")}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onEdit({ kind: "rename", name: item.name, to: item.name })}
              >
                {t("remotes.remoteConfiguration.rename")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onRemove(item.name)}>
                {t("common.remove")}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-2 rounded border border-border-default p-3">
        <p className="text-sm font-medium">
          {edit.kind === "add"
            ? t("remotes.remoteConfiguration.addRemote")
            : t("remotes.remoteConfiguration.edit", { name: edit.name })}
        </p>
        {edit.kind === "add" && (
          <Input
            aria-label={t("remotes.remoteConfiguration.remoteName")}
            disabled={busy}
            value={edit.name}
            onChange={(event) => onEdit({ ...edit, name: event.target.value })}
          />
        )}
        {(edit.kind === "add" || edit.kind === "url") && (
          <Input
            aria-label={t("remotes.remoteConfiguration.remoteUrl")}
            disabled={busy}
            value={edit.url}
            onChange={(event) => onEdit({ ...edit, url: event.target.value })}
            placeholder={t("remotes.remoteConfiguration.httpsHostOwnerRepositoryGit")}
          />
        )}
        {edit.kind === "rename" && (
          <Input
            aria-label={t("remotes.remoteConfiguration.newRemoteName")}
            disabled={busy}
            value={edit.to}
            onChange={(event) => onEdit({ ...edit, to: event.target.value })}
          />
        )}
        <div className="flex gap-2">
          <Button disabled={busy} onClick={onSave}>
            {t("remotes.remoteConfiguration.saveRemote")}
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => onEdit({ kind: "add", name: "", url: "" })}
          >
            {t("remotes.remoteConfiguration.newRemote")}
          </Button>
        </div>
      </div>
    </>
  );
}

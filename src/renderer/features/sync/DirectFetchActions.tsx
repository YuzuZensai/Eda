import type { TransportCredentials } from "@shared/integrations/remotes";
import { HttpsAuthenticationDialog } from "./HttpsAuthenticationDialog";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  ChevronDownIcon as ChevronDown,
  GlobeIcon as Globe,
  RefreshIcon as RefreshCw,
  SettingsIcon as Settings,
  TagIcon as Tag,
} from "../../components/ui/icons";
import { useRef, useState } from "react";
import { openSettings } from "../../stores/shell-store";
import { Button, ErrorDialog, MenuItem, AnchoredPopover } from "../../components/ui/index";
import { GitHubSignInDialog } from "../connections/GitHubSignInDialog";
import { useDirectFetch, type FetchOptions } from "./hooks/useDirectFetch";

export function DirectFetchActions({
  repositoryId,
  disabled,
  onBusyChange,
}: {
  repositoryId: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const action = useDirectFetch(repositoryId);
  const [menu, setMenu] = useState(false);
  const [showError, setShowError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const fetch = async (
    remote?: string | null,
    credentials?: TransportCredentials,
    options?: FetchOptions,
  ) => {
    onBusyChange(true);

    try {
      await action.fetch(remote, credentials, options);
    } finally {
      onBusyChange(false);
    }
  };

  const closeAuth = () => {
    action.setAuthentication(null);
    action.setError(null);
  };

  return (
    <>
      <div className="relative flex items-center">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || action.busy}
          busy={action.busy}
          feedback={action.error ? "error" : action.message ? "success" : "idle"}
          icon={<RefreshCw size={14} />}
          title={
            action.error
              ? t("directFetchActions.fetchFailedClickForDetails")
              : (action.message ?? t("directFetchActions.fetch"))
          }
          onClick={() => (action.error ? setShowError(true) : void fetch())}
        >
          {t("directFetchActions.fetch")}
        </Button>

        <Button
          variant="ghost"
          size="icon-xs"
          ref={trigger}
          disabled={disabled || action.busy}
          aria-label={t("directFetchActions.fetchOptions")}
          aria-haspopup="menu"
          aria-expanded={menu}
          icon={<ChevronDown size={12} />}
          onClick={() => {
            setMenu(!menu);

            if (!menu)
              void window.eda.remotes.inspect(repositoryId).then((result) => {
                if (result.ok) action.setRemotes(result.value.remotes);
                else action.setError(errorMessage(result.error));
              });
          }}
        />

        {menu && (
          <AnchoredPopover
            role="menu"
            aria-label={t("directFetchActions.fetchOptions")}
            anchorRef={trigger}
            placement="bottom-start"
            onClose={() => setMenu(false)}
            className="w-56 p-1"
          >
            {action.remotes.map((remote) => (
              <MenuItem
                key={remote.name}
                onClick={() => {
                  setMenu(false);
                  void fetch(remote.name);
                }}
              >
                <RefreshCw size={13} className="shrink-0" aria-hidden="true" />
                {t("directFetchActions.fetchRemote", { name: remote.name })}
              </MenuItem>
            ))}

            <MenuItem
              onClick={() => {
                setMenu(false);
                void fetch(null);
              }}
            >
              <RefreshCw size={13} className="shrink-0" aria-hidden="true" />
              {t("directFetchActions.fetchAllRemotes")}
            </MenuItem>

            <MenuItem
              onClick={() => {
                setMenu(false);
                void fetch(undefined, undefined, { allTags: true });
              }}
            >
              <Tag size={13} className="shrink-0" aria-hidden="true" />
              {t("directFetchActions.fetchAllTags")}
            </MenuItem>

            <MenuItem
              onClick={() => {
                setMenu(false);
                openSettings("repository-fetch");
              }}
            >
              <Settings size={13} className="shrink-0" aria-hidden="true" />
              {t("directFetchActions.fetchSettings")}
            </MenuItem>

            <MenuItem
              onClick={() => {
                setMenu(false);
                openSettings("repository-remotes");
              }}
            >
              <Globe size={13} className="shrink-0" aria-hidden="true" />
              {t("directFetchActions.manageRemotes")}
            </MenuItem>
          </AnchoredPopover>
        )}
      </div>

      <span role="status" className="sr-only">
        {action.busy ? t("directFetchActions.fetching") : (action.error ?? action.message)}
      </span>

      {action.authentication && (
        <HttpsAuthenticationDialog
          key={action.authentication}
          title={t("directFetchActions.hTtpsAuthentication")}
          description={t("directFetchActions.signInToFetchCredentialsAreUsedForThisActionOnly", {
            authentication: action.authentication,
          })}
          submitLabel={t("directFetchActions.retryFetch")}
          busy={action.busy}
          error={action.error}
          onClose={closeAuth}
          onSubmit={(credentials) =>
            void fetch(action.authentication, credentials, action.retryOptions)
          }
        />
      )}

      {action.githubAuthentication && (
        <GitHubSignInDialog
          accessDenied={action.githubAccessDenied}
          onClose={() => {
            action.setGitHubAuthentication(null);
            action.setError(null);
          }}
        />
      )}

      {showError && !action.authentication && !action.githubAuthentication && (
        <ErrorDialog
          onDismiss={() => {
            setShowError(false);
            action.setError(null);
          }}
        >
          {action.error}
        </ErrorDialog>
      )}
    </>
  );
}

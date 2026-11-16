import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  preferredRemote,
  type RemoteSummary,
  type TransportCredentials,
} from "@shared/integrations/remotes";
import { useState } from "react";
import { useRepositoryStore } from "../../../stores/repository-store";
import { useTransportOperation } from "./useTransportOperation";

export interface FetchOptions {
  allTags?: boolean;
  tag?: string;
}

export function useDirectFetch(repositoryId: string) {
  const { busy, begin } = useTransportOperation(repositoryId);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [authentication, setAuthentication] = useState<string | null>(null);
  const [githubAuthentication, setGitHubAuthentication] = useState<string | null>(null);
  const [githubAccessDenied, setGitHubAccessDenied] = useState(false);
  const [remotes, setRemotes] = useState<RemoteSummary[]>([]);
  const [retryOptions, setRetryOptions] = useState<FetchOptions>({});

  const fetch = async (
    target?: string | null,
    credentials?: TransportCredentials,
    options: FetchOptions = {},
  ): Promise<boolean> => {
    const operation = begin();
    if (!operation) return false;
    const { current, profileId } = operation;
    setError(null);
    setMessage(null);
    setAuthentication(null);
    setGitHubAuthentication(null);
    setGitHubAccessDenied(false);
    try {
      const context = { profileId, repositoryId };
      const [inspected, prune, tags] = await Promise.all([
        window.eda.remotes.inspect(repositoryId),
        window.eda.settings.resolve("fetchPrune", context),
        window.eda.settings.resolve("fetchTags", context),
      ]);
      if (!current()) return false;
      if (!inspected.ok) {
        setError(errorMessage(inspected.error));
        return false;
      }
      if (!prune.ok) {
        setError(errorMessage(prune.error));
        return false;
      }
      if (!tags.ok) {
        setError(errorMessage(tags.error));
        return false;
      }
      setRemotes(inspected.value.remotes);
      const preferred = preferredRemote(inspected.value);
      const remote = target === undefined ? preferred?.name : target;
      if (remote === undefined || !inspected.value.remotes.length) {
        setError(t("useDirectFetch.noRemotesConfiguredAddARemoteInThe"));
        return false;
      }
      if (remote !== null && !inspected.value.remotes.some((item) => item.name === remote)) {
        setError(t("useDirectFetch.thisRemoteNoLongerExistsChooseAnotherRemote"));
        return false;
      }
      const destinations =
        remote === null
          ? inspected.value.remotes
          : inspected.value.remotes.filter((item) => item.name === remote);
      for (const destination of destinations) {
        if (!current()) return false;
        const result = await window.eda.remotes.fetch({
          repositoryId,
          remote: destination.name,
          prune: !options.tag && prune.value.value,
          tags: !options.tag && (options.allTags ?? tags.value.value),
          ...(options.tag !== undefined ? { tag: options.tag } : {}),
          ...(credentials ? { credentials } : {}),
        });
        if (!current()) return false;
        if (!result.ok) {
          setRetryOptions(options);
          setError(errorMessage(result.error));
          if (
            result.error.kind === "github-auth-required" ||
            result.error.kind === "github-access-required"
          ) {
            setGitHubAuthentication(destination.name);
            setGitHubAccessDenied(result.error.kind === "github-access-required");
          }
          if (
            result.error.kind === "auth-failed" &&
            (options.tag ? destination.pushUrls : destination.fetchUrls).some((url) =>
              url.startsWith("https://"),
            )
          )
            setAuthentication(destination.name);
          return false;
        }
      }
      setMessage(
        remote === null
          ? t("useDirectFetch.fetchedAllRemotes")
          : t("useDirectFetch.fetched", { remote: remote }),
      );
    } catch {
      if (current()) setError(t("useDirectFetch.couldNotCompleteFetchTryAgain"));
      return false;
    } finally {
      await operation.finish();
      if (current()) await useRepositoryStore.getState().syncFromDisk();
    }
    return current();
  };
  return {
    fetch,
    busy,
    error,
    setError,
    message,
    authentication,
    setAuthentication,
    githubAuthentication,
    githubAccessDenied,
    setGitHubAuthentication,
    remotes,
    setRemotes,
    retryOptions,
  };
}

import type { Result } from "@shared/errors";
import { errorAction, errorMessage } from "@shared/errors";
import { t, type MessageKey } from "@shared/i18n";
import type { RemoteChange, RemoteState } from "@shared/integrations/remotes";
import { useEffect, useRef, useState } from "react";
import { useRepositoryStore } from "../../../stores/repository-store";

export function useRepositoryRemotes(repositoryId: string) {
  const loadRevision = useRef(0);
  const running = useRef(false);
  const mounted = useRef(false);
  const contextRevision = useRef(0);
  const [state, setState] = useState<RemoteState>({ remotes: [], branches: [] });
  const [branch, setBranch] = useState("");
  const [upstream, setUpstream] = useState("");
  const [edit, setEdit] = useState<RemoteChange>({ kind: "add", name: "origin", url: "" });
  const [remove, setRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState<MessageKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = async () => {
    const revision = ++loadRevision.current;
    try {
      const result = await window.eda.remotes.inspect(repositoryId);

      if (revision !== loadRevision.current) return;

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      setState(result.value);

      const current = result.value.branches.find((item) => item.isHead)?.name ?? "";

      setBranch((old) => old || current);
    } catch (error) {
      if (revision === loadRevision.current) setError(errorMessage(error));
    }
  };

  useEffect(() => {
    mounted.current = true;
    running.current = false;
    setBusy(null);
    setState({ remotes: [], branches: [] });
    setBranch("");
    setUpstream("");
    setEdit({ kind: "add", name: "origin", url: "" });
    setRemove(null);
    setError(null);
    setMessage(null);
    void load();
    return () => {
      mounted.current = false;
      loadRevision.current++;
      contextRevision.current++;
    };
  }, [repositoryId]);

  const run = async <T>(kindKey: MessageKey, work: () => Promise<Result<T>>) => {
    if (!mounted.current || running.current) return;
    running.current = true;
    const context = contextRevision.current;

    setBusy(kindKey);
    setError(null);
    setMessage(null);

    try {
      const result = await work();

      if (context !== contextRevision.current) return;

      if (!result.ok) {
        setError(`${errorMessage(result.error)} ${errorAction(result.error) ?? ""}`);
      } else {
        setMessage(
          typeof result.value === "string" ? result.value : t("remotes.useRepositoryRemotes.saved"),
        );
      }

      await load();

      if (context !== contextRevision.current) return;
      if (useRepositoryStore.getState().repositoryId === repositoryId)
        await useRepositoryStore.getState().syncFromDisk();
    } catch (error) {
      if (context === contextRevision.current) setError(errorMessage(error));
    } finally {
      if (context === contextRevision.current) {
        running.current = false;
        setBusy(null);
      }
    }
  };

  const selectedBranch = state.branches.find((item) => !item.remote && item.name === branch);

  return {
    state,
    branch,
    setBranch,
    upstream,
    setUpstream,
    edit,
    setEdit,
    remove,
    setRemove,
    busy,
    error,
    setError,
    message,
    run,
    selectedBranch,
  };
}

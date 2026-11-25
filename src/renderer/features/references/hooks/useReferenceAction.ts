import { useRef, useState } from "react";
import { errorText, type ErrorText } from "@shared/error-codes";
import { AppError, errorAction, errorMessage } from "@shared/errors";
import {
  repositoryCommandReason,
  type RepositoryCommandContext,
} from "../../../commands/repository-commands";
import { useRepositoryStore } from "../../../stores/repository-store";

export function useReferenceAction(
  context: RepositoryCommandContext,
  options: {
    onClose?: () => void;
    onBusyChange?: (busy: boolean) => void;
    initiallyBusy?: boolean;
    fallback?: ErrorText;
  },
) {
  const running = useRef(false);
  const [busy, setBusy] = useState(options.initiallyBusy ?? false);
  const [error, setError] = useState<string | null>(null);

  const assertContext = () => {
    const reason = repositoryCommandReason(context);
    if (reason) throw new AppError(errorText("errors.operationBlocked", { reason }));
  };

  const run = async (work: () => Promise<void>, { dismiss = true, write = true } = {}) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    options.onBusyChange?.(true);
    setError(null);

    try {
      if (write) assertContext();
      await work();
      if (dismiss) options.onClose?.();
    } catch (failure) {
      setError(
        [errorMessage(failure, options.fallback), errorAction(failure)].filter(Boolean).join(" "),
      );
    } finally {
      running.current = false;
      setBusy(false);
      options.onBusyChange?.(false);
    }
  };

  const refresh = async () => {
    if (!repositoryCommandReason(context)) await useRepositoryStore.getState().refresh();
  };

  return { running, busy, setBusy, error, setError, assertContext, run, refresh };
}

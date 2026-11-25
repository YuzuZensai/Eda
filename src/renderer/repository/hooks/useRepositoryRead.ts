import { errorAction, errorMessage, type Result } from "@shared/errors";
import { useState, useEffect, useEffectEvent, useMemo } from "react";

export function useRepositoryRead<Request, Value>(
  read: (request: Request) => Promise<Result<Value>>,
  request: Request | null,
) {
  const runRead = useEffectEvent(read);
  const [attempt, setAttempt] = useState(0);
  const readKey = useMemo(() => ({ request, attempt }), [request, attempt]);
  const [response, setResponse] = useState<{
    readKey: typeof readKey;
    value?: Value;
    error?: string;
  }>();

  useEffect(() => {
    const { request } = readKey;
    if (request === null) return;
    let active = true;

    const load = async () => {
      try {
        const result = await runRead(request);
        if (!active) return;

        if (result.ok) setResponse({ readKey, value: result.value });
        else {
          const error = [errorMessage(result.error), errorAction(result.error)]
            .filter(Boolean)
            .join(" ");
          setResponse({ readKey, error });
        }
      } catch (error) {
        if (active) setResponse({ readKey, error: errorMessage(error) });
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [readKey]);

  const current = response?.readKey === readKey ? response : null;
  return { value: current?.value, error: current?.error, retry: () => setAttempt((n) => n + 1) };
}

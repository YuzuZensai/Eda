import { errorAction, errorMessage, type Result } from "@shared/errors";
import { useState, useEffect, useEffectEvent } from "react";

export function useRepositoryRead<Request, Value>(
  read: (request: Request) => Promise<Result<Value>>,
  request: Request | null,
) {
  const runRead = useEffectEvent(read);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{
    request: Request;
    attempt: number;
    value?: Value;
    error?: string;
  }>();

  useEffect(() => {
    if (!request) return;
    let active = true;

    const load = async () => {
      try {
        const result = await runRead(request);
        if (!active) return;

        if (result.ok) setResponse({ request, attempt, value: result.value });
        else {
          const error = [errorMessage(result.error), errorAction(result.error)]
            .filter(Boolean)
            .join(" ");
          setResponse({ request, attempt, error });
        }
      } catch (error) {
        if (active) setResponse({ request, attempt, error: errorMessage(error) });
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [request, attempt]);

  const current = response?.request === request && response.attempt === attempt ? response : null;
  return { value: current?.value, error: current?.error, retry: () => setAttempt((n) => n + 1) };
}

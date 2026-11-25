import {
  builtInSetting,
  type ResolvedSetting,
  type SettingKey,
  type SettingScope,
  type SettingValues,
} from "@shared/preferences/settings";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../../stores/app-store";
import { preferenceReadError, usePreferencesStore } from "../../../stores/preferences-store";

function isActiveScope(scope: SettingScope) {
  const state = useAppStore.getState();
  return (
    state.switchingIdentityId === null &&
    (scope.kind === "application" ||
      (state.activeIdentity?.id === scope.profileId &&
        (scope.kind === "profile" || state.selectedRepositoryId === scope.repositoryId)))
  );
}

export function useScopedSetting<K extends SettingKey>(
  key: K,
  owner: "application" | "profile" | "repository",
  repositoryId?: string,
) {
  const profileId = useAppStore((state) =>
    owner === "application" ? undefined : state.activeIdentity?.id,
  );
  const switching = useAppStore((state) => state.switchingIdentityId);
  const values = usePreferencesStore((state) => state.values);
  const request = useMemo(() => {
    if (switching !== null) return null;
    let scope: SettingScope;
    if (owner === "application") scope = { kind: owner };
    else if (owner === "profile" && profileId) scope = { kind: owner, profileId };
    else if (owner === "repository" && profileId && repositoryId)
      scope = { kind: owner, profileId, repositoryId };
    else return null;
    return { key, scope };
  }, [key, owner, profileId, repositoryId, switching]);

  const [result, setResult] = useState<{
    request: NonNullable<typeof request>;
    values: typeof values;
    value: ResolvedSetting<K> | null;
  } | null>(null);
  const fallback = useMemo(() => builtInSetting(key), [key]);
  const current = result?.request === request ? result : null;
  const confirmed = current?.value;
  const resolved = confirmed ?? fallback;
  const reading = !!request && current?.values !== values;
  const unavailable = !confirmed || reading;
  const writable = useRef<typeof request>(null);

  useLayoutEffect(() => {
    writable.current = confirmed ? request : null;
    return () => {
      writable.current = null;
    };
  }, [request, confirmed]);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;

    const current = () => !cancelled && isActiveScope(request.scope);
    const { kind: _kind, ...context } = request.scope;
    void window.eda.settings
      .resolve(request.key, context)
      .then((result) => {
        if (!current()) return;
        if (result.ok) setResult({ request, values, value: result.value });
        else {
          setResult({ request, values, value: null });
          usePreferencesStore.setState({ error: result.error });
        }
      })
      .catch(() => {
        if (!current()) return;
        setResult({ request, values, value: null });
        usePreferencesStore.setState({ error: preferenceReadError() });
      });

    return () => {
      cancelled = true;
    };
  }, [request, values]);

  const scope = request?.scope;
  const canWrite = (scope: SettingScope) =>
    !unavailable && writable.current === request && isActiveScope(scope);

  return {
    resolved,
    reading,
    unavailable,
    following: owner !== "application" && resolved.source.kind !== owner,
    set: (value: SettingValues[K]) =>
      scope && canWrite(scope)
        ? usePreferencesStore.getState().set(key, scope, value)
        : Promise.resolve(false),
    reset: () =>
      scope && canWrite(scope)
        ? usePreferencesStore.getState().reset(key, scope)
        : Promise.resolve(false),
  };
}

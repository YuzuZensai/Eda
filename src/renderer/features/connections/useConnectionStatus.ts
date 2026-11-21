import { errorMessage, type Result } from "@shared/errors";
import { useEffect, useRef, useState } from "react";

export function useConnectionStatus<
  Status extends { account: { id: string } | null },
  Profile extends { id: string },
  SignIn extends { id: string },
>(
  profileId: string,
  api: {
    selectAccount: (profileId: string, accountId: string) => Promise<Result<Status>>;
    status: (profileId: string) => Promise<Result<Status>>;
    profile: (profileId: string) => Promise<Result<Profile | null>>;
    cancel: (profileId: string, sessionId: string) => Promise<unknown>;
  },
  loadError: string,
) {
  const [busy, setBusy] = useState(false);
  const [statusRevision, setStatusRevision] = useState(0);
  const [statusLoading, setStatusLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [profileReadyFor, setProfileReadyFor] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const current = useRef<SignIn | null>(null);

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      if (current.current) void api.cancel(profileId, current.current.id);
      current.current = null;
    };
  }, [api, profileId]);

  useEffect(() => {
    let active = true;
    setStatusLoading(true);
    setError(null);

    void api
      .status(profileId)
      .then((result) => {
        if (!active) return;
        if (result.ok) setStatus(result.value);
        else setError(errorMessage(result.error));
      })
      .catch(() => {
        if (active) setError(loadError);
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, profileId, statusRevision, loadError]);

  useEffect(() => {
    let active = true;
    setProfile(null);
    setProfileReadyFor(null);
    const accountId = status?.account?.id;

    if (accountId)
      void api
        .profile(profileId)
        .then((result) => {
          if (active && result.ok && result.value?.id === accountId) setProfile(result.value);
        })
        .catch(() => {
          if (active) setProfile(null);
        })
        .finally(() => {
          if (active) setProfileReadyFor(accountId);
        });

    return () => {
      active = false;
    };
  }, [api, profileId, status?.account?.id]);

  const selectAccount = async (accountId: string) => {
    if (!accountId) return;
    setBusy(true);
    setError(null);

    try {
      const result = await api.selectAccount(profileId, accountId);
      if (!alive.current) return;
      if (result.ok) setStatus(result.value);
      else setError(errorMessage(result.error));
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return {
    busy,
    setBusy,
    selectAccount,
    status,
    setStatus,
    statusLoading,
    loading: statusLoading || !!(status?.account && profileReadyFor !== status.account.id),
    profile,
    error,
    setError,
    alive,
    current,
    retryStatus: () => setStatusRevision((value) => value + 1),
  };
}

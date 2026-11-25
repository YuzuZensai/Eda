import { errorMessage, type Result } from "@shared/errors";
import { useEffect, useRef, useState } from "react";

export function useConnectionStatus<
  Status extends { account: { id: string } | null; alternatives?: readonly unknown[] },
  Profile extends { id: string },
  SignIn extends { id: string },
>(
  profileId: string,
  api: {
    selectAccount: (profileId: string, accountId: string) => Promise<Result<Status>>;
    status: (profileId: string) => Promise<Result<Status>>;
    profile: (profileId: string) => Promise<Result<Profile | null>>;
    cancel: (profileId: string, sessionId: string) => Promise<unknown>;
    begin: (profileId: string) => Promise<Result<SignIn>>;
    disconnect: (profileId: string) => Promise<Result<void>>;
    openProfile: (profileId: string, copyUrl?: boolean) => Promise<Result<void>>;
  },
  messages: { load: string; begin: string; disconnect: string; openProfile: string },
) {
  const [pending, setPending] = useState<SignIn | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [connectRequested, setConnectRequested] = useState(false);
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
        if (active) setError(messages.load);
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, profileId, statusRevision, messages.load]);

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

  const beginSignIn = async (openBrowser: (signIn: SignIn) => Promise<boolean>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.begin(profileId);
      if (!alive.current) {
        if (result.ok) void api.cancel(profileId, result.value.id);
        return;
      }
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      current.current = result.value;
      setPending(result.value);
      await openBrowser(result.value);
    } catch {
      if (alive.current) setError(messages.begin);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const cancel = () => {
    if (current.current) void api.cancel(profileId, current.current.id);
    current.current = null;
    setPending(null);
    setError(null);
    setExpanded(false);
    setConnectRequested(false);
  };

  const retryStatus = () => setStatusRevision((value) => value + 1);
  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.disconnect(profileId);
      if (!alive.current) return;
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      setStatus((value) => value && { ...value, account: null });
      if (status?.alternatives?.length) retryStatus();
      setExpanded(false);
      setConnectRequested(false);
    } catch {
      if (alive.current) setError(messages.disconnect);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const openProfile = async (copyUrl = false) => {
    try {
      const result = await (copyUrl
        ? api.openProfile(profileId, true)
        : api.openProfile(profileId));
      if (alive.current && !result.ok) setError(errorMessage(result.error));
      return result.ok;
    } catch {
      if (alive.current) setError(messages.openProfile);
      return false;
    }
  };

  return {
    busy,
    beginSignIn,
    cancel,
    disconnect,
    openProfile,
    pending,
    setPending,
    expanded,
    setExpanded,
    connectRequested,
    setConnectRequested,
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
    retryStatus,
  };
}

import { ProviderConnections } from "../connections/ProviderConnections";
import { t } from "@shared/i18n";
import { useAppStore } from "../../stores/app-store";
import { SshSetupCard } from "./SshSetupCard";

export function ConnectionsStep({ profileId }: { profileId: string }) {
  const identity = useAppStore((state) => state.activeIdentity);

  return (
    <div className="space-y-3">
      <ProviderConnections profileId={profileId} />

      {identity?.id === profileId && <SshSetupCard key={profileId} identity={identity} />}
      <p className="text-xs leading-relaxed text-text-tertiary">
        {t("onboarding.connectionsStep.connectionsAndKeysBelongToThisProfileYou")}
      </p>
    </div>
  );
}

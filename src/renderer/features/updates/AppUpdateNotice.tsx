import { useState } from "react";
import { t } from "@shared/i18n";
import type { UpdateState } from "@shared/updates";
import { Button, StatusBanner } from "../../components/ui/index";
import { usePreferencesStore } from "../../stores/preferences-store";
import { openSettings } from "../../stores/shell-store";

export function AppUpdateNotice({
  state,
  preview,
  aboutOpen,
}: {
  state: UpdateState | null;
  preview: boolean;
  aboutOpen: boolean;
}) {
  const enabled = usePreferencesStore((store) => store.values.updateNotices.value);
  if (!state || (state.phase !== "available" && state.phase !== "ready")) return null;

  const release = state.release;
  const noticeId = JSON.stringify([
    preview,
    release?.version ?? release?.name,
    state.phase,
    state.capability,
    state.reason,
  ]);

  return <ReleaseNotice key={noticeId} release={release} hidden={!enabled || aboutOpen} />;
}

function ReleaseNotice({ release, hidden }: { release: UpdateState["release"]; hidden: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  if (hidden || dismissed) return null;

  const name = release?.version
    ? t("appUpdateNotice.releaseVersion", { version: release.version })
    : (release?.name ?? t("appUpdateNotice.anUpdate"));

  const heading = t("appUpdateNotice.isAvailable", { value1: name });

  return (
    <StatusBanner
      label={t("appUpdateNotice.updateNotification")}
      title={heading}
      onDismiss={() => setDismissed(true)}
      action={
        <Button size="sm" variant="quiet" onClick={() => openSettings("about")}>
          {t("appUpdateNotice.viewUpdate")}
        </Button>
      }
    >
      <span className="font-medium text-text-primary">{heading}</span>
    </StatusBanner>
  );
}

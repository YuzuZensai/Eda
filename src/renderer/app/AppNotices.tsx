import { StatusBannerStack } from "../components/ui/index";
import { GlobalGitWarning } from "../features/profiles/GlobalGitWarning";
import { AppUpdateNotice } from "../features/updates/AppUpdateNotice";
import { useUpdates } from "../features/updates/hooks/useUpdates";

export function AppNotices({
  aboutOpen,
  onReviewGitSettings,
}: {
  aboutOpen: boolean;
  onReviewGitSettings: () => void;
}) {
  const { state, preview } = useUpdates();

  return (
    <StatusBannerStack>
      {state?.phase !== "installing" && <GlobalGitWarning onReview={onReviewGitSettings} />}

      <AppUpdateNotice state={state} preview={preview} aboutOpen={aboutOpen} />
    </StatusBannerStack>
  );
}

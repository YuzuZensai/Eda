import { t } from "@shared/i18n";
import { Button, StateMessage } from "../../components/ui/index";

export function LocalReferenceFeedback({
  loaded,
  empty,
  error,
  retry,
}: {
  loaded: boolean;
  empty: boolean;
  error: string | undefined;
  retry: () => void;
}) {
  if (loaded) return empty ? <p role="status">{t("references.noMatches")}</p> : null;
  return (
    <StateMessage
      tone={error ? "error" : "loading"}
      title={
        error ? t("manageReferencesDialog.referencesCouldNotBeLoaded") : t("references.loading")
      }
      description={error}
      action={error && <Button onClick={retry}>{t("common.retry")}</Button>}
    />
  );
}

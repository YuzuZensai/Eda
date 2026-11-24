import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { PatchExportRequest } from "@shared/repository/repository-read";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useState } from "react";
import { ErrorDialog, TextButton } from "../../components/ui/index";

export function ExportPatchButton({
  request,
  oldPath,
}: {
  request: PatchExportRequest & { path: string };
  oldPath?: string | undefined;
}) {
  const diffTool = usePreferencesStore((state) => state.values.diffExecutable.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <TextButton
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await window.eda.repository.exportPatch(request);
            if (!result.ok) setError(errorMessage(result.error));
          } catch (failure) {
            setError(errorMessage(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("patch.export")}
      </TextButton>
      {diffTool && (
        <TextButton
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await window.eda.repository.externalDiff({
                repositoryId: request.repositoryId,
                path: request.path,
                ...("oid" in request
                  ? {
                      kind: "commit",
                      oid: request.oid,
                      ...(request.oldPath && { oldPath: request.oldPath }),
                    }
                  : {
                      kind: request.area === "staged" ? "staged" : "working",
                      ...(oldPath && { oldPath }),
                    }),
              });
              if (!result.ok) setError(errorMessage(result.error));
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("externalDiff.open")}
        </TextButton>
      )}
      {error && <ErrorDialog onDismiss={() => setError("")}>{error}</ErrorDialog>}
    </>
  );
}

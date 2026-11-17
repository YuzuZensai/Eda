import { CommitSignatureIcon } from "../../components/ui/display/CommitSignatureIcon";
import { commitSignatureLabel } from "../../components/ui/display/commit-signature-label";
import type { CommitSignatureVerification } from "@shared/repository/repository-read";
import { t } from "@shared/i18n";
import { useState } from "react";
import {
  ActionList,
  Button,
  ComparisonTable,
  DefinitionList,
  ErrorDialog,
  NoticeBanner,
  RefreshButton,
  ReviewActions,
  SectionLabel,
  StatusBanner,
  StatusBannerStack,
} from "../../components/ui/index";
import { Name, Sample } from "./GallerySample";
const previewRelease = { name: "Eda", version: "0.0.3" };

export function GalleryFeedback({ setFeedback }: { setFeedback: (message: string) => void }) {
  const [showStatusNotice, setShowStatusNotice] = useState(true);
  const [showErrorExample, setShowErrorExample] = useState(false);

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {(["trusted", "unknown", "distrusted", "github", "unsigned"] as const).map(
          (signerTrust) => {
            const signature: CommitSignatureVerification = {
              status: signerTrust === "unsigned" ? "unsigned" : "verified",
              validity: signerTrust === "unsigned" ? "unknown" : "valid",
              signerTrust:
                signerTrust === "github" || signerTrust === "unsigned" ? "unknown" : signerTrust,
              ...(signerTrust === "github" ? { keySource: "https://github.com/web-flow.gpg" } : {}),
              format: "openpgp",
              reasonCode: null,
              diagnostics: "",
            };
            return (
              <span key={signerTrust} className="flex items-center gap-1 text-xs">
                <CommitSignatureIcon signature={signature} />
                {commitSignatureLabel(signature)}
              </span>
            );
          },
        )}
      </div>
      <Sample id="gallery-feedback" title={t("settings.componentGallery.feedbackAndHeadings")}>
        <div className="space-y-3">
          <SectionLabel
            trailing={<Name inline>{t("settings.componentGallery.trailingContent")}</Name>}
          >
            {t("settings.componentGallery.sectionLabel")}
          </SectionLabel>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-text-secondary">
              {t("settings.componentGallery.quickRefresh")}
            </span>

            <RefreshButton
              label={t("settings.componentGallery.quickRefreshPreview")}
              onRefresh={async () => true}
            />

            <span className="text-xs text-text-secondary">
              {t("settings.componentGallery.slowRefresh")}
            </span>

            <RefreshButton
              label={t("settings.componentGallery.slowRefreshPreview")}
              onRefresh={() => new Promise((resolve) => setTimeout(() => resolve(true), 1200))}
            />

            <span className="text-xs text-text-secondary">
              {t("settings.componentGallery.failedRefresh")}
            </span>

            <RefreshButton
              label={t("settings.componentGallery.failedRefreshPreview")}
              onRefresh={async () => false}
            />
          </div>

          <Button onClick={() => setShowErrorExample(true)}>
            {t("settings.componentGallery.showErrorDialog")}
          </Button>

          {showErrorExample && (
            <ErrorDialog onDismiss={() => setShowErrorExample(false)}>
              {t("settings.componentGallery.theActionCouldNotBeCompletedYourChangesArePreserved")}
            </ErrorDialog>
          )}

          <ActionList
            items={[
              {
                id: "example",
                title: t("settings.componentGallery.developerTools"),
                description: t("settings.componentGallery.inspectRuntimeErrorsInTheConsole"),
                actions: (
                  <Button
                    onClick={() =>
                      setFeedback(t("settings.componentGallery.developerToolsActionSelected"))
                    }
                  >
                    {t("settings.componentGallery.openTools")}
                  </Button>
                ),
              },
            ]}
          />

          <DefinitionList
            items={[
              {
                label: t("settings.componentGallery.author"),
                value: t("componentGallery.alexChen"),
              },
              {
                label: t("settings.componentGallery.gitVersion"),
                value: "2.44",
                description: t("settings.componentGallery.bundledInstallation"),
              },
            ]}
          />

          <StatusBannerStack>
            <StatusBanner
              label={t("globalGitWarning.globalGitConfigurationWarning")}
              tone="warning"
            >
              {t("globalGitWarning.globalGitSettingsDifferFrom", {
                name: t("componentGallery.alexChen"),
              })}
            </StatusBanner>

            {showStatusNotice && (
              <StatusBanner
                label={t("appUpdateNotice.updateNotification")}
                onDismiss={() => setShowStatusNotice(false)}
                action={
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => setFeedback(t("appUpdateNotice.viewUpdate"))}
                  >
                    {t("appUpdateNotice.viewUpdate")}
                  </Button>
                }
              >
                {t("appUpdateNotice.isAvailable", {
                  value1: `${previewRelease.name} ${previewRelease.version}`,
                })}
              </StatusBanner>
            )}
          </StatusBannerStack>

          {!showStatusNotice && (
            <Button onClick={() => setShowStatusNotice(true)}>
              {t("settings.stateSimulations.resetPreview")}
            </Button>
          )}

          <NoticeBanner
            tone="warning"
            action={
              <Button
                size="sm"
                onClick={() =>
                  setFeedback(t("settings.componentGallery.globalAppearanceSelectedInPreview"))
                }
              >
                {t("settings.componentGallery.useGlobalAppearance")}
              </Button>
            }
          >
            {t("settings.componentGallery.previewingGlobalAppearanceYourWorkspaceHasItsOwnTheme")}
          </NoticeBanner>

          <NoticeBanner>{t("settings.componentGallery.yourPreferencesHaveBeenSaved")}</NoticeBanner>
          <NoticeBanner tone="error">
            {t("settings.componentGallery.couldNotSaveYourPreferencesTryAgain")}
          </NoticeBanner>

          <ComparisonTable
            label={t("settings.componentGallery.exampleSettingsChanges")}
            fieldLabel={t("settings.componentGallery.setting")}
            beforeLabel={t("settings.componentGallery.current")}
            afterLabel={t("settings.componentGallery.proposed")}
            rows={[
              {
                id: "email",
                label: t("common.email"),
                before: "alex@personal.example",
                after: "alex@work.example",
              },
            ]}
          />

          <p className="rounded-md border border-accent-border bg-accent-muted px-3 py-2 text-sm text-accent-text">
            {t("settings.componentGallery.yourPreferencesHaveBeenSaved")}
          </p>

          <div className="flex flex-wrap gap-2">
            <ReviewActions
              busy={false}
              onClose={() => setFeedback(t("settings.componentGallery.reviewActionsCancel"))}
              onReview={() => setFeedback(t("settings.componentGallery.reviewActionsReview"))}
              onConfirm={() => setFeedback(t("settings.componentGallery.reviewActionsConfirm"))}
              confirmLabel={t("settings.componentGallery.confirm")}
              confirmDisabled={false}
            />
          </div>

          <Name>
            {t("settings.componentGallery.actionListSectionLabelErrorDialogDefinitionList")}
          </Name>
        </div>
      </Sample>
    </>
  );
}

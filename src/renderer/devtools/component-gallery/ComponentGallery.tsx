import { t } from "@shared/i18n";
import type { AccentColor } from "@shared/preferences/accent";
import { useState } from "react";
import { ProfileAvatar } from "../../components/ui/display/ProfileAvatar";
import { Fingerprint, HuePicker, Skeleton, SkeletonRows } from "../../components/ui/index";
import {
  CodePreview,
  DiffPreview,
  KeysPreview,
  LayoutPreview,
  RebasePreview,
  RemotesPreview,
  RepositoryRowsPreview,
  StatesPreview,
  ThemesPreview,
  UpdatesPreview,
  ViewTransitionPreview,
} from "./ComponentPreviews";
import { GalleryActions } from "./GalleryActions";
import { GalleryFeedback } from "./GalleryFeedback";
import { GalleryForms } from "./GalleryForms";
import { GalleryIcons } from "./GalleryIcons";
import { GalleryInventory } from "./GalleryInventory";
import { COMPONENT_GROUPS, Name, Sample } from "./GallerySample";
import { GallerySurfaces } from "./GallerySurfaces";

export function ComponentGallery() {
  const [hue, setHue] = useState<AccentColor>(210);

  const [feedback, setFeedback] = useState(
    t("settings.componentGallery.theseExamplesOnlyChangeThisPage"),
  );

  return (
    <div className="component-gallery space-y-5 pb-12">
      <p className="max-w-2xl text-sm leading-relaxed text-text-secondary">
        {t("settings.componentGallery.aLivePlaygroundForEdaSInterfaceExplore")}
      </p>

      <nav
        aria-label={t("settings.componentGallery.componentCategories")}
        className="gallery-nav sticky top-0 z-10 flex min-w-0 gap-1 overflow-x-auto border-b border-border-subtle py-3"
      >
        {COMPONENT_GROUPS.map((group) => (
          <a
            key={group.id}
            href={`#${group.id}`}
            className="ui-interactive shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-raised hover:text-text-primary"
          >
            {group.title}
          </a>
        ))}
      </nav>

      <GalleryActions hue={hue} feedback={feedback} setFeedback={setFeedback} />

      <GalleryForms />

      <Sample id="gallery-identity" title={t("settings.componentGallery.identityAndColor")}>
        <div className="flex flex-wrap items-center gap-5">
          <ProfileAvatar name="Eda Example" hue={hue} />
          <ProfileAvatar name="Eda Example" hue={hue} small />
          <ProfileAvatar name="Eda Example" hue={hue} compact />
          <ProfileAvatar name="Eda Example" hue={hue} loading />
          <ProfileAvatar name="Eda Example" hue={hue} small loading />
          <ProfileAvatar name="Eda Example" hue={hue} compact loading />
          <HuePicker value={hue} onChange={setHue} />
        </div>

        <Name>{t("settings.componentGallery.profileAvatarHuePicker")}</Name>

        <div className="mt-6">
          <ThemesPreview />

          <Name>
            {t(
              "settings.componentGallery.themePreferencesThemeGridRadioCardChangesStayInThisPreview",
            )}
          </Name>
        </div>
      </Sample>

      <GalleryFeedback setFeedback={setFeedback} />

      <GallerySurfaces setFeedback={setFeedback} />

      <Sample id="gallery-code" title={t("settings.componentGallery.codeBlocksAndOutput")}>
        <CodePreview />
        <Name>{t("settings.componentGallery.codeBlockCopyButton")}</Name>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Fingerprint
            value="0123456789ABCDEF0123456789ABCDEF01234567"
            shortValue="89ABCDEF01234567"
            label={t("settings.componentGallery.gpgFingerprint")}
          />

          <Fingerprint
            value="SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            label={t("settings.componentGallery.sshFingerprint")}
          />
        </div>

        <Name>{t("settings.componentGallery.fingerprint")}</Name>
      </Sample>

      <Sample id="gallery-diff" title={t("settings.componentGallery.diffViewer")}>
        <DiffPreview />

        <Name>
          {t(
            "settings.componentGallery.diffContentDiffSummaryRowUnifiedDiffRowDiffCellVirtualRows",
          )}
        </Name>
      </Sample>

      <Sample
        id="gallery-repository"
        title={t("settings.componentGallery.repositoryRowsAndMetadata")}
      >
        <RepositoryRowsPreview />
        <Name>{t("settings.componentGallery.directoryRowChangeRowCommitRowCommitDetails")}</Name>
      </Sample>

      <Sample id="gallery-layout" title={t("settings.componentGallery.panelControls")}>
        <LayoutPreview />
        <Name>
          {t("settings.componentGallery.splitCollapsiblePanelPanelControlsCollapsedRail")}
        </Name>
        <ViewTransitionPreview />
        <Name>{t("settings.componentGallery.viewTransitionLayoutTransitionRetainedView")}</Name>
      </Sample>

      <Sample id="gallery-features" title={t("settings.componentGallery.featureControls")}>
        <div className="space-y-6 text-sm">
          <div>
            <RemotesPreview />
            <Name>{t("settings.remotes")}</Name>
          </div>

          <div>
            <KeysPreview />
            <Name>{t("settings.componentGallery.sshKeyListSampleKeysLocalAssignment")}</Name>
          </div>

          <div className="border-t border-border-subtle pt-6">
            <RebasePreview />
            <Name>
              {t("settings.componentGallery.rebasePlanEditorSampleCommitsLocalEditsOnly")}
            </Name>
          </div>
        </div>
      </Sample>

      <Sample id="gallery-states" title={t("settings.componentGallery.contentStates")}>
        <div className="mb-6 space-y-3 border-b border-border-subtle pb-6">
          <h3 className="text-sm font-medium">
            {t("settings.componentGallery.applicationUpdates")}
          </h3>
          <UpdatesPreview />
        </div>

        <StatesPreview />
        <Name>{t("settings.componentGallery.stateMessage")}</Name>

        <div
          role="status"
          aria-label={t("settings.componentGallery.loadingExample")}
          className="mt-4 max-w-sm rounded border border-border-subtle p-3"
        >
          <Skeleton className="h-5 w-28" />
          <SkeletonRows rows={3} />
        </div>

        <Name>{t("settings.componentGallery.skeletonSkeletonRows")}</Name>
      </Sample>

      <GalleryIcons />

      <Sample
        id="gallery-inventory"
        title={t("settings.componentGallery.componentInventoryAndCoverage")}
      >
        <GalleryInventory />
      </Sample>
    </div>
  );
}

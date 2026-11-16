import { t } from "@shared/i18n";
import type { AccentColor } from "@shared/preferences/accent";
import { useRef, useState, type MouseEvent } from "react";
import { ProfileAvatar } from "../../components/ui/display/ProfileAvatar";
import { StarIcon } from "../../components/ui/icons";
import {
  AsyncButton,
  Button,
  CheckIcon,
  CloseIcon,
  DiffIcon,
  ExternalLinkButton,
  HistoryIcon,
  IconButton,
  ListItemButton,
  MinusIcon,
  PlusIcon,
  ProfileButton,
  RefreshButton,
  TabTrigger,
  TextButton,
  WindowControlButton,
} from "../../components/ui/index";
import { Name, PreviewRow, Sample } from "./GallerySample";
const BUTTON_VARIANTS = ["primary", "identity", "secondary", "ghost", "quiet", "danger"] as const;

export function GalleryActions({
  hue,
  feedback,
  setFeedback,
}: {
  hue: AccentColor;
  feedback: string;
  setFeedback: (message: string) => void;
}) {
  const exampleTabs = useRef(new Map<string, HTMLButtonElement>());
  const [tab, setTab] = useState("first");
  const [list, setList] = useState("changes");
  const previewExternalLink = (event: MouseEvent<HTMLButtonElement>) => {
    if (window.eda.app.platform === "mac" ? event.metaKey : event.ctrlKey) return;

    event.preventDefault();
    setFeedback(t("settings.componentGallery.externalLinkPreviewClickedTheBrowserStaysClosed"));
  };

  return (
    <>
      <Sample id="gallery-actions" title={t("settings.componentGallery.actions")}>
        <div className="gallery-preview-rows">
          <PreviewRow label={t("settings.componentGallery.emphasis")}>
            {BUTTON_VARIANTS.map((variant) => (
              <Button
                key={variant}
                variant={variant}
                hue={variant === "identity" ? hue : undefined}
                onClick={() =>
                  setFeedback(
                    t("settings.componentGallery.actionTriggered", {
                      value1: variant.charAt(0).toUpperCase(),
                      variant: variant.slice(1),
                    }),
                  )
                }
              >
                {variant.charAt(0).toUpperCase()}
                {variant.slice(1)}
              </Button>
            ))}
          </PreviewRow>

          <PreviewRow label={t("settings.componentGallery.sizesStates")}>
            <Button
              size="sm"
              onClick={() => setFeedback(t("settings.componentGallery.smallActionTriggered"))}
            >
              {t("settings.componentGallery.small")}
            </Button>

            <Button
              size="md"
              onClick={() => setFeedback(t("settings.componentGallery.mediumActionTriggered"))}
            >
              {t("settings.componentGallery.medium")}
            </Button>

            <Button
              size="lg"
              onClick={() => setFeedback(t("settings.componentGallery.largeActionTriggered"))}
            >
              {t("settings.componentGallery.large")}
            </Button>

            <Button disabled>{t("settings.componentGallery.disabled")}</Button>

            <AsyncButton
              label={t("settings.componentGallery.tryLoading")}
              onAction={() => new Promise((resolve) => setTimeout(() => resolve(true), 1200))}
            >
              {t("settings.componentGallery.tryLoading")}
            </AsyncButton>

            <AsyncButton
              label={t("settings.componentGallery.tryFailure")}
              onAction={async () => false}
            >
              {t("settings.componentGallery.tryFailure")}
            </AsyncButton>
          </PreviewRow>

          <PreviewRow label={t("settings.componentGallery.compactActions")}>
            <ExternalLinkButton href="https://example.com" onClick={previewExternalLink}>
              {t("settings.componentGallery.externalLink")}
            </ExternalLinkButton>

            <ExternalLinkButton
              href="https://example.com"
              trailingIcon
              icon={<StarIcon size={16} aria-hidden="true" />}
              onClick={previewExternalLink}
            >
              {t("settings.aboutSettings.starTheRepo")}
            </ExternalLinkButton>

            <RefreshButton
              label={t("settings.componentGallery.refreshCompactAction")}
              onRefresh={async () => true}
            />

            <IconButton
              size="xs"
              aria-label={t("settings.componentGallery.smallIconAction")}
              title={t("common.add")}
              icon={<PlusIcon size={14} />}
              onClick={() => setFeedback(t("settings.componentGallery.addActionTriggered"))}
            />

            <TextButton
              tone="accent"
              onClick={() => setFeedback(t("settings.componentGallery.textActionTriggered"))}
            >
              {t("settings.componentGallery.viewDetails")}
            </TextButton>

            <TextButton
              tone="warning"
              onClick={() => setFeedback(t("settings.componentGallery.textActionTriggered"))}
            >
              {t("repositoryOverview.untrusted")}
            </TextButton>

            <ProfileButton
              profileName={t("settings.componentGallery.edaExample")}
              aria-label={t("settings.componentGallery.exampleProfileButton")}
              onClick={() => setFeedback(t("settings.componentGallery.profileActionTriggered"))}
            >
              <ProfileAvatar name="Eda Example" hue={hue} small />
            </ProfileButton>

            <div className="ml-2 flex h-[32px] overflow-hidden rounded-md border border-border-subtle bg-bg-inset">
              <WindowControlButton
                aria-label={t("settings.componentGallery.exampleWindowControl")}
                onClick={() => setFeedback(t("settings.componentGallery.minimizePreviewTriggered"))}
              >
                <MinusIcon size={14} />
              </WindowControlButton>

              <WindowControlButton
                close
                aria-label={t("settings.componentGallery.exampleCloseControl")}
                onClick={() => setFeedback(t("settings.componentGallery.closePreviewTriggered"))}
              >
                <CloseIcon size={14} />
              </WindowControlButton>
            </div>
          </PreviewRow>

          <PreviewRow label={t("settings.componentGallery.listsTabs")}>
            <div className="w-44 space-y-1 rounded-lg border border-border-subtle bg-bg-inset p-1">
              <ListItemButton selected={list === "changes"} onClick={() => setList("changes")}>
                <DiffIcon size={14} />
                {t("settings.componentGallery.changes")}
              </ListItemButton>

              <ListItemButton selected={list === "history"} onClick={() => setList("history")}>
                <HistoryIcon size={14} />
                {t("settings.componentGallery.history")}
              </ListItemButton>
            </div>

            <div className="ml-2">
              <div
                role="tablist"
                aria-label={t("settings.componentGallery.exampleTabs")}
                className="flex gap-1 border-b border-border-subtle"
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

                  event.preventDefault();

                  const next =
                    event.key === "Home"
                      ? "first"
                      : event.key === "End"
                        ? "second"
                        : tab === "first"
                          ? "second"
                          : "first";

                  setTab(next);

                  exampleTabs.current.get(next)?.focus();
                }}
              >
                {["first", "second"].map((value, index) => (
                  <TabTrigger
                    key={value}
                    ref={(element) => {
                      if (element) exampleTabs.current.set(value, element);
                      else exampleTabs.current.delete(value);
                    }}
                    id={`gallery-tab-${value}`}
                    aria-controls={`gallery-panel-${value}`}
                    selected={tab === value}
                    onClick={() => setTab(value)}
                    tabIndex={tab === value ? 0 : -1}
                  >
                    {index === 0
                      ? t("settings.componentGallery.overview")
                      : t("settings.componentGallery.activity")}
                  </TabTrigger>
                ))}
              </div>

              {["first", "second"].map((value) => (
                <p
                  key={value}
                  role="tabpanel"
                  id={`gallery-panel-${value}`}
                  aria-labelledby={`gallery-tab-${value}`}
                  hidden={tab !== value}
                  tabIndex={0}
                  className="px-2 pt-3 text-xs text-text-tertiary"
                >
                  {value === "first"
                    ? t("settings.componentGallery.yourRepositoryAtAGlance")
                    : t("settings.componentGallery.recentRepositoryActivity")}
                </p>
              ))}
            </div>
          </PreviewRow>
        </div>

        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-center gap-2 rounded-md border border-border-subtle bg-bg-inset px-3 py-2 text-xs text-text-secondary"
        >
          <CheckIcon size={14} className="shrink-0 text-accent-text" aria-hidden="true" />
          {feedback}
        </div>

        <Name>{t("settings.componentGallery.buttonBaseButtonAsyncButtonRefreshButtonAction")}</Name>
      </Sample>
    </>
  );
}

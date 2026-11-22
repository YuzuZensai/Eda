import { t } from "@shared/i18n";
import { useId, useRef, useState } from "react";
import {
  Button,
  Dialog,
  Disclosure,
  NoticeBanner,
  FolderIcon,
  MenuItem,
  MenuSubmenu,
  AnchoredPopover,
  RefreshIcon,
} from "../../components/ui/index";
import { CopyIcon, LinkIcon, Trash2Icon } from "../../components/ui/icons";
import {
  ModalDescription,
  ModalSurface,
  ModalTitle,
} from "../../components/ui/overlays/ModalSurface";
import { RepositoryTrustPrompt } from "../../features/repositories/RepositoryTrustDialog";
import { Name, Sample } from "./GallerySample";

export function GallerySurfaces({ setFeedback }: { setFeedback: (message: string) => void }) {
  const modalDescriptionId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [modal, setModal] = useState<"dialog" | "drawer" | "surface" | "trust" | null>(null);

  const selectMenuItem = () => {
    setFeedback(t("settings.componentGallery.menuItemClicked"));
    setMenuOpen(false);
  };

  return (
    <>
      <Sample id="gallery-surfaces" title={t("settings.componentGallery.surfaces")}>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setModal("dialog")}>
            {t("settings.componentGallery.openDialog")}
          </Button>
          <Button onClick={() => setModal("drawer")}>
            {t("settings.componentGallery.openRightDialog")}
          </Button>
          <Button onClick={() => setModal("trust")}>{t("main.repositoryTrust.title")}</Button>
          <Button onClick={() => setModal("surface")}>
            {t("settings.componentGallery.openModalSurface")}
          </Button>

          <div className="relative">
            <Button
              ref={menuTrigger}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {t("settings.componentGallery.openMenu")}
            </Button>

            {menuOpen && (
              <AnchoredPopover
                role="menu"
                aria-label={t("settings.componentGallery.exampleMenu")}
                onClose={() => setMenuOpen(false)}
                anchorRef={menuTrigger}
                className="w-52 p-1"
              >
                <MenuItem onClick={selectMenuItem}>
                  <RefreshIcon size={14} />
                  {t("settings.componentGallery.refreshPreview")}
                </MenuItem>

                <MenuItem disabled>
                  <FolderIcon size={14} />
                  {t("settings.componentGallery.unavailableAction")}
                </MenuItem>

                <MenuSubmenu label={t("common.copy")} icon={<CopyIcon size={14} aria-hidden />}>
                  <MenuItem onClick={selectMenuItem}>
                    <LinkIcon size={14} aria-hidden />
                    {t("commitMenu.commitBrowserUrl")}
                  </MenuItem>
                </MenuSubmenu>

                <MenuItem danger onClick={selectMenuItem}>
                  <Trash2Icon size={14} />
                  {t("common.delete")}
                </MenuItem>
              </AnchoredPopover>
            )}
          </div>
        </div>

        <Disclosure
          title={t("settings.componentGallery.disclosureExample")}
          className="mt-3 text-xs"
        >
          <p className="mt-2">
            {t("settings.componentGallery.sharedDisclosureStylingAndFocusState")}
          </p>
        </Disclosure>

        <Name>
          {t("settings.componentGallery.dialogModalSurfaceModalTitleModalDescriptionPopover")}
        </Name>
      </Sample>

      {modal === "trust" && (
        <RepositoryTrustPrompt
          request={{
            id: "preview",
            path: "/home/user/Projects/example",
            reasons: ["hooks/pre-commit", "hooks/pre-push", "filter.lfs"],
          }}
          respond={() => setModal(null)}
        />
      )}

      {modal === "dialog" && (
        <Dialog
          title={t("settings.componentGallery.dialogExample")}
          description={t("settings.componentGallery.aCenteredModalWithATitleAndDescription")}
          onClose={() => setModal(null)}
          footer={<Button onClick={() => setModal(null)}>{t("common.close")}</Button>}
        >
          <NoticeBanner tone="error">{t("settings.componentGallery.reviewFailure")}</NoticeBanner>
          <ul className="mt-3 divide-y divide-border-subtle">
            {Array.from({ length: 24 }, (_, index) => (
              <li key={index} className="py-2 font-mono text-xs">
                {t("settings.componentGallery.exampleFile", { number: index + 1 })}
              </li>
            ))}
          </ul>
        </Dialog>
      )}

      {modal === "drawer" && (
        <Dialog
          placement="right"
          title={t("settings.componentGallery.rightDialogExample")}
          onClose={() => setModal(null)}
          footer={<Button onClick={() => setModal(null)}>{t("common.close")}</Button>}
        >
          <p className="text-sm">
            {t("settings.componentGallery.theSameDialogComponentSupportsARightSidePlacement")}
          </p>
        </Dialog>
      )}

      {modal === "surface" && (
        <ModalSurface
          placement="top"
          onClose={() => setModal(null)}
          descriptionId={modalDescriptionId}
          className="w-[calc(100vw-2rem)] max-w-lg rounded-lg border border-border-default p-6"
        >
          <ModalTitle className="text-lg font-semibold">
            {t("settings.componentGallery.modalSurfaceExample")}
          </ModalTitle>
          <ModalDescription id={modalDescriptionId} className="mt-2 text-sm text-text-secondary">
            {t("settings.componentGallery.aLowerLevelSurfaceUsedByTheRepositoryPicker")}
          </ModalDescription>
          <Button className="mt-4" onClick={() => setModal(null)}>
            {t("common.close")}
          </Button>
        </ModalSurface>
      )}
    </>
  );
}

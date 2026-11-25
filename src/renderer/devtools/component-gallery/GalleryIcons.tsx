import { t } from "@shared/i18n";
import * as sharedIcons from "../../components/ui/icons";
import { Name, Sample } from "./GallerySample";

const { IconDefaults, ICON_SIZE, ...icons } = sharedIcons;

export function GalleryIcons() {
  return (
    <Sample id="gallery-icons" title={t("settings.componentGallery.icons")}>
      <IconDefaults>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {Object.entries(icons).map(([name, Icon]) => (
            <div
              key={name}
              className="gallery-icon flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-bg-inset px-3 py-3 text-xs text-text-secondary"
            >
              <Icon size={ICON_SIZE} aria-hidden="true" />
              <span className="min-w-0 truncate">{name}</span>
            </div>
          ))}
        </div>
      </IconDefaults>

      <Name>{t("settings.componentGallery.iconDefaultsIconsTsx")}</Name>
    </Sample>
  );
}

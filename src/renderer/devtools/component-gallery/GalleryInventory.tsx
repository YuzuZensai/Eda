import { t } from "@shared/i18n";
import { useState } from "react";
import { Disclosure, SearchField, StateMessage } from "../../components/ui/index";
import { createTextSearch } from "../../utils/search";
import { COMPONENT_GROUPS } from "./componentInventory";
import { PREVIEW_ANCHORS } from "./galleryCoverage";

export function GalleryInventory() {
  const [query, setQuery] = useState("");
  const matchesQuery = createTextSearch(query);

  const groups = COMPONENT_GROUPS.map(({ group, directory, files }) => ({
    group: group ?? t("settings.componentGallery.sharedUi"),
    files: files.map((entry) => {
      const [name, names] =
        typeof entry === "string" ? [entry, [entry.slice(entry.lastIndexOf("/") + 1)]] : entry;
      return { file: directory + name + ".tsx", names };
    }),
  }));
  const allFiles = groups.flatMap(({ files }) => files);
  const matches = groups
    .map(({ group, files }) => ({
      group,
      files: files.filter(({ file, names }) => matchesQuery([file, ...names].join(" "))),
    }))
    .filter((group) => group.files.length);

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-text-secondary">
        {t("settings.componentGallery.sourceFilesExportedComponentsFilesHaveLiveExamples", {
          length: allFiles.length,
          lengthValue: allFiles.reduce((count, { names }) => count + names.length, 0),
          lengthValueValue: allFiles.filter(({ file }) => PREVIEW_ANCHORS[file]).length,
        })}
      </p>

      <SearchField
        size="md"
        aria-label={t("settings.componentGallery.findAComponent")}
        placeholder={t("settings.componentGallery.findAComponentSourceFileOrView")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {!matches.length && (
        <StateMessage
          title={t("settings.componentGallery.noComponentsMatch")}
          description={t("settings.componentGallery.tryAComponentNameSuchAsDiffContentOrCodeBlock")}
        />
      )}

      {matches.map((group) => (
        <Disclosure
          key={`${group.group}:${!!query.trim()}`}
          open={query.trim() ? true : undefined}
          title={
            <>
              {group.group} <span className="text-text-tertiary">({group.files.length})</span>
            </>
          }
          className="rounded-md border border-border-subtle bg-bg-inset px-3 py-3"
          summaryClassName="text-sm font-medium"
        >
          <ul className="mt-3 divide-y divide-border-subtle">
            {group.files.map(({ file, names }) => (
              <li
                key={file}
                className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-3"
              >
                <div className="min-w-0 flex-1">
                  <code className="break-all text-xs text-text-primary">{file}</code>

                  <p className="mt-1 break-words text-xs text-text-tertiary">
                    {names.join(", ") || t("settings.componentGallery.sharedExports")}
                  </p>
                </div>

                {PREVIEW_ANCHORS[file] ? (
                  <a
                    className="inline-flex min-h-6 shrink-0 items-center rounded-sm text-xs text-accent-text underline underline-offset-2"
                    href={`#${PREVIEW_ANCHORS[file]}`}
                  >
                    {t("settings.componentGallery.livePreview")}
                  </a>
                ) : (
                  <span className="py-1 text-xs text-text-tertiary">
                    {t("settings.componentGallery.appContext")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Disclosure>
      ))}
    </div>
  );
}

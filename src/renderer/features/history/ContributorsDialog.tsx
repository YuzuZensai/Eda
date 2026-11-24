import { t } from "@shared/i18n";
import type { Contributor } from "@shared/repository/repository-read";
import { useMemo, useState } from "react";
import {
  Button,
  Dialog,
  IconButton,
  SearchField,
  Select,
  StateMessage,
} from "../../components/ui/index";
import { ArrowDownIcon, ArrowUpIcon, RefreshIcon } from "../../components/ui/icons";
import { ProfileAvatar } from "../../components/ui/display/ProfileAvatar";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { createTextSearch } from "../../utils/search";

export function ContributorRow({
  contributor,
  repositoryId,
}: {
  contributor: Contributor;
  repositoryId?: string;
}) {
  return (
    <div className="flex h-14 items-center gap-3 border-b border-border-subtle px-3 text-sm">
      <ProfileAvatar
        name={contributor.name || t("common.notSet")}
        {...(repositoryId && { email: contributor.email, repositoryId })}
        hue={210}
        small
      />

      <div className="min-w-0 flex-1 select-text">
        <p className="truncate font-medium text-text-primary" title={contributor.name}>
          {contributor.name || t("common.notSet")}
        </p>
        <p className="truncate text-xs text-text-secondary" title={contributor.email}>
          {contributor.email || t("common.notSet")}
        </p>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-text-tertiary">
        {t("contributors.commits", { count: contributor.commits })}
      </span>
    </div>
  );
}

export function ContributorsDialog({
  repositoryId,
  onClose,
}: {
  repositoryId: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"commits" | "name" | "email">("commits");
  const [descending, setDescending] = useState(true);
  const { value, error, retry } = useRepositoryRead(
    window.eda.repository.contributors,
    repositoryId,
  );
  const sorted = useMemo(() => {
    const { compare } = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    const direction = descending ? -1 : 1;

    return value?.toSorted((a, b) => {
      const primary = sort === "commits" ? a.commits - b.commits : compare(a[sort], b[sort]);
      return primary * direction || compare(a.name, b.name) || compare(a.email, b.email);
    });
  }, [value, sort, descending]);
  const matches = useMemo(() => {
    const search = createTextSearch(query);
    return sorted?.filter((entry) => search(`${entry.name} ${entry.email}`));
  }, [sorted, query]);
  const directionLabel = t(descending ? "contributors.ascending" : "contributors.descending");

  return (
    <Dialog
      title={t("contributors.title")}
      description={t("contributors.scope")}
      size="lg"
      onClose={onClose}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <SearchField
            autoFocus
            className="flex-1"
            aria-label={t("contributors.search")}
            placeholder={t("contributors.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <IconButton
            icon={<RefreshIcon />}
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            disabled={!value && !error}
            onClick={retry}
          />
        </div>

        {error ? (
          <StateMessage tone="error" title={error} />
        ) : !value ? (
          <StateMessage tone="loading" title={t("contributors.title")} />
        ) : !value.length ? (
          <StateMessage title={t("commitGraph.noCommitsYet")} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-xs text-text-tertiary">
                {t("contributors.count", { count: value.length })}
              </p>

              <Select
                compact
                className="w-32"
                aria-label={t("contributors.sortBy")}
                value={sort}
                onValueChange={(next) => {
                  if (next !== "commits" && next !== "name" && next !== "email") return;
                  setSort(next);
                  setDescending(next === "commits");
                }}
              >
                <option value="commits">{t("contributors.sortCommits")}</option>
                <option value="name">{t("contributors.sortName")}</option>
                <option value="email">{t("contributors.sortEmail")}</option>
              </Select>
              <IconButton
                icon={descending ? <ArrowDownIcon /> : <ArrowUpIcon />}
                aria-label={directionLabel}
                title={directionLabel}
                onClick={() => setDescending((previous) => !previous)}
              />
            </div>
            {matches?.length ? (
              <div style={{ height: Math.min(320, matches.length * 56 + 2) }}>
                <VirtualRows
                  key={JSON.stringify([query, sort, descending])}
                  items={matches}
                  rowHeight={56}
                  className="h-full rounded-md border border-border-subtle"
                  horizontalScroll={false}
                  ariaLabel={t("contributors.title")}
                  renderRow={(contributor) => (
                    <ContributorRow
                      key={JSON.stringify([contributor.name, contributor.email])}
                      contributor={contributor}
                      repositoryId={repositoryId}
                    />
                  )}
                />
              </div>
            ) : (
              <StateMessage title={t("contributors.noMatches")} />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

import { t } from "@shared/i18n";
import { useState } from "react";
import { defaultGraphFilter, type GraphFilter } from "@shared/preferences/graph-view";
import { useLocalReferences } from "../../repository/hooks/useLocalReferences";
import { useSessionStore } from "../../stores/session-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import {
  Button,
  Dialog,
  Input,
  Radio,
  Checkbox,
  ErrorDialog,
  StateMessage,
  TextButton,
  Select,
} from "../../components/ui/index";

export function GraphFilterDialog({
  repositoryId,
  onClose,
}: {
  repositoryId: string;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<GraphFilter>(
    () =>
      useSessionStore.getState().snapshot?.session.views[repositoryId]?.graphFilter ??
      defaultGraphFilter(),
  );
  const { references, loadError, retry } = useLocalReferences(repositoryId);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const globalDefault = usePreferencesStore((state) => state.values.showInternalRefs.value);

  const refs: { name: string; oid: string; head?: boolean; upstream?: string }[] = references
    ? [
        ...references.branches.map((branch) => ({
          name: `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`,
          oid: branch.oid,
          head: branch.isHead,
          upstream: branch.upstream,
        })),
        ...references.tags.map((tag) => ({ name: `refs/tags/${tag.name}`, oid: tag.oid })),
      ]
    : [];
  const matches = refs.filter((ref) => ref.name.toLowerCase().includes(query.toLowerCase()));

  const apply = () => {
    if (!references) return;
    const pin = refs.find((ref) => ref.name === filter.pinnedRef);
    const next = {
      ...filter,
      ...(pin ? { pinnedOid: pin.oid } : { pinnedRef: null, pinnedOid: undefined }),
    };

    useSessionStore.getState().setView(repositoryId, { graphFilter: next });
    void useRepositoryStore.getState().refresh();
    onClose();
  };

  const remotes = [
    ...new Set(
      refs
        .filter((ref) => ref.name.startsWith("refs/remotes/"))
        .map((ref) => ref.name.split("/")[2]!),
    ),
  ];

  return (
    <Dialog
      title={t("graphFilterDialog.graphVisibility")}
      description={t("graphFilterDialog.theseControlsOnlyChangeTheGraphReferencesAnd")}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="quiet"
            onClick={() => setFilter({ ...defaultGraphFilter(), showInternalRefs: true })}
          >
            {t("graphFilterDialog.showAll")}
          </Button>
          <Button variant="primary" disabled={!references} onClick={apply}>
            {t("graphFilterDialog.applyGraphView")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block space-y-2">
          <span>{t("historyRefs.historyReferences")}</span>
          <Select
            aria-label={t("historyRefs.historyReferences")}
            value={
              filter.showInternalRefs === undefined ? "default" : String(filter.showInternalRefs)
            }
            onValueChange={(value) =>
              setFilter({
                ...filter,
                showInternalRefs: value === "default" ? undefined : value === "true",
              })
            }
          >
            <option value="default">
              {t("historyRefs.useGlobalDefault", {
                value: globalDefault
                  ? t("historyRefs.allReferences")
                  : t("historyRefs.branchesAndTags"),
              })}
            </option>
            <option value="false">{t("historyRefs.branchesAndTags")}</option>
            <option value="true">{t("historyRefs.allReferences")}</option>
          </Select>
        </label>
        <p className="text-xs text-text-tertiary">{t("historyRefs.allReferencesDescription")}</p>
        <Checkbox
          checked={filter.showStashes ?? true}
          onChange={(event) => setFilter({ ...filter, showStashes: event.target.checked })}
        >
          {t("graphFilterDialog.showStashes")}
        </Checkbox>
        <p className="text-xs text-text-tertiary">
          {t("graphFilterDialog.includesTheNewest200StashesAcrossTheRepositoryIncluding")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="quiet"
            disabled={!references}
            onClick={() => {
              const head = refs.find((ref) => ref.head);

              if (!head) {
                setError(t("graphFilterDialog.checkOutABranchBeforeFocusingTheCurrentBranch"));
                return;
              }

              const upstream = head.upstream ? `refs/remotes/${head.upstream}` : null;

              setFilter({
                ...filter,
                refs: [
                  head.name,
                  ...(upstream && refs.some((ref) => ref.name === upstream) ? [upstream] : []),
                ],
                hiddenRefs: [],
                pinnedRef: head.name,
              });
            }}
          >
            {t("graphFilterDialog.focusCurrentUpstream")}
          </Button>
          {remotes.map((remote) => {
            const names = refs
              .filter((ref) => ref.name.startsWith(`refs/remotes/${remote}/`))
              .map((ref) => ref.name);
            const hidden = names.every((name) => filter.hiddenRefs.includes(name));
            const change = (solo: boolean) => {
              const hiddenRefs = hidden
                ? filter.hiddenRefs.filter((name) => !names.includes(name))
                : [...new Set([...filter.hiddenRefs, ...names])];

              if ((solo ? names : hiddenRefs).length > 256) {
                setError(
                  t("graphFilterDialog.thisViewExceedsThe256ReferenceLimitFilterIndividual"),
                );
                return;
              }

              setError(null);
              setFilter({ ...filter, refs: solo ? names : [], hiddenRefs: solo ? [] : hiddenRefs });
            };

            return (
              <div key={remote} className="flex gap-1">
                <Button variant="quiet" onClick={() => change(false)}>
                  {t("graphFilterDialog.remote", {
                    value1: hidden ? t("graphFilterDialog.show") : t("graphFilterDialog.hide"),
                    remote: remote,
                  })}
                </Button>
                <Button variant="quiet" onClick={() => change(true)}>
                  {t("graphFilterDialog.soloRemote", { remote: remote })}
                </Button>
              </div>
            );
          })}{" "}
        </div>
        <Input
          aria-label={t("graphFilterDialog.findGraphReference")}
          placeholder={t("graphFilterDialog.filterReferences")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="text-xs text-text-tertiary">
          {t("graphFilterDialog.soloReferencesIncludeTheirAncestorsSelectSeveralTo")}
        </p>
        {!references && (
          <StateMessage
            tone={loadError ? "error" : "loading"}
            title={
              loadError
                ? t("manageReferencesDialog.referencesCouldNotBeLoaded")
                : t("references.loading")
            }
            description={loadError}
            action={loadError && <Button onClick={retry}>{t("common.retry")}</Button>}
          />
        )}
        {references && !matches.length && <p role="status">{t("references.noMatches")}</p>}
        <div className="max-h-72 overflow-auto">
          {matches.slice(0, 200).map((ref) => (
            <div
              key={ref.name}
              className="flex items-center gap-2 border-b border-border-subtle py-2"
            >
              <span className="min-w-0 flex-1 truncate text-xs" title={ref.name}>
                {ref.name.replace(/^refs\/(heads|remotes|tags)\//, "")}
              </span>
              <Checkbox
                className="flex gap-1 text-xs"
                aria-label={t("graphFilterDialog.hideReference", { name: ref.name })}
                checked={filter.hiddenRefs.includes(ref.name)}
                disabled={!filter.hiddenRefs.includes(ref.name) && filter.hiddenRefs.length >= 256}
                onChange={(event) =>
                  setFilter({
                    ...filter,
                    refs: [],
                    hiddenRefs: event.target.checked
                      ? [...filter.hiddenRefs, ref.name]
                      : filter.hiddenRefs.filter((name) => name !== ref.name),
                  })
                }
              >
                {t("graphFilterDialog.hide")}
              </Checkbox>
              <Checkbox
                className="flex gap-1 text-xs"
                aria-label={t("graphFilterDialog.soloReference", { name: ref.name })}
                checked={filter.refs.includes(ref.name)}
                disabled={!filter.refs.includes(ref.name) && filter.refs.length >= 256}
                onChange={(event) =>
                  setFilter({
                    ...filter,
                    hiddenRefs: [],
                    refs: event.target.checked
                      ? [...filter.refs, ref.name]
                      : filter.refs.filter((name) => name !== ref.name),
                  })
                }
              >
                {t("graphFilterDialog.solo")}
              </Checkbox>
              <label className="flex min-h-6 items-center gap-1 text-xs">
                <Radio
                  name="pinned-reference"
                  aria-label={t("graphFilterDialog.pinReference", { name: ref.name })}
                  checked={filter.pinnedRef === ref.name}
                  onChange={() => setFilter({ ...filter, pinnedRef: ref.name })}
                />
                {t("graphFilterDialog.pin")}
              </label>
            </div>
          ))}
        </div>
        {matches.length > 200 && (
          <p className="text-xs">
            {t("graphFilterDialog.showingAtMost200MatchesSearchToFindMoreReferences")}
          </p>
        )}
        {filter.pinnedRef && (
          <TextButton
            className="text-xs text-accent-text"
            onClick={() => setFilter({ ...filter, pinnedRef: null, pinnedOid: undefined })}
          >
            {t("graphFilterDialog.unpin", { pinnedRef: filter.pinnedRef })}
          </TextButton>
        )}
        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}

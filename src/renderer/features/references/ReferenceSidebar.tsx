import { ReferenceRow } from "./ReferenceRow";
import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { BranchSummary, TagSummary } from "@shared/repository/repository-write";
import {
  BranchIcon as GitBranch,
  GlobeIcon as Globe,
  PanelLeftCloseIcon as PanelLeftClose,
  PanelLeftOpenIcon as PanelLeftOpen,
  TagIcon as Tag,
} from "../../components/ui/icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLayoutTransition } from "../../components/layout/hooks/useLayoutTransition";
import {
  captureRepositoryCommand,
  repositoryCommandDispatcher,
} from "../../commands/repository-commands";
import { Skeleton, SkeletonRows } from "../../components/ui/feedback/Skeleton";
import {
  cx,
  Disclosure,
  ErrorDialog,
  IconButton,
  ListItemButton,
  SearchField,
  TextButton,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { useSessionStore } from "../../stores/session-store";
import { useTagReferences } from "./hooks/useTagReferences";
import type { ReferenceTarget } from "./ReferenceMenu";

const defaults = { hidden: false, locals: true, remotes: true, tags: true };

const ReferenceMenu = lazy(() =>
  import("../repository-dialogs").then((module) => ({ default: module.ReferenceMenu })),
);

const ManageReferencesDialog = lazy(() =>
  import("../repository-dialogs").then((module) => ({ default: module.ManageReferencesDialog })),
);

export function ReferenceSidebar({
  repositoryId,
  compact = false,
  pending = false,
  forceExpanded = false,
  onExpand,
}: {
  repositoryId: string;
  compact?: boolean;
  pending?: boolean;
  forceExpanded?: boolean;
  onExpand?: () => void;
}) {
  const transition = useLayoutTransition();
  const [manageOpen, setManageOpen] = useState(false);
  const profileId = useAppStore((state) => state.activeIdentity?.id);
  const status = useRepositoryStore((state) => state.status);
  const selection = useRepositoryStore((state) => state.selection);

  const saved = useSessionStore(
    (state) => state.snapshot?.session.views[repositoryId]?.references ?? defaults,
  );

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [localTags, setTags] = useState<TagSummary[]>([]);
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState<ReferenceTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const checkoutPending = useRef(false);
  const [revision, setRevision] = useState(0);
  const tags = useTagReferences(repositoryId, profileId, localTags, revision, pending);

  const actionTarget =
    actions?.kind === "branch"
      ? {
          ...actions,
          ref:
            branches.find(
              (branch) => branch.name === actions.ref.name && branch.remote === actions.ref.remote,
            ) ?? actions.ref,
        }
      : actions;

  useEffect(() => {
    if (pending) return;

    let cancelled = false;

    setLoading(true);
    setError(null);

    void Promise.all([
      window.eda.repository.listBranches(repositoryId),
      window.eda.repository.listTags(repositoryId),
    ])
      .then(([branchResult, tagResult]) => {
        if (cancelled) return;

        setBranches(branchResult.ok ? branchResult.value : []);
        setTags(tagResult.ok ? tagResult.value : []);

        const session = useSessionStore.getState();
        const filter = session.snapshot?.session.views[repositoryId]?.graphFilter;

        if (filter?.pinnedRef && branchResult.ok && tagResult.ok) {
          const branch = branchResult.value.find(
            (item) => `refs/${item.remote ? "remotes" : "heads"}/${item.name}` === filter.pinnedRef,
          );

          const tag = tagResult.value.find((item) => `refs/tags/${item.name}` === filter.pinnedRef);
          const oid = branch?.oid ?? tag?.oid;

          if (oid !== filter.pinnedOid) {
            session.setView(repositoryId, {
              graphFilter: { ...filter, pinnedOid: oid, pinnedRef: oid ? filter.pinnedRef : null },
            });

            void useRepositoryStore.getState().refresh();
          }
        }

        if (!branchResult.ok) setError(errorMessage(branchResult.error));
        else if (!tagResult.ok) setError(errorMessage(tagResult.error));
      })
      .catch(() => {
        if (!cancelled) setError(t("referenceSidebar.referencesCouldNotBeReadTryRefreshing"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repositoryId, profileId, status, revision, pending]);

  const toggle = (key: keyof typeof defaults) => {
    const update = () =>
      useSessionStore
        .getState()
        .setView(repositoryId, { references: { ...saved, [key]: !saved[key] } });

    if (key === "hidden") transition(update);
    else update();
  };

  const checkout = async (branch: BranchSummary) => {
    if (checkoutPending.current) return;
    checkoutPending.current = true;
    setCheckoutError(null);

    try {
      const context = captureRepositoryCommand(repositoryId);
      const result = await repositoryCommandDispatcher(context)("checkoutBranch", {
        repositoryId,
        name: branch.name,
      });

      if (!result.ok) {
        setCheckoutError(
          [errorMessage(result.error), errorAction(result.error)].filter(Boolean).join(" "),
        );
        return;
      }

      await useRepositoryStore.getState().refresh();
      setRevision((value) => value + 1);
    } catch (failure) {
      setCheckoutError([errorMessage(failure), errorAction(failure)].filter(Boolean).join(" "));
    } finally {
      checkoutPending.current = false;
    }
  };

  const collapsed = !forceExpanded && (saved.hidden || compact);
  const sidebarWidth = forceExpanded ? "w-full" : collapsed ? "w-9" : "w-[200px]";
  const contentWidth = forceExpanded ? "w-full" : "w-[200px]";
  const sidebar = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);

  useEffect(() => {
    const element = sidebar.current;

    if (element && (focusToggle.current || element.contains(document.activeElement))) {
      (collapsed ? expandButton : collapseButton).current?.focus();
    }

    focusToggle.current = false;
  }, [collapsed]);

  const groups = [
    {
      key: "locals" as const,
      label: t("referenceSidebar.localBranches"),
      icon: GitBranch,
      items: branches.filter((branch) => !branch.remote),
    },
    {
      key: "remotes" as const,
      label: t("referenceSidebar.remoteBranches"),
      icon: Globe,
      items: branches.filter((branch) => branch.remote),
    },
    { key: "tags" as const, label: t("referenceSidebar.tags"), icon: Tag, items: tags },
  ];

  return (
    <aside
      data-tour="references"
      ref={sidebar}
      onClickCapture={(event) => {
        if (
          collapsed ||
          (event.target instanceof Element &&
            event.target.closest('[data-reference-toggle="collapse"]'))
        )
          focusToggle.current = true;
      }}
      aria-label={t("referenceSidebar.repositoryReferences")}
      data-layout-region=""
      data-collapsed={collapsed}
      className={cx(
        "reference-sidebar app-surface-panel relative min-h-0 shrink-0 overflow-hidden border-r border-border-subtle",
        sidebarWidth,
      )}
    >
      <div
        className="reference-sidebar-rail absolute inset-y-0 left-0 flex w-9 flex-col items-center pt-3"
        inert={!collapsed}
        aria-hidden={!collapsed}
      >
        <IconButton
          ref={expandButton}
          onClick={() => (compact ? onExpand?.() : toggle("hidden"))}
          title={t("referenceSidebar.showBranchesAndTags")}
          aria-label={t("referenceSidebar.showBranchesAndTags")}
          data-reference-toggle="expand"
          icon={<PanelLeftOpen size={16} />}
        />

        {groups.map(({ key, label, icon: Icon, items }) => (
          <ListItemButton
            key={key}
            title={`${label}: ${items.length}`}
            aria-label={`${label}: ${items.length}`}
            className="mt-3 flex-col gap-0 p-1 text-text-tertiary"
            onClick={() =>
              compact
                ? onExpand?.()
                : transition(() =>
                    useSessionStore.getState().setView(repositoryId, {
                      references: { ...saved, hidden: false, [key]: true },
                    }),
                  )
            }
          >
            <Icon size={15} aria-hidden="true" />
            <span className="text-xs">{items.length}</span>
          </ListItemButton>
        ))}
      </div>

      <div
        className={cx("reference-sidebar-content flex h-full min-h-0 flex-col", contentWidth)}
        inert={collapsed}
        aria-hidden={collapsed}
      >
        <header className="flex h-10 shrink-0 items-center justify-between px-3">
          <h2 className="text-xs font-semibold text-text-secondary">
            {t("referenceSidebar.repository")}
          </h2>

          <IconButton
            ref={collapseButton}
            size="xs"
            onClick={() => (forceExpanded ? onExpand?.() : toggle("hidden"))}
            title={t("referenceSidebar.hideBranchesAndTags")}
            aria-label={t("referenceSidebar.hideBranchesAndTags")}
            data-reference-toggle="collapse"
            icon={<PanelLeftClose size={14} />}
          />
        </header>

        {actionTarget && (
          <Suspense fallback={null}>
            <ReferenceMenu
              key={`${profileId}:${repositoryId}:${actionTarget.kind}:${actionTarget.ref.name}`}
              repositoryId={repositoryId}
              target={actionTarget}
              onClose={() => setActions(null)}
              onChanged={() => setRevision((value) => value + 1)}
            />
          </Suspense>
        )}

        {manageOpen && (
          <Suspense fallback={null}>
            <ManageReferencesDialog
              repositoryId={repositoryId}
              onClose={() => setManageOpen(false)}
            />
          </Suspense>
        )}

        <ErrorDialog onDismiss={() => setCheckoutError(null)}>{checkoutError}</ErrorDialog>

        <SearchField
          className="mx-3 mb-3 bg-bg-base"
          aria-label={t("referenceSidebar.filterBranchesAndTags")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("referenceSidebar.findABranch")}
        />

        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {error && (
            <ErrorDialog>
              {error}{" "}
              <TextButton onClick={() => setRevision((value) => value + 1)}>
                {t("common.retry")}
              </TextButton>
            </ErrorDialog>
          )}

          {groups.map((group) => {
            const items = group.items.filter((item) =>
              item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
            );

            return (
              <Disclosure
                key={group.key}
                className="mb-2"
                summaryClassName="px-3 py-2 text-xs font-medium"
                open={saved[group.key]}
                onToggle={(event) => {
                  if (event.currentTarget.open !== saved[group.key]) toggle(group.key);
                }}
                title={
                  <>
                    <group.icon size={13} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{group.label}</span>

                    <span className="mono ml-auto flex h-4 w-6 shrink-0 items-center justify-center text-text-tertiary">
                      {loading && branches.length === 0 ? (
                        <Skeleton className="w-5" />
                      ) : (
                        group.items.length
                      )}
                    </span>
                  </>
                }
              >
                <div className="px-1">
                  {loading && branches.length === 0 ? (
                    <div
                      role="status"
                      aria-label={t("referenceSidebar.loading", {
                        label: group.label.toLowerCase(),
                      })}
                    >
                      <SkeletonRows rows={3} />
                    </div>
                  ) : (
                    <>
                      {items.slice(0, 200).map((item) => (
                        <ReferenceRow
                          key={item.name}
                          item={item}
                          selected={selection?.kind === "commit" && selection.oid === item.oid}
                          onActions={setActions}
                          onCheckout={(branch) => void checkout(branch)}
                        />
                      ))}

                      {!loading && items.length === 0 && (
                        <p className="py-1 pl-[51px] pr-2 text-xs text-text-tertiary">
                          {query ? t("referenceSidebar.noMatches") : t("referenceSidebar.noneYet")}
                        </p>
                      )}

                      {items.length > 200 && (
                        <p className="px-3 py-2 text-xs text-text-tertiary">
                          {t("referenceSidebar.showing200OfFilterToFindAReference", {
                            length: items.length,
                          })}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </Disclosure>
            );
          })}
        </div>

        <p className="border-t border-border-subtle px-3 py-3 text-xs leading-relaxed text-text-tertiary">
          <TextButton tone="accent" onClick={() => setManageOpen(true)}>
            {t("referenceSidebar.manageLocalReferences")}
          </TextButton>
        </p>
      </div>
    </aside>
  );
}

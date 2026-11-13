import { errorText } from "@shared/error-codes";
import { errorMessage, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import type { BranchSummary } from "@shared/repository/repository-write";
import { CircleIcon as Circle } from "../../components/ui/icons";
import { useEffect, useRef, useState } from "react";
import {
  captureRepositoryCommand,
  repositoryCommandDispatcher,
  repositoryCommandReason,
} from "../../commands/repository-commands";
import { ButtonBase } from "../../components/ui/actions/ButtonBase";
import { useListNavigation } from "../../components/ui/hooks/useListNavigation";
import {
  BranchIcon,
  Button,
  CloseIcon,
  ErrorDialog,
  IconButton,
  Input,
  ListItemButton,
  AnchoredPopover,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { openSettings } from "../../stores/shell-store";
import { useRepositoryStore } from "../../stores/repository-store";

export function BranchMenu({ head }: { head: string }) {
  const repositoryId = useAppStore((state) => state.selectedRepositoryId);
  const commandContext = captureRepositoryCommand(repositoryId ?? "");
  const dispatch = repositoryCommandDispatcher(commandContext);
  const commandUnavailable = repositoryCommandReason(commandContext);
  const refresh = useRepositoryStore((state) => state.refresh);
  const upstream = useRepositoryStore((state) => state.status?.branch.upstream);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const writeUnavailable = useRepositoryStore(
    (state) => state.status?.capabilities?.write === false,
  );

  useEffect(() => {
    if (!open || !repositoryId) return;

    void window.eda.repository.listBranches(repositoryId).then((result) => {
      if (result.ok) setBranches(result.value);
      else setError(errorMessage(result.error));
    });
  }, [open, repositoryId]);

  const run = async (work: () => Promise<Result<unknown>>) => {
    if (!repositoryId || writeUnavailable || commandUnavailable) {
      setError(
        commandUnavailable ?? t("branchMenu.thisRepositoryIsReadOnlyCheckPermissionsThenRefresh"),
      );

      return false;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await work();

      if (!result.ok) {
        setError(errorMessage(result.error, errorText("branchMenu.thatDidNotWork")));
        return false;
      }

      await refresh();

      const listed = await window.eda.repository.listBranches(repositoryId);

      if (listed.ok) setBranches(listed.value);

      return true;
    } finally {
      setBusy(false);
    }
  };

  const local = branches.filter((branch) => !branch.remote);
  const needle = query.trim().toLowerCase();
  const matches = needle ? local.filter((b) => b.name.toLowerCase().includes(needle)) : local;
  const renderedMatches = matches.slice(0, 200);

  const { index, setHighlight, onKeyDown } = useListNavigation(
    renderedMatches.length,
    (position) => {
      const branch = renderedMatches[position];

      if (
        !repositoryId ||
        !branch ||
        branch.isHead ||
        branch.worktreePath ||
        busy ||
        commandUnavailable
      )
        return;

      void run(() => dispatch("checkoutBranch", { repositoryId, name: branch.name })).then(
        (done) => done && setOpen(false),
      );
    },
  );

  if (!repositoryId) return null;

  return (
    <div className="relative">
      <ButtonBase
        ref={trigger}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("branchMenu.onBranchSwitchOrCreateABranch", { head: head })}
        title={t("branchMenu.onBranchSwitchOrCreateABranch", { head: head })}
        className="ui-press mono flex min-h-6 min-w-0 max-w-[12rem] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent-text hover:bg-bg-raised"
      >
        <BranchIcon size={13} />
        <span className="truncate">{head}</span>
      </ButtonBase>

      {open && (
        <AnchoredPopover
          role="dialog"
          aria-label={t("branchMenu.branches")}
          onClose={() => setOpen(false)}
          anchorRef={trigger}
          placement="bottom-start"
          className="flex max-h-[min(24rem,calc(100dvh-16px))] w-64 flex-col"
        >
          <div className="shrink-0 border-b border-border-subtle p-1.5">
            <Input
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={t("branchMenu.findOrCreateABranch")}
              aria-label={t("branchMenu.findOrCreateABranch")}
            />
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto p-1">
            {renderedMatches.map((branch, position) => (
              <li key={branch.name} className="group/branch flex items-center gap-1">
                <ListItemButton
                  disabled={
                    !!commandUnavailable || busy || (!!branch.worktreePath && !branch.isHead)
                  }
                  title={
                    branch.worktreePath
                      ? t("branchMenu.checkedOutIn", { worktreePath: branch.worktreePath })
                      : branch.name
                  }
                  onClick={() =>
                    void run(() =>
                      dispatch("checkoutBranch", {
                        repositoryId,
                        name: branch.name,
                      }),
                    ).then((done) => done && setOpen(false))
                  }
                  selected={index === position || branch.isHead}
                  className="mono min-w-0 flex-1 gap-1.5 px-2 py-1 text-xs"
                  onMouseEnter={() => setHighlight(position)}
                >
                  <span className="w-2 shrink-0">
                    {branch.isHead && <Circle size={8} fill="currentColor" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 truncate">{branch.name}</span>
                </ListItemButton>

                {!branch.isHead && (
                  <IconButton
                    size="xs"
                    disabled={busy || !!branch.worktreePath}
                    aria-label={t("branchMenu.delete", { name: branch.name })}
                    title={t("branchMenu.delete", { name: branch.name })}
                    onClick={() =>
                      void run(() =>
                        dispatch("deleteBranch", {
                          repositoryId,
                          name: branch.name,
                        }),
                      )
                    }
                    className="mr-1 opacity-0 hover:text-git-deleted focus-visible:opacity-100 group-hover/branch:opacity-100"
                    icon={<CloseIcon size={12} />}
                  />
                )}
              </li>
            ))}

            {matches.length > 200 && (
              <li className="px-2 py-2 text-xs text-text-tertiary">
                {t("branchMenu.showing200OfSearchToFindABranch", { length: matches.length })}
              </li>
            )}

            {matches.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-text-tertiary">
                {t("branchMenu.noBranchMatches")}
              </li>
            )}
          </ul>

          {commandUnavailable && <p className="text-xs text-text-tertiary">{commandUnavailable}</p>}
          <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>

          <div className="shrink-0 border-t border-border-subtle p-1.5">
            <p
              className="truncate px-2 py-1 text-xs text-text-tertiary"
              title={upstream ?? undefined}
            >
              {upstream
                ? t("repositoryOverview.tracking", { upstream })
                : t("repositoryOverview.noUpstreamConfigured")}
            </p>
            <Button
              size="sm"
              variant="ghost"
              block
              className="justify-start"
              disabled={!!commandUnavailable || busy}
              onClick={() => {
                setOpen(false);
                openSettings("repository-remotes");
              }}
            >
              {t("branchMenu.configureUpstream")}
            </Button>

            {creating || (query.trim() && matches.length === 0) ? (
              <Button
                size="sm"
                variant="identity"
                block
                busy={busy}
                disabled={!!commandUnavailable || query.trim().length === 0}
                onClick={() =>
                  void run(() =>
                    dispatch("createBranch", {
                      repositoryId,
                      name: query.trim(),
                      checkout: true,
                    }),
                  ).then((done) => {
                    if (done) {
                      setQuery("");
                      setCreating(false);
                      setOpen(false);
                    }
                  })
                }
              >
                {t("branchMenu.createFromHead", { value1: query.trim() || "..." })}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                block
                className="justify-start"
                onClick={() => setCreating(true)}
              >
                {t("branchMenu.newBranch")}
              </Button>
            )}
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}

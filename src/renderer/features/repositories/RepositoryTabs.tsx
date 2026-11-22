import { t } from "@shared/i18n";
import { useAppStore } from "../../stores/app-store";
import {
  CloseIcon,
  FolderIcon,
  IconButton,
  PlusIcon,
  TabTrigger,
  Button,
  cx,
} from "../../components/ui/index";
import { useMemo, useRef } from "react";

export function RepositoryTabs() {
  const repositories = useAppStore((s) => s.repositories);
  const activeIdentity = useAppStore((s) => s.activeIdentity);
  const selectedId = useAppStore((s) => s.selectedRepositoryId);
  const tabsByIdentity = useAppStore((s) => s.openTabsByIdentity);
  const selectRepository = useAppStore((s) => s.selectRepository);
  const closeTab = useAppStore((s) => s.closeTab);
  const moveTab = useAppStore((s) => s.moveTab);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const dragged = useRef<string | null>(null);
  const byId = useMemo(() => new Map(repositories.map((repo) => [repo.id, repo])), [repositories]);

  if (!activeIdentity) return null;

  const openIds = tabsByIdentity[activeIdentity.id] ?? [];
  const tabs = openIds
    .map((id) => byId.get(id))
    .filter((repository): repository is NonNullable<typeof repository> => repository !== undefined);

  return (
    <div
      data-tour="repository-tabs"
      role="tablist"
      aria-label={t("repositoryTabs.openRepositories")}
      className="flex min-w-0 items-center gap-1.5 overflow-x-auto py-1"
    >
      {tabs.map((repository, index) => {
        const selected = repository.id === selectedId;

        return (
          <div
            key={repository.id}
            draggable
            onDragStart={(event) => {
              dragged.current = repository.id;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", repository.id);
            }}
            onDragEnd={() => {
              dragged.current = null;
            }}
            onDragOver={(event) => {
              if (dragged.current) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged.current) moveTab(dragged.current, index);
              dragged.current = null;
            }}
            className={cx(
              "ui-repository-tab group relative flex min-w-0 shrink-0 items-center rounded-md",
              "ui-interactive",
              !selected && "hover:bg-bg-raised",
            )}
          >
            <span aria-hidden="true" className="ui-tab-indicator inset-x-0! bottom-0!" />
            <TabTrigger
              ref={(element) => {
                if (element) tabButtons.current.set(repository.id, element);
                else tabButtons.current.delete(repository.id);
              }}
              selected={selected}
              indicator={false}
              tabIndex={selected || (!selectedId && index === 0) ? 0 : -1}
              aria-keyshortcuts="Control+1 Control+2 Control+9 Control+W Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
              title={repository.path}
              onKeyDown={(event) => {
                if (event.key === "Delete") {
                  event.preventDefault();
                  closeTab(repository.id);
                  requestAnimationFrame(() => {
                    const selected = useAppStore.getState().selectedRepositoryId;
                    if (selected) tabButtons.current.get(selected)?.focus();
                  });
                  return;
                }

                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

                event.preventDefault();

                const target =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : Math.max(
                          0,
                          Math.min(tabs.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)),
                        );

                if (event.altKey && event.shiftKey) {
                  moveTab(repository.id, target);
                } else {
                  const id = tabs[target]?.id;
                  if (id) {
                    selectRepository(id);
                    tabButtons.current.get(id)?.focus();
                  }
                }
              }}
              onClick={() => selectRepository(repository.id)}
              onAuxClick={(event) => {
                if (event.button === 1) closeTab(repository.id);
              }}
              className={cx(
                "max-w-44 py-2 pl-3 pr-1",
                selected && "hover:not-disabled:bg-transparent!",
              )}
            >
              <span aria-hidden="true" className="shrink-0 text-text-tertiary">
                <FolderIcon size={13} />
              </span>
              <span
                className={cx(
                  "min-w-0 truncate text-xs",
                  selected ? "font-medium text-text-primary" : "text-text-secondary",
                  !repository.available && "line-through opacity-60",
                )}
              >
                {repository.name}
              </span>
            </TabTrigger>
            <IconButton
              size="xs"
              aria-label={t("repositoryTabs.close", { name: repository.name })}
              title={t("repositoryTabs.close", { name: repository.name })}
              onClick={() => closeTab(repository.id)}
              className={cx(
                "mr-1",
                selected
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
              icon={<CloseIcon size={12} />}
            />
          </div>
        );
      })}

      <Button
        size="sm"
        variant="ghost"
        onClick={() => selectRepository(null)}
        aria-label={t("repositoryTabs.openARepository")}
        title={t("repositoryTabs.openARepository")}
        className="self-center text-text-tertiary"
      >
        <PlusIcon size={13} />
        {tabs.length === 0 && <span>{t("repositoryTabs.openARepository")}</span>}
      </Button>
    </div>
  );
}

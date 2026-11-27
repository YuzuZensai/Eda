import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type DragEvent,
} from "react";
import {
  resolveGraphColumns,
  type GraphColumn,
  type GraphColumnId,
} from "@shared/preferences/graph-view";
import type { SessionContext } from "@shared/identity/profile-session";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { useSessionStore } from "../../stores/session-store";

interface ColumnDrag {
  repositoryId: string;
  id: GraphColumnId;
  pointerId: number;
  target: HTMLElement;
  x: number;
  width: number;
  context: SessionContext;
}

type ColumnReorder = Pick<ColumnDrag, "id" | "repositoryId" | "context">;

function isCurrentView(repositoryId: string, context: SessionContext) {
  const store = useSessionStore.getState();
  const latest = store.snapshot?.context;

  return (
    !store.transitioning &&
    !store.snapshot?.recovery &&
    latest?.profileId === context.profileId &&
    latest.windowId === context.windowId &&
    latest.generation === context.generation &&
    useRepositoryStore.getState().repositoryId === repositoryId
  );
}

const clampWidth = (width: number) => Math.max(48, Math.min(320, Math.round(width)));

export function useGraphColumns(repositoryId: string | null, disabled: boolean) {
  const savedColumns = useSessionStore((state) =>
    repositoryId ? state.snapshot?.session.views[repositoryId]?.graphColumns : undefined,
  );
  const context = useSessionStore((state) => state.snapshot?.context);
  const visibleColumns = usePreferencesStore((state) => state.values.historyVisibleColumns.value);
  const columns = resolveGraphColumns(savedColumns).map((column) => ({
    ...column,
    visible: visibleColumns.includes(column.id),
  }));
  const [drag, setDrag] = useState<ColumnDrag | null>(null);
  const [draftWidth, setDraftWidth] = useState(0);
  const width = useRef(0);
  const reordered = useRef<ColumnReorder | null>(null);
  const [dropTarget, setDropTarget] = useState<GraphColumnId | null>(null);

  const cancelReorder = useCallback(() => {
    reordered.current = null;
    setDropTarget(null);
  }, []);

  useEffect(
    () => cancelReorder(),
    [
      cancelReorder,
      repositoryId,
      disabled,
      context?.profileId,
      context?.windowId,
      context?.generation,
    ],
  );

  const saveWidth = useCallback(
    (id: GraphColumnId, nextWidth: number) => {
      if (!repositoryId || disabled) return;

      const store = useSessionStore.getState();
      const latest = resolveGraphColumns(store.snapshot?.session.views[repositoryId]?.graphColumns);
      const next = clampWidth(nextWidth);

      if (latest.find((column) => column.id === id)?.width === next) return;

      store.setView(repositoryId, {
        graphColumns: latest.map((column) =>
          column.id === id ? { ...column, width: next } : column,
        ),
      });
    },
    [repositoryId, disabled],
  );

  useEffect(() => {
    if (!drag || !repositoryId) return;

    const current = () =>
      repositoryId === drag.repositoryId && isCurrentView(repositoryId, drag.context);

    if (disabled || !current()) {
      setDrag(null);
      return;
    }

    const move = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      if (!current()) {
        setDrag(null);
        return;
      }

      // Metadata columns are anchored to the right, so their left edge controls their width.
      width.current = clampWidth(drag.width + drag.x - event.clientX);
      setDraftWidth(width.current);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      if (current()) saveWidth(drag.id, width.current);
      setDrag(null);
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === drag.pointerId) setDrag(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDrag(null);
    };
    const blur = () => setDrag(null);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);

      if (drag.target.hasPointerCapture(drag.pointerId))
        drag.target.releasePointerCapture(drag.pointerId);
    };
  }, [
    drag,
    repositoryId,
    disabled,
    context?.profileId,
    context?.windowId,
    context?.generation,
    saveWidth,
  ]);

  const startResize = (column: GraphColumn, event: ReactPointerEvent<HTMLElement>) => {
    const store = useSessionStore.getState();
    const snapshot = store.snapshot;

    if (
      disabled ||
      drag ||
      event.button !== 0 ||
      !repositoryId ||
      !snapshot ||
      store.transitioning ||
      snapshot.recovery
    )
      return;

    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    width.current = column.width;
    setDraftWidth(column.width);
    setDrag({
      repositoryId,
      id: column.id,
      pointerId: event.pointerId,
      target: event.currentTarget,
      x: event.clientX,
      width: column.width,
      context: snapshot.context,
    });
  };

  const moveColumn = (id: GraphColumnId, targetId: GraphColumnId) => {
    const store = useSessionStore.getState();
    const snapshot = store.snapshot;

    if (
      disabled ||
      drag ||
      !repositoryId ||
      !snapshot ||
      !isCurrentView(repositoryId, snapshot.context)
    )
      return;

    const latest = resolveGraphColumns(snapshot.session.views[repositoryId]?.graphColumns);
    const from = latest.findIndex((column) => column.id === id);
    const to = latest.findIndex((column) => column.id === targetId);

    if (from < 0 || to < 0 || from === to) return;

    const next = [...latest];
    const [column] = next.splice(from, 1);

    if (!column) return;

    next.splice(to, 0, column);
    store.setView(repositoryId, { graphColumns: next });
  };

  const canReorder = () => {
    const source = reordered.current;

    return (
      source &&
      !disabled &&
      !drag &&
      repositoryId === source.repositoryId &&
      isCurrentView(source.repositoryId, source.context)
    );
  };

  return {
    columns: columns.map((column) =>
      drag?.id === column.id ? { ...column, width: draftWidth } : column,
    ),
    startResize,
    saveWidth,
    moveColumn,
    dropTarget,
    startReorder: (id: GraphColumnId, event: DragEvent<HTMLElement>) => {
      const snapshot = useSessionStore.getState().snapshot;

      if (
        disabled ||
        drag ||
        !repositoryId ||
        !snapshot ||
        !isCurrentView(repositoryId, snapshot.context)
      ) {
        event.preventDefault();
        return;
      }

      reordered.current = { id, repositoryId, context: snapshot.context };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    },
    previewReorder: (id: GraphColumnId, event: DragEvent<HTMLElement>) => {
      if (!canReorder()) return;

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(id);
    },
    finishReorder: (id: GraphColumnId, event: DragEvent<HTMLElement>) => {
      if (canReorder() && reordered.current) {
        event.preventDefault();
        event.stopPropagation();
        moveColumn(reordered.current.id, id);
      }

      cancelReorder();
    },
    cancelReorder,
  };
}

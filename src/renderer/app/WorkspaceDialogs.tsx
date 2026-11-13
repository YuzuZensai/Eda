import type { ComponentType } from "react";
import { DiscardDialog } from "../features/changes/DiscardDialog";
import {
  CommitMenu,
  GraphFilterDialog,
  HistoryRecoveryDialog,
  ManageReferencesDialog,
  UndoRedoDialog,
} from "../features/repository-dialogs";
import type { RepositoryReadState } from "../stores/repository-state";

type CommandDialog = NonNullable<RepositoryReadState["commandDialog"]>;

interface DialogProps {
  repositoryId: string;
  onClose: () => void;
}

const DIALOGS: Partial<Record<CommandDialog["kind"], ComponentType<DialogProps>>> = {
  "repository.graph": GraphFilterDialog,
  "repository.references": ManageReferencesDialog,
  "repository.historyRecovery": HistoryRecoveryDialog,
  "repository.undoRedo": UndoRedoDialog,
};

export function WorkspaceDialogs({ command, ...props }: DialogProps & { command: CommandDialog }) {
  const Content = DIALOGS[command.kind];
  if (Content) return <Content {...props} />;

  if (command.kind === "repository.recovery") return <DiscardDialog {...props} paths={null} />;

  if (
    command.oid &&
    (command.kind === "repository.createBranch" || command.kind === "repository.createTag")
  )
    return (
      <CommitMenu
        target={{ oid: command.oid, x: window.innerWidth / 2 - 120, y: 100 }}
        initialMode={command.kind === "repository.createBranch" ? "branch" : "tag"}
        onClose={props.onClose}
      />
    );

  return null;
}

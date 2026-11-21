import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { invalidRequest } from "../../request-errors";
import { handle, withRepositoryChange } from "../transport";
import { requireId, requireRecord, requireString } from "../validate";

export function registerConflictHandlers({ conflicts }: Services) {
  handle(IPC_CHANNELS.conflictExternal, async (_event, rawId, token) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(await conflicts.external(id, requireId(token)));
    });
  });

  handle(IPC_CHANNELS.conflictInspect, async (_event, id, path) =>
    ok(await conflicts.inspect(requireId(id), requireString(path, t("fields.conflictPath")))),
  );

  handle(IPC_CHANNELS.conflictResolve, async (_event, raw) => {
    const value = requireRecord(raw, t("main.conflictHandlers.conflictResolution"));
    const repositoryId = requireId(value["repositoryId"]);
    const choice = value["choice"];

    if (
      choice !== "text" &&
      choice !== "current" &&
      choice !== "incoming" &&
      choice !== "delete" &&
      choice !== "worktree"
    )
      throw invalidRequest(errorText("main.conflictHandlers.chooseHowToResolveThisConflict"));

    const stage = value["stage"];

    if (typeof stage !== "boolean")
      throw invalidRequest(
        errorText("main.conflictHandlers.chooseWhetherToMarkTheConflictResolved"),
      );

    const output = value["text"];

    if (output !== undefined && (typeof output !== "string" || output.length > 4 * 1024 * 1024))
      throw invalidRequest(errorText("main.conflictHandlers.theResolvedTextExceedsTheEditorLimit"));

    return withRepositoryChange(repositoryId, async () => {
      await conflicts.resolve({
        repositoryId,
        token: requireId(value["token"]),
        choice,
        stage,
        ...(typeof output === "string" ? { text: output } : {}),
      });

      return ok(undefined);
    });
  });
}

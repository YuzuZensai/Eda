import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { invalidRequest } from "../../request-errors";
import { handle, withRepositoryChange } from "../transport";
import { requireId, requireRecord, requireString } from "../validate";

export function registerStashHandlers({ stashes }: Services) {
  handle(IPC_CHANNELS.stashesRename, async (_event, rawId, rawToken, name) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(
        await stashes.rename(id, requireId(rawToken), requireString(name, t("fields.stashName"))),
      );
    });
  });

  handle(IPC_CHANNELS.stashesPrepareBranch, async (_event, rawId, rawToken, name) =>
    ok(
      await stashes.prepareBranch(
        requireId(rawId),
        requireId(rawToken),
        requireString(name, t("fields.branchName")),
      ),
    ),
  );

  handle(IPC_CHANNELS.stashesCreateBranch, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(await stashes.createBranch(id, requireId(rawToken)));
    });
  });

  handle(IPC_CHANNELS.stashesPrepareFile, async (_event, rawId, rawToken, area, path) => {
    if (area !== "tracked" && area !== "staged" && area !== "untracked")
      throw invalidRequest(errorText("main.stashHandlers.chooseAVersionFromTheStash"));

    return ok(
      await stashes.prepareFile(
        requireId(rawId),
        requireId(rawToken),
        area,
        requireString(path, t("fields.stashFile")),
      ),
    );
  });

  handle(IPC_CHANNELS.stashesRestoreFile, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      await stashes.restoreFile(id, requireId(rawToken));
      return ok(undefined);
    });
  });

  handle(IPC_CHANNELS.stashesApply, async (_event, rawId, rawToken, pop, restoreIndex) => {
    const id = requireId(rawId);
    const token = requireId(rawToken);

    if (typeof pop !== "boolean" || typeof restoreIndex !== "boolean")
      throw invalidRequest(errorText("main.stashHandlers.chooseStashApplicationOptions"));

    return withRepositoryChange(id, async () => {
      return ok(await stashes.apply(id, token, pop, restoreIndex));
    });
  });

  handle(IPC_CHANNELS.stashesList, async (_event, id) => ok(await stashes.list(requireId(id))));

  handle(IPC_CHANNELS.stashesInspect, async (_event, id, selector, oid) =>
    ok(
      await stashes.inspect(
        requireId(id),
        requireString(selector, t("fields.stashSelector")),
        requireString(oid, t("fields.stashCommit")),
      ),
    ),
  );

  handle(IPC_CHANNELS.stashesCreate, async (_event, rawId, message, contents, rawOptions) => {
    const id = requireId(rawId);

    if (contents !== "tracked" && contents !== "untracked" && contents !== "all")
      throw invalidRequest(errorText("main.stashHandlers.chooseWhichFilesToStash"));

    const name = requireString(message, t("fields.stashName"));

    const options =
      rawOptions === undefined
        ? {}
        : requireRecord(rawOptions, t("main.stashHandlers.stashOptions"));

    for (const key of ["stagedOnly", "keepIndex"]) {
      if (options[key] !== undefined && typeof options[key] !== "boolean")
        throw invalidRequest(errorText("main.stashHandlers.chooseValidStashOptions"));
    }

    const paths = options["paths"];

    if (
      paths !== undefined &&
      (!Array.isArray(paths) ||
        paths.length > 256 ||
        paths.some((path) => typeof path !== "string"))
    )
      throw invalidRequest(errorText("main.stashHandlers.chooseUpTo256StashPaths"));

    return withRepositoryChange(id, async () => {
      await stashes.create(id, name, contents, {
        ...(Array.isArray(paths) ? { paths: paths as string[] } : {}),
        stagedOnly: options["stagedOnly"] === true,
        keepIndex: options["keepIndex"] === true,
      });

      return ok(undefined);
    });
  });

  handle(IPC_CHANNELS.stashesDrop, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);
    const token = requireId(rawToken);

    return withRepositoryChange(id, async () => {
      await stashes.drop(id, token);
      return ok(undefined);
    });
  });
}

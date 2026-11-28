import { basename } from "node:path";
import type { PatchExportRequest } from "@shared/repository/repository-read";
import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS } from "@shared/ipc";
import { readRegularFile } from "../../filesystem/read-regular-file";
import { saveFile } from "../../filesystem/save-file";
import type { RepositoryContext } from "../../repo/lifecycle/repository-context";
import type { Services } from "../../services";
import { invalidRequest } from "../../request-errors";
import { showOpenDialog, showSaveDialog } from "../dialogs";
import { handle, withRepositoryChange } from "../transport";
import { repositoryRequest, requireId, requireString, requireRecord } from "../validate";

export async function saveRepositoryExport(
  repositories: Services["repositories"],
  event: Electron.IpcMainInvokeEvent,
  owner: RepositoryContext,
  options: Electron.SaveDialogOptions,
  bytes: Buffer,
) {
  const result = await showSaveDialog(event, options);
  if (result.canceled || !result.filePath) return ok(false);
  repositories.assertCurrentRepository(owner);
  await saveFile(result.filePath, bytes);
  return ok(true);
}

export function registerPatchHandlers(services: Services) {
  const { repositories, writer } = services;
  handle(IPC_CHANNELS.repositoryExportPatch, async (event, raw, rawMailbox) => {
    const { input, repositoryId } = repositoryRequest(raw, t("patch.export"));
    const area = input["area"];
    const path =
      input["path"] === undefined ? undefined : requireString(input["path"], t("fields.filePath"));
    const oldPath =
      input["oldPath"] === undefined
        ? undefined
        : requireString(input["oldPath"], t("fields.filePath"));
    const oid =
      input["oid"] === undefined
        ? undefined
        : requireString(input["oid"], t("fields.commitObjectId"), 64);
    let request: PatchExportRequest;
    if (oid && area === undefined && (!oldPath || path)) {
      request = { repositoryId, oid, ...(path && { path }), ...(oldPath && { oldPath }) };
    } else if (!oid && !oldPath && path && (area === "staged" || area === "unstaged")) {
      request = { repositoryId, area, path };
    } else {
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAValidDiffArea"));
    }
    const owner = repositories.resolveActiveRepository(repositoryId);
    const mailbox =
      rawMailbox === undefined ? undefined : requireRecord(rawMailbox, t("mailbox.export"));
    if (mailbox && (!oid || path)) throw invalidRequest(errorText("mailbox.range"));
    const after =
      mailbox?.["after"] === undefined
        ? undefined
        : requireString(mailbox["after"], t("mailbox.base"), 64);
    const bytes =
      mailbox && oid
        ? await services.repositoryReader.mailboxPatch(repositoryId, oid, after)
        : await services.repositoryReader.filePatch(request);
    const name = "oid" in request ? (request.path ?? request.oid.slice(0, 12)) : request.path;
    if (!bytes.length) throw invalidRequest(errorText("patch.empty"));
    const options = {
      title: t("patch.save", { path: name, bytes: bytes.length }),
      defaultPath: basename(name) + (mailbox ? ".mbox" : ".patch"),
      filters: mailbox
        ? [{ name: t("mailbox.export"), extensions: ["mbox"] }]
        : [{ name: t("patch.export"), extensions: ["patch", "diff"] }],
    };
    return saveRepositoryExport(repositories, event, owner, options, bytes);
  });

  handle(IPC_CHANNELS.repositoryResumeMailbox, async (_e, rawId, action, rawToken) => {
    if (action !== "continue" && action !== "abort")
      throw invalidRequest(errorText("mailbox.invalid"));
    const id = requireId(rawId);
    const token = requireString(rawToken, t("mailbox.preview"), 64);
    await withRepositoryChange(id, () => writer.mailbox(id, { action, token }));
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositoryApplyPatch, async (event, rawId, mailbox) => {
    const id = requireId(rawId);
    const owner = repositories.resolveActiveRepository(id);
    const file = await showOpenDialog(event, {
      title: t(mailbox === true ? "mailbox.apply" : "patch.apply"),
      buttonLabel: t(mailbox === true ? "mailbox.apply" : "patch.apply"),
      properties: ["openFile"],
      filters: [
        {
          name: t("patch.files"),
          extensions: mailbox === true ? ["mbox", "patch"] : ["patch", "diff"],
        },
        { name: t("patch.allFiles"), extensions: ["*"] },
      ],
    });
    if (file.canceled || !file.filePaths[0]) return ok(false);
    const { bytes } = await readRegularFile(file.filePaths[0], 32 * 1024 * 1024, () =>
      invalidRequest(errorText("patch.invalidFile")),
    );
    repositories.assertCurrentRepository(owner);
    await withRepositoryChange(id, () =>
      mailbox === true ? writer.mailbox(id, { bytes }) : writer.applyPatch(id, bytes),
    );
    return ok(true);
  });
}

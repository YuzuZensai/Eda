import { errorText } from "@shared/error-codes";
import { GitError, ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { showOpenDialog, showSaveDialog } from "../dialogs";
import { invalidRequest } from "../../request-errors";
import { handle } from "../transport";
import { optionalRecord, requireAbsolutePath, requireId, requireString } from "../validate";

export function registerSshHandlers(services: Services): void {
  const keyDestinations = new WeakMap<Electron.WebContents, string>();
  handle(IPC_CHANNELS.sshPendingHostTrust, async (event) => {
    if (event.senderFrame !== event.sender.mainFrame)
      throw invalidRequest(errorText("main.sshHandlers.sshHostTrustRequiresTheApplicationWindow"));
    return ok(services.sshHostTrust.current(event.sender.id));
  });

  handle(IPC_CHANNELS.sshRespondHostTrust, async (event, rawId, rawTrust) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof rawTrust !== "boolean")
      throw invalidRequest(errorText("main.sshHandlers.invalidSshHostTrustResponse"));
    if (!services.sshHostTrust.respond(event.sender.id, requireId(rawId), rawTrust))
      throw invalidRequest(
        errorText("main.sshHandlers.thisSshHostTrustRequestHasExpiredOrBelongsToAnotherWindow"),
      );
    return ok(undefined);
  });

  handle(IPC_CHANNELS.sshListKeys, async () => ok(await services.ssh.discoverKeys()));

  handle(IPC_CHANNELS.sshImportKey, async (_e, rawPath) =>
    ok(await services.ssh.importKey(requireAbsolutePath(rawPath, t("fields.keyPath")))),
  );

  handle(IPC_CHANNELS.sshGenerateKey, async (event, raw) => {
    const input = optionalRecord(raw);
    const path = requireAbsolutePath(input["path"], t("fields.keyPath"));
    if (keyDestinations.get(event.sender) !== path)
      throw invalidRequest(errorText("main.sshHandlers.chooseKeyFirst"));
    keyDestinations.delete(event.sender);
    const type = input["type"] === "rsa" ? "rsa" : "ed25519";
    const bits = typeof input["bits"] === "number" ? input["bits"] : undefined;

    return ok(
      await services.ssh.generateKey({
        path,
        type,
        comment: requireString(input["comment"], t("fields.comment"), 256),
        ...(bits !== undefined && { bits }),
      }),
    );
  });

  handle(IPC_CHANNELS.sshGetAgentStatus, async () => ok(await services.ssh.getAgentStatus()));

  handle(IPC_CHANNELS.sshUnlockKey, async (_e, rawRequest, rawPassphrase) => {
    const request = optionalRecord(rawRequest);
    const lifetime = request["lifetimeSeconds"];

    if (typeof rawPassphrase !== "string" || rawPassphrase.length === 0) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.unlockSshKey"),
        message: errorText("main.sshHandlers.enterTheKeySPassphrase"),
        suggestedAction: errorText(
          "main.sshHandlers.thePassphraseIsTheOneYouSetWhenTheKeyWasCreated",
        ),
      });
    }

    const status = await services.ssh.unlockKey(
      {
        keyPath: requireAbsolutePath(request["keyPath"], t("fields.keyPath")),
        ...(typeof lifetime === "number" &&
          lifetime > 0 && { lifetimeSeconds: Math.floor(lifetime) }),
      },
      rawPassphrase,
    );

    return ok(status);
  });

  handle(IPC_CHANNELS.sshLockKey, async (_e, rawPath) =>
    ok(await services.ssh.lockKey(requireAbsolutePath(rawPath, t("fields.keyPath")))),
  );

  handle(IPC_CHANNELS.sshTestConnection, async (_e, rawHost, rawPath) =>
    ok(
      await services.ssh.testConnection(
        requireString(rawHost, t("fields.host"), 253),
        requireAbsolutePath(rawPath, t("fields.keyPath")),
      ),
    ),
  );

  handle(IPC_CHANNELS.sshChoosePrivateKey, async (event) => {
    const result = await showOpenDialog(event, {
      title: t("main.sshHandlers.chooseAnSshPrivateKey"),
      properties: ["openFile"],
      filters: [{ name: t("main.fileFilters.sshPrivateKeys"), extensions: ["pem", "key", "*"] }],
    });
    return ok(result.canceled ? null : (result.filePaths[0] ?? null));
  });

  handle(IPC_CHANNELS.sshChoosePublicKey, async (event) => {
    const result = await showOpenDialog(event, {
      title: t("main.sshHandlers.chooseAnSshPublicKey"),
      properties: ["openFile"],
      filters: [{ name: t("main.fileFilters.sshPublicKeys"), extensions: ["pub"] }],
    });
    return ok(result.canceled ? null : (result.filePaths[0] ?? null));
  });

  handle(IPC_CHANNELS.sshChooseKeyDestination, async (event) => {
    const options = { title: t("main.sshHandlers.createSshKey"), defaultPath: "id_ed25519" };
    const result = await showSaveDialog(event, options);
    keyDestinations.delete(event.sender);
    if (!result.canceled && result.filePath) keyDestinations.set(event.sender, result.filePath);
    return ok(result.canceled ? null : (result.filePath ?? null));
  });
}

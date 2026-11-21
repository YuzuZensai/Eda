import { errorText } from "@shared/error-codes";
import { GitError, ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { captureProfile } from "../profile-context";
import { missingIdentity } from "../../request-errors";
import { handle } from "../transport";
import { optionalRecord } from "../validate";

export function registerCredentialHandlers(services: Services): void {
  const { identity, identities } = services;

  handle(IPC_CHANNELS.credentialsGetSecretMetadata, async (_e, rawProfile) =>
    ok(await services.credentials.getSecretMetadata(captureProfile(identity, rawProfile))),
  );

  handle(
    IPC_CHANNELS.credentialsUnlockActiveKey,
    async (_e, rawRequest, rawPassphrase, rawProfile) => {
      const request = optionalRecord(rawRequest);
      const lifetime = request["lifetimeSeconds"];
      const passphrase = rawPassphrase === undefined ? undefined : requirePassphrase(rawPassphrase);
      const captured = captureProfile(identity, rawProfile);

      return ok(
        await identity.serialize(async () => {
          if (!identities.findById(captured.id)) throw missingIdentity(t("operations.unlockKey"));

          return services.credentials.unlockActiveKey(
            {
              remember: request["remember"] === true,
              ...(typeof lifetime === "number" &&
                lifetime > 0 && { lifetimeSeconds: Math.floor(lifetime) }),
            },
            passphrase,
            captured,
          );
        }),
      );
    },
  );

  handle(IPC_CHANNELS.credentialsForgetActivePassphrase, async (_e, rawProfile) => {
    const captured = captureProfile(identity, rawProfile);
    await identity.serialize(() => services.credentials.forgetActivePassphrase(captured));
    return ok(undefined);
  });
}

function requirePassphrase(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new GitError({
      kind: "invalid-input",
      operation: t("operations.unlockSshKey"),
      message: errorText("main.credentialHandlers.enterTheKeySPassphrase"),
      suggestedAction: errorText(
        "main.credentialHandlers.thePassphraseIsTheOneYouSetWhenTheKeyWasCreated",
      ),
    });
  }

  return value;
}

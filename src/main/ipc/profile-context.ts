import { ok } from "@shared/errors";
import type { Services } from "../services";
import { errorText } from "@shared/error-codes";
import { t, type MessageKey } from "@shared/i18n";
import type { IdentityManager } from "../identity/identity-manager";
import { invalidRequest, missingIdentity } from "../request-errors";
import { requireId } from "./validate";

export function captureProfile(identity: IdentityManager, rawId?: unknown) {
  const active = identity.getActive();
  if (!active) throw missingIdentity(t("operations.profileOperation"));

  if (rawId !== undefined && requireId(rawId) !== active.id)
    throw invalidRequest(
      errorText("main.profileContext.theProfileChangedBeforeThisActionCouldStart"),
    );

  return active;
}

export function profileOperation(
  { identity, identities }: Pick<Services, "identity" | "identities">,
  operation: MessageKey,
) {
  return async <T>(rawProfile: unknown, action: (id: string) => Promise<T> | T) => {
    const captured = captureProfile(identity, requireId(rawProfile));

    return identity.serialize(async () => {
      if (!identities.findById(captured.id)) throw missingIdentity(t(operation));
      return ok(await action(captured.id));
    });
  };
}

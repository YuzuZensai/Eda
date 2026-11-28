import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import type { PublicKeyRequest } from "@shared/repository/repository-read";
import { keyError } from "../../providers/public-signing-keys";
import { invalidRequest } from "../../request-errors";
import type { Services } from "../../services";
import { broadcast, handle } from "../transport";
import { requireId, requireRecord, requireString } from "../validate";

export function registerSignatureHandlers(services: Pick<Services, "commitSignatures">): void {
  handle(IPC_CHANNELS.repositoryForgetSigningKey, async (_e, rawId, fingerprint) => {
    const id = requireId(rawId);
    services.commitSignatures.forgetKey(
      id,
      requireString(fingerprint, t("diff.commitDetails.signatureKey"), 64),
    );
    broadcast(IPC_EVENTS.repositoryChanged, id);
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositoryCancelKeyDiscovery, async (_e, id) => {
    services.commitSignatures.cancelDiscovery(requireId(id));
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositorySignerDecisions, async (_e, id) =>
    ok(services.commitSignatures.listSigners(requireId(id))),
  );
  handle(IPC_CHANNELS.repositoryDecideSigner, async (_e, rawId, raw, remove) => {
    const id = requireId(rawId);
    const input = requireRecord(raw, t("diff.commitDetails.signatureTrust"));
    const scope = input["scope"];
    const decision = input["decision"];
    if (
      (scope !== "profile" && scope !== "repository") ||
      (decision !== "trusted" && decision !== "distrusted") ||
      typeof remove !== "boolean"
    )
      throw keyError();
    services.commitSignatures.decide(
      id,
      {
        fingerprint: requireString(input["fingerprint"], t("diff.commitDetails.signatureKey"), 100),
        identity: requireString(input["identity"], t("diff.commitDetails.signatureSigner"), 320),
        scope,
        decision,
      },
      remove,
    );
    broadcast(IPC_EVENTS.repositoryChanged, id);
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositoryDiscoverSigningKey, async (_e, rawId, rawOid, raw) => {
    const id = requireId(rawId);
    const oid = requireString(rawOid, t("fields.commitObjectId"), 64);
    const input = requireRecord(raw, t("diff.commitDetails.signatureKey"));
    let request: PublicKeyRequest;
    if (input["source"] === "automatic") request = { source: "automatic" };
    else if (input["source"] === "github")
      request = {
        source: "github",
        account: requireString(input["account"], t("signature.github"), 39),
      };
    else if (input["source"] === "keyserver")
      request = {
        source: "keyserver",
        server: requireString(input["server"], t("signature.server"), 2048),
      };
    else if (input["source"] === "manual")
      request = {
        source: "manual",
        armoredKey: requireString(
          input["armoredKey"],
          t("diff.commitDetails.signatureKey"),
          256 * 1024,
        ),
      };
    else throw keyError();
    const result = await services.commitSignatures.discover(id, oid, request);
    broadcast(IPC_EVENTS.repositoryChanged, id);
    return ok(result);
  });

  handle(IPC_CHANNELS.repositoryInspectCommit, async (_e, id, oid, refreshSignature) => {
    if (refreshSignature !== undefined && typeof refreshSignature !== "boolean")
      throw invalidRequest(
        errorText("main.repositoryHandlers.chooseWhetherToVerifySignatureAgain"),
      );

    return ok(
      await services.commitSignatures.inspect(
        requireId(id),
        requireString(oid, t("fields.commitObjectId"), 64),
        refreshSignature === true,
      ),
    );
  });

  handle(IPC_CHANNELS.repositoryCommitSignature, async (_e, id, oid) => {
    return ok(
      await services.commitSignatures.read(
        requireId(id),
        requireString(oid, t("fields.commitObjectId"), 64),
      ),
    );
  });
}

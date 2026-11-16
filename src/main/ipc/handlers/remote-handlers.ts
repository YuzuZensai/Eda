import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  PUSH_MODES,
  REMOTE_REF_KINDS,
  type RemoteChange,
  type TransportCredentials,
} from "@shared/integrations/remotes";
import { isOneOf } from "@shared/validation";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import { isPullStrategy } from "@shared/workflows/pull";
import type { Services } from "../../services";
import { invalidRequest } from "../request-errors";
import { broadcast, handle, withRepositoryChange } from "../transport";
import { requireAbsolutePath, requireId, requireRecord, requireString } from "../validate";

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw invalidRequest(errorText("main.remoteHandlers.chooseAnExplicitOption"));
  return value;
}

function credentials(value: unknown): TransportCredentials | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, t("main.remoteHandlers.hTtpsCredentials"));

  return {
    username: requireString(input["username"], t("fields.username"), 256),
    password: requireString(input["password"], t("fields.token"), 4096),
  };
}

export function registerRemoteHandlers({ remotes, pull, backgroundFetch }: Services): void {
  handle(IPC_CHANNELS.backgroundFetchInspect, async (_event, id) =>
    ok(await backgroundFetch.inspect(requireId(id))),
  );

  handle(IPC_CHANNELS.backgroundFetchConfigure, async (_event, id, minutes) => {
    if (minutes !== null && typeof minutes !== "number")
      throw invalidRequest(errorText("main.remoteHandlers.chooseAFetchInterval"));
    backgroundFetch.configure(requireId(id), minutes);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.backgroundFetchRetry, async (_event, rawId, remote) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      await backgroundFetch.retry(id, requireString(remote, t("fields.remote")));
      return ok(undefined);
    });
  });

  handle(IPC_CHANNELS.pullPreference, async (_event, id) => ok(pull.preference(requireId(id))));

  handle(IPC_CHANNELS.pullSetPreference, async (_event, id, strategy) => {
    if (strategy !== null && !isPullStrategy(strategy))
      throw invalidRequest(errorText("main.remoteHandlers.chooseAPullStrategy"));
    pull.setPreference(requireId(id), strategy);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.pullPrepare, async (_event, raw) => {
    const value = requireRecord(raw, t("main.remoteHandlers.pullRequest"));
    const id = requireId(value["repositoryId"]);
    const strategy = value["strategy"];

    if (!isPullStrategy(strategy))
      throw invalidRequest(errorText("main.remoteHandlers.chooseAPullStrategy"));

    const auth = credentials(value["credentials"]);

    return withRepositoryChange(id, async () => {
      return ok(
        await pull.prepare({ repositoryId: id, strategy, ...(auth ? { credentials: auth } : {}) }),
      );
    });
  });

  handle(IPC_CHANNELS.pullExecute, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);
    const token = requireId(rawToken);

    return withRepositoryChange(id, async () => {
      return ok(await pull.execute(id, token));
    });
  });

  handle(IPC_CHANNELS.remotesInspect, async (_event, id) =>
    ok(await remotes.inspect(requireId(id))),
  );

  handle(IPC_CHANNELS.remotesListTags, async (_event, raw) => {
    const input = requireRecord(raw, t("main.remoteService.inspectRemoteTags"));

    return ok(
      await remotes.listTags({
        repositoryId: requireId(input["repositoryId"]),
        remote: requireString(input["remote"], t("fields.remoteName"), 100),
        ...(input["credentials"] === undefined
          ? {}
          : { credentials: credentials(input["credentials"])! }),
      }),
    );
  });

  handle(IPC_CHANNELS.remotesChange, async (_event, rawId, rawChange) => {
    const id = requireId(rawId);
    const value = requireRecord(rawChange, t("main.remoteHandlers.remoteChange"));
    const name = requireString(value["name"], t("fields.remoteName"), 100);
    let change: RemoteChange;

    switch (value["kind"]) {
      case "add":
        change = { kind: "add", name, url: requireString(value["url"], "URL") };
        break;
      case "url":
        change = {
          kind: "url",
          name,
          url: requireString(value["url"], "URL"),
          push: boolean(value["push"]),
        };
        break;
      case "rename":
        change = { kind: "rename", name, to: requireString(value["to"], t("fields.newName"), 100) };
        break;
      case "remove":
        change = { kind: "remove", name };
        break;
      default:
        throw invalidRequest(errorText("main.remoteHandlers.chooseARemoteConfigurationAction"));
    }

    await withRepositoryChange(id, async () => remotes.change(id, change));

    return ok(undefined);
  });

  handle(IPC_CHANNELS.remotesTrack, async (_event, rawId, branch, upstream) => {
    const id = requireId(rawId);

    await withRepositoryChange(id, async () =>
      remotes.track(
        id,
        requireString(branch, t("fields.branch")),
        upstream === null ? null : requireString(upstream, t("fields.upstream")),
      ),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.remotesFetch, async (_event, raw) => {
    const input = requireRecord(raw, t("main.remoteHandlers.fetch"));
    const id = requireId(input["repositoryId"]);
    const auth = credentials(input["credentials"]);

    return withRepositoryChange(id, async () => {
      return ok(
        await remotes.fetch({
          repositoryId: id,
          remote:
            input["remote"] === null ? null : requireString(input["remote"], t("fields.remote")),
          prune: boolean(input["prune"]),
          tags: boolean(input["tags"]),
          ...(input["tag"] !== undefined
            ? { tag: requireString(input["tag"], t("fields.tagName"), 255) }
            : {}),
          ...(auth ? { credentials: auth } : {}),
        }),
      );
    });
  });

  handle(IPC_CHANNELS.remotesPreparePush, async (_event, raw) => {
    const input = requireRecord(raw, t("main.remoteHandlers.pushPreview"));
    const mode = input["mode"];

    if (!isOneOf(mode, PUSH_MODES))
      throw invalidRequest(errorText("main.remoteHandlers.chooseASupportedPushMode"));

    const refKind = input["refKind"] ?? "branch";

    if (!isOneOf(refKind, REMOTE_REF_KINDS))
      throw invalidRequest(errorText("main.remoteHandlers.chooseABranchOrTag"));

    const auth = credentials(input["credentials"]);

    return ok(
      await remotes.preparePush({
        repositoryId: requireId(input["repositoryId"]),
        remote: requireString(input["remote"], t("fields.remote")),
        branch: requireString(input["branch"], t("fields.sourceBranch")),
        destination: requireString(input["destination"], t("fields.destinationBranch")),
        setUpstream: boolean(input["setUpstream"]),
        mode,
        refKind,
        ...(auth ? { credentials: auth } : {}),
      }),
    );
  });

  handle(IPC_CHANNELS.remotesPush, async (_event, rawId, token, auth) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(await remotes.push(id, requireId(token), credentials(auth)));
    });
  });

  handle(IPC_CHANNELS.remotesClone, async (_event, raw) => {
    const input = requireRecord(raw, t("main.remoteHandlers.clone"));
    const auth = credentials(input["credentials"]);

    const result = await remotes.clone({
      profileId: requireId(input["profileId"]),
      url: requireString(input["url"], "URL"),
      parent: requireAbsolutePath(input["parent"]),
      name: requireString(input["name"], t("fields.folderName"), 200),
      ...(auth ? { credentials: auth } : {}),
    });

    broadcast(IPC_EVENTS.repositoriesChanged);

    return ok(result);
  });
}

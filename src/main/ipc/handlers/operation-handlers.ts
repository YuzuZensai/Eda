import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import type { Services } from "../../services";
import { invalidRequest } from "../../request-errors";
import { broadcast, handle } from "../transport";
import { requireId } from "../validate";

export function registerOperationHandlers(services: Services): void {
  const profile = () => {
    const id = services.identity.getActive()?.id;
    if (!id)
      throw invalidRequest(errorText("main.operationHandlers.selectAProfileToViewItsActivity"));
    return id;
  };

  services.operations.onChange((record) => {
    broadcast(IPC_EVENTS.operationsChanged);
    if (record.state !== "queued" && record.state !== "running")
      broadcast(IPC_EVENTS.repositoryChanged, record.repositoryId);
  });

  handle(IPC_CHANNELS.operationsList, async () => ok(services.operations.list(profile())));

  handle(IPC_CHANNELS.operationsCancel, async (_event, id) => {
    services.operations.cancel(profile(), requireId(id));
    return ok(undefined);
  });

  handle(IPC_CHANNELS.operationsRetry, async (_event, id) => {
    await services.operations.retry(profile(), requireId(id));
    return ok(undefined);
  });
}

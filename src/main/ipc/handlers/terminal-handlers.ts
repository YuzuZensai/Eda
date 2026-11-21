import type { WebContents } from "electron";
import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { IPC_CHANNELS } from "@shared/ipc";
import { sameTerminalOwner } from "../../git/terminal-sessions";
import type { Services } from "../../services";
import { handle } from "../transport";
import { invalidRequest } from "../../request-errors";
import { requireId, requireString } from "../validate";
import { t } from "@shared/i18n";

export function registerTerminalHandlers({ terminals, repositories, git, preferences }: Services) {
  const watched = new WeakSet<WebContents>();
  const invalid = () => invalidRequest(errorText("terminal.unavailable"));
  const number = (v: unknown, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw invalid();
    return v;
  };
  const owner = (sender: WebContents, raw: unknown) => {
    const repo = repositories.resolveActiveRepository(requireId(raw));
    return {
      windowId: sender.id,
      profileId: repo.identityId,
      repositoryId: repo.id,
      cwd: repo.path,
    };
  };
  handle(IPC_CHANNELS.terminalList, async (e, id) => ok(terminals.list(owner(e.sender, id))));
  handle(IPC_CHANNELS.terminalStart, async (e, id) => {
    const sender = e.sender;
    const scope = owner(sender, id);
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once("destroyed", () => terminals.dispose(scope.windowId));
    }
    if (git.trust && !(await git.trust.checked(scope.cwd)).trusted) throw invalid();
    const opts = preferences.resolve("terminalOptions", { profileId: scope.profileId }).value;
    return ok(
      await terminals.start(
        scope,
        opts,
        () => !sender.isDestroyed() && sameTerminalOwner(owner(sender, id), scope),
      ),
    );
  });
  handle(IPC_CHANNELS.terminalFrame, async (e, id, tab, offset, query, revision) => {
    if (typeof query !== "string" || query.length > 200) throw invalid();
    return ok(
      terminals.frame(
        owner(e.sender, id),
        requireId(tab),
        offset === null ? null : number(offset, 0, 10000),
        query,
        number(revision, -1, Number.MAX_SAFE_INTEGER),
      ),
    );
  });
  handle(IPC_CHANNELS.terminalInput, async (e, id, tab, text, paste) => {
    if (typeof paste !== "boolean") throw invalid();
    terminals.input(
      owner(e.sender, id),
      requireId(tab),
      requireString(text, t("terminal.input"), 65536),
      paste,
    );
    return ok(undefined);
  });
  handle(IPC_CHANNELS.terminalResize, async (e, id, tab, cols, rows) => {
    terminals.resize(
      owner(e.sender, id),
      requireId(tab),
      number(cols, 10, 300),
      number(rows, 3, 100),
    );
    return ok(undefined);
  });
  handle(IPC_CHANNELS.terminalMove, async (e, id, tab, step) => {
    terminals.move(owner(e.sender, id), requireId(tab), number(step, -1, 1));
    return ok(undefined);
  });
  handle(IPC_CHANNELS.terminalClose, async (e, id, tab) => {
    terminals.close(owner(e.sender, id), requireId(tab));
    return ok(undefined);
  });
}

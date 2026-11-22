import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import { GitError } from "@shared/errors";
import { errorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import type { TerminalOptions, TerminalFrame, TerminalTab } from "@shared/repository/terminal";
import type { Terminal } from "@xterm/headless";
import type { IPty } from "node-pty";
import { buildGitEnvironment } from "./execution/environment";

export interface TerminalOwner {
  windowId: number;
  profileId: string;
  repositoryId: string;
  cwd: string;
}
interface Session {
  owner: TerminalOwner;
  id: string;
  process: IPty;
  screen: Terminal;
  title: string;
  exit: number | null;
  revision: number;
}
const invalid = () =>
  new GitError({
    kind: "invalid-input",
    operation: t("terminal.title"),
    message: errorText("terminal.unavailable"),
  });
export const sameTerminalOwner = (a: TerminalOwner, b: TerminalOwner) =>
  a.windowId === b.windowId &&
  a.profileId === b.profileId &&
  a.repositoryId === b.repositoryId &&
  a.cwd === b.cwd;

export class TerminalSessions {
  private sessions: Session[] = [];
  private readonly starting = new Set<TerminalOwner>();
  private readonly removing = new Set<string>();

  list(owner: TerminalOwner): TerminalTab[] {
    return this.sessions
      .filter((s) => sameTerminalOwner(s.owner, owner))
      .map(({ id, title, exit }) => ({ id, title, exit }));
  }
  busyAt(path: string) {
    return (
      this.sessions.some((s) => s.owner.cwd === path && s.exit === null) ||
      [...this.starting].some((owner) => owner.cwd === path)
    );
  }
  async whileWorktreeIdle<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (this.removing.has(path) || this.busyAt(path))
      throw new GitError({
        kind: "invalid-input",
        operation: t("worktrees.title"),
        message: errorText("worktrees.inUse"),
      });
    this.removing.add(path);
    try {
      return await operation();
    } finally {
      this.removing.delete(path);
    }
  }
  async start(owner: TerminalOwner, opts: TerminalOptions, stillOwned: () => boolean) {
    if (this.sessions.length + this.starting.size >= 24 || this.removing.has(owner.cwd))
      throw invalid();
    const pending = { ...owner };
    this.starting.add(pending);
    try {
      const [pty, xterm] = await Promise.all([import("node-pty"), import("@xterm/headless")]);
      const shell =
        opts.shell ||
        (process.platform === "win32" ? process.env["ComSpec"] : userInfo().shell) ||
        (process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh");
      if (!isAbsolute(shell) || !stillOwned() || !this.starting.has(pending)) throw invalid();
      const env = buildGitEnvironment();
      for (const key of ["GIT_TERMINAL_PROMPT", "SSH_ASKPASS_REQUIRE", "LC_ALL"]) delete env[key];
      Object.assign(env, {
        TERM: "xterm-256color",
        LANG: process.env["LANG"] || "C.UTF-8",
        ...opts.environment,
      });
      const screen = new xterm.default.Terminal({
        cols: 80,
        rows: 24,
        scrollback: opts.scrollback,
        allowProposedApi: true,
      });
      let child: IPty;
      try {
        child = pty.spawn(shell, [], {
          useConptyDll: process.platform === "win32",
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: owner.cwd,
          env,
        });
      } catch (error) {
        screen.dispose();
        throw error;
      }
      const session: Session = {
        owner,
        id: randomUUID(),
        title: basename(shell),
        process: child,
        screen,
        exit: null,
        revision: 0,
      };
      this.sessions.push(session);
      let pendingCharacters = 0;
      child.onData((data) => {
        pendingCharacters += data.length;
        if (pendingCharacters > 128 * 1024) child.pause();
        screen.write(data, () => {
          pendingCharacters -= data.length;
          session.revision++;
          if (pendingCharacters < 32 * 1024 && session.exit === null) child.resume();
        });
      });
      screen.onData((data) => {
        if (session.exit === null) child.write(data);
      });
      child.onExit(({ exitCode }) => {
        session.exit = exitCode;
        session.revision++;
      });
      return session.id;
    } finally {
      this.starting.delete(pending);
    }
  }
  private get(owner: TerminalOwner, id: string) {
    const s = this.sessions.find((s) => s.id === id && sameTerminalOwner(s.owner, owner));
    if (!s) throw invalid();
    return s;
  }
  frame(
    owner: TerminalOwner,
    id: string,
    offset: number | null,
    query: string,
    revision: number,
  ): TerminalFrame | null {
    const s = this.get(owner, id);
    if (s.revision === revision) return null;
    const buffer = s.screen.buffer.active;
    let start = offset ?? buffer.baseY;
    if (query) {
      const needle = query.toLowerCase();
      for (let i = buffer.length - 1; i >= 0; i--)
        if (buffer.getLine(i)?.translateToString(true).toLowerCase().includes(needle)) {
          start = i;
          break;
        }
    }
    start = Math.max(0, Math.min(start, buffer.baseY));
    return {
      lines: Array.from(
        { length: s.screen.rows },
        (_, i) => buffer.getLine(start + i)?.translateToString(true) ?? "",
      ),
      start,
      total: buffer.length,
      cursorX: buffer.cursorX,
      cursorY: buffer.baseY + buffer.cursorY - start,
      exit: s.exit,
      revision: s.revision,
      applicationCursor: s.screen.modes.applicationCursorKeysMode,
    };
  }
  input(owner: TerminalOwner, id: string, text: string, paste: boolean) {
    const s = this.get(owner, id);
    if (s.exit !== null) throw invalid();
    s.process.write(
      paste && s.screen.modes.bracketedPasteMode
        ? "\x1b[200~" + text.replaceAll("\x1b", "") + "\x1b[201~"
        : text,
    );
  }
  resize(owner: TerminalOwner, id: string, cols: number, rows: number) {
    const s = this.get(owner, id);
    if (s.screen.cols === cols && s.screen.rows === rows) return;
    if (s.exit === null) s.process.resize(cols, rows);
    s.screen.resize(cols, rows);
    s.revision++;
  }
  move(owner: TerminalOwner, id: string, step: number) {
    const s = this.get(owner, id);
    const items = this.sessions.filter((item) => sameTerminalOwner(item.owner, owner));
    const target = items[items.indexOf(s) + step];
    if (!target) return;
    const i = this.sessions.indexOf(s),
      j = this.sessions.indexOf(target);
    this.sessions[i] = target;
    this.sessions[j] = s;
  }
  close(owner: TerminalOwner, id: string) {
    const s = this.get(owner, id);
    this.sessions = this.sessions.filter((item) => item !== s);
    if (s.exit === null) {
      s.exit = 1;
      s.process.kill();
    }
    s.screen.dispose();
  }
  private closeMatching(matchesOwner: (owner: TerminalOwner) => boolean) {
    for (const pending of this.starting) {
      if (matchesOwner(pending)) this.starting.delete(pending);
    }
    for (const session of this.sessions) {
      if (matchesOwner(session.owner)) this.close(session.owner, session.id);
    }
  }

  forget(profileId: string, repositoryId?: string) {
    this.closeMatching(
      (owner) =>
        owner.profileId === profileId &&
        (repositoryId === undefined || owner.repositoryId === repositoryId),
    );
  }

  dispose(windowId?: number) {
    this.closeMatching((owner) => windowId === undefined || owner.windowId === windowId);
  }
}

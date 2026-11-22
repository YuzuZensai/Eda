import { WorkingFileDialog } from "../changes/WorkingFileDialog";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import { defaultTerminalOptions, type TerminalFrame } from "@shared/repository/terminal";
import {
  ButtonBase,
  IconButton,
  Input,
  StateMessage,
  TabTrigger,
  TextButton,
} from "../../components/ui/index";
import { navigateTabList } from "../../components/ui/display/TabTrigger";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  BranchIcon,
  CloseIcon,
  CopyIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  TreeIcon,
  type LucideIcon,
} from "../../components/ui/icons";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useRepositoryStore } from "../../stores/repository-store";
import { copyText } from "../../utils/clipboard";

function shellKey(e: KeyboardEvent, applicationCursor: boolean) {
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[a-z@[\\\]^_]$/i.test(e.key))
    return e.key.toLowerCase() === "v"
      ? null
      : String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 31);
  if (e.key === "Tab" && e.shiftKey) return null;
  const prefix = applicationCursor ? "\x1bO" : "\x1b[";
  const keys: Record<string, string> = {
    Enter: "\r",
    Backspace: "\x7f",
    Tab: "\t",
    Escape: "\x1b",
    ArrowUp: prefix + "A",
    ArrowDown: prefix + "B",
    ArrowRight: prefix + "C",
    ArrowLeft: prefix + "D",
    Home: prefix + "H",
    End: prefix + "F",
    Delete: "\x1b[3~",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
  };
  if (!e.ctrlKey && !e.metaKey && !e.altKey && keys[e.key]) return keys[e.key];
  if (!e.ctrlKey && !e.metaKey && e.key.length === 1) return (e.altKey ? "\x1b" : "") + e.key;
  return null;
}

function toolButton(
  label: string,
  Icon: LucideIcon,
  onClick: () => void,
  disabled?: boolean,
  pressed?: boolean,
) {
  return (
    <IconButton
      size="xs"
      aria-label={label}
      title={label}
      icon={<Icon />}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    />
  );
}

export default function TerminalSessions({
  id,
  profileId,
  onHide,
}: {
  id: string;
  profileId: string;
  onHide: () => void;
}) {
  const { terminal } = window.eda;
  const tabs = useRepositoryRead(terminal.list, id);
  const panel = useId();
  const settings = useRepositoryRead(
    (owner: string) => window.eda.settings.resolve("terminalOptions", { profileId: owner }),
    profileId,
  );
  const options = settings.value?.value ?? defaultTerminalOptions;
  const [selected, setSelected] = useState("");
  const sessions = tabs.value ?? [];
  const activeIndex = Math.max(
    0,
    sessions.findIndex((session) => session.id === selected),
  );
  const active = sessions[activeIndex]?.id;
  const [tool, setTool] = useState<"search" | "suggest" | null>(null);
  const [frame, setFrame] = useState<TerminalFrame | null>(null);
  const [filter, setFilter] = useState("");
  const query = tool === "search" ? filter : "";
  const suggest = tool === "suggest" ? filter : "";
  const [offset, setOffset] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [linkedPath, setLinkedPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const surface = useRef<HTMLDivElement>(null);
  const focusSession = useRef<string>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const branches = useRepositoryRead(
    window.eda.repository.listBranches,
    options.completion && suggest ? id : null,
  );
  const head = useRepositoryStore((s) => s.status?.branch.oid);
  useEffect(() => {
    setFrame(null);
    if (!active) return;
    let alive = true;
    let revision = -1;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await terminal.frame(id, active, offset, query, revision);
        if (!alive) return;
        if (!result.ok) {
          setError(errorMessage(result.error));
          return;
        }
        if (result.value) {
          revision = result.value.revision;
          setFrame(result.value);
          if (active === focusSession.current) {
            surface.current?.focus();
            focusSession.current = null;
          }
        }
        timer = setTimeout(() => void read(), document.hidden ? 600 : 120);
      } catch (failure) {
        if (alive) setError(errorMessage(failure));
      }
    };
    void read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, active, offset, query, terminal]);

  const check = async <T,>(work: Promise<Result<T>>) => {
    try {
      const result = await work;
      if (!result.ok) setError(errorMessage(result.error));
      else return result.value;
    } catch (failure) {
      setError(errorMessage(failure));
    }
    return undefined;
  };

  useEffect(() => {
    const element = surface.current;
    const glyph = measure.current;
    if (!active || !element || !glyph) return;
    const resize = new ResizeObserver(() => {
      const box = glyph.getBoundingClientRect();
      if (!box.width || !box.height) return;
      void check(
        terminal.resize(
          id,
          active,
          Math.min(300, Math.max(10, Math.floor(element.clientWidth / box.width))),
          Math.min(100, Math.max(3, Math.floor(element.clientHeight / box.height))),
        ),
      );
    });
    resize.observe(element);
    resize.observe(glyph);
    return () => resize.disconnect();
  }, [active, id]);

  const resetView = () => {
    setOffset(null);
    setFilter("");
    setText("");
  };
  const change = async (kind: "new" | "close" | "up" | "down") => {
    setBusy(true);
    setError("");
    try {
      if (kind === "new") {
        const created = await check(terminal.start(id));
        if (created) {
          focusSession.current = created;
          setSelected(created);
        }
      } else if (active) {
        if (kind === "close") await check(terminal.close(id, active));
        else await check(terminal.move(id, active, kind === "up" ? -1 : 1));
      }
      tabs.retry();
      resetView();
    } finally {
      setBusy(false);
    }
  };
  const input = (data: string, paste = false) => {
    if (active && data && frame?.exit === null) {
      setOffset(null);
      if (query) setFilter("");
      void check(terminal.input(id, active, data, paste));
    }
  };
  const path = text
    .trim()
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^\.\//, "");
  const loadError = tabs.error ?? settings.error;
  const loading = !loadError && (!tabs.value || !settings.value);
  const failure = error || loadError;

  const finding = tool === "search";
  const completing = options.completion && tool === "suggest";
  const live = () => {
    setTool(null);
    setFilter("");
    setOffset(null);
    surface.current?.focus();
  };
  const toggleTool = (next: "search" | "suggest") => {
    if (tool === next) live();
    else {
      setTool(next);
      setFilter("");
      if (finding) setOffset(null);
    }
  };
  const searchLabel = t("terminal.search");
  const completionLabel = t("terminal.suggest");
  const toolLabel = finding ? searchLabel : completionLabel;
  const sessionsLabel = t("terminal.sessions");

  return (
    <div className="terminal-sessions">
      <div
        className="terminal-main"
        id={panel}
        role={active ? "tabpanel" : undefined}
        aria-labelledby={active ? `${panel}-${active}` : undefined}
      >
        {active && (
          <div className="terminal-tools">
            {(finding || completing) && (
              <Input
                key={tool}
                autoFocus
                size="sm"
                aria-label={toolLabel}
                placeholder={toolLabel}
                maxLength={200}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  live();
                }}
              />
            )}
            {toolButton(searchLabel, SearchIcon, () => toggleTool("search"), false, finding)}
            {options.completion &&
              toolButton(
                completionLabel,
                BranchIcon,
                () => toggleTool("suggest"),
                false,
                completing,
              )}
            {toolButton(t("terminal.live"), ArrowDownToLineIcon, live, !query && offset === null)}
            {toolButton(
              t("terminal.copy"),
              CopyIcon,
              () => void copyText(text).catch((failure) => setError(errorMessage(failure))),
              !text,
            )}
            {toolButton(
              t("terminal.inspect"),
              TreeIcon,
              () => {
                if (!head) return;
                useRepositoryStore.setState({ contentView: { kind: "tree", oid: head, path } });
                onHide();
              },
              !head || !path || path.length > 4096 || /[\r\n]/.test(path),
            )}
          </div>
        )}
        {completing && suggest && (
          <div className="terminal-suggestions">
            {[
              "git status",
              "git diff",
              "git log",
              "git switch",
              "--oneline",
              "--stat",
              "--staged",
              "--all",
              ...(branches.value ?? []).map((branch) => branch.name),
            ]
              .filter((item) => item.startsWith(suggest))
              .slice(0, 12)
              .map((item) => (
                <TextButton
                  key={item}
                  onClick={() => {
                    input(item, true);
                    live();
                  }}
                >
                  {item}
                </TextButton>
              ))}
          </div>
        )}

        {failure && (
          <p className="terminal-error" role="alert">
            {failure}
          </p>
        )}
        {!active && !failure && (
          <StateMessage
            className="grow"
            tone={loading ? "loading" : "empty"}
            title={t(loading ? "terminal.loading" : "terminal.empty")}
          />
        )}
        {active && (
          <div
            ref={surface}
            tabIndex={0}
            role="textbox"
            aria-label={t("terminal.input")}
            aria-multiline="true"
            className="terminal-output selectable"
            style={{
              fontFamily: options.font,
              fontSize: options.size,
            }}
            onMouseUp={() => setText(window.getSelection()?.toString() ?? "")}
            onWheel={(e) => setOffset(Math.max(0, (frame?.start ?? 0) + Math.sign(e.deltaY) * 3))}
            onPaste={(e) => {
              e.preventDefault();
              input(e.clipboardData.getData("text/plain"), true);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              const data = shellKey(e, frame?.applicationCursor ?? false);
              if (data) {
                e.preventDefault();
                e.stopPropagation();
                input(data);
              }
            }}
            onCompositionEnd={(e) => input(e.data)}
          >
            <span ref={measure} aria-hidden="true" className="invisible absolute">
              M
            </span>
            {frame?.lines.map((line, index) => (
              <div key={frame.start + index}>
                {options.completion
                  ? line
                      .split(/((?:[\w.-]+\/)+[\w.-]+\.[\w-]+(?::\d+(?::\d+)?)?)/g)
                      .map((part, i) =>
                        i % 2 ? (
                          <ButtonBase
                            key={i}
                            className="underline decoration-dotted"
                            onClick={() => setLinkedPath(part.replace(/:\d+(?::\d+)?$/, ""))}
                          >
                            {part}
                          </ButtonBase>
                        ) : (
                          part
                        ),
                      )
                  : line}
              </div>
            ))}
            {frame?.exit === null && frame.cursorY >= 0 && frame.cursorY < frame.lines.length && (
              <span
                aria-hidden="true"
                className="terminal-cursor"
                data-shape={options.cursor}
                style={{
                  left: frame.cursorX + "ch",
                  top: frame.cursorY * 1.35 + "em",
                }}
              />
            )}
          </div>
        )}
        {frame && frame.exit !== null && (
          <p role="status" className="terminal-exit">
            {t("terminal.exit", { code: frame.exit })}
          </p>
        )}
      </div>

      <aside className="terminal-sidebar">
        <div className="terminal-session-tools">
          <span>{sessionsLabel}</span>
          {toolButton(
            t("terminal.new"),
            PlusIcon,
            () => void change("new"),
            busy || loading || !!loadError,
          )}
        </div>
        {sessions.length > 0 && (
          <div
            className="terminal-session-list"
            role="tablist"
            aria-label={sessionsLabel}
            aria-orientation="vertical"
            onKeyDown={navigateTabList}
          >
            {sessions.map((session, index) => (
              <TabTrigger
                key={session.id}
                id={`${panel}-${session.id}`}
                aria-controls={panel}
                selected={active === session.id}
                indicator={false}
                tabIndex={active === session.id ? 0 : -1}
                onClick={() => {
                  setSelected(session.id);
                  resetView();
                }}
              >
                <MonitorIcon aria-hidden="true" />
                <span>
                  {index + 1} · {session.title}
                </span>
              </TabTrigger>
            ))}
          </div>
        )}
        {active && (
          <div className="terminal-session-tools">
            {toolButton(
              t("terminal.previous"),
              ArrowUpIcon,
              () => void change("up"),
              busy || activeIndex === 0,
            )}
            {toolButton(
              t("terminal.next"),
              ArrowDownIcon,
              () => void change("down"),
              busy || activeIndex === sessions.length - 1,
            )}
            {toolButton(t("terminal.close"), CloseIcon, () => void change("close"), busy)}
          </div>
        )}
      </aside>

      {linkedPath && (
        <WorkingFileDialog id={id} initialPath={linkedPath} onClose={() => setLinkedPath("")} />
      )}
    </div>
  );
}

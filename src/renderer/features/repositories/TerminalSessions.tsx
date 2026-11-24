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
  PlusIcon,
  SearchIcon,
  TreeIcon,
  type LucideIcon,
} from "../../components/ui/icons";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useRepositoryStore } from "../../stores/repository-store";
import { copyText } from "../../utils/clipboard";

function shellKey(e: KeyboardEvent, applicationCursor: boolean) {
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[a-z@[\\\]^_]$/i.test(e.key)) {
    const key = e.key.toUpperCase();
    return key === "V" ? null : String.fromCharCode(key.charCodeAt(0) & 31);
  }
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
  const ready = !!(tabs.value && settings.value);
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
  const finding = tool === "search";
  const completing = options.completion && tool === "suggest";
  const query = finding ? filter : "";
  const suggest = completing ? filter : "";
  const [offset, setOffset] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [linkedPath, setLinkedPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changing = useRef(false);
  const handledOpening = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const focusSession = useRef<string>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const branches = useRepositoryRead(window.eda.repository.listBranches, suggest ? id : null);
  const head = useRepositoryStore((s) => s.status?.branch.oid);

  const check = async <T,>(
    work: () => Promise<Result<T>>,
    onError: (message: string) => void = setError,
  ) => {
    try {
      const result = await work();
      if (result.ok) return result.value;
      onError(errorMessage(result.error));
    } catch (failure) {
      onError(errorMessage(failure));
    }
    return undefined;
  };

  useEffect(() => {
    setFrame(null);
    if (!active) return;
    let alive = true;
    let revision = -1;
    let timer: ReturnType<typeof setTimeout>;
    const onError = (message: string) => {
      if (alive) setError(message);
    };
    const read = async () => {
      const result = await check(
        () => terminal.frame(id, active, offset, query, revision),
        onError,
      );
      if (!alive || result === undefined) return;
      if (result) {
        revision = result.revision;
        setFrame(result);
        if (active === focusSession.current) {
          surface.current?.focus();
          focusSession.current = null;
        }
      }
      timer = setTimeout(() => void read(), document.hidden ? 600 : 120);
    };
    void read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, active, offset, query, terminal]);

  useEffect(() => {
    const element = surface.current;
    const glyph = measure.current;
    if (!active || !element || !glyph) return;
    const resize = new ResizeObserver(() => {
      const box = glyph.getBoundingClientRect();
      if (!box.width || !box.height) return;
      void check(() =>
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
  const change = async (kind: "new" | "close" | -1 | 1, target = active) => {
    if (changing.current) return;
    changing.current = true;
    handledOpening.current = true;
    setBusy(true);
    setError("");

    if (kind === "new") {
      const created = await check(() => terminal.start(id));
      if (created) {
        focusSession.current = created;
        setSelected(created);
      }
    } else if (target) {
      await check(() =>
        kind === "close" ? terminal.close(id, target) : terminal.move(id, target, kind),
      );
    }

    tabs.retry();
    if (target === active) resetView();
    changing.current = false;
    setBusy(false);
  };
  const newShell = () => void change("new");

  // React Activity runs this cleanup each time the drawer hides.
  useEffect(
    () => () => {
      handledOpening.current = false;
    },
    [],
  );

  useEffect(() => {
    if (handledOpening.current || busy || !ready) return;

    if (active) handledOpening.current = true;
    else newShell();
  }, [active, busy, ready]);

  const input = (data: string, paste = false) => {
    if (active && data && frame?.exit === null) {
      setOffset(null);
      if (query) setFilter("");
      void check(() => terminal.input(id, active, data, paste));
    }
  };
  const path = text
    .trim()
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^\.\//, "");
  const loadError = tabs.error ?? settings.error;
  const failure = error || loadError;
  const pending = busy || (!loadError && !ready);

  const toggleTool = (next: typeof tool) => {
    const selectedTool = tool === next ? null : next;
    setTool(selectedTool);
    setFilter("");
    if (!selectedTool || finding) setOffset(null);
    if (!selectedTool) surface.current?.focus();
  };
  const live = () => toggleTool(null);
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
        {suggest && (
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
            tone={pending ? "loading" : "empty"}
            title={t(pending ? "terminal.loading" : "terminal.empty")}
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
          {toolButton(t("terminal.new"), PlusIcon, newShell, pending || !!loadError)}
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
              <div key={session.id} role="presentation">
                <TabTrigger
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
                  <span>
                    {index + 1} · {session.title}
                  </span>
                </TabTrigger>
                {toolButton(
                  t("terminal.close", { number: index + 1 }),
                  CloseIcon,
                  () => void change("close", session.id),
                  busy,
                )}
              </div>
            ))}
          </div>
        )}
        {active && (
          <div className="terminal-session-tools">
            {toolButton(
              t("terminal.previous"),
              ArrowUpIcon,
              () => void change(-1),
              busy || activeIndex === 0,
            )}
            {toolButton(
              t("terminal.next"),
              ArrowDownIcon,
              () => void change(1),
              busy || activeIndex === sessions.length - 1,
            )}
          </div>
        )}
      </aside>

      {linkedPath && (
        <WorkingFileDialog id={id} initialPath={linkedPath} onClose={() => setLinkedPath("")} />
      )}
    </div>
  );
}

import { WorkingFileDialog } from "../changes/WorkingFileDialog";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  defaultTerminalOptions,
  isTerminalOptions,
  type TerminalFrame,
  type TerminalOptions,
} from "@shared/repository/terminal";
import {
  ButtonBase,
  Checkbox,
  Dialog,
  Disclosure,
  Field,
  Input,
  Select,
  StateMessage,
  Textarea,
  TextButton,
} from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useRepositoryStore } from "../../stores/repository-store";
import { copyText } from "../../utils/clipboard";

function TerminalSettings({
  options,
  profileId,
  onSave,
}: {
  options: TerminalOptions;
  profileId: string;
  onSave: () => void;
}) {
  const [draft, set] = useState(options);
  const [environment, setEnvironment] = useState(
    Object.entries(options.environment)
      .map(([k, v]) => k + "=" + v)
      .join("\n"),
  );
  const [error, setError] = useState("");
  const save = async () => {
    const entries = environment.split("\n").filter(Boolean);
    const env: Record<string, string> = {};
    for (const entry of entries) {
      const i = entry.indexOf("=");
      if (i < 1) {
        setError(t("terminal.invalidSettings"));
        return;
      }
      env[entry.slice(0, i)] = entry.slice(i + 1);
    }
    const value = { ...draft, environment: env };
    if (!isTerminalOptions(value)) {
      setError(t("terminal.invalidSettings"));
      return;
    }
    try {
      const result = await window.eda.settings.set(
        "terminalOptions",
        { kind: "profile", profileId },
        value,
      );
      if (result.ok) {
        setError("");
        onSave();
      } else setError(errorMessage(result.error));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  return (
    <Disclosure title={t("terminal.settings")}>
      <div className="space-y-2">
        {(["shell", "font", "size", "scrollback"] as const).map((k) => (
          <Field key={k} label={t(`terminal.${k}`)}>
            {(field) => (
              <Input
                {...field}
                type={k === "size" || k === "scrollback" ? "number" : "text"}
                value={draft[k]}
                onChange={(e) =>
                  set({
                    ...draft,
                    [k]:
                      k === "size" || k === "scrollback" ? Number(e.target.value) : e.target.value,
                  })
                }
              />
            )}
          </Field>
        ))}
        <Field label={t("terminal.cursor")}>
          {(field) => (
            <Select
              {...field}
              value={draft.cursor}
              onValueChange={(cursor) => {
                if (cursor === "bar" || cursor === "block" || cursor === "underline")
                  set({ ...draft, cursor });
              }}
            >
              {(["bar", "block", "underline"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`terminal.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Checkbox
          checked={draft.completion}
          onChange={(e) => set({ ...draft, completion: e.target.checked })}
        >
          {t("terminal.completion")}
        </Checkbox>
        <Field label={t("terminal.env")}>
          {(field) => (
            <Textarea
              {...field}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          )}
        </Field>
        <TextButton onClick={() => void save()}>{t("common.save")}</TextButton>
        {error && <p role="alert">{error}</p>}
      </div>
    </Disclosure>
  );
}

function shellKey(e: KeyboardEvent, applicationCursor: boolean) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return null;
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[a-z@[\\\]^_]$/i.test(e.key))
    return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 31);
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

export function TerminalDialog({
  id,
  profileId,
  onClose,
}: {
  id: string;
  profileId: string;
  onClose: () => void;
}) {
  const tabs = useRepositoryRead(window.eda.terminal.list, id);
  const settings = useRepositoryRead(
    (owner: string) => window.eda.settings.resolve("terminalOptions", { profileId: owner }),
    profileId,
  );
  const options = settings.value?.value ?? defaultTerminalOptions;
  const [selected, setSelected] = useState("");
  const active = tabs.value?.find((s) => s.id === selected)?.id ?? tabs.value?.[0]?.id;
  const [frame, setFrame] = useState<TerminalFrame | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [linkedPath, setLinkedPath] = useState("");
  const [suggest, setSuggest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const surface = useRef<HTMLDivElement>(null);
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
        const result = await window.eda.terminal.frame(id, active, offset, query, revision);
        if (!alive) return;
        if (!result.ok) {
          setError(errorMessage(result.error));
          return;
        }
        if (result.value) {
          revision = result.value.revision;
          setFrame(result.value);
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
  }, [id, active, offset, query]);
  useEffect(() => {
    const element = surface.current;
    const glyph = measure.current;
    if (!active || !element || !glyph) return;
    const resize = new ResizeObserver(() => {
      const box = glyph.getBoundingClientRect();
      if (!box.width || !box.height) return;
      void window.eda.terminal
        .resize(
          id,
          active,
          Math.min(300, Math.max(10, Math.floor(element.clientWidth / box.width))),
          Math.min(100, Math.max(3, Math.floor(element.clientHeight / box.height))),
        )
        .then((result) => {
          if (!result.ok) setError(errorMessage(result.error));
        })
        .catch((f) => setError(errorMessage(f)));
    });
    resize.observe(element);
    resize.observe(glyph);
    return () => resize.disconnect();
  }, [active, id]);
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
  const change = async (kind: "new" | "close" | "left" | "right") => {
    setBusy(true);
    setError("");
    try {
      if (kind === "new") {
        const created = await check(window.eda.terminal.start(id));
        if (created) setSelected(created);
      } else if (active) {
        if (kind === "close") await check(window.eda.terminal.close(id, active));
        else await check(window.eda.terminal.move(id, active, kind === "left" ? -1 : 1));
      }
      tabs.retry();
      setOffset(null);
      setQuery("");
      setText("");
    } finally {
      setBusy(false);
    }
  };
  const input = (data: string, paste = false) => {
    if (active && data && frame?.exit === null) {
      setOffset(null);
      setQuery("");
      void check(window.eda.terminal.input(id, active, data, paste));
    }
  };
  const path = text
    .trim()
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^\.\//, "");
  return (
    <Dialog title={t("terminal.title")} wide busy={busy} onClose={onClose}>
      <p className="text-xs text-text-secondary">{t("terminal.notice")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {tabs.value?.map((tab, i) => (
          <TextButton
            key={tab.id}
            aria-pressed={active === tab.id}
            onClick={() => {
              setSelected(tab.id);
              setOffset(null);
              setText("");
              setQuery("");
            }}
          >
            {i + 1} · {tab.title}
          </TextButton>
        ))}
        <TextButton disabled={busy || !settings.value} onClick={() => void change("new")}>
          {t("terminal.new")}
        </TextButton>
        {active && (
          <>
            <TextButton disabled={busy} onClick={() => void change("left")}>
              {t("terminal.previous")}
            </TextButton>
            <TextButton disabled={busy} onClick={() => void change("right")}>
              {t("terminal.next")}
            </TextButton>
            <TextButton disabled={busy} onClick={() => void change("close")}>
              {t("terminal.close")}
            </TextButton>
          </>
        )}
      </div>
      {(error || tabs.error || settings.error) && (
        <StateMessage tone="error" title={error || tabs.error || settings.error || ""} />
      )}
      {active && (
        <>
          <div
            ref={surface}
            tabIndex={0}
            role="textbox"
            aria-label={t("terminal.input")}
            aria-multiline="true"
            className="selectable relative h-80 overflow-hidden bg-bg-inset outline-offset-2"
            style={{
              fontFamily: options.font,
              fontSize: options.size,
              lineHeight: 1.35,
              whiteSpace: "pre",
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
              <div key={frame.start + index} style={{ height: "1.35em" }}>
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
                style={{
                  position: "absolute",
                  pointerEvents: "none",
                  left: frame.cursorX + "ch",
                  top: (frame.cursorY + (options.cursor === "underline" ? 0.92 : 0)) * 1.35 + "em",
                  width: options.cursor === "bar" ? "2px" : "1ch",
                  height: options.cursor === "underline" ? "2px" : "1.35em",
                  backgroundColor: "currentColor",
                  opacity: 0.5,
                }}
              />
            )}
          </div>
          {frame && frame.exit !== null && (
            <p role="status">{t("terminal.exit", { code: frame.exit })}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label={t("terminal.search")}
              placeholder={t("terminal.search")}
              maxLength={200}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <TextButton
              onClick={() => {
                setQuery("");
                setOffset(null);
                surface.current?.focus();
              }}
            >
              {t("terminal.live")}
            </TextButton>
            <TextButton
              disabled={!text}
              onClick={() => void copyText(text).catch((f) => setError(errorMessage(f)))}
            >
              {t("terminal.copy")}
            </TextButton>
            <TextButton
              disabled={!head || !path || path.length > 4096 || /[\r\n]/.test(path)}
              onClick={() => {
                if (head) {
                  useRepositoryStore.setState({ contentView: { kind: "tree", oid: head, path } });
                  onClose();
                }
              }}
            >
              {t("terminal.inspect")}
            </TextButton>
          </div>
          {options.completion && (
            <Field label={t("terminal.suggest")}>
              {(field) => (
                <>
                  <Input {...field} value={suggest} onChange={(e) => setSuggest(e.target.value)} />
                  {suggest &&
                    [
                      "git status",
                      "git diff",
                      "git log",
                      "git switch",
                      "--oneline",
                      "--stat",
                      "--staged",
                      "--all",
                      ...(branches.value ?? []).map((b) => b.name),
                    ]
                      .filter((item) => item.startsWith(suggest))
                      .slice(0, 12)
                      .map((item) => (
                        <TextButton
                          key={item}
                          onClick={() => {
                            input(item, true);
                            setSuggest("");
                            surface.current?.focus();
                          }}
                        >
                          {item}
                        </TextButton>
                      ))}
                </>
              )}
            </Field>
          )}
        </>
      )}
      {linkedPath && (
        <WorkingFileDialog id={id} initialPath={linkedPath} onClose={() => setLinkedPath("")} />
      )}
      {settings.value && (
        <TerminalSettings options={options} profileId={profileId} onSave={settings.retry} />
      )}
    </Dialog>
  );
}

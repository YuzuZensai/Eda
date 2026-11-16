import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExternalLinkButton } from "@renderer/components/ui/actions/ExternalLinkButton";
import { HeartIcon, StarIcon } from "@renderer/components/ui/icons";
import { ACTION_FEEDBACK } from "@renderer/motion";
import { ok } from "@shared/errors";

let root: Root;
let container: HTMLDivElement;
const copyText = vi.fn();
const href = "https://example.test/repository";
const button = () => container.querySelector("button")!;
const glyph = (name: string) => container.querySelector(`.ui-action-visible .lucide-${name}`);
const key = (type: "keydown" | "keyup", modifier: "Meta" | "Control", held: boolean) =>
  act(async () => {
    window.dispatchEvent(
      new KeyboardEvent(type, {
        key: modifier,
        metaKey: modifier === "Meta" && held,
        ctrlKey: modifier === "Control" && held,
      }),
    );
  });
const click = (modifiers: MouseEventInit = {}) =>
  act(async () => {
    button().dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }),
    );
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { app: { platform: "linux", copyText } });
  copyText.mockReset().mockResolvedValue(ok(undefined));
  vi.spyOn(window, "open").mockReturnValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ["mac", "Meta"],
  ["windows", "Control"],
  ["linux", "Control"],
] as const)(
  "opens normally and copies with %s's %s modifier without changing text or focus",
  async (platform, modifier) => {
    vi.stubGlobal("eda", { app: { platform, copyText } });
    await act(async () =>
      root.render(<ExternalLinkButton href={href}>Website</ExternalLinkButton>),
    );
    const original = button();
    original.focus();

    await click();
    expect(window.open).toHaveBeenCalledExactlyOnceWith(href, "_blank", "noopener,noreferrer");
    expect(copyText).not.toHaveBeenCalled();
    expect(glyph("external-link")).not.toBeNull();

    await key("keydown", modifier, true);
    expect(button()).toBe(original);
    expect(document.activeElement).toBe(original);
    expect(button().textContent).toBe("Website");
    expect(button().title).toBe("Copy URL");
    expect(glyph("copy")).not.toBeNull();
    expect(glyph("external-link")).toBeNull();

    await click({ metaKey: platform === "mac", ctrlKey: platform !== "mac" });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(href);
    expect(window.open).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending));
    expect(glyph("check")).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.outcomeHold));
    await key("keyup", modifier, false);
    expect(button().textContent).toBe("Website");
    expect(glyph("external-link")).not.toBeNull();
  },
);

it.each([
  ["Sponsor on GitHub", HeartIcon, "heart"],
  ["Star the repo", StarIcon, "star"],
] as const)("changes only the external-link arrow on %s", async (label, Icon, name) => {
  await act(async () =>
    root.render(
      <ExternalLinkButton href={href} trailingIcon icon={<Icon size={16} />}>
        {label}
      </ExternalLinkButton>,
    ),
  );
  const leading = button().querySelector(`.lucide-${name}`);
  expect(leading).not.toBeNull();
  expect(button().lastElementChild?.querySelector(".lucide-external-link")).not.toBeNull();

  await key("keydown", "Control", true);
  expect(button().querySelector(`.lucide-${name}`)).toBe(leading);
  expect(button().textContent).toBe(label);
  expect(
    button().lastElementChild?.querySelector(".ui-action-visible .lucide-copy"),
  ).not.toBeNull();
  expect(glyph("external-link")).toBeNull();

  await key("keyup", "Control", false);
  expect(glyph("external-link")).not.toBeNull();
});

it.each(["Enter", " "])(
  "copies with the platform modifier and %j using keyboard activation",
  async (activationKey) => {
    vi.stubGlobal("eda", { app: { platform: "mac", copyText } });
    await act(async () =>
      root.render(<ExternalLinkButton href={href}>Website</ExternalLinkButton>),
    );
    await key("keydown", "Meta", true);
    await act(async () => {
      button().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: activationKey,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(href);
    expect(window.open).not.toHaveBeenCalled();
  },
);

it("uses click modifiers even if the key was pressed before mounting, and reports copy failure", async () => {
  copyText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await act(async () => root.render(<ExternalLinkButton href={href}>Website</ExternalLinkButton>));
  await click({ ctrlKey: true });
  await act(async () => vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending));
  expect(glyph("x")).not.toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("failed");
  expect(window.open).not.toHaveBeenCalled();

  await click({ ctrlKey: true });
  await act(async () => vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending));
  expect(glyph("check")).not.toBeNull();
  expect(copyText).toHaveBeenCalledTimes(2);
});

it("resets the copy icon after losing focus or becoming hidden", async () => {
  await act(async () => root.render(<ExternalLinkButton href={href}>Website</ExternalLinkButton>));
  await key("keydown", "Control", true);
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(glyph("external-link")).not.toBeNull();

  await key("keydown", "Control", true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(glyph("external-link")).not.toBeNull();
  await click();
  expect(window.open).toHaveBeenCalledOnce();
});

it("uses guarded callbacks for protected URLs and honors prevented and disabled actions", async () => {
  const onOpen = vi.fn();
  const onCopy = vi.fn(async () => true);
  const render = (disabled = false, prevent = false) =>
    act(async () =>
      root.render(
        <ExternalLinkButton
          onOpen={onOpen}
          onCopy={onCopy}
          disabled={disabled}
          onClick={(event) => {
            if (prevent) event.preventDefault();
          }}
        >
          Open GitLab
        </ExternalLinkButton>,
      ),
    );
  await render();
  await click();
  expect(onOpen).toHaveBeenCalledOnce();
  await click({ ctrlKey: true });
  await act(async () => vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending));
  expect(onCopy).toHaveBeenCalledOnce();
  expect(copyText).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();

  await render(false, true);
  await click({ ctrlKey: true });
  await render(true);
  await act(async () => button().click());
  expect(onCopy).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledOnce();
});

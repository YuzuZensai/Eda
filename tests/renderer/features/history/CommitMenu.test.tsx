import { CommitMenu } from "@renderer/features/history/CommitMenu";
import { useAppStore } from "@renderer/stores/app-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useSessionStore } from "@renderer/stores/session-store";
import { ok } from "@shared/errors";
import { emptySession } from "@shared/identity/profile-session";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const app = useAppStore.getState();
const repository = useRepositoryStore.getState();
const session = useSessionStore.getState();
let root: Root;
let host: HTMLDivElement;
const createTag = vi.fn();
const close = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { repository: { createTag } });

  useAppStore.setState({
    activeIdentity: { id: "profile" } as never,
    selectedRepositoryId: "repo",
    switchingIdentityId: null,
  });

  useRepositoryStore.setState({
    repositoryId: "repo",
    identityId: "profile",
    phase: "ready",
    writing: false,
    status: null,
    refresh: vi.fn(async () => {}),
  });

  useSessionStore.setState({
    transitioning: false,
    snapshot: {
      context: { profileId: "profile", windowId: "window", generation: 1 },
      session: emptySession(),
      drafts: {},
      recovery: null,
    },
  });

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAppStore.setState(app, true);
  useRepositoryStore.setState(repository, true);
  useSessionStore.setState(session, true);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("uses the same signed-tag validation for Enter and clicks and ignores repeated submissions", async () => {
  let finish!: () => void;

  createTag.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(ok(undefined));
      }),
  );

  await act(async () =>
    root.render(
      <CommitMenu
        target={{ oid: "a".repeat(40), x: 20, y: 20 }}
        initialMode="tag"
        onClose={close}
      />,
    ),
  );

  const name = document.querySelector<HTMLInputElement>('input[aria-label="Tag name"]')!;
  const message = document.querySelector<HTMLTextAreaElement>("textarea")!;

  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === "Create tag",
  )!;

  const enter = () =>
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  await fill(name, "release");

  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );

  expect(button.disabled).toBe(true);

  await act(async () => {
    enter();
    button.click();
  });

  expect(createTag).not.toHaveBeenCalled();

  await fill(message, "Release annotation");
  expect(button.disabled).toBe(false);

  await act(async () => {
    enter();
    enter();
    button.click();
  });

  expect(createTag).toHaveBeenCalledExactlyOnceWith({
    repositoryId: "repo",
    name: "release",
    target: "a".repeat(40),
    message: "Release annotation",
    sign: true,
  });

  await act(async () => finish());
  expect(close).toHaveBeenCalledOnce();
});

it("exports the right-clicked commit even when a different commit is selected", async () => {
  const exportPatch = vi.fn(async () => ok(true));
  vi.stubGlobal("eda", { repository: { exportPatch } });
  useRepositoryStore.setState({ selection: { kind: "commit", oid: "a".repeat(40) } });
  const oid = "b".repeat(40);
  await act(async () => root.render(<CommitMenu target={{ oid, x: 20, y: 20 }} onClose={close} />));
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === "Export commit patch",
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
  expect(exportPatch).toHaveBeenCalledExactlyOnceWith({ repositoryId: "repo", oid });
  expect(close).toHaveBeenCalledOnce();
});

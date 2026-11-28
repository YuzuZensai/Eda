import { fillInput, setInputValue } from "../../../helpers/form-controls";
import { errorFixture } from "../../../helpers/error";
import { ok, type Result } from "@shared/errors";
import { deferred } from "../../../helpers/deferred";
import type { CommitInspection } from "@shared/repository/repository-read";
import { emptyDraft, emptySession } from "@shared/identity/profile-session";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommitBox } from "@renderer/features/changes/CommitBox";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useSessionStore } from "@renderer/stores/session-store";
import { useAppStore } from "@renderer/stores/app-store";

const oid = "a".repeat(40);
const app = useAppStore.getState();
const session = useSessionStore.getState();
const repository = useRepositoryStore.getState();
const preferences = usePreferencesStore.getState();
let container: HTMLDivElement;
let root: Root;

const render = () => act(async () => root.render(<CommitBox />));
const draft = () => useSessionStore.getState().snapshot!.drafts["repo"]!;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === name || button.getAttribute("aria-label") === name,
  )!;
const setDraft = (patch: Partial<ReturnType<typeof emptyDraft>>) =>
  useSessionStore.getState().setDraft("repo", { ...draft(), ...patch });
const rebindSession = () => {
  const snapshot = useSessionStore.getState().snapshot!;
  useSessionStore.setState({ snapshot: { ...snapshot, context: { ...snapshot.context } } });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", {
    sessions: { change: vi.fn(async () => ok(undefined)) },
    repository: {
      previewCommit: vi.fn(async () => ({
        ok: false,
        error: errorFixture({ message: "Unavailable" }),
      })),
      inspectCommit: vi.fn(),
      commitTemplate: vi.fn(),
    },
    remotes: { inspect: vi.fn(async () => ok({ branches: [], remotes: [] })) },
  });
  useAppStore.setState({
    selectedRepositoryId: "repo",
    activeIdentity: {
      id: "profile",
      name: "Work",
      gitName: "Yuzu",
      gitEmail: "yuzu@example.test",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "",
      updatedAt: "",
    },
  });
  useRepositoryStore.setState({
    repositoryId: "repo",
    identityId: "profile",
    phase: "ready",
    writing: false,
    status: {
      branch: { head: "main", oid, ahead: 0, behind: 0, detached: false, unborn: false },
      changes: [],
    },
  });
  useSessionStore.setState({
    transitioning: false,
    snapshot: {
      context: { profileId: "profile", windowId: "window", generation: 1 },
      session: { ...emptySession(), tabs: ["repo"], selectedRepositoryId: "repo" },
      recovery: null,
      drafts: { repo: { ...emptyDraft(), message: "Existing draft", signOff: true } },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await session.flush();
  useRepositoryStore.setState(repository);
  useSessionStore.setState(session);
  useAppStore.setState(app);
  usePreferencesStore.setState(preferences);
  vi.unstubAllGlobals();
});

it.each([
  "load",
  "title-only",
  "edit",
  "cancel",
  "repository",
  "session",
  "error",
  "edit then error",
  "rejected",
])("loads the previous commit for amend safely: %s", async (scenario) => {
  const inspection = deferred<Result<CommitInspection>>();
  const inspectCommit = vi.mocked(window.eda.repository.inspectCommit);
  inspectCommit.mockReturnValue(
    inspection.promise.then((result) => {
      if (scenario === "rejected") throw new Error("Cannot read previous commit");
      return result;
    }),
  );
  const body = scenario === "title-only" ? "" : "Details\n\nMore details\n";
  usePreferencesStore.setState({
    values: {
      ...preferences.values,
      conventionalCommitsEnabled: { ...preferences.values.conventionalCommitsEnabled, value: true },
      commitPrefixes: { ...preferences.values.commitPrefixes, value: ["feat"] },
    },
  });
  await act(async () => root.render(<CommitBox />));
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox.click());
  expect(inspectCommit).toHaveBeenCalledWith("repo", oid);
  expect(container.textContent).not.toContain("Remote-tracking refs do not prove");
  expect(container.textContent).not.toContain("Amend replaces the latest commit ID");
  const submit = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Amend commit"),
  )!;
  expect(submit.disabled).toBe(true);

  await act(async () => {
    if (scenario === "edit" || scenario === "edit then error") {
      const field = container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!;
      setInputValue(field, "Edited while loading");
    } else if (scenario === "cancel") checkbox.click();
    else if (scenario === "repository") {
      useRepositoryStore.setState({ repositoryId: "other" });
      useAppStore.setState({ selectedRepositoryId: "other" });
    } else if (scenario === "session") {
      const snapshot = useSessionStore.getState().snapshot!;
      useSessionStore.setState({
        snapshot: { ...snapshot, context: { ...snapshot.context, generation: 2 } },
      });
    }
  });
  await act(async () => {
    inspection.resolve(
      scenario.endsWith("error")
        ? { ok: false, error: errorFixture({ message: "Cannot read previous commit" }) }
        : {
            ok: true,
            value: {
              commit: {
                oid,
                subject: "feat(core)!: Previous title",
                body,
                parents: [],
                decorations: [],
                author: { name: "Yuzu", email: "yuzu@example.test", timestamp: "0" },
                committerTimestamp: "0",
              },
              containingRefs: [],
              shallow: false,
              signed: false,
              signature: {
                status: "unsigned",
                format: null,
                reasonCode: null,
                diagnostics: "",
              },
            },
          },
    );
  });

  const draft = useSessionStore.getState().snapshot!.drafts["repo"]!;
  if (scenario === "load" || scenario === "title-only") {
    expect(draft.message).toBe(`feat(core)!: Previous title${body ? `\n\n${body}` : ""}`);
    expect(draft.amend).toBe(true);
    expect(draft.signOff).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!.value).toBe(
      "Previous title",
    );
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Commit description"]')!.value,
    ).toBe(body);
    expect(submit.disabled).toBe(false);
  } else {
    expect(draft.message).toBe(
      scenario.startsWith("edit") ? "Edited while loading" : "Existing draft",
    );
    expect(draft.amend).toBe(scenario === "edit");
    if (scenario === "rejected")
      expect(document.body.textContent).toContain("Something went wrong. Please try again.");
    if (scenario.endsWith("error"))
      expect(document.body.textContent).toContain("Cannot read previous commit");
  }
});

it("applies a chosen prefix to the draft while preserving scope, breaking marker and body", async () => {
  setDraft({ message: "feat(core)!: change API\n\nDetails" });
  const save = vi.spyOn(useSessionStore.getState(), "setDraft");
  usePreferencesStore.setState({
    values: {
      ...preferences.values,
      conventionalCommitsEnabled: {
        ...preferences.values.conventionalCommitsEnabled,
        value: true,
      },
      commitPrefixes: { ...preferences.values.commitPrefixes, value: ["feat", "repair"] },
    },
  });
  await act(async () => root.render(<CommitBox />));
  expect(save).not.toHaveBeenCalled();

  const title = container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!;

  expect(title.value).toBe("change API");

  const picker = container.querySelector<HTMLButtonElement>('[aria-label="Commit prefix"]')!;

  await act(async () => picker.click());

  const search = document.querySelector<HTMLInputElement>('[aria-label="Search commit prefixes"]')!;

  await fillInput(search, "rep");
  expect(document.querySelector('[data-eda-select-value="feat"]')).toBeNull();
  expect(document.querySelector('[data-eda-select-value=""]')?.textContent).toContain("No prefix");

  const option = document.querySelector<HTMLElement>('[data-eda-select-value="repair"]')!;

  expect(option).toBeTruthy();

  await act(async () => option.click());
  expect(save).toHaveBeenCalledWith(
    "repo",
    expect.objectContaining({ message: "repair(core)!: change API\n\nDetails" }),
  );
  expect(title.value).toBe("change API");

  await act(async () => picker.click());

  const options = document.querySelectorAll("[data-eda-select-value]");

  expect(options[options.length - 1]?.getAttribute("data-eda-select-value")).toBe("");

  await act(async () =>
    (document.querySelector('[data-eda-select-value=""]') as HTMLButtonElement).click(),
  );
  expect(useSessionStore.getState().snapshot?.drafts["repo"]?.message).toBe(
    "change API\n\nDetails",
  );

  await fillInput(title, "feat: manually typed");
  expect(title.value).toBe("manually typed");
  expect(picker.textContent).toContain("feat:");
  expect(useSessionStore.getState().snapshot?.drafts["repo"]?.message).toBe(
    "feat: manually typed\n\nDetails",
  );

  await fillInput(title, "edited subject");
  expect(useSessionStore.getState().snapshot?.drafts["repo"]?.message).toBe(
    "feat: edited subject\n\nDetails",
  );

  await act(async () =>
    usePreferencesStore.setState({
      values: {
        ...usePreferencesStore.getState().values,
        commitPrefixes: { ...preferences.values.commitPrefixes, value: ["✨ feat", "🐛 fix"] },
      },
    }),
  );
  await fillInput(title, "fix: emoji subject");
  expect(title.value).toBe("emoji subject");
  expect(picker.textContent).toContain("🐛 fix:");
  expect(useSessionStore.getState().snapshot?.drafts["repo"]?.message).toBe(
    "🐛 fix: emoji subject\n\nDetails",
  );

  await act(async () =>
    usePreferencesStore.setState({
      values: {
        ...preferences.values,
        conventionalCommitsEnabled: {
          ...preferences.values.conventionalCommitsEnabled,
          value: false,
        },
      },
    }),
  );
  expect(container.querySelector('[aria-label="Commit prefix"]')).toBeNull();
});

it.each(["repository", "reopened repository", "session", "draft edit", "read-only"])(
  "cancels submission when the %s changes during draft flush",
  async (change) => {
    setDraft({ amend: true });
    await useSessionStore.getState().flush();
    const saved = deferred<boolean>();
    const flush = vi.fn(() => saved.promise);
    useSessionStore.setState({ flush });
    const commit = vi.fn(async () => true);
    useRepositoryStore.setState({ commit });
    await render();
    await act(async () => button("Amend commit").click());
    expect(flush).toHaveBeenCalled();
    await act(async () => {
      if (change === "repository") useAppStore.setState({ selectedRepositoryId: "other" });
      if (change === "reopened repository")
        useRepositoryStore.setState({ generation: repository.generation + 1 });
      if (change === "session") rebindSession();
      if (change === "draft edit") setDraft({ message: "New title" });
      if (change === "read-only") {
        const status = useRepositoryStore.getState().status!;
        useRepositoryStore.setState({
          status: { ...status, capabilities: { write: false } },
        });
      }
      saved.resolve(true);
    });
    expect(commit).not.toHaveBeenCalled();
    expect(draft().message).toBe(change === "draft edit" ? "New title" : "Existing draft");
  },
);

it.each(["session", "repository", "draft edit"])(
  "preserves the draft when the %s changes before a successful commit returns",
  async (change) => {
    setDraft({ amend: true });
    const result = deferred<boolean>();
    const commit = vi.fn(() => result.promise);
    useRepositoryStore.setState({ commit });
    await render();
    await act(async () => button("Amend and Push").click());
    expect(commit).toHaveBeenCalledOnce();
    await act(async () => {
      if (change === "session") rebindSession();
      if (change === "repository")
        useRepositoryStore.setState({ generation: repository.generation + 1 });
      if (change === "draft edit") setDraft({ message: "Next commit" });
      result.resolve(true);
    });
    expect(draft().message).toBe(change === "draft edit" ? "Next commit" : "Existing draft");
    if (change === "draft edit") expect(window.eda.remotes.inspect).toHaveBeenCalledWith("repo");
    else expect(window.eda.remotes.inspect).not.toHaveBeenCalled();
  },
);

it.each(["sign-off", "title", "session", "repository"])(
  "inserts a template only into the requested message and preserves a concurrent %s change",
  async (change) => {
    const template = deferred<Result<string | null>>();
    vi.mocked(window.eda.repository.commitTemplate).mockReturnValue(template.promise);
    await render();
    await act(async () => button("Insert Git template").click());
    expect(window.eda.repository.commitTemplate).toHaveBeenCalledWith("repo");
    await act(async () => {
      if (change === "session") rebindSession();
      if (change === "repository")
        useRepositoryStore.setState({ generation: repository.generation + 1 });
      if (change === "sign-off") setDraft({ signOff: false });
      if (change === "title") setDraft({ message: "New title" });
      template.resolve(ok("Template body"));
    });
    if (change === "sign-off")
      expect(draft()).toMatchObject({ message: "Existing draft\n\nTemplate body", signOff: false });
    else expect(draft().message).toBe(change === "title" ? "New title" : "Existing draft");
  },
);

it.each(["selection", "session selection", "profile", "loading"])(
  "disables all commit draft actions during a %s mismatch",
  async (change) => {
    setDraft({ amend: true });
    const snapshot = useSessionStore.getState().snapshot!;
    if (change === "selection") useAppStore.setState({ selectedRepositoryId: "other" });
    if (change === "session selection")
      useSessionStore.setState({
        snapshot: { ...snapshot, session: { ...snapshot.session, selectedRepositoryId: "other" } },
      });
    if (change === "profile") useRepositoryStore.setState({ identityId: "other" });
    if (change === "loading") useRepositoryStore.setState({ phase: "loading" });
    await render();
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      expect(checkbox.disabled).toBe(true);
    expect(button("Insert Git template").disabled).toBe(true);
    expect(button("Add co-author...").disabled).toBe(true);
    expect(button("Commit once without pre-commit and commit-msg hooks").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!.disabled).toBe(
      true,
    );
  },
);

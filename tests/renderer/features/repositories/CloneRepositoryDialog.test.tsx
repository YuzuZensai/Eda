import { fillInput } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deferred } from "../../../helpers/deferred";
import { ok } from "@shared/errors";
import { builtInSetting, type ResolvedSetting } from "@shared/preferences/settings";
import type { Identity } from "@shared/identity/identity";
import type { GitHubStatus } from "@shared/integrations/github";
import { CloneRepositoryDialog } from "@renderer/features/repositories/CloneRepositoryDialog";
import { useShellStore } from "@renderer/stores/shell-store";
import { useAppStore } from "@renderer/stores/app-store";

const profile: Identity = {
  id: "work",
  name: "Work",
  gitName: "Author",
  gitEmail: "work@example.com",
  hue: 210,
  signing: { format: "none", signCommits: false },
  createdAt: "now",
  updatedAt: "now",
};

const connected: GitHubStatus = {
  secureStorage: true,
  account: { id: "7", login: "work-user", state: "connected" },
};

const repositories = ["eda", "website"].map((name, index) => ({
  id: String(index),
  name,
  fullName: `team/${name}`,
  cloneUrl: `https://github.com/team/${name}.git`,
  description: null,
  private: index === 0,
  archived: false,
  updatedAt: null,
}));

let root: Root;
let container: HTMLDivElement;
let previous: ReturnType<typeof useAppStore.getState>;

const refreshRepositories = vi.fn().mockResolvedValue(undefined);
const selectRepository = vi.fn();
const onClose = vi.fn();
const clone = vi.fn().mockResolvedValue(ok({ id: "cloned" }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previous = useAppStore.getState();
  useAppStore.setState({ activeIdentity: profile, refreshRepositories, selectRepository });

  vi.stubGlobal("eda", {
    github: {
      status: vi.fn().mockResolvedValue(ok(connected)),
      repositories: vi.fn().mockResolvedValue(ok({ repositories, nextPage: null })),
    },
    gitlab: { status: vi.fn().mockResolvedValue(ok({ secureStorage: true, account: null })) },
    gitlabSelfHosted: {
      status: vi.fn().mockResolvedValue(ok({ secureStorage: true, accounts: [] })),
      repositories: vi.fn(),
    },
    remotes: { clone },
    settings: {
      resolve: vi
        .fn()
        .mockResolvedValue(ok({ ...builtInSetting("repositoryRoot"), value: "/default-repos" })),
    },
    repository: { chooseFolder: vi.fn().mockResolvedValue(ok("/repos")) },
    operations: {
      list: vi.fn().mockResolvedValue(ok([])),
      cancel: vi.fn().mockResolvedValue(ok(undefined)),
    },
    events: { onOperationsChanged: () => () => {} },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(previous, true);
  useShellStore.setState({ request: null });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const field = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;

it("uses the profile repository root for cloning and allows a different destination for one clone", async () => {
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  expect(field("Clone parent folder").value).toBe("/default-repos");
  expect(window.eda.settings.resolve).toHaveBeenCalledWith("repositoryRoot", {
    profileId: profile.id,
  });
  await act(async () => button("team/eda").click());
  await act(async () => button("Clone repository").click());
  expect(clone).toHaveBeenLastCalledWith(
    expect.objectContaining({ parent: "/default-repos", name: "eda" }),
  );

  await fillInput(field("Clone parent folder"), "/another-folder");
  await act(async () => button("Clone repository").click());
  expect(clone).toHaveBeenLastCalledWith(expect.objectContaining({ parent: "/another-folder" }));
});

it.each(["work", "home"])("loads the clone root belonging to the %s profile", async (profileId) => {
  useAppStore.setState({ activeIdentity: { ...profile, id: profileId } });
  vi.mocked(window.eda.settings.resolve).mockResolvedValueOnce(
    ok({ ...builtInSetting("repositoryRoot"), value: `/${profileId}-repos` }),
  );
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  expect(window.eda.settings.resolve).toHaveBeenCalledWith("repositoryRoot", { profileId });
  expect(field("Clone parent folder").value).toBe(`/${profileId}-repos`);
  await act(async () => button("team/eda").click());
  await act(async () => button("Clone repository").click());
  expect(clone).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId, parent: `/${profileId}-repos` }),
  );
});

it.each(["/custom-repos", ""])(
  "preserves a manually entered destination when the default loads late: %j",
  async (destination) => {
    let finish!: (value: ReturnType<typeof ok<ResolvedSetting<"repositoryRoot">>>) => void;
    vi.mocked(window.eda.settings.resolve).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
    await fillInput(field("Clone parent folder"), "/typed-first");
    await fillInput(field("Clone parent folder"), destination);
    await act(async () =>
      finish(ok({ ...builtInSetting("repositoryRoot"), value: "/default-repos" })),
    );
    expect(field("Clone parent folder").value).toBe(destination);
  },
);

it("preserves a browsed destination when the default loads late", async () => {
  let finish!: (value: ReturnType<typeof ok<ResolvedSetting<"repositoryRoot">>>) => void;
  vi.mocked(window.eda.settings.resolve).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Browse folders..."]')!.click(),
  );
  await act(async () =>
    finish(ok({ ...builtInSetting("repositoryRoot"), value: "/default-repos" })),
  );
  expect(field("Clone parent folder").value).toBe("/repos");
});

it("allows choosing a destination if the default cannot be loaded", async () => {
  vi.mocked(window.eda.settings.resolve).mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  expect(document.body.textContent).toContain("Could not read application preferences.");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Browse folders..."]')!.click(),
  );
  expect(field("Clone parent folder").value).toBe("/repos");
});

it("uses a connected account, filters repositories, suggests the folder and clones with saved authentication", async () => {
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  expect(document.querySelector('[role="combobox"]')?.textContent).toContain("GitHub");
  expect(document.body.textContent).not.toContain("Cloning into");
  await fillInput(field("Search repositories…"), "eda");
  expect(document.body.textContent).not.toContain("team/website");
  await act(async () => button("team/eda").click());
  expect(field("Clone folder name").value).toBe("eda");

  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Browse folders..."]')!.click(),
  );

  expect(field("Clone parent folder").value).toBe("/repos");
  expect(document.body.textContent).not.toContain("/repos/eda");
  expect(document.body.textContent).not.toContain("Destination path");
  await act(async () => button("Clone repository").click());

  expect(clone).toHaveBeenCalledWith({
    profileId: "work",
    url: "https://github.com/team/eda.git",
    parent: "/repos",
    name: "eda",
  });

  expect(refreshRepositories).toHaveBeenCalled();
  expect(selectRepository).toHaveBeenCalledWith("cloned");
  expect(onClose).toHaveBeenCalled();
});

it("keeps a URL being entered while connection checks finish and preserves an edited folder name", async () => {
  let finish!: (value: ReturnType<typeof ok<GitHubStatus>>) => void;

  vi.mocked(window.eda.github.status).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await fillInput(field("Repository URL"), "git@github.com:team/eda.git");
  expect(field("Clone folder name").value).toBe("eda");
  await fillInput(field("Clone folder name"), "custom-name");
  await act(async () => finish(ok(connected)));
  expect(field("Repository URL").value).toBe("git@github.com:team/eda.git");
  await fillInput(field("Repository URL"), "/local/website.git/");
  expect(field("Clone folder name").value).toBe("custom-name");
  expect(window.eda.github.repositories).not.toHaveBeenCalled();
});

async function openSelect(label: string) {
  const control = document.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`)!;

  await act(async () =>
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
}

async function choose(label: string, value: string) {
  await openSelect(label);

  await act(async () =>
    document.querySelector<HTMLElement>(`[data-eda-select-value="${value}"]`)!.click(),
  );
}

it("hides unconfigured providers and routes Add provider to Integrations", async () => {
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await openSelect("Provider");
  expect(document.querySelector('[data-eda-select-value="github"]')).not.toBeNull();
  expect(document.querySelector('[data-eda-select-value="gitlab"]')).toBeNull();
  expect(document.querySelector('[data-eda-select-value="url"]')).not.toBeNull();

  await act(async () =>
    document.querySelector<HTMLElement>('[data-eda-select-value="add"]')!.click(),
  );

  expect(onClose).toHaveBeenCalled();
  expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "integrations" });
});

it("combines name sorting, visibility filters and search without losing the selected repository", async () => {
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await act(async () => button("team/eda").click());
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
  await choose("Sort repositories", "nameDescending");

  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("website"),
    expect.stringContaining("eda"),
  ]);

  await choose("Filter repositories", "private");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.getAttribute("aria-pressed")).toBe("true");
  expect(document.body.textContent).toContain("1 of 2 loaded");
  await fillInput(field("Search repositories…"), "no-match");
  expect(rows()).toHaveLength(0);
  expect(document.body.textContent).toContain("No matching repositories");
  expect(field("Clone folder name").value).toBe("eda");
});

it("loads the next page near the scroll boundary, prevents duplicate requests, and stops at the last page", async () => {
  let intersect: (() => void) | undefined;
  const disconnect = vi.fn();

  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect = disconnect;
    },
  );

  let resolvePage!: (
    value: ReturnType<typeof ok<{ repositories: typeof repositories; nextPage: number | null }>>,
  ) => void;

  vi.mocked(window.eda.github.repositories)
    .mockResolvedValueOnce(ok({ repositories: [repositories[0]!], nextPage: 2 }))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  expect(window.eda.github.repositories).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("Load more");

  await act(async () => {
    intersect!();
    intersect!();
  });

  expect(window.eda.github.repositories).toHaveBeenCalledTimes(2);
  expect(window.eda.github.repositories).toHaveBeenLastCalledWith("work", 2);
  expect(document.body.textContent).toContain("Loading more…");
  expect(disconnect).toHaveBeenCalled();
  await act(async () => resolvePage(ok({ repositories: [repositories[1]!], nextPage: null })));
  expect(document.body.textContent).toContain("2 of 2 loaded");
  expect(document.body.textContent).not.toContain("Loading more…");
  expect(window.eda.github.repositories).toHaveBeenCalledTimes(2);
});

it("browses multiple self-hosted instances separately even when account and project IDs are identical", async () => {
  const instances = ["https://git.company.test/gitlab", "https://other.company.test"];

  vi.mocked(window.eda.gitlabSelfHosted.status).mockResolvedValue(
    ok({
      secureStorage: true,
      accounts: instances.map((baseUrl) => ({
        id: "7",
        login: "work-user",
        baseUrl,
        ignoreTlsErrors: false,
        state: "connected",
      })),
    }),
  );

  vi.mocked(window.eda.gitlabSelfHosted.repositories).mockImplementation(
    async (_profile, baseUrl) =>
      ok({
        repositories: [
          {
            ...repositories[0]!,
            id: "1",
            fullName: baseUrl === instances[0] ? "team/first" : "team/second",
            cloneUrl: `${baseUrl}/team/eda.git`,
          },
        ],
        nextPage: null,
      }),
  );

  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await choose("Provider", `gitlab-self-hosted:${instances[0]}`);

  expect(window.eda.gitlabSelfHosted.repositories).toHaveBeenLastCalledWith(
    "work",
    instances[0],
    1,
  );

  expect(document.body.textContent).toContain("team/first");
  await choose("Provider", `gitlab-self-hosted:${instances[1]}`);

  expect(window.eda.gitlabSelfHosted.repositories).toHaveBeenLastCalledWith(
    "work",
    instances[1],
    1,
  );

  expect(document.body.textContent).toContain("team/second");
  expect(document.body.textContent).not.toContain("team/first");
});

it("shows only compact cloning controls without logs or a repeated destination", async () => {
  let finish!: () => void;
  clone.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(ok({ id: "cloned" }));
      }),
  );
  vi.mocked(window.eda.operations.list).mockResolvedValue(
    ok([
      {
        id: "clone-operation",
        profileId: profile.id,
        repositoryId: "cloning",
        repositoryName: "eda",
        kind: "Clone repository",
        kindKey: "operationTitles.cloneRepository",
        state: "running",
        startedAt: "now",
        updatedAt: "now",
        durationMs: 0,
        cancellable: true,
        retryable: false,
        message: "Receiving objects",
        output: "Cloning into '/repos/eda'...",
      },
    ]),
  );
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await act(async () => button("team/eda").click());
  await fillInput(field("Clone parent folder"), "/repos");
  await act(async () => button("Clone repository").click());
  expect(field("Clone parent folder").disabled).toBe(true);
  expect(document.body.textContent).toContain("Cloning");
  expect(document.body.textContent).not.toContain("Receiving objects");
  expect(document.body.textContent).not.toContain("Cloning into");
  expect(document.body.textContent).not.toContain("Destination path");
  expect(document.body.textContent).not.toContain("/repos/eda");
  await act(async () => button("Cancel operation").click());
  expect(window.eda.operations.cancel).toHaveBeenCalledExactlyOnceWith("clone-operation");
  await act(async () => finish());
});

it("keeps the chosen repository active when a background clone completes after the clone dialog has closed", async () => {
  const completion = deferred<ReturnType<typeof ok<{ id: string }>>>();
  clone.mockReturnValueOnce(completion.promise);
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await act(async () => button("team/eda").click());
  await act(async () => button("Clone repository").click());
  await act(async () => button("Continue in background").click());
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  useAppStore.setState({ selectedRepositoryId: "different-repository" });
  await act(async () => completion.resolve(ok({ id: "cloned" })));
  expect(selectRepository).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps a repository chosen while the completed clone refreshes the list", async () => {
  const refreshed = deferred<void>();
  refreshRepositories.mockReturnValueOnce(refreshed.promise);
  await act(async () => root.render(<CloneRepositoryDialog onClose={onClose} />));
  await act(async () => button("team/eda").click());
  await act(async () => button("Clone repository").click());
  expect(refreshRepositories).toHaveBeenCalledOnce();
  useAppStore.setState({ selectedRepositoryId: "chosen" });
  await act(async () => refreshed.resolve());
  expect(selectRepository).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

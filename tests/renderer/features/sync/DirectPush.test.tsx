import { fillInput } from "../../../helpers/form-controls";
import { errorFixture } from "../../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, err, type Result } from "@shared/errors";
import { DirectPush } from "@renderer/features/sync/DirectPush";
import { useAppStore } from "@renderer/stores/app-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useShellStore } from "@renderer/stores/shell-store";
import { ACTION_FEEDBACK } from "@renderer/motion";
import { mapGitError } from "@main/git/execution/error-mapping";
import { pushErrorFixtures } from "../../../fixtures/git-errors";

let root: Root;
let container: HTMLDivElement;
const preparePush = vi.fn();
const push = vi.fn();
const inspected = {
  branches: [{ name: "main", isHead: true, upstream: "origin/main" }],
  remotes: [{ name: "origin", pushUrls: ["https://example.com/repo"] }],
};
const preview = { token: "preview", source: "refs/heads/main", destination: "refs/heads/main" };
const button = () =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === "Push")!;
const finish = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending);
  });
};

const useGitHubRemote = () => {
  vi.mocked(window.eda.remotes.inspect).mockResolvedValue(
    ok({
      branches: [
        {
          name: "main",
          isHead: true,
          remote: false,
          oid: "a".repeat(40),
          upstream: "origin/main",
          upstreamState: "",
        },
      ],
      remotes: [
        {
          name: "origin",
          fetchUrls: ["https://github.com/owner/repo.git"],
          pushUrls: ["https://github.com/owner/repo.git"],
        },
      ],
    }),
  );
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAppStore.setState({
    selectedRepositoryId: "repo",
    activeIdentity: { id: "profile" } as never,
  });
  useRepositoryStore.setState({ writing: false });
  vi.spyOn(useRepositoryStore.getState(), "syncFromDisk").mockResolvedValue();
  preparePush.mockReset().mockResolvedValue(ok(preview));
  push.mockReset().mockResolvedValue(ok("Push completed."));
  vi.stubGlobal("eda", {
    remotes: { inspect: vi.fn().mockResolvedValue(ok(inspected)), preparePush, push },
    operations: { list: vi.fn(async () => ok([])) },
    events: { onOperationsChanged: vi.fn(() => () => {}) },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<DirectPush repositoryId="repo" />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows pending then a check, resets the outcome and supports another push", async () => {
  await act(async () => button().click());
  expect(button().getAttribute("aria-busy")).toBe("true");
  expect(button().querySelector(".ui-action-visible .lucide-loader-circle")).not.toBeNull();
  await finish();
  expect(button().querySelector(".ui-action-visible .lucide-check")).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Push completed.");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.outcomeHold);
  });
  expect(button().querySelector(".ui-action-visible .lucide-arrow-up")).not.toBeNull();
  await act(async () => button().click());
  await finish();
  expect(push).toHaveBeenCalledTimes(2);
  expect(button().querySelector(".ui-action-visible .lucide-check")).not.toBeNull();
});

it.each(["protectedBranch", "hookRejected", "policyMentionsHistory", "generic"] as const)(
  "shows %s details without preparing or offering a force push",
  async (fixture) => {
    const failure = mapGitError({ operation: "push", exitCode: 1, ...pushErrorFixtures[fixture] });
    push.mockResolvedValueOnce(err(failure));

    await act(async () => button().click());
    await finish();

    expect(preparePush).toHaveBeenCalledOnce();
    expect(preparePush).toHaveBeenCalledWith(expect.objectContaining({ mode: "normal" }));
    expect(push).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Force with lease");

    await act(async () => button().click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Push failed");
    expect(dialog?.textContent).toContain(failure.message);
    expect(dialog?.textContent).toContain(failure.suggestedAction);
    expect(dialog?.textContent).not.toContain("Force with lease");
    expect(dialog?.querySelector('input[type="password"]')).toBeNull();
    expect(push).toHaveBeenCalledOnce();
  },
);

it.each(["nonFastForward", "fetchFirst"] as const)(
  "offers a reviewed force-with-lease push for %s and only pushes after confirmation",
  async (fixture) => {
    push.mockResolvedValueOnce(
      err(mapGitError({ operation: "push", exitCode: 1, ...pushErrorFixtures[fixture] })),
    );
    preparePush
      .mockResolvedValueOnce(ok(preview))
      .mockResolvedValueOnce(ok({ ...preview, token: "lease" }));

    await act(async () => button().click());
    await finish();

    expect(preparePush).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "lease" }));
    expect(push).toHaveBeenCalledOnce();
    const confirm = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "Force with lease",
    )!;
    expect(confirm).toBeDefined();

    await act(async () => confirm.click());
    await finish();
    expect(push).toHaveBeenLastCalledWith("repo", "lease", undefined);
    expect(push).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Push completed.");
  },
);

it("offers authentication recovery for mapped permission failures without preparing a force push", async () => {
  push.mockResolvedValueOnce(
    err(mapGitError({ operation: "push", exitCode: 1, ...pushErrorFixtures.permissionDenied })),
  );

  await act(async () => button().click());
  await finish();

  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("HTTPS authentication");
  expect(dialog?.querySelector('input[type="password"]')).not.toBeNull();
  expect(dialog?.textContent).not.toContain("Force with lease");
  expect(preparePush).toHaveBeenCalledOnce();
  expect(push).toHaveBeenCalledOnce();
});

it.each(["hookRejected", "staleLease"] as const)(
  "does not retry automatically when a confirmed force-with-lease push fails with %s",
  async (fixture) => {
    push.mockResolvedValueOnce(
      err(mapGitError({ operation: "push", exitCode: 1, ...pushErrorFixtures.nonFastForward })),
    );
    await act(async () => button().click());
    await finish();

    push.mockResolvedValueOnce(
      err(mapGitError({ operation: "push", exitCode: 1, ...pushErrorFixtures[fixture] })),
    );
    const confirm = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "Force with lease",
    )!;
    await act(async () => confirm.click());
    await finish();

    expect(push).toHaveBeenCalledTimes(2);
    expect(preparePush).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      fixture === "hookRejected"
        ? "The remote server rejected this push."
        : "history or lease may have changed",
    );
    if (fixture === "hookRejected")
      expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
        "Force with lease",
      );
  },
);

it.each(["preview", "push"])(
  "shows an inline X for %s failure and opens details on click",
  async (stage) => {
    (stage === "preview" ? preparePush : push).mockResolvedValueOnce(
      err(
        errorFixture({ kind: "network-failed", operation: "push", message: "Network unavailable" }),
      ),
    );
    await act(async () => button().click());
    await finish();
    expect(button().querySelector(".ui-action-visible .lucide-x")).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button().click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Network unavailable");
    expect(preparePush).toHaveBeenCalledOnce();
  },
);

it.each([
  ["preview", "github-auth-required"],
  ["push", "github-auth-required"],
  ["preview", "github-access-required"],
  ["push", "github-access-required"],
] as const)(
  "keeps manual HTTPS authentication available for GitHub %s failures: %s",
  async (stage, kind) => {
    useGitHubRemote();
    (stage === "preview" ? preparePush : push).mockResolvedValueOnce(
      err(errorFixture({ kind, operation: "push", message: "GitHub connection required" })),
    );

    await act(async () => button().click());
    await finish();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("HTTPS authentication");
    expect(dialog?.textContent).toContain("This is a GitHub remote.");
    expect(dialog?.textContent).toContain("Use GitHub integration");
    expect(dialog?.querySelector('input[type="password"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    const fields = dialog!.querySelectorAll("input");
    const values = ["manual-user", "manual-token"];
    expect(fields).toHaveLength(values.length);
    for (const [index, value] of values.entries()) await fillInput(fields.item(index), value);

    const retry = [...dialog!.querySelectorAll("button")].find(
      (item) => item.textContent === "Retry push",
    )!;
    await act(async () => retry.click());
    await finish();
    expect(preparePush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credentials: { username: "manual-user", password: "manual-token" },
      }),
    );
    expect(push).toHaveBeenLastCalledWith("repo", "preview", {
      username: "manual-user",
      password: "manual-token",
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Push completed.");
  },
);

it("opens GitHub settings only when the user chooses the integration", async () => {
  useGitHubRemote();
  const settings = vi.spyOn(useShellStore.getState(), "openSettings").mockImplementation(() => {});
  preparePush.mockResolvedValueOnce(
    err(
      errorFixture({
        kind: "github-auth-required",
        message: "GitHub connection required",
      }),
    ),
  );

  await act(async () => button().click());
  await finish();
  expect(settings).not.toHaveBeenCalled();

  const integration = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === "Use GitHub integration",
  )!;
  await act(async () => integration.click());
  expect(settings).toHaveBeenCalledExactlyOnceWith("integrations");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(push).not.toHaveBeenCalled();
});

it("does not offer GitHub integration for other HTTPS remotes", async () => {
  preparePush.mockResolvedValueOnce(
    err(errorFixture({ kind: "auth-failed", message: "Authentication failed" })),
  );
  await act(async () => button().click());
  await finish();

  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("HTTPS authentication");
  expect(dialog?.querySelector('input[type="password"]')).not.toBeNull();
  expect(dialog?.textContent).not.toContain("GitHub");
});

it("closes a consumed force-push preview before requesting HTTPS credentials", async () => {
  push.mockResolvedValueOnce(
    err(errorFixture({ kind: "non-fast-forward", message: "Remote history changed" })),
  );
  await act(async () => button().click());
  await finish();

  push.mockResolvedValueOnce(
    err(errorFixture({ kind: "github-auth-required", message: "GitHub connection required" })),
  );
  const confirm = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === "Force with lease",
  )!;

  await act(async () => confirm.click());
  await finish();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("HTTPS authentication");
  expect(document.querySelector('[role="dialog"] input[type="password"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Force with lease");
});

it("pushes to the most specific upstream remote when configured names overlap", async () => {
  vi.mocked(window.eda.remotes.inspect).mockResolvedValueOnce(
    ok({
      branches: [
        {
          name: "main",
          isHead: true,
          remote: false,
          oid: "a".repeat(40),
          upstreamState: "",
          upstream: "team/fork/release",
        },
      ],
      remotes: [
        { name: "team", fetchUrls: [], pushUrls: [] },
        { name: "team/fork", fetchUrls: [], pushUrls: [] },
      ],
    }),
  );
  await act(async () => button().click());
  await finish();
  expect(preparePush).toHaveBeenCalledWith(
    expect.objectContaining({ remote: "team/fork", destination: "release" }),
  );
});

it("does not send a push after the component closes while its preview is pending", async () => {
  let resolve: (value: Result<typeof preview>) => void = () => {};
  preparePush.mockReturnValueOnce(
    new Promise<Result<typeof preview>>((done) => {
      resolve = done;
    }),
  );
  await act(async () => button().click());
  expect(preparePush).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => resolve(ok(preview)));
  await finish();
  expect(push).not.toHaveBeenCalled();
});

it("releases the busy state when the repository changes during a push preview", async () => {
  let resolve!: (value: Result<typeof preview>) => void;
  preparePush.mockReturnValueOnce(
    new Promise<Result<typeof preview>>((done) => {
      resolve = done;
    }),
  );
  await act(async () => button().click());
  useAppStore.setState({ selectedRepositoryId: "other" });
  await act(async () => resolve(ok(preview)));
  await finish();
  expect(push).not.toHaveBeenCalled();
  expect(button().disabled).toBe(false);
});

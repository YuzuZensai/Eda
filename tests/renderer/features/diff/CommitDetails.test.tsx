import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, type Result } from "@shared/errors";
import type {
  CommitInspection,
  CommitSignatureVerification,
  HistoryCommit,
} from "@shared/repository/repository-read";
import { CommitDetails } from "@renderer/features/diff/CommitDetails";
import { CommitChangesPanel } from "@renderer/features/history/CommitChangesPanel";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { CommitRow } from "@renderer/features/history/CommitRow";
import { layoutCommitPage } from "@renderer/repository/dag-layout";

const commit: HistoryCommit = {
  oid: "a".repeat(40),
  subject: "Example commit",
  body: "",
  parents: [],
  decorations: [],
  author: { name: "Sample", email: "signature@example.test", timestamp: "2026-11-06T12:00:00Z" },
  committerTimestamp: "2026-11-06T12:00:00Z",
};

const inspection = (signature: CommitSignatureVerification): CommitInspection => ({
  commit,
  containingRefs: ["refs/heads/main"],
  shallow: false,
  signed: signature.status !== "unsigned",
  signature,
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["verified", null, "Verified signature", "text-git-added"],
  ["invalid", "bad-signature", "Invalid signature", "text-git-deleted"],
  ["unverified", "missing-key", "Unverifiable: public key is missing", "text-git-modified"],
  ["unsigned", null, "Unsigned", "text-git-modified"],
] as const)(
  "shows an accessible icon and details for %s signatures",
  async (status, reasonCode, label, color) => {
    const signature: CommitSignatureVerification = {
      status,
      format: status === "unsigned" ? null : "openpgp",
      reasonCode,
      diagnostics: status === "unsigned" ? "" : "Verification result",
      ...(status === "verified"
        ? ({ signer: "Sample signer", fingerprint: "B".repeat(40), trustLevel: "fully" } as const)
        : {}),
    };

    const verify = vi.fn();

    await act(async () =>
      root.render(
        <CommitDetails
          commit={commit}
          inspection={inspection(signature)}
          onSelectParent={vi.fn()}
          onVerify={verify}
        />,
      ),
    );

    const indicator = container.querySelector<HTMLElement>('[role="img"]')!;
    expect(indicator.getAttribute("aria-label")).toBe(label);
    expect(indicator.textContent).toBe("");
    expect(indicator.className).toContain(color);

    const toggle = container.querySelector<HTMLButtonElement>("button[aria-controls]")!;
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;

    expect(details.getAttribute("aria-hidden")).toBe("true");
    expect(details.hasAttribute("inert")).toBe(true);

    await act(async () => toggle.click());
    expect(details.getAttribute("aria-hidden")).toBe("false");
    expect(details.hasAttribute("inert")).toBe(false);

    const verifyButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Verify signature again"]',
    )!;

    await act(async () => verifyButton.click());
    expect(verify).toHaveBeenCalledOnce();

    await act(async () => toggle.click());
    expect(details.getAttribute("aria-hidden")).toBe("true");
    expect(details.hasAttribute("inert")).toBe(true);

    if (status === "verified") {
      expect(container.textContent).toContain("Sample signer");
      expect(container.textContent).toContain("Fully trusted");
      expect(container.querySelector('[aria-label="Copy signing key fingerprint"]')).not.toBeNull();
    }
  },
);

it("rechecks trust without clearing the file filter and ignores a response for the previous commit", async () => {
  const previous = useRepositoryStore.getState();
  const pending: Array<(value: Result<CommitInspection>) => void> = [];

  vi.stubGlobal("eda", {
    repository: {
      inspectCommit: vi.fn(
        () => new Promise<Result<CommitInspection>>((resolve) => pending.push(resolve)),
      ),
    },
  });

  try {
    useRepositoryStore.setState({
      repositoryId: "repo",
      selection: { kind: "commit", oid: commit.oid },
      pages: [{ commits: [commit], nextOffset: null }],
      diff: { files: [] },
      error: null,
      diffLoading: false,
    });

    await act(async () => root.render(<CommitChangesPanel />));

    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Checking signature",
    );
    expect(container.querySelector('[role="img"] .animate-spin-fast')).not.toBeNull();

    await act(async () =>
      pending[0]!(
        ok(
          inspection({
            status: "verified",
            format: "ssh",
            reasonCode: null,
            diagnostics: "Good signature",
          }),
        ),
      ),
    );

    const filter = container.querySelector<HTMLInputElement>('[aria-label="Filter commit files"]')!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        filter,
        "keep-filter",
      );

      filter.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLButtonElement>("button[aria-controls]")!.click();
    });

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Verify signature again"]')!.click(),
    );
    expect(window.eda.repository.inspectCommit).toHaveBeenLastCalledWith("repo", commit.oid, true);

    expect(filter.value).toBe("keep-filter");

    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Checking signature",
    );

    await act(async () =>
      useRepositoryStore.setState({ selection: { kind: "commit", oid: "c".repeat(40) } }),
    );
    expect(window.eda.repository.inspectCommit).toHaveBeenLastCalledWith(
      "repo",
      "c".repeat(40),
      false,
    );

    await act(async () =>
      pending[1]!(
        ok(
          inspection({
            status: "invalid",
            format: "ssh",
            reasonCode: "bad-signature",
            diagnostics: "Bad signature",
          }),
        ),
      ),
    );

    expect(container.querySelector('[aria-label="Invalid signature"]')).toBeNull();
  } finally {
    await act(async () => useRepositoryStore.setState(previous));
  }
});

it("ends the verification loading state when the inspection request rejects", async () => {
  const previous = useRepositoryStore.getState();
  vi.stubGlobal("eda", {
    repository: { inspectCommit: vi.fn().mockRejectedValue(new Error("Transport closed")) },
  });

  try {
    useRepositoryStore.setState({
      repositoryId: "failed-inspection",
      selection: { kind: "commit", oid: commit.oid },
      pages: [{ commits: [commit], nextOffset: null }],
      diff: { files: [] },
      error: null,
      diffLoading: false,
    });

    await act(async () => root.render(<CommitChangesPanel />));
    expect(container.querySelector('[aria-label="Checking signature"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    await act(async () => useRepositoryStore.setState(previous));
  }
});

it("finishes a history row's recheck after selecting another commit", async () => {
  const previous = useRepositoryStore.getState();
  const pending: Array<(value: Result<CommitInspection>) => void> = [];
  const verified: CommitSignatureVerification = {
    status: "verified",
    format: "ssh",
    reasonCode: null,
    diagnostics: "",
  };
  vi.stubGlobal("eda", {
    repository: {
      commitSignature: async () => ok(verified),
      inspectCommit: () =>
        new Promise<Result<CommitInspection>>((resolve) => pending.push(resolve)),
    },
  });

  try {
    useRepositoryStore.setState({
      repositoryId: "refresh-row",
      selection: { kind: "commit", oid: commit.oid },
      pages: [{ commits: [commit], nextOffset: null }],
      diff: { files: [] },
      error: null,
      diffLoading: false,
    });
    await act(async () =>
      root.render(
        <>
          <CommitChangesPanel />
          <CommitRow
            row={layoutCommitPage([commit]).rows[0]!}
            columns={[{ id: "sha", visible: true, width: 72 }]}
            gutter={40}
            selected={false}
            related={false}
            vigilantMode
            onSelect={vi.fn()}
            onContextMenu={vi.fn()}
          />
        </>,
      ),
    );
    await act(async () => pending[0]!(ok(inspection(verified))));
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button[aria-controls]")!.click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Verify signature again"]')!.click(),
    );
    const rowIcon = () => container.querySelector('[data-tour="history-commit"] [role="img"]');
    expect(rowIcon()?.getAttribute("aria-label")).toBe("Checking signature");

    await act(async () =>
      useRepositoryStore.setState({ selection: { kind: "commit", oid: "c".repeat(40) } }),
    );
    await act(async () =>
      pending[1]!(ok(inspection({ ...verified, status: "invalid", reasonCode: "bad-signature" }))),
    );
    expect(rowIcon()?.getAttribute("aria-label")).toBe("Invalid signature");
    expect(rowIcon()?.querySelector(".animate-spin-fast")).toBeNull();
  } finally {
    await act(async () => useRepositoryStore.setState(previous));
  }
});

it("opens trust review from the visible button beside signature recheck", async () => {
  vi.stubGlobal("eda", { repository: { signerDecisions: async () => ok([]) } });
  await act(async () =>
    root.render(
      <CommitDetails
        commit={commit}
        repositoryId="repo"
        inspection={inspection({
          status: "unverified",
          format: "ssh",
          validity: "valid",
          signerTrust: "unknown",
          reasonCode: "untrusted-key",
          fingerprint: `SHA256:${"A".repeat(43)}`,
          diagnostics: "",
        })}
        onSelectParent={vi.fn()}
        onVerify={vi.fn()}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-controls]")!.click(),
  );
  const review = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Review signer…",
  )!;
  expect(review).toBeDefined();
  expect(
    review.parentElement?.querySelector('[aria-label="Verify signature again"]'),
  ).not.toBeNull();
  await act(async () => review.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Trust key");
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deferred } from "../../../helpers/deferred";
import { ok } from "@shared/errors";
import { SignerDialog } from "@renderer/features/diff/SignerDialog";
import { CommitSignatureIcon } from "@renderer/components/ui/display/CommitSignatureIcon";
import type { CommitSignatureVerification } from "@shared/repository/repository-read";

let container: HTMLDivElement;
let root: Root;
const githubEmail = `123+example@${"users.noreply.github.com"}`;
const fingerprint = "A".repeat(40);
const signature: CommitSignatureVerification = {
  status: "unverified",
  validity: "valid",
  signerTrust: "unknown",
  format: "openpgp",
  reasonCode: "untrusted-key",
  fingerprint,
  diagnostics: "",
};
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
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;

it("requires a separate explicit trust decision after discovery and defaults it to the repository", async () => {
  const decideSigner = vi.fn(async () => ok(undefined));
  const discoverSigningKey = vi.fn(async () => ok(signature));
  vi.stubGlobal("eda", {
    repository: {
      signerDecisions: async () => ok([]),
      decideSigner,
      discoverSigningKey,
      commitSignature: async () => ok({ ...signature, signerTrust: "trusted" }),
    },
  });
  await act(async () =>
    root.render(
      <SignerDialog
        repositoryId="repo"
        oid={"b".repeat(40)}
        email={githubEmail}
        initialSignature={{
          status: "unverified",
          format: "openpgp",
          validity: "unknown",
          reasonCode: "missing-key",
          diagnostics: "",
        }}
        onClose={() => {}}
      />,
    ),
  );
  expect(button("Trust key")).toBeUndefined();
  await act(async () =>
    [...document.querySelectorAll("summary")]
      .find((item) => item.textContent === "Import or choose another key source")!
      .click(),
  );
  await act(async () => button("Find and verify key").click());
  expect(discoverSigningKey).toHaveBeenCalledWith("repo", "b".repeat(40), {
    source: "github",
    account: "example",
  });
  expect(decideSigner).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("signer not yet trusted");
  await act(async () => button("Trust key").click());
  expect(decideSigner).toHaveBeenCalledWith(
    "repo",
    {
      fingerprint,
      identity: githubEmail,
      scope: "repository",
      decision: "trusted",
    },
    false,
  );
  expect(document.body.textContent).toContain("trusted signer");
});

it("keeps the saved signer decision when the initial list arrives after a trust change", async () => {
  const initial = deferred<Awaited<ReturnType<typeof window.eda.repository.signerDecisions>>>();
  const saved = {
    fingerprint,
    identity: githubEmail,
    scope: "repository",
    decision: "trusted",
  } as const;
  vi.stubGlobal("eda", {
    repository: {
      signerDecisions: vi
        .fn<typeof window.eda.repository.signerDecisions>()
        .mockReturnValueOnce(initial.promise)
        .mockResolvedValue(ok([saved])),
      decideSigner: async () => ok(undefined),
      commitSignature: async () => ok({ ...signature, signerTrust: "trusted" }),
    },
  });
  await act(async () =>
    root.render(
      <SignerDialog
        repositoryId="repo"
        oid={"b".repeat(40)}
        email={githubEmail}
        initialSignature={signature}
        onClose={() => {}}
      />,
    ),
  );
  await act(async () => button("Trust key").click());
  expect(button("Remove decision")).toBeDefined();
  await act(async () => initial.resolve(ok([])));
  expect(button("Remove decision")).toBeDefined();
});

it("keeps revoked keys visibly blocked even with a saved trust decision", async () => {
  vi.stubGlobal("eda", { repository: { signerDecisions: async () => ok([]) } });
  const revoked = {
    ...signature,
    signerTrust: "trusted" as const,
    reasonCode: "revoked-key" as const,
    status: "invalid" as const,
  };
  await act(async () =>
    root.render(
      <>
        <CommitSignatureIcon signature={revoked} />
        <SignerDialog
          repositoryId="repo"
          oid={"b".repeat(40)}
          email="author@example.test"
          initialSignature={revoked}
          onClose={() => {}}
        />
      </>,
    ),
  );
  expect(button("Trust key").disabled).toBe(true);
  expect(container.querySelector('[role="img"]')?.className).toContain("text-git-deleted");
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("revoked");
});

it.each([{ keyId: "B5690EEEBB952194" }, { committerEmail: `noreply@${"github.com"}` }])(
  "offers GitHub's service key without an author account or automatic fetch (%j)",
  async (hint) => {
    const discoverSigningKey = vi.fn(async () => ok(signature));
    vi.stubGlobal("eda", {
      repository: { signerDecisions: async () => ok([]), discoverSigningKey },
    });
    await act(async () =>
      root.render(
        <SignerDialog
          repositoryId="repo"
          oid={"b".repeat(40)}
          email="author@example.test"
          initialSignature={{
            status: "unverified",
            format: "openpgp",
            reasonCode: "missing-key",
            ...hint,
            diagnostics: "",
          }}
          onClose={() => {}}
        />,
      ),
    );
    expect(discoverSigningKey).not.toHaveBeenCalled();
    await act(async () =>
      [...document.querySelectorAll("summary")]
        .find((item) => item.textContent === "Import or choose another key source")!
        .click(),
    );
    await act(async () => button("Find and verify key").click());
    expect(discoverSigningKey).toHaveBeenCalledWith("repo", "b".repeat(40), {
      source: "github",
      account: "web-flow",
    });
  },
);

it.each([
  ["verified", "valid", "unknown", null, true],
  ["hint only", "unknown", "unknown", "missing-key", false],
  ["distrusted", "valid", "distrusted", null, false],
  ["revoked", "valid", "unknown", "revoked-key", false],
] as const)(
  "uses the GitHub brand only for verified web signatures without warnings (%s)",
  async (_name, validity, signerTrust, reasonCode, branded) => {
    await act(async () =>
      root.render(
        <CommitSignatureIcon
          signature={{
            ...signature,
            validity,
            signerTrust,
            reasonCode,
            keySource: "https://github.com/web-flow.gpg",
          }}
        />,
      ),
    );
    const indicator = container.querySelector('[role="img"]')!;
    expect(indicator.querySelector("svg title")?.textContent === "GitHub").toBe(branded);
    if (branded) {
      expect(indicator.className).toContain("text-text-secondary");
      expect(indicator.getAttribute("aria-label")).toBe("Signed by GitHub");
    }
  },
);

it("shows GitHub provenance without personal identity or trust controls", async () => {
  vi.stubGlobal("eda", { repository: { signerDecisions: async () => ok([]) } });
  await act(async () =>
    root.render(
      <SignerDialog
        repositoryId="repo"
        oid={"b".repeat(40)}
        email="author@example.test"
        initialSignature={{ ...signature, keySource: "https://github.com/web-flow.gpg" }}
        onClose={() => {}}
      />,
    ),
  );
  expect(document.body.textContent).toContain("Signed by GitHub");
  expect(document.body.textContent).toContain("This does not verify the author’s identity.");
  expect(document.body.textContent).not.toContain("signer not yet trusted");
  expect(document.body.textContent).not.toContain("Identity bound to this key");
  expect(document.body.textContent).not.toContain("Apply in Eda");
  expect(button("Trust key")).toBeUndefined();
  expect(button("Distrust key")).toBeUndefined();
});

it.each([
  ["unknown", "text-git-modified"],
  ["trusted", "text-git-added"],
  ["local", "text-git-added"],
  ["distrusted", "text-git-deleted"],
] as const)(
  "colors valid signatures with %s trust distinctly from service provenance",
  async (signerTrust, color) => {
    await act(async () =>
      root.render(<CommitSignatureIcon signature={{ ...signature, signerTrust }} />),
    );
    expect(container.querySelector('[role="img"]')?.className).toContain(color);
  },
);

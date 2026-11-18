import { errorFixture } from "../../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok, type Result } from "@shared/errors";
import type { Identity } from "@shared/identity/identity";
import type { GpgSigningKey } from "@shared/identity/signing";
import { SigningSettings } from "@renderer/features/credentials/SigningSettings";

const identity: Identity = {
  id: "work",
  name: "Work",
  gitName: "Author",
  gitEmail: "work@example.com",
  signing: { format: "gpg", signCommits: true },
  hue: 210,
  rules: [],
  createdAt: "now",
  updatedAt: "now",
};

const key: GpgSigningKey = {
  fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567",
  keyId: "89ABCDEF01234567",
  userIds: ["Author <work@example.com>"],
  signingKeys: [{ fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567", expiresAt: null }],
  expiresAt: null,
};

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

const button = () =>
  [...document.querySelectorAll("button")].find((item) => item.textContent === "Retry saving")!;

it("keeps the selected key after a failed save and only persists an explicit choice for its profile", async () => {
  const configureSigning = vi.fn().mockResolvedValue(
    err(
      errorFixture({
        kind: "config-write-refused",
        operation: "configure signing",
        message: "Could not update Git configuration.",
      }),
    ),
  );

  vi.stubGlobal("eda", {
    identity: { listGpgSigningKeys: async () => ok([key]), configureSigning },
  });

  const onSaved = vi.fn(async () => {});

  await act(async () =>
    root.render(<SigningSettings identity={identity} sshKeys={[]} onSaved={onSaved} />),
  );
  expect(configureSigning).not.toHaveBeenCalled();
  expect(button()).toBeUndefined();

  const option = container.querySelector<HTMLInputElement>(`input[value="${key.fingerprint}!"]`)!;
  await act(async () => option.click());
  expect(configureSigning).toHaveBeenCalledWith(
    { format: "gpg", keyRef: `${key.fingerprint}!`, signCommits: true },
    identity.id,
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not update Git configuration",
  );
  expect(option.checked).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();

  configureSigning.mockResolvedValue(ok(identity));
  await act(async () => button().click());
  expect(onSaved).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(button()).toBeUndefined();
});

it("discards a late key query after switching profiles and preserves an undetected saved key", async () => {
  let finish!: (result: Result<GpgSigningKey[]>) => void;
  const pending = new Promise<Result<GpgSigningKey[]>>((resolve) => {
    finish = resolve;
  });
  const listGpgSigningKeys = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(ok([]));

  vi.stubGlobal("eda", { identity: { listGpgSigningKeys } });

  const onSaved = async () => {};

  await act(async () =>
    root.render(
      <SigningSettings key={identity.id} identity={identity} sshKeys={[]} onSaved={onSaved} />,
    ),
  );

  const home = { ...identity, id: "home", signing: { ...identity.signing, keyRef: "ABCDEF12" } };

  await act(async () =>
    root.render(<SigningSettings key={home.id} identity={home} sshKeys={[]} onSaved={onSaved} />),
  );
  await act(async () => finish(ok([key])));
  expect(container.textContent).toContain("ABCDEF12");
  expect(container.textContent).not.toContain(key.keyId);
  expect(container.textContent).toContain("No usable GPG signing keys found");
  expect(container.textContent).toContain("Saved key unavailable");
});

it("preserves automatic selection until the user explicitly chooses a signer or identity", async () => {
  const subkey = "AB".repeat(20);
  const configureSigning = vi.fn().mockResolvedValue(ok(identity));
  vi.stubGlobal("eda", {
    identity: {
      listGpgSigningKeys: async () =>
        ok([
          {
            ...key,
            signingKeys: [...key.signingKeys, { fingerprint: subkey, expiresAt: 1_890_000_000 }],
          },
        ]),
      configureSigning,
    },
  });
  const profile = { ...identity, signing: { ...identity.signing, keyRef: key.keyId } };
  await act(async () =>
    root.render(<SigningSettings identity={profile} sshKeys={[]} onSaved={async () => {}} />),
  );
  const automatic = container.querySelector<HTMLInputElement>(`input[value="${key.fingerprint}"]`)!;
  expect(automatic.checked).toBe(true);
  expect(configureSigning).not.toHaveBeenCalled();
  const option = container.querySelector<HTMLInputElement>(`input[value="${subkey}!"]`)!;
  expect(option.closest("label")?.textContent).toContain("Signing subkey");
  expect(option.closest("label")?.textContent).toContain("Expires");
  await act(async () => option.click());
  expect(configureSigning).toHaveBeenCalledWith(
    { ...identity.signing, keyRef: subkey + "!" },
    identity.id,
  );
  expect(option.checked).toBe(true);

  await act(async () => automatic.click());
  expect(configureSigning).toHaveBeenLastCalledWith(
    { ...identity.signing, keyRef: key.fingerprint },
    identity.id,
  );
});

it("groups the available signing subkey under its identity when the primary private key is offline", async () => {
  const subkey = "AB".repeat(20);
  const configureSigning = vi.fn();
  vi.stubGlobal("eda", {
    identity: {
      listGpgSigningKeys: async () =>
        ok([{ ...key, signingKeys: [{ fingerprint: subkey, expiresAt: 1_890_000_000 }] }]),
      configureSigning,
    },
  });
  const profile = { ...identity, signing: { ...identity.signing, keyRef: `${subkey}!` } };
  await act(async () =>
    root.render(<SigningSettings identity={profile} sshKeys={[]} onSaved={async () => {}} />),
  );
  const group = container.querySelector('[role="radiogroup"]')!;
  const card = group.querySelector('section[aria-label="Author <work@example.com>"]')!;
  expect(card.textContent).toContain("Primary key");
  expect(card.textContent).toContain(key.keyId);
  expect(card.querySelector(`input[value="${key.fingerprint}!"]`)).toBeNull();
  expect(card.querySelector<HTMLInputElement>(`input[value="${subkey}!"]`)!.checked).toBe(true);
  expect(card.querySelector<HTMLInputElement>(`input[value="${key.fingerprint}"]`)!.checked).toBe(
    false,
  );
  expect(card.textContent).toContain("Let GnuPG choose the signing key.");
  expect(configureSigning).not.toHaveBeenCalled();
});

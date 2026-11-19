import { errorFixture } from "../../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SshSetupCard } from "@renderer/features/onboarding/SshSetupCard";
import { useAppStore } from "@renderer/stores/app-store";
import type { Identity } from "@shared/identity/identity";
import type { SshKey } from "@shared/identity/ssh";

const identity: Identity = {
  id: "personal",
  name: "Personal",
  gitName: "Eda",
  gitEmail: "eda@example.com",
  hue: 210,
  signing: { format: "none", signCommits: false },
  createdAt: "",
  updatedAt: "",
};
const key: SshKey = {
  path: "/fixture/id_ed25519",
  type: "ED25519",
  bits: 256,
  fingerprint: "SHA256:fixture",
  comment: "eda@example.com",
  publicKey: "ssh-ed25519 public-fixture",
  encrypted: false,
  loadedInAgent: false,
};
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useAppStore.getState>;
const assign = vi.fn();
const refresh = vi.fn();

function Setup() {
  const profile = useAppStore((state) => state.activeIdentity)!;
  return <SshSetupCard identity={profile} />;
}
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === text,
  )!;
  await act(async () => button.click());
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  assign.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset().mockImplementation(async () => {
    useAppStore.setState({ activeIdentity: { ...identity, sshKeyPath: key.path } });
  });
  vi.stubGlobal("eda", {
    ssh: {
      listKeys: vi.fn(async () => ({ ok: true, value: [] })),
      choosePrivateKey: vi.fn(async () => ({ ok: true, value: key.path })),
      chooseKeyDestination: vi.fn(async () => ({ ok: true, value: key.path })),
      importKey: vi.fn(async () => ({ ok: true, value: key })),
      generateKey: vi.fn(async () => ({ ok: true, value: key })),
    },
    identity: { assignSshKey: assign },
  });
  state = useAppStore.getState();
  useAppStore.setState({ activeIdentity: identity, refreshIdentities: refresh });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Setup />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(state, true);
  vi.unstubAllGlobals();
});
it.each(["Import key", "Generate key"])(
  "assigns the result of %s and offers its public key",
  async (action) => {
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector('[aria-label="SSH key assigned"]')).toBeNull();
    await click(action);
    expect(assign).toHaveBeenCalledWith(key.path, identity.id);
    expect(container.querySelector('[aria-label="SSH key assigned"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Copy public key"]')).not.toBeNull();
    expect(container.textContent).toContain("Add its public key to your Git host");
    expect(container.textContent).not.toContain("Signing");
    if (action === "Generate key")
      expect(window.eda.ssh.generateKey).toHaveBeenCalledWith({
        path: key.path,
        type: "ed25519",
        comment: identity.gitEmail,
      });
  },
);
it("does not show completion when assignment fails and allows retry", async () => {
  assign.mockResolvedValueOnce({
    ok: false,
    error: errorFixture({ message: "Could not assign key" }),
  });
  await click("Import key");
  expect(container.textContent).toContain("Could not assign key");
  expect(container.querySelector('[aria-label="SSH key assigned"]')).toBeNull();
  await click("Import key");
  expect(container.querySelector('[aria-label="SSH key assigned"]')).not.toBeNull();
});
it("leaves the profile untouched when the file picker is cancelled", async () => {
  vi.mocked(window.eda.ssh.choosePrivateKey).mockResolvedValueOnce({ ok: true, value: null });
  await click("Import key");
  expect(assign).not.toHaveBeenCalled();
  expect(window.eda.ssh.importKey).not.toHaveBeenCalled();
});

it("uses the header status slot for progress and completion", async () => {
  let finish!: (value: unknown) => void;
  assign.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Import key");
  expect(container.querySelector('summary [aria-label="Saving SSH key"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="SSH key assigned"]')).toBeNull();
  expect(container.textContent).not.toContain("Choose a key for this profile");
  await act(async () => finish({ ok: true }));
  expect(container.querySelector('summary [aria-label="SSH key assigned"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Saving SSH key"]')).toBeNull();
});

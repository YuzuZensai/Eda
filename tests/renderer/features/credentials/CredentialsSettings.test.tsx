import { act } from "react";
import { createRoot } from "react-dom/client";
import { CredentialsSettings } from "@renderer/features/credentials/CredentialsSettings";
import { useAppStore } from "@renderer/stores/app-store";
import type { ConnectionTestResult, SshKey } from "@shared/identity/ssh";

vi.mock("@renderer/features/credentials/SigningSettings", () => ({
  SigningSettings: () => null,
}));

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  "shows local key access for encrypted=%s and loadedInAgent=%s without claiming a connection",
  async (encrypted, loadedInAgent) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const key: SshKey = {
      path: "/fixture/key",
      type: "ED25519",
      bits: 256,
      fingerprint: "SHA256:fixture",
      comment: "Fixture",
      encrypted,
      loadedInAgent,
    };
    vi.stubGlobal("eda", {
      ssh: {
        listKeys: async () => ({ ok: true, value: [key] }),
        getAgentStatus: async () => ({
          ok: true,
          value: { available: true, source: "builtin", keys: [] },
        }),
      },
      credentials: {
        getSecretMetadata: async () => ({
          ok: true,
          value: { available: true, remembered: false },
        }),
      },
    });
    const state = useAppStore.getState();
    useAppStore.setState({
      activeIdentity: {
        id: "fixture",
        name: "Fixture",
        gitName: "Fixture",
        gitEmail: "fixture@example.invalid",
        hue: 210,
        sshKeyPath: key.path,
        signing: { format: "none", signCommits: false },
        createdAt: "",
        updatedAt: "",
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CredentialsSettings />));
      expect(container.textContent).not.toContain("Not loaded");
      expect(container.textContent).toContain("Built-in (managed by Eda)");
      expect(container.textContent).not.toContain("Ready to connect");
      expect(container.textContent).toContain(
        "Having a key available does not confirm server access",
      );
      if (encrypted) {
        expect(container.textContent).toContain(
          loadedInAgent ? "Key unlocked in the SSH agent." : "Passphrase required.",
        );
        expect(container.querySelector('input[type="password"]')).not.toBeNull();
        expect(container.textContent).toContain("Built-in agent, 0 keys loaded");
      } else {
        expect(container.textContent).toContain("Key available. No passphrase needed.");
        expect(container.querySelector('input[type="password"]')).toBeNull();
        expect(container.textContent).not.toContain("Unlock assigned key");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useAppStore.setState(state, true);
      vi.unstubAllGlobals();
    }
  },
);

it("keeps host verification feedback next to the test and hides results for a different key", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state = useAppStore.getState();
  const key: SshKey = {
    path: "/fixture/key",
    type: "ED25519",
    bits: 256,
    fingerprint: "SHA256:fixture",
    comment: "Fixture",
    encrypted: false,
    loadedInAgent: false,
  };
  const result: ConnectionTestResult = {
    status: "host-key-unknown",
    reachable: false,
    message: "This computer has no trusted host key for git@github.com yet.",
  };
  let finish: ((value: { ok: true; value: ConnectionTestResult }) => void) | undefined;
  const testConnection = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: result })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal("eda", {
    ssh: {
      listKeys: async () => ({ ok: true, value: [key] }),
      getAgentStatus: async () => ({ ok: true, value: { available: true, keys: [] } }),
      testConnection,
    },
    credentials: {
      getSecretMetadata: async () => ({ ok: true, value: { available: true, remembered: false } }),
    },
  });
  useAppStore.setState({
    activeIdentity: {
      id: "fixture",
      name: "Fixture",
      gitName: "Fixture",
      gitEmail: "fixture@example.invalid",
      hue: 210,
      sshKeyPath: key.path,
      signing: { format: "none", signCommits: false },
      createdAt: "",
      updatedAt: "",
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CredentialsSettings />));
    const test = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test connection",
    )!;
    const details = test.closest("details")!;
    await act(async () => {
      details.open = true;
      test.click();
    });
    expect(testConnection).toHaveBeenCalledWith("git@github.com", key.path);
    expect(details.textContent).toContain(result.message);
    expect(details.querySelector('[role="status"]')).not.toBeNull();
    expect(details.querySelector("pre")).toBeNull();
    expect(container.querySelector('select, [role="combobox"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Ready to connect");

    await act(async () => {
      test.click();
    });
    expect(details.textContent).not.toContain(result.message);
    await act(async () => {
      const identity = useAppStore.getState().activeIdentity!;
      useAppStore.setState({ activeIdentity: { ...identity, sshKeyPath: "/fixture/other" } });
    });
    await act(async () => {
      finish!({ ok: true, value: result });
    });
    expect(details.textContent).not.toContain(result.message);
    expect(details.querySelector('[aria-label="Verify SSH host in a terminal"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(state, true);
    vi.unstubAllGlobals();
  }
});

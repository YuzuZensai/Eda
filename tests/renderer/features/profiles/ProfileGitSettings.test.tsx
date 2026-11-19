import { act } from "react";
import { createRoot } from "react-dom/client";
import { ok } from "@shared/errors";
import type * as I18n from "@shared/i18n";
import { RepositoryGitSettings } from "@renderer/features/profiles/ProfileGitSettings";
import { useAppStore } from "@renderer/stores/app-store";

vi.mock("@renderer/features/settings/repository/RepositoryCommitIdentity", () => ({
  RepositoryCommitIdentity: () => null,
}));
vi.mock("@shared/i18n", async (importOriginal) => {
  const original = await importOriginal<typeof I18n>();
  return {
    ...original,
    t: (key: Parameters<typeof original.t>[0], values?: Parameters<typeof original.t>[1]) =>
      key === "profileGitSettings.off" ? "Désactivé" : original.t(key, values),
  };
});

it("uses Git signing state rather than the translated Off label to show configuration details", async () => {
  const app = useAppStore.getState();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAppStore.setState({
    activeIdentity: {
      id: "work",
      name: "Work",
      gitName: "Author",
      gitEmail: "work@example.com",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "now",
      updatedAt: "now",
    },
    selectedRepositoryId: "repo",
  });
  vi.stubGlobal("eda", {
    identity: {
      inspectGit: vi.fn().mockResolvedValue(
        ok({
          profileId: "work",
          global: [],
          repository: [{ key: "commit.gpgsign", value: "false", scope: "local" }],
          localOverrides: [],
        }),
      ),
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RepositoryGitSettings />));
    expect(container.textContent).toContain("Désactivé");
    const terms = [...container.querySelectorAll("dt")].map((term) => term.textContent);
    expect(terms).not.toContain("Format");
    expect(terms).not.toContain("Key");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(app, true);
    vi.unstubAllGlobals();
  }
});

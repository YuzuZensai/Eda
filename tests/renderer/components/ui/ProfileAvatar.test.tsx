import { act } from "react";
import { createRoot } from "react-dom/client";
import { ProfileAvatar } from "@renderer/components/ui/display/ProfileAvatar";

it("falls back on image failure and replaces the previous profile image immediately", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <ProfileAvatar
          name="First User"
          hue={210}
          imageUrl="https://www.gravatar.com/avatar/first"
        />,
      ),
    );

    const first = container.querySelector("img")!;
    expect(container.querySelector(".ui-skeleton")).not.toBeNull();
    expect(container.textContent).toBe("");

    await act(async () => first.dispatchEvent(new Event("load")));
    expect(container.querySelector(".ui-skeleton")).toBeNull();
    await act(async () =>
      root.render(
        <ProfileAvatar
          name="Second User"
          hue={210}
          imageUrl="https://www.gravatar.com/avatar/second"
        />,
      ),
    );

    const second = container.querySelector("img")!;

    expect(second).not.toBe(first);
    expect(second.src).toContain("/second");
    expect(container.textContent).toBe("");
    expect(container.querySelector(".ui-skeleton")).not.toBeNull();

    await act(async () => second.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ui-skeleton")).toBeNull();
    expect(container.textContent).toBe("SU");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("shares cached lookups and rejects late avatar results after an author changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  let finish!: (value: { ok: true; value: { dataUrl: string; expiresAt: number } }) => void;
  const pending = new Promise<{ ok: true; value: { dataUrl: string; expiresAt: number } }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const get = vi.fn((email: string) =>
    email === "first@avatar.test"
      ? pending
      : Promise.resolve({
          ok: true,
          value: { dataUrl: "data:image/png;base64,Ag==", expiresAt: Date.now() + 60_000 },
        }),
  );

  vi.stubGlobal("eda", { avatars: { get } });

  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <>
          <ProfileAvatar name="First" hue={210} email=" First@Avatar.test " />
          <ProfileAvatar name="First" hue={210} email="first@avatar.test" />
        </>,
      ),
    );
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () =>
      root.render(<ProfileAvatar name="Second" hue={210} email="second@avatar.test" />),
    );
    expect(container.querySelector("img")?.src).toBe("data:image/png;base64,Ag==");

    await act(async () =>
      finish({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AQ==", expiresAt: Date.now() + 60_000 },
      }),
    );
    expect(container.querySelector("img")?.src).toBe("data:image/png;base64,Ag==");
    expect(container.textContent).toBe("S");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("requests commit avatars within the selected repository", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const getCommit = vi.fn(async (repositoryId: string) => ({
    ok: true as const,
    value: {
      dataUrl:
        repositoryId === "github-repo"
          ? "data:image/png;base64,AQ=="
          : "data:image/png;base64,Ag==",
      expiresAt: Date.now() + 60_000,
    },
  }));
  vi.stubGlobal("eda", { avatars: { getCommit } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const email = "same-author@example.test";

  try {
    await act(async () =>
      root.render(
        <ProfileAvatar name="Author" hue={210} email={email} repositoryId="github-repo" />,
      ),
    );
    expect(container.querySelector("img")?.src).toBe("data:image/png;base64,AQ==");

    await act(async () =>
      root.render(
        <ProfileAvatar name="Author" hue={210} email={email} repositoryId="gitlab-repo" />,
      ),
    );
    expect(container.querySelector("img")?.src).toBe("data:image/png;base64,Ag==");
    expect(getCommit).toHaveBeenNthCalledWith(1, "github-repo", email);
    expect(getCommit).toHaveBeenNthCalledWith(2, "gitlab-repo", email);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([{}, { small: true }, { compact: true }])(
  "keeps the same avatar element while loading with size %j",
  async (size) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(<ProfileAvatar name="Work User" hue={210} {...size} loading />),
      );
      const avatar = container.firstElementChild;
      expect(avatar?.classList.contains("ui-skeleton")).toBe(true);
      expect(container.textContent).toBe("");

      await act(async () => root.render(<ProfileAvatar name="Work User" hue={210} {...size} />));
      expect(container.firstElementChild).toBe(avatar);
      expect(avatar?.classList.contains("ui-skeleton")).toBe(false);
      expect(container.textContent).toBe("WU");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

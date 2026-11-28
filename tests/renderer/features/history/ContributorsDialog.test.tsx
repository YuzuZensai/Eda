import { fillInput } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok } from "@shared/errors";
import type { Contributor } from "@shared/repository/repository-read";
import { ContributorsDialog } from "@renderer/features/history/ContributorsDialog";
import { errorFixture } from "../../../helpers/error";
import { deferred } from "../../../helpers/deferred";

const contributors = vi.fn<typeof window.eda.repository.contributors>();
const getCommit = vi.fn<typeof window.eda.avatars.getCommit>();
const authors: Contributor[] = [
  { name: "Alice Example", email: "alice@example.test", commits: 3 },
  { name: "Alice Example", email: "alice@other.test", commits: 1 },
  { name: "Bob Example", email: "bob@example.test", commits: 1 },
];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { repository: { contributors }, avatars: { getCommit } });
  getCommit.mockResolvedValue(ok({ dataUrl: null, expiresAt: Date.now() + 60_000 }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  contributors.mockResolvedValue(ok(authors));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const open = async (repositoryId = "repo") => {
  await act(async () =>
    root.render(<ContributorsDialog repositoryId={repositoryId} onClose={() => {}} />),
  );
};
const search = async (query: string) => {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search name or email"]')!;
  await fillInput(input, query);
};
const sortBy = async (value: string) => {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Sort contributors by"]')!;
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  await act(async () =>
    document.querySelector<HTMLElement>(`[data-eda-select-value="${value}"]`)!.click(),
  );
};
const reverseSort = async () => {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Sort ascending"], button[aria-label="Sort descending"]',
  )!;
  await act(async () => button.click());
};
const visibleEmails = () =>
  [...document.querySelectorAll('[role="region"][aria-label="Contributors"] p[title]')]
    .map((element) => element.getAttribute("title"))
    .filter((title) => title?.includes("@"));
const refresh = () => document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;

it("lists author identities and counts, and filters by name and email without merging aliases", async () => {
  await open();
  expect(contributors).toHaveBeenCalledWith("repo");
  expect(document.body.textContent).toContain("3 contributors");
  expect(document.body.textContent).toContain("3 commits");
  expect(document.body.textContent).toContain("1 commit");
  expect(document.body.textContent).toContain("alice@example.test");
  expect(document.body.textContent).toContain("alice@other.test");
  await search("ALICE other.test");
  expect(document.body.textContent).toContain("alice@other.test");
  expect(document.body.textContent).not.toContain("alice@example.test");
  expect(document.body.textContent).not.toContain("bob@example.test");
  await search("nobody");
  expect(document.body.textContent).toContain("No matching contributors");
  await search("");
  expect(document.body.textContent).toContain("bob@example.test");
});

it("sorts by numeric commit counts, natural names and emails in both directions without refetching", async () => {
  const entries: Contributor[] = [
    { name: "Bob", email: "b@example.test", commits: 12 },
    { name: "Alice", email: "z@example.test", commits: 3 },
    { name: "Alice", email: "a@example.test", commits: 3 },
    { name: "User 10", email: "u10@example.test", commits: 1 },
    { name: "User 2", email: "u2@example.test", commits: 2 },
  ];
  contributors.mockResolvedValueOnce(ok(entries));
  const emails = (...names: string[]) => names.map((name) => `${name}@example.test`);

  await open();
  expect(visibleEmails()).toEqual(emails("b", "a", "z", "u2", "u10"));
  await reverseSort();
  expect(visibleEmails()).toEqual(emails("u10", "u2", "a", "z", "b"));

  await sortBy("name");
  expect(visibleEmails()).toEqual(emails("a", "z", "b", "u2", "u10"));
  await reverseSort();
  expect(visibleEmails()).toEqual(emails("u10", "u2", "b", "a", "z"));

  await sortBy("email");
  expect(visibleEmails()).toEqual(emails("a", "b", "u2", "u10", "z"));
  await reverseSort();
  expect(visibleEmails()).toEqual(emails("z", "u10", "u2", "b", "a"));

  await search("Alice");
  expect(visibleEmails()).toEqual(emails("z", "a"));
  expect(contributors).toHaveBeenCalledTimes(1);
  expect(entries.map((entry) => entry.email)).toEqual(emails("b", "z", "a", "u10", "u2"));
});

it("offers retry after a failed scan and shows an empty repository without stale authors", async () => {
  const pending = deferred<Awaited<ReturnType<typeof window.eda.repository.contributors>>>();
  contributors.mockReturnValueOnce(pending.promise);
  await open();
  expect(refresh().disabled).toBe(true);
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => pending.resolve(err(errorFixture({ message: "Cannot read authors" }))));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Cannot read authors");
  expect(refresh().disabled).toBe(false);
  await act(async () => refresh().click());
  expect(document.body.textContent).toContain("alice@example.test");
  contributors.mockResolvedValueOnce(ok([]));
  await act(async () => refresh().click());
  expect(document.body.textContent).toContain("No commits yet.");
  expect(document.body.textContent).not.toContain("alice@example.test");
});

it("ignores a pending contributors response after switching repositories", async () => {
  const pending = deferred<Awaited<ReturnType<typeof window.eda.repository.contributors>>>();
  contributors.mockReturnValueOnce(pending.promise);
  await open();
  contributors.mockResolvedValueOnce(
    ok([{ name: "Other", email: "other@example.test", commits: 2 }]),
  );
  await open("other");
  await act(async () => pending.resolve(ok(authors)));
  expect(document.body.textContent).toContain("other@example.test");
  expect(document.body.textContent).not.toContain("alice@example.test");
});

it("renders a bounded slice of large contributor lists while keeping every author searchable", async () => {
  contributors.mockResolvedValueOnce(
    ok(
      Array.from({ length: 10_000 }, (_, index) => ({
        name: `Author ${index}`,
        email: `author${index}@example.test`,
        commits: 1,
      })),
    ),
  );
  await open("large-contributors");
  expect(visibleEmails().length).toBeLessThanOrEqual(80);
  expect(getCommit.mock.calls.length).toBeLessThanOrEqual(80);

  const list = document.querySelector<HTMLElement>('[role="region"][aria-label="Contributors"]')!;
  Object.defineProperty(list, "clientHeight", { value: 320 });
  await act(async () => {
    list.scrollTop = 9990 * 56;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  expect(visibleEmails()).toContain("author9999@example.test");

  await sortBy("name");
  expect(visibleEmails()[0]).toBe("author0@example.test");
  await reverseSort();
  expect(visibleEmails()[0]).toBe("author9999@example.test");
  expect(visibleEmails().length).toBeLessThanOrEqual(80);

  await search("author9999@example.test");
  expect(document.body.textContent).toContain("author9999@example.test");
});

it("loads contributor photos from the selected repository and falls back to initials", async () => {
  const photo = "data:image/png;base64,AQ==";
  getCommit.mockImplementation(async (_repositoryId, email) =>
    ok({
      dataUrl: email === "alice@example.test" ? photo : null,
      expiresAt: Date.now() + 60_000,
    }),
  );

  await open("contributor-photos");

  for (const author of authors) {
    expect(getCommit).toHaveBeenCalledWith("contributor-photos", author.email);
  }

  const avatars = document.querySelectorAll(".profile-avatar");
  const image = avatars[0]!.querySelector("img")!;
  expect(image.src).toBe(photo);
  expect(avatars[2]!.querySelector("img")).toBeNull();
  expect(avatars[2]!.textContent).toBe("BE");

  await act(async () => image.dispatchEvent(new Event("error")));

  expect(avatars[0]!.querySelector("img")).toBeNull();
  expect(avatars[0]!.textContent).toBe("AE");
});

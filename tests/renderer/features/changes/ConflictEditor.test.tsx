import { act } from "react";
import { createRoot } from "react-dom/client";
import { ok } from "@shared/errors";
import type { ResolveConflictRequest } from "@shared/workflows/workflow";
import { ConflictEditor } from "@renderer/features/changes/ConflictEditor";
import { useRepositoryStore } from "@renderer/stores/repository-store";

it("navigates conflicts, keeps surrounding text and diff3 bases out of the chosen lines, and advances after staging", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state = useRepositoryStore.getState();
  const changes = ["one.txt", "two.txt"].map((path) => ({
    path,
    kind: "unmerged" as const,
    index: "U" as const,
    worktree: "U" as const,
    submodule: "N...",
  }));
  const output = [
    "pre",
    "<<<<<<< HEAD",
    "one",
    "||||||| base",
    "ancestor",
    "=======",
    "other one",
    ">>>>>>> topic",
    "between",
    "<<<<<<< HEAD",
    "two",
    "=======",
    "other two",
    ">>>>>>> topic",
    "end",
    "",
  ].join("\r\n");
  let workingText = output;
  const inspect = vi.fn(async (_repository: string, path: string) =>
    ok({
      path,
      token: path,
      markerSize: 7,
      hasMarkers: workingText.includes("<<<<<<<"),
      workflow: null,
      base: null,
      current: null,
      incoming: null,
      output: workingText,
      outputKind: "file",
      newline: "crlf",
    }),
  );
  const selectChange = vi.fn().mockResolvedValue(undefined);
  const resolve = vi.fn(async (request: ResolveConflictRequest) => {
    if (request.text !== undefined) workingText = request.text;
    return ok(undefined);
  });
  vi.stubGlobal("eda", { conflicts: { inspect, resolve } });
  useRepositoryStore.setState({
    repositoryId: "repo",
    status: { branch: { ahead: 0, behind: 0, unborn: false, detached: false }, changes },
    identityId: "profile",
    selectChange,
    syncFromDisk: vi.fn().mockResolvedValue(undefined),
  });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find(
      (control) => (control.getAttribute("aria-label") ?? control.textContent) === name,
    )!;
  const outputText = () => document.querySelector("textarea")?.value.replaceAll("\r\n", "\n");
  try {
    await act(async () =>
      root.render(<ConflictEditor repositoryId="repo" path="one.txt" onBack={vi.fn()} />),
    );
    expect(button("Save and mark resolved").disabled).toBe(true);
    expect(outputText()).toBe("pre\nancestor\nbetween\nend\n");
    await act(async () => button("Edit conflict markers").click());
    expect(outputText()).toBe(output.replaceAll("\r\n", "\n"));
    await act(async () => button("Show merged preview").click());
    await act(async () => button("Next").click());
    expect(
      document.querySelector('[aria-label="Compare conflicting changes"]')?.textContent,
    ).toContain("other two");
    await act(async () => button("Use incoming content").click());
    await act(async () => button("Undo last choice").click());
    expect(
      document.querySelector('[aria-label="Compare conflicting changes"]')?.textContent,
    ).toContain("other two");
    await act(async () => button("Use incoming content").click());
    await act(async () => root.render(null));
    useRepositoryStore.setState({ identityId: "another profile" });
    await act(async () =>
      root.render(<ConflictEditor repositoryId="repo" path="one.txt" onBack={vi.fn()} />),
    );
    expect(outputText()).toBe("pre\nancestor\nbetween\nend\n");

    await act(async () => root.render(null));
    useRepositoryStore.setState({ identityId: "profile" });
    await act(async () =>
      root.render(<ConflictEditor repositoryId="repo" path="one.txt" onBack={vi.fn()} />),
    );
    expect(outputText()).toBe("pre\nancestor\nbetween\nother two\nend\n");
    await act(async () => button("Save output").click());
    expect(workingText).toBe(
      output.slice(0, output.indexOf("<<<<<<< HEAD\r\ntwo")) + "other two\r\nend\r\n",
    );
    expect(button("Save and mark resolved").disabled).toBe(true);
    await act(async () => button("Use both in order").click());
    await act(async () => button("Save and mark resolved").click());
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: "repo",
      token: "one.txt",
      choice: "text",
      text: "pre\r\none\r\nother one\r\nbetween\r\nother two\r\nend\r\n",
      stage: true,
    });
    expect(selectChange).toHaveBeenCalledWith(changes[1], "conflicted");
  } finally {
    await act(async () => root.unmount());
    element.remove();
    useRepositoryStore.setState(state, true);
    vi.unstubAllGlobals();
  }
});

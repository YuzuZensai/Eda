import { it, expect } from "vitest";
import {
  collectionManifest,
  importCollection,
  isCollectionList,
  portableRemote,
} from "@shared/repository/collections";

it("round-trips a versioned local collection without exporting machine IDs, credentials or unrequested path hints", () => {
  const collection = {
    id: "one",
    name: "Tools",
    description: "Build tools",
    color: "#ff0000",
    icon: "🔧",
    members: [
      {
        name: "tool",
        repositoryId: "mine",
        remote: "https://git.example/tool.git",
        pathHint: "/my/tool",
      },
    ],
  };
  const manifest = collectionManifest(collection, false);
  expect(manifest.members).toEqual([{ name: "tool", remote: "https://git.example/tool.git" }]);
  expect(importCollection(manifest, "two")?.id).toBe("two");
  expect(importCollection(collectionManifest(collection, true), "two")?.members[0]?.pathHint).toBe(
    "/my/tool",
  );
  expect(isCollectionList([collection, collection])).toBe(false);
  expect(importCollection({ ...manifest, version: 0 }, "two")).toBeNull();
  for (const remote of [
    "https://user:secret@example.com/r",
    "https://example.com/r?t=secret",
    "ext::bad",
    "file:///home/user",
  ])
    expect(portableRemote(remote)).toBe(false);
});

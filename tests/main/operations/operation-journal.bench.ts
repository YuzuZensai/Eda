import { test } from "vitest";
import { OperationManager } from "@main/operations/operation-manager";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { OperationRepository } from "@main/persistence/operation-repository";

test("journal maintenance with five profiles of 200 recent completed operations", async ({
  bench,
}) => {
  const db = openInMemoryDatabase();
  try {
    const identities = new IdentityRepository(db);
    const store = new OperationRepository(db);
    const manager = new OperationManager(store);
    let profileId = "";
    for (let profile = 0; profile < 5; profile++) {
      profileId = identities.create({
        name: `Profile ${profile}`,
        gitName: "Author",
        gitEmail: "author@example.com",
        hue: 0,
        signing: { format: "none", signCommits: false },
      }).id;
      await manager.run(
        { profileId, repositoryId: "repo", repositoryName: "fixture" },
        "Stage",
        async () => {
          manager.progress("x".repeat(8_000));
        },
      );
      const [record] = store.list(profileId);
      for (let index = 1; index < 200; index++)
        store.save({ ...record!, id: `${profile}-${index}` });
    }

    await bench("recover all profiles", () => store.recover()).run();
    await bench("prune one profile", () => store.prune(profileId)).run();
  } finally {
    db.close();
  }
});

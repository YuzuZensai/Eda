import { deferred } from "../../../helpers/deferred";
import { describe, expect, it } from "vitest";
import { WriteQueue } from "@main/operations/write-queue";

describe("per-repository write serialization", () => {
  it("never runs two writes for one repository at the same time", async () => {
    const queue = new WriteQueue();
    let running = 0;
    let overlaps = 0;

    const work = async () => {
      running += 1;
      if (running > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    };

    await Promise.all(Array.from({ length: 8 }, () => queue.run("/repo", work)));
    expect(overlaps).toBe(0);
  });

  it("preserves submission order", async () => {
    const queue = new WriteQueue();
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        queue.run("/repo", async () => {
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("runs different repositories in parallel", async () => {
    const queue = new WriteQueue();
    const first = deferred<void>();
    const started: string[] = [];

    const a = queue.run("/a", async () => {
      started.push("a");
      await first.promise;
    });
    const b = queue.run("/b", async () => {
      started.push("b");
    });

    await b;
    expect(started).toContain("b");

    first.resolve();
    await a;
  });

  it("keeps draining after a write fails", async () => {
    const queue = new WriteQueue();
    const failure = queue.run("/repo", async () => {
      throw new Error("index.lock held");
    });

    await expect(failure).rejects.toThrow("index.lock held");
    await expect(queue.run("/repo", async () => "ok")).resolves.toBe("ok");
  });

  it("propagates each write result to its own caller", async () => {
    const queue = new WriteQueue();
    const results = await Promise.all([
      queue.run("/repo", async () => "first"),
      queue.run("/repo", async () => "second"),
    ]);
    expect(results).toEqual(["first", "second"]);
  });

  it("reports busy while a write is in flight and clears afterwards", async () => {
    const queue = new WriteQueue();
    const gate = deferred<void>();
    const pending = queue.run("/repo", () => gate.promise);

    expect(queue.isBusy("/repo")).toBe(true);
    expect(queue.isBusy("/other")).toBe(false);

    gate.resolve();
    await pending;
    expect(queue.isBusy("/repo")).toBe(false);
  });
});

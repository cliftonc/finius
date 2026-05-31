import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/server/queue.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SerialQueue", () => {
  it("runs tasks one at a time, in order", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (name: string) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      log.push(name);
      active--;
    };

    queue.enqueue(task("a"));
    queue.enqueue(task("b"));
    queue.enqueue(task("c"));
    await queue.settle();

    expect(maxActive).toBe(1); // never concurrent
    expect(log).toEqual(["a", "b", "c"]); // FIFO
  });

  it("keeps draining after a task throws", async () => {
    const queue = new SerialQueue();
    const done: string[] = [];
    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(async () => {
      done.push("after");
    });
    await queue.settle();
    expect(done).toEqual(["after"]);
  });

  it("resumes when work is enqueued after the queue has drained", async () => {
    const queue = new SerialQueue();
    const done: string[] = [];
    queue.enqueue(async () => {
      done.push("first");
    });
    await queue.settle();
    queue.enqueue(async () => {
      done.push("second");
    });
    await queue.settle();
    expect(done).toEqual(["first", "second"]);
  });
});

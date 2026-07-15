import { describe, expect, it, vi } from "vitest";
import { WizardSession } from "../wizard/session.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";

describe("createWizardSessionTracker", () => {
  it("retains an uncollected terminal result before reaping it", async () => {
    let now = 1_000;
    const tracker = createWizardSessionTracker({ now: () => now });
    const terminal = new WizardSession(async () => {});
    tracker.wizardSessions.set("finished", terminal);
    await terminal.next();

    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(true);

    now += 5 * 60 * 1000 - 1;
    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(true);

    now += 1;
    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(false);
  });

  it("retains and reports the running session", () => {
    const tracker = createWizardSessionTracker();
    const running = new WizardSession(async (prompter) => {
      await prompter.note("waiting");
    });
    tracker.wizardSessions.set("running", running);

    expect(tracker.findRunningWizard()).toBe("running");
    expect(tracker.countRunningWizards()).toBe(1);
    expect(tracker.wizardSessions.get("running")).toBe(running);
    running.cancel();
    expect(tracker.countRunningWizards()).toBe(0);
  });

  it("releases an abandoned timed-out wizard from the running count", async () => {
    vi.useFakeTimers();
    try {
      const tracker = createWizardSessionTracker();
      const abandoned = new WizardSession(
        async (prompter) => {
          await prompter.text({ message: "Waiting for client" });
        },
        { timeoutMs: 1_000 },
      );
      tracker.wizardSessions.set("abandoned", abandoned);
      await abandoned.next();

      expect(tracker.countRunningWizards()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(tracker.countRunningWizards()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

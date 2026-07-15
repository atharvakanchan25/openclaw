import { describe, expect, it, vi } from "vitest";
import { WizardSession } from "../../wizard/session.js";
import type { GatewayRequestContext } from "./types.js";
import { wizardHandlers } from "./wizard.js";

describe("wizard gateway methods", () => {
  it("returns a retained persisted outcome when cancelling a channels wizard", async () => {
    const session = new WizardSession(async (prompter, _signal, currentSession) => {
      currentSession.setConfiguredResult({ accounts: [], changed: true });
      await prompter.text({ message: "Continue setup" });
    });
    expect((await session.next()).step?.type).toBe("text");

    const wizardSessions = new Map([["session-1", session]]);
    const context = { wizardSessions } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const handler = wizardHandlers["wizard.cancel"];
    if (!handler) {
      throw new Error("wizard.cancel handler missing");
    }

    await handler({
      params: { sessionId: "session-1" },
      context,
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        status: "cancelled",
        error: "cancelled",
        changed: true,
        channels: [],
        accounts: [],
      },
      undefined,
    );
    expect(wizardSessions.has("session-1")).toBe(false);
  });
});

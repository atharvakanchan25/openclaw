// Channel wizard controller: step/answer state machine over wizard.* RPCs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelWizardController } from "./wizard-controller.ts";

type RequestHandler = (method: string, params?: unknown) => Promise<unknown>;

function createController(
  handler: RequestHandler,
  isKnownChannel: (value: string) => boolean = () => false,
  onPersistedResult: (result: {
    accounts: ReadonlyArray<{ channel: string; accountId: string }>;
    completed: boolean;
  }) => void = () => {},
) {
  const request = vi.fn(handler);
  const onChange = vi.fn();
  const controller = new ChannelWizardController(
    () => ({ request: request as never }),
    onChange,
    isKnownChannel,
    onPersistedResult,
  );
  return { controller, request, onChange };
}

const selectStep = {
  id: "step-select",
  type: "select" as const,
  message: "Which channel?",
  options: [
    { value: "telegram", label: "Telegram" },
    { value: "__done__", label: "Finished" },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

const tokenStep = {
  id: "step-token",
  type: "text" as const,
  message: "Paste token",
  sensitive: true,
};

describe("ChannelWizardController", () => {
  it("walks start → step → answer → done", async () => {
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      if (method === "wizard.next") {
        return {
          done: true,
          status: "done",
          channels: ["telegram"],
          accounts: [{ channel: "telegram", accountId: "default" }],
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    await controller.start("telegram");
    expect(controller.state).toMatchObject({
      phase: "step",
      channel: "telegram",
      step: { id: "step-select" },
      busy: false,
    });
    expect(request).toHaveBeenCalledWith("wizard.start", {
      flow: "channels",
      channel: "telegram",
    });

    await controller.answer("telegram");
    expect(controller.state).toEqual({
      phase: "done",
      channel: "telegram",
      changed: true,
      channels: ["telegram"],
      accounts: [{ channel: "telegram", accountId: "default" }],
    });
    expect(request).toHaveBeenCalledWith("wizard.next", {
      sessionId: "s1",
      answer: { stepId: "step-select", value: "telegram" },
    });
  });

  it("surfaces validation errors on the re-emitted step", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: tokenStep };
      }
      return {
        done: false,
        status: "running",
        step: tokenStep,
        error: "Token looks invalid.",
      };
    });

    await controller.start("telegram");
    await controller.answer("nope");
    expect(controller.state).toMatchObject({
      phase: "step",
      validationError: "Token looks invalid.",
      busy: false,
    });
  });

  it("sends typed Back navigation without an answer value", async () => {
    const backStep = {
      ...tokenStep,
      navigation: { canGoBack: true, canGoForward: false },
    };
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: backStep };
      }
      return { done: false, status: "running", step: selectStep };
    });

    await controller.start("telegram");
    await controller.navigate("back");

    expect(request).toHaveBeenCalledWith("wizard.next", {
      sessionId: "s1",
      answer: { stepId: "step-token", navigation: "back" },
    });
    expect(controller.state).toMatchObject({
      phase: "step",
      step: { id: "step-select" },
    });
  });

  it("replaces the presented channel after Back returns to channel selection", async () => {
    const backStep = {
      ...tokenStep,
      navigation: { canGoBack: true, canGoForward: false },
    };
    let nextCall = 0;
    const { controller } = createController(
      async (method) => {
        if (method === "wizard.start") {
          return { sessionId: "s1", done: false, status: "running", step: backStep };
        }
        nextCall += 1;
        if (nextCall === 1) {
          return { done: false, status: "running", step: selectStep };
        }
        return { done: false, status: "running", step: tokenStep };
      },
      (value) => value === "telegram" || value === "whatsapp",
    );

    await controller.start("telegram");
    await controller.navigate("back");

    expect(controller.state).toMatchObject({
      phase: "step",
      channel: null,
      step: { id: "step-select" },
    });

    await controller.answer("whatsapp");

    expect(controller.state).toMatchObject({
      phase: "step",
      channel: "whatsapp",
      step: { id: "step-token" },
    });
  });

  it("does not treat a later select value as a channel choice", async () => {
    const agentStep = {
      id: "step-agent",
      type: "select" as const,
      message: "Send messages to agent",
      options: [{ value: "whatsapp", label: "whatsapp" }],
    };
    const { controller } = createController(
      async (method) => {
        if (method === "wizard.start") {
          return { sessionId: "s1", done: false, status: "running", step: agentStep };
        }
        return { done: false, status: "running", step: tokenStep };
      },
      (value) => value === "telegram" || value === "whatsapp",
    );

    await controller.start("telegram");
    await controller.answer("whatsapp");

    expect(controller.state).toMatchObject({
      phase: "step",
      channel: "telegram",
      step: { id: "step-token" },
    });
  });

  it("maps runner failures to the error phase", async () => {
    const onPersistedResult = vi.fn();
    const { controller } = createController(
      async (method) => {
        if (method === "wizard.start") {
          return {
            sessionId: "s1",
            done: true,
            status: "error",
            error: "config invalid",
            changed: true,
            accounts: [],
          };
        }
        throw new Error(`unexpected ${method}`);
      },
      undefined,
      onPersistedResult,
    );

    await controller.start(null);
    expect(onPersistedResult).toHaveBeenCalledWith({ accounts: [], completed: false });
    expect(controller.state).toEqual({
      phase: "error",
      channel: null,
      message: "config invalid",
    });
  });

  it("preserves completion effects for gateways that omit changed", async () => {
    const onPersistedResult = vi.fn();
    const { controller } = createController(
      async (method) => {
        if (method === "wizard.start") {
          return {
            sessionId: "s1",
            done: true,
            status: "done",
            channels: ["whatsapp"],
            accounts: [{ channel: "whatsapp", accountId: "work" }],
          };
        }
        throw new Error(`unexpected ${method}`);
      },
      undefined,
      onPersistedResult,
    );

    await controller.start("whatsapp");

    expect(onPersistedResult).toHaveBeenCalledWith({
      accounts: [{ channel: "whatsapp", accountId: "work" }],
      completed: true,
    });
  });

  it("cancels a stale in-flight start so the gateway session is not leaked", async () => {
    let resolveStart: (value: unknown) => void = () => {};
    const cancelled: unknown[] = [];
    const { controller } = createController(async (method, params) => {
      if (method === "wizard.start") {
        return await new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      if (method === "wizard.cancel") {
        cancelled.push((params as { sessionId?: string }).sessionId);
        return { status: "cancelled" };
      }
      throw new Error(`unexpected ${method}`);
    });

    const start = controller.start("telegram");
    await Promise.resolve();
    await controller.cancel();
    resolveStart({ sessionId: "s-stale", done: false, status: "running", step: selectStep });
    await start;
    await Promise.resolve();
    expect(controller.state).toEqual({ phase: "idle" });
    expect(cancelled).toContain("s-stale");
  });

  it("uses the gateway-reported channels for completion", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return {
        done: true,
        status: "done",
        channels: ["telegram", "whatsapp"],
        accounts: [
          { channel: "telegram", accountId: "default" },
          { channel: "whatsapp", accountId: "work" },
        ],
      };
    });

    await controller.start(null);
    await controller.answer("whatsapp");
    expect(controller.state).toEqual({
      phase: "done",
      channel: "telegram",
      changed: true,
      channels: ["telegram", "whatsapp"],
      accounts: [
        { channel: "telegram", accountId: "default" },
        { channel: "whatsapp", accountId: "work" },
      ],
    });
  });

  it("reports no channels when the flow ends without configuring any", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return { done: true, status: "done" };
    });

    await controller.start("whatsapp");
    await controller.answer("__skip__");
    expect(controller.state).toEqual({
      phase: "done",
      channel: "whatsapp",
      changed: false,
      channels: [],
      accounts: [],
    });
  });

  it("reports saved config-only changes without inventing a configured channel", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return { done: true, status: "done", changed: true, channels: [], accounts: [] };
    });

    await controller.start(null);
    await controller.answer("__done__");

    expect(controller.state).toEqual({
      phase: "done",
      channel: null,
      changed: true,
      channels: [],
      accounts: [],
    });
  });

  it("cancel clears the session and notifies the gateway", async () => {
    const calls: string[] = [];
    const { controller } = createController(async (method) => {
      calls.push(method);
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return { status: "cancelled" };
    });

    await controller.start("slack");
    await controller.cancel();
    expect(controller.state).toEqual({ phase: "idle" });
    expect(calls).toContain("wizard.cancel");
  });

  it("waits for a protected write to settle before cancellation completes", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      if (method === "wizard.cancel") {
        return { status: "running" };
      }
      if (method === "wizard.status") {
        statusCalls += 1;
        return { status: statusCalls === 1 ? "running" : "cancelled" };
      }
      throw new Error(`unexpected ${method}`);
    });

    await controller.start("telegram");
    const cancellation = controller.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await cancellation;

    expect(statusCalls).toBe(2);
    expect(controller.state).toEqual({ phase: "idle" });
  });

  it("reports a persisted channels outcome returned by cancellation", async () => {
    const onPersistedResult = vi.fn();
    const { controller } = createController(
      async (method) => {
        if (method === "wizard.start") {
          return { sessionId: "s1", done: false, status: "running", step: selectStep };
        }
        if (method === "wizard.cancel") {
          return {
            status: "cancelled",
            changed: true,
            channels: [],
            accounts: [],
          };
        }
        throw new Error(`unexpected ${method}`);
      },
      () => false,
      onPersistedResult,
    );

    await controller.start("telegram");
    await expect(controller.cancel()).resolves.toBe(true);

    expect(onPersistedResult).toHaveBeenCalledWith({ accounts: [], completed: false });
  });

  it("ignores answers while a previous answer is in flight", async () => {
    let resolveNext: (value: unknown) => void = () => {};
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return await new Promise((resolve) => {
        resolveNext = resolve;
      });
    });

    await controller.start("telegram");
    const first = controller.answer("telegram");
    await Promise.resolve();
    await controller.answer("again");
    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);
    resolveNext({
      done: true,
      status: "done",
      channels: ["telegram"],
      accounts: [{ channel: "telegram", accountId: "default" }],
    });
    await first;
    expect(controller.state).toEqual({
      phase: "done",
      channel: "telegram",
      changed: true,
      channels: ["telegram"],
      accounts: [{ channel: "telegram", accountId: "default" }],
    });
  });
});

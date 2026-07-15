import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { ChannelWizardHost } from "./wizard-host.ts";

describe("ChannelWizardHost", () => {
  it("refreshes saved state when page teardown cancels a live session", async () => {
    const refreshRuntimeConfig = vi.fn(async () => undefined);
    const refreshChannels = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "wizard.start") {
        return {
          sessionId: "session-1",
          done: false,
          status: "running",
          step: { id: "token", type: "text", message: "Token" },
        };
      }
      if (method === "wizard.cancel") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = {
      gateway: { snapshot: { client: { request } } },
      runtimeConfig: {
        state: { configFormDirty: false },
        refresh: refreshRuntimeConfig,
      },
      channels: {
        state: { channelsSnapshot: null },
        refresh: refreshChannels,
      },
    } as unknown as ApplicationContext;
    const host = new ChannelWizardHost({
      getContext: () => context,
      requestUpdate: () => undefined,
      clearSelection: () => undefined,
    });

    host.startSetup("telegram");
    await vi.waitFor(() => expect(host.state.phase).toBe("step"));

    host.cancelOnDisconnect();
    await vi.waitFor(() => expect(refreshRuntimeConfig).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "session-1" });
    expect(refreshRuntimeConfig).toHaveBeenCalledWith();
    expect(refreshChannels).toHaveBeenCalledWith(true);
  });

  it("refreshes saved state after closing an errored live session", async () => {
    const refreshRuntimeConfig = vi.fn(async () => undefined);
    const refreshChannels = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "wizard.start") {
        return {
          sessionId: "session-1",
          done: false,
          status: "running",
          step: { id: "token", type: "text", message: "Token" },
        };
      }
      if (method === "wizard.next") {
        throw new Error("gateway request failed");
      }
      if (method === "wizard.cancel") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = {
      gateway: { snapshot: { client: { request } } },
      runtimeConfig: {
        state: { configFormDirty: false },
        refresh: refreshRuntimeConfig,
      },
      channels: {
        state: { channelsSnapshot: null },
        refresh: refreshChannels,
      },
    } as unknown as ApplicationContext;
    const host = new ChannelWizardHost({
      getContext: () => context,
      requestUpdate: () => undefined,
      clearSelection: () => undefined,
    });

    host.startSetup("telegram");
    await vi.waitFor(() => expect(host.state.phase).toBe("step"));
    host.answer("token");
    await vi.waitFor(() => expect(host.state.phase).toBe("error"));

    host.close();
    await vi.waitFor(() => expect(refreshRuntimeConfig).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "session-1" });
    expect(refreshRuntimeConfig).toHaveBeenCalledWith();
    expect(refreshChannels).toHaveBeenCalledWith(true);
  });

  it("does not discard edits made while protected cancellation settles", async () => {
    let finishCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const refreshRuntimeConfig = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "wizard.start") {
        return {
          sessionId: "session-1",
          done: false,
          status: "running",
          step: { id: "token", type: "text", message: "Token" },
        };
      }
      if (method === "wizard.cancel") {
        await cancellationGate;
        return { status: "cancelled", changed: true, channels: [], accounts: [] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = {
      gateway: { snapshot: { client: { request } } },
      runtimeConfig: {
        state: { configFormDirty: false },
        refresh: refreshRuntimeConfig,
      },
      channels: {
        state: { channelsSnapshot: null },
        refresh: vi.fn(async () => undefined),
      },
    } as unknown as ApplicationContext;
    const host = new ChannelWizardHost({
      getContext: () => context,
      requestUpdate: () => undefined,
      clearSelection: () => undefined,
    });

    host.startSetup("telegram");
    await vi.waitFor(() => expect(host.state.phase).toBe("step"));
    host.close();
    context.runtimeConfig.state.configFormDirty = true;
    finishCancellation();
    await vi.waitFor(() => expect(refreshRuntimeConfig).toHaveBeenCalledOnce());

    expect(refreshRuntimeConfig).toHaveBeenCalledWith();
    expect(context.runtimeConfig.state.configFormDirty).toBe(true);
  });
});

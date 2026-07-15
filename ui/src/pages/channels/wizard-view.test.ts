/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChannelWizard } from "./wizard-view.ts";

describe("renderChannelWizard", () => {
  it("renders the advertised Back action and forwards the click", () => {
    const onNavigate = vi.fn();
    const container = document.createElement("div");

    render(
      renderChannelWizard({
        wizard: {
          phase: "step",
          channel: "telegram",
          step: {
            id: "step-token",
            type: "text",
            message: "Token",
            navigation: { canGoBack: true, canGoForward: false },
          },
          stepIndex: 2,
          busy: false,
          validationError: null,
        },
        channelLabel: () => "Telegram",
        multiselectValues: [],
        onToggleMultiselect: vi.fn(),
        onAnswer: vi.fn(),
        onNavigate,
        onClose: vi.fn(),
        whatsappQrDataUrl: null,
        whatsappMessage: null,
        whatsappConnected: null,
        whatsappBusy: false,
        onWhatsAppStart: vi.fn(),
        onWhatsAppWait: vi.fn(),
      }),
      container,
    );

    const back = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Back",
    );
    expect(back).toBeTruthy();
    back?.click();
    expect(onNavigate).toHaveBeenCalledWith("back");
  });

  it("renders Forward for a replayed select with a remembered answer", () => {
    const onNavigate = vi.fn();
    const container = document.createElement("div");

    render(
      renderChannelWizard({
        wizard: {
          phase: "step",
          channel: "telegram",
          step: {
            id: "step-select",
            type: "select",
            message: "Choose a mode",
            options: [{ value: "default", label: "Default" }],
            initialValue: "default",
            navigation: { canGoBack: true, canGoForward: true },
          },
          stepIndex: 2,
          busy: false,
          validationError: null,
        },
        channelLabel: () => "Telegram",
        multiselectValues: [],
        onToggleMultiselect: vi.fn(),
        onAnswer: vi.fn(),
        onNavigate,
        onClose: vi.fn(),
        whatsappQrDataUrl: null,
        whatsappMessage: null,
        whatsappConnected: null,
        whatsappBusy: false,
        onWhatsAppStart: vi.fn(),
        onWhatsAppWait: vi.fn(),
      }),
      container,
    );

    const forward = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Continue",
    );
    expect(forward).toBeTruthy();
    forward?.click();
    expect(onNavigate).toHaveBeenCalledWith("forward");
  });

  it("does not call a saved config-only completion a no-op", () => {
    const container = document.createElement("div");

    render(
      renderChannelWizard({
        wizard: {
          phase: "done",
          channel: null,
          changed: true,
          channels: [],
          accounts: [],
        },
        channelLabel: () => "Channel",
        multiselectValues: [],
        onToggleMultiselect: vi.fn(),
        onAnswer: vi.fn(),
        onNavigate: vi.fn(),
        onClose: vi.fn(),
        whatsappQrDataUrl: null,
        whatsappMessage: null,
        whatsappConnected: null,
        whatsappBusy: false,
        onWhatsAppStart: vi.fn(),
        onWhatsAppWait: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).not.toContain("No changes made");
    expect(container.textContent).toContain("Channel configured");
  });
});

// Wizard session helpers track onboarding session ids and state.
import { randomUUID } from "node:crypto";
import type {
  WizardNextResult as GatewayWizardNextResult,
  WizardStep as GatewayWizardStep,
} from "../../packages/gateway-protocol/src/schema/wizard.js";
import { createDeferred, type Deferred } from "../shared/deferred.js";
import {
  WizardCancelledError,
  WizardNavigationError,
  type WizardProgress,
  type WizardPrompter,
} from "./prompts.js";

// WizardSession exposes interactive setup as a step/answer protocol for remote
// clients while reusing the same WizardPrompter contract as the local CLI.
export type WizardStep = GatewayWizardStep;

type WizardSessionStatus = "running" | "done" | "cancelled" | "error";

type WizardNextResult = Omit<GatewayWizardNextResult, "status"> & {
  status: WizardSessionStatus;
};

function normalizeTextAnswer(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

class WizardSessionPrompter implements WizardPrompter {
  constructor(private session: WizardSession) {}

  async intro(title: string): Promise<void> {
    await this.prompt({
      type: "note",
      title,
      message: "",
      executor: "client",
    });
  }

  async outro(message: string): Promise<void> {
    await this.prompt({
      type: "note",
      title: "Done",
      message,
      executor: "client",
    });
  }

  async note(message: string, title?: string): Promise<void> {
    await this.prompt({ type: "note", title, message, executor: "client" });
  }

  async deviceCode(params: {
    title: string;
    code: string;
    expiresInMinutes?: number;
    message?: string;
  }): Promise<void> {
    const fallbackMessage = [
      params.message ?? "Enter this one-time code on the provider's sign-in page.",
      `Code: ${params.code}`,
      ...(params.expiresInMinutes
        ? [`Code expires in ${params.expiresInMinutes} minutes. Never share it.`]
        : []),
    ].join("\n");
    await this.prompt({
      type: "note",
      title: params.title,
      message: fallbackMessage,
      deviceCode: {
        code: params.code,
        ...(params.expiresInMinutes ? { expiresInMinutes: params.expiresInMinutes } : {}),
        ...(params.message ? { message: params.message } : {}),
      },
      executor: "client",
    });
  }

  async plain(message: string): Promise<void> {
    await this.prompt({ type: "note", message, format: "plain", executor: "client" });
  }

  async select<T>(params: Parameters<WizardPrompter["select"]>[0]): Promise<T> {
    const res = await this.prompt({
      type: "select",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValue,
      navigation: params.navigation,
      executor: "client",
    });
    return res as T;
  }

  async multiselect<T>(params: Parameters<WizardPrompter["multiselect"]>[0]): Promise<T[]> {
    const res = await this.prompt({
      type: "multiselect",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValues,
      navigation: params.navigation,
      executor: "client",
    });
    return (Array.isArray(res) ? res : []) as T[];
  }

  async text(params: Parameters<WizardPrompter["text"]>[0]): Promise<string> {
    const res = await this.session.awaitAnswer(
      this.createStep({
        type: "text",
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        sensitive: params.sensitive,
        navigation: params.navigation,
        executor: "client",
      }),
      params.validate,
    );
    const value =
      res === null || res === undefined
        ? ""
        : typeof res === "string"
          ? res
          : typeof res === "number" || typeof res === "boolean" || typeof res === "bigint"
            ? String(res)
            : "";
    return value;
  }

  async confirm(params: Parameters<WizardPrompter["confirm"]>[0]): Promise<boolean> {
    const res = await this.prompt({
      type: "confirm",
      message: params.message,
      initialValue: params.initialValue,
      navigation: params.navigation,
      executor: "client",
    });
    return Boolean(res);
  }

  progress(_label: string): WizardProgress {
    return {
      update: (_message) => {},
      stop: (_message) => {},
    };
  }

  async openUrl(url: string): Promise<void> {
    this.session.queueExternalUrl(url);
  }

  private async prompt(step: Omit<WizardStep, "id">): Promise<unknown> {
    return await this.session.awaitAnswer(this.createStep(step));
  }

  private createStep(step: Omit<WizardStep, "id">): WizardStep {
    // Each emitted step receives an id so remote clients can answer the exact
    // pending prompt and stale answers can be rejected. Explicit browser
    // destinations bind to the very next step regardless of its input type.
    const externalUrl = this.session.consumeExternalUrl();
    return {
      ...step,
      ...(externalUrl ? { externalUrl } : {}),
      id: randomUUID(),
    };
  }
}

export class WizardSession {
  private readonly abortController = new AbortController();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timeoutMs: number | undefined;
  private currentStep: WizardStep | null = null;
  private stepDeferred: Deferred<WizardStep | null> | null = null;
  private pendingTerminalResolution = false;
  private cancellationLocked = false;
  private cancellationRequestedWhileLocked = false;
  private pendingExternalUrl: string | undefined;
  private answerDeferred = new Map<
    string,
    {
      deferred: Deferred<unknown>;
      text: boolean;
      validate?: (value: string) => string | undefined;
    }
  >();
  private status: WizardSessionStatus = "running";
  private error: string | undefined;
  private configuredResult:
    | { accounts: Array<{ channel: string; accountId: string }>; changed: boolean }
    | undefined;

  constructor(
    private runner: (
      prompter: WizardPrompter,
      signal: AbortSignal,
      session: WizardSession,
    ) => Promise<void>,
    options?: { timeoutMs?: number },
  ) {
    const prompter = new WizardSessionPrompter(this);
    this.timeoutMs = options?.timeoutMs;
    this.rearmExpiryTimer();
    void this.run(prompter);
  }

  async next(): Promise<WizardNextResult> {
    if (this.currentStep) {
      return { done: false, step: this.currentStep, status: this.status };
    }
    if (this.pendingTerminalResolution) {
      this.pendingTerminalResolution = false;
      return this.terminalResult();
    }
    if (this.status !== "running") {
      return this.terminalResult();
    }
    if (!this.stepDeferred) {
      this.stepDeferred = createDeferred();
    }
    const step = await this.stepDeferred.promise;
    if (step) {
      return { done: false, step, status: this.status };
    }
    return this.terminalResult();
  }

  private terminalResult(): WizardNextResult {
    if (!this.configuredResult) {
      return { done: true, status: this.status, error: this.error };
    }
    return {
      done: true,
      status: this.status,
      error: this.error,
      changed: this.configuredResult.changed,
      channels: [...new Set(this.configuredResult.accounts.map((entry) => entry.channel))],
      accounts: this.configuredResult.accounts.map((entry) => ({ ...entry })),
    };
  }

  /** Record the saved channels-flow outcome (channels flow only). */
  setConfiguredResult(result: {
    accounts: ReadonlyArray<{ channel: string; accountId: string }>;
    changed: boolean;
  }) {
    this.configuredResult = {
      accounts: result.accounts.map((entry) => ({ ...entry })),
      changed: result.changed,
    };
  }

  /** Read the latest durable channels-flow outcome without exposing mutable session state. */
  getConfiguredResult():
    | { accounts: Array<{ channel: string; accountId: string }>; changed: boolean }
    | undefined {
    if (!this.configuredResult) {
      return undefined;
    }
    return {
      accounts: this.configuredResult.accounts.map((entry) => ({ ...entry })),
      changed: this.configuredResult.changed,
    };
  }

  async answer(stepId: string, value: unknown): Promise<string | undefined> {
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      throw new Error("wizard: no pending step");
    }
    const normalizedValue = pending.text ? normalizeTextAnswer(value) : value;
    if (pending.text && normalizedValue === undefined) {
      return "wizard: text answer must be a scalar value";
    }
    const validationError = pending.validate?.(normalizedValue as string) ?? undefined;
    if (validationError) {
      return validationError;
    }
    this.answerDeferred.delete(stepId);
    this.currentStep = null;
    this.rearmExpiryTimer();
    pending.deferred.resolve(normalizedValue);
    return undefined;
  }

  async navigate(stepId: string, direction: "back" | "forward"): Promise<void> {
    const pending = this.answerDeferred.get(stepId);
    if (!pending || this.currentStep?.id !== stepId) {
      throw new Error("wizard: no pending step");
    }
    const allowed =
      direction === "back"
        ? this.currentStep.navigation?.canGoBack
        : this.currentStep.navigation?.canGoForward;
    if (!allowed) {
      throw new Error(`wizard: navigation ${direction} unavailable`);
    }
    this.answerDeferred.delete(stepId);
    this.currentStep = null;
    this.rearmExpiryTimer();
    pending.deferred.reject(new WizardNavigationError(direction));
  }

  cancel(): boolean {
    if (this.status !== "running") {
      return false;
    }
    if (this.cancellationLocked) {
      this.cancellationRequestedWhileLocked = true;
      this.acknowledgeLockedPresentationStep();
      return false;
    }
    return this.cancelNow();
  }

  private cancelNow(): boolean {
    if (this.status !== "running") {
      return false;
    }
    this.status = "cancelled";
    this.error = "cancelled";
    this.abortController.abort(new WizardCancelledError());
    this.currentStep = null;
    for (const [, pending] of this.answerDeferred) {
      // Reject all pending prompt promises so the runner can unwind through its
      // normal cancellation path.
      pending.deferred.reject(new WizardCancelledError());
    }
    this.answerDeferred.clear();
    this.resolveStep(null);
    return true;
  }

  private expire() {
    // Expiry is a hard lifecycle bound, unlike an operator close request. A
    // hung durable call must eventually release restart/reload blockers.
    this.cancellationLocked = false;
    this.cancellationRequestedWhileLocked = false;
    this.cancelNow();
  }

  /** Protect the current durable operation until it completes or reaches another prompt. */
  lockCancellation() {
    this.cancellationLocked = true;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  pushStep(step: WizardStep) {
    this.currentStep = step;
    this.resolveStep(step);
  }

  queueExternalUrl(url: string) {
    this.pendingExternalUrl = url;
  }

  consumeExternalUrl(): string | undefined {
    const url = this.pendingExternalUrl;
    this.pendingExternalUrl = undefined;
    return url;
  }

  private async run(prompter: WizardPrompter) {
    try {
      await this.runner(prompter, this.signal, this);
      if (this.status === "running") {
        if (this.cancellationRequestedWhileLocked) {
          // The durable effect finished without another input prompt. Honor the
          // queued close only after the runner has persisted its matching state.
          this.cancellationRequestedWhileLocked = false;
          this.cancellationLocked = false;
          this.cancel();
        } else {
          this.status = "done";
        }
      }
    } catch (err) {
      if (this.status !== "running") {
        return;
      }
      if (err instanceof WizardCancelledError) {
        this.status = "cancelled";
        this.error = err.message;
      } else {
        this.status = "error";
        this.error = String(err);
      }
    } finally {
      if (this.expiryTimer) {
        clearTimeout(this.expiryTimer);
      }
      this.resolveStep(null);
    }
  }

  async awaitAnswer(
    step: WizardStep,
    validate?: (value: string) => string | undefined,
  ): Promise<unknown> {
    if (this.status !== "running") {
      throw new Error("wizard: session not running");
    }
    if (step.type !== "note") {
      this.cancellationLocked = false;
      if (this.cancellationRequestedWhileLocked) {
        this.cancellationRequestedWhileLocked = false;
        this.cancel();
        throw new WizardCancelledError();
      }
    } else if (this.cancellationLocked && this.cancellationRequestedWhileLocked) {
      // The client already closed while a durable effect was running. Notes are
      // presentation-only, so acknowledge them and let the protected flow reach
      // its commit/cleanup boundary without waiting for a vanished client.
      return undefined;
    }
    this.pushStep(step);
    const deferred = createDeferred<unknown>();
    this.answerDeferred.set(step.id, { deferred, text: step.type === "text", validate });
    return await deferred.promise;
  }

  private acknowledgeLockedPresentationStep() {
    if (this.currentStep?.type !== "note") {
      return;
    }
    const pending = this.answerDeferred.get(this.currentStep.id);
    if (!pending) {
      return;
    }
    this.answerDeferred.delete(this.currentStep.id);
    this.currentStep = null;
    pending.deferred.resolve(undefined);
  }

  private resolveStep(step: WizardStep | null) {
    if (!this.stepDeferred) {
      if (step === null) {
        // The runner can finish immediately after an answer before next() has
        // installed a waiter; remember that terminal state for the next poll.
        this.pendingTerminalResolution = true;
      }
      return;
    }
    const deferred = this.stepDeferred;
    this.stepDeferred = null;
    deferred.resolve(step);
  }

  private rearmExpiryTimer() {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
    }
    if (this.timeoutMs === undefined || this.status !== "running") {
      this.expiryTimer = undefined;
      return;
    }
    this.expiryTimer = setTimeout(() => this.expire(), this.timeoutMs);
    this.expiryTimer.unref?.();
  }

  getStatus(): WizardSessionStatus {
    return this.status;
  }

  getError(): string | undefined {
    return this.error;
  }
}

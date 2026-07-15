// Drives a gateway channel-setup wizard session (wizard.start flow "channels")
// as a step/answer state machine for the Control UI wizard modal.
import type {
  WizardAnswer,
  WizardNextResult as GatewayWizardNextResult,
  WizardStartResult,
  WizardStatusResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/schema/wizard.js";

type WizardGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

// The browser gateway client does not expose per-request timeouts, so race a
// local ceiling; stale late responses are cleaned up by the generation guard.
async function requestWithTimeout<T>(
  client: WizardGatewayClient,
  method: string,
  params: unknown,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.request<T>(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`wizard request timed out: ${method}`)),
          WIZARD_STEP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type ChannelWizardStep = WizardStep;
export type ChannelWizardStepOption = NonNullable<WizardStep["options"]>[number];
export type ChannelWizardNavigationDirection = NonNullable<WizardAnswer["navigation"]>;
type WizardResult = GatewayWizardNextResult | WizardStartResult;
type PersistedWizardResult = {
  accounts: ReadonlyArray<{ channel: string; accountId: string }>;
  completed: boolean;
};

export type ChannelWizardState =
  | { phase: "idle" }
  | { phase: "starting"; channel: string | null }
  | {
      phase: "step";
      channel: string | null;
      step: ChannelWizardStep;
      stepIndex: number;
      busy: boolean;
      validationError: string | null;
    }
  | {
      phase: "done";
      channel: string | null;
      changed: boolean;
      channels: readonly string[];
      accounts: ReadonlyArray<{ channel: string; accountId: string }>;
    }
  | { phase: "error"; channel: string | null; message: string };

// Long ceiling: a single step can wrap a slow gateway-side effect such as a
// catalog plugin install; the modal stays interactive via the busy flag.
const WIZARD_STEP_TIMEOUT_MS = 120_000;
const WIZARD_CANCEL_POLL_INITIAL_MS = 500;
const WIZARD_CANCEL_POLL_MAX_MS = 5_000;
const WIZARD_CANCEL_SETTLE_TIMEOUT_MS = 5 * 60_000 + 30_000;

async function waitForWizardToSettle(
  client: WizardGatewayClient,
  sessionId: string,
  initialResult: WizardStatusResult,
): Promise<WizardStatusResult> {
  let result = initialResult;
  let pollMs = WIZARD_CANCEL_POLL_INITIAL_MS;
  const deadline = Date.now() + WIZARD_CANCEL_SETTLE_TIMEOUT_MS;
  while (result.status === "running" && Date.now() < deadline) {
    const delayMs = Math.min(pollMs, deadline - Date.now());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    if (Date.now() >= deadline) {
      return result;
    }
    result = await requestWithTimeout<WizardStatusResult>(client, "wizard.status", {
      sessionId,
    });
    pollMs = Math.min(pollMs * 2, WIZARD_CANCEL_POLL_MAX_MS);
  }
  return result;
}

function isChannelPickerStep(step: WizardStep): boolean {
  return (
    step.type === "select" &&
    Boolean(
      step.options?.some((option) => option.value === "__done__" || option.value === "__skip__"),
    )
  );
}

export class ChannelWizardController {
  private currentState: ChannelWizardState = { phase: "idle" };
  private sessionId: string | null = null;
  private channel: string | null = null;
  private stepIndex = 0;
  private generation = 0;

  constructor(
    private readonly getClient: () => WizardGatewayClient | null,
    private readonly onChange: () => void,
    // Known channel ids from the status snapshot. Presentation only: lets a
    // browse-all session title/link the wizard for the picked channel; the
    // completion behavior keys off the gateway-reported accounts instead.
    private readonly isKnownChannel: (value: string) => boolean = () => false,
    private readonly onPersistedResult: (result: PersistedWizardResult) => void = () => {},
  ) {}

  get state(): ChannelWizardState {
    return this.currentState;
  }

  get hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  async start(channel: string | null): Promise<void> {
    const client = this.getClient();
    if (!client) {
      return;
    }
    const generation = ++this.generation;
    this.sessionId = null;
    this.channel = channel;
    this.stepIndex = 0;
    this.setState({ phase: "starting", channel });
    try {
      const result = await requestWithTimeout<WizardStartResult>(client, "wizard.start", {
        flow: "channels",
        ...(channel ? { channel } : {}),
      });
      if (this.generation !== generation) {
        // The modal was closed/superseded mid-start, but the gateway already
        // created a running session; cancel it or later starts get rejected.
        if (result.sessionId && !result.done) {
          void client.request("wizard.cancel", { sessionId: result.sessionId }).catch(() => {});
        }
        return;
      }
      this.sessionId = result.sessionId ?? null;
      this.applyResult(result);
    } catch (err) {
      if (this.generation !== generation) {
        return;
      }
      this.setState({ phase: "error", channel, message: String(err) });
    }
  }

  async answer(value: unknown): Promise<void> {
    await this.advance({ value });
  }

  async navigate(direction: ChannelWizardNavigationDirection): Promise<void> {
    const current = this.currentState;
    const allowed =
      current.phase === "step" &&
      (direction === "back"
        ? current.step.navigation?.canGoBack
        : current.step.navigation?.canGoForward);
    if (!allowed) {
      return;
    }
    await this.advance({ navigation: direction });
  }

  private async advance(answer: Pick<WizardAnswer, "value" | "navigation">): Promise<void> {
    const client = this.getClient();
    const current = this.currentState;
    if (!client || !this.sessionId || current.phase !== "step" || current.busy) {
      return;
    }
    const generation = this.generation;
    if (
      !answer.navigation &&
      isChannelPickerStep(current.step) &&
      typeof answer.value === "string" &&
      this.isKnownChannel(answer.value)
    ) {
      this.channel = answer.value;
    }
    this.setState({ ...current, busy: true, validationError: null });
    try {
      const result = await requestWithTimeout<GatewayWizardNextResult>(client, "wizard.next", {
        sessionId: this.sessionId,
        answer: {
          stepId: current.step.id,
          ...(answer.navigation ? { navigation: answer.navigation } : { value: answer.value }),
        },
      });
      if (this.generation !== generation) {
        return;
      }
      if (
        answer.navigation === "back" &&
        !result.done &&
        result.step &&
        isChannelPickerStep(result.step)
      ) {
        this.channel = null;
      }
      this.applyResult(result);
    } catch (err) {
      if (this.generation !== generation) {
        return;
      }
      this.setState({ phase: "error", channel: this.channel, message: String(err) });
    }
  }

  async cancel(): Promise<boolean> {
    const client = this.getClient();
    const sessionId = this.sessionId;
    this.generation += 1;
    this.sessionId = null;
    this.channel = null;
    this.setState({ phase: "idle" });
    if (client && sessionId) {
      try {
        const result = await client.request<WizardStatusResult>("wizard.cancel", { sessionId });
        const settled = await waitForWizardToSettle(client, sessionId, result);
        return this.reportPersistedResult(settled);
      } catch {
        // Session may already be finished/purged; closing the modal wins.
      }
    }
    return false;
  }

  private applyResult(result: WizardResult): void {
    if (!result.done && result.step) {
      this.stepIndex += 1;
      this.setState({
        phase: "step",
        channel: this.channel,
        step: result.step,
        stepIndex: this.stepIndex,
        busy: false,
        validationError: result.error ?? null,
      });
      return;
    }
    const changed = result.changed ?? (result.channels?.length ?? 0) > 0;
    if (result.done) {
      this.reportPersistedResult(result);
    }
    if (result.status === "done") {
      this.sessionId = null;
      // The gateway reports what the flow actually configured; the initially
      // requested channel is only a preselection and may have been skipped.
      const channels = result.channels ?? [];
      this.setState({
        phase: "done",
        channel: this.channel ?? channels[0] ?? null,
        changed,
        channels,
        accounts: result.accounts ?? [],
      });
      return;
    }
    if (result.status === "cancelled") {
      this.sessionId = null;
      this.channel = null;
      this.setState({ phase: "idle" });
      return;
    }
    this.sessionId = null;
    this.setState({
      phase: "error",
      channel: this.channel,
      message: result.error ?? "Wizard failed.",
    });
  }

  private reportPersistedResult(result: {
    status?: WizardStatusResult["status"];
    changed?: boolean;
    channels?: readonly string[];
    accounts?: ReadonlyArray<{ channel: string; accountId: string }>;
  }): boolean {
    const changed = result.changed ?? (result.channels?.length ?? 0) > 0;
    if (!changed) {
      return false;
    }
    this.onPersistedResult({
      accounts: result.accounts ?? [],
      completed: result.status === "done",
    });
    return true;
  }

  private setState(next: ChannelWizardState): void {
    this.currentState = next;
    this.onChange();
  }
}

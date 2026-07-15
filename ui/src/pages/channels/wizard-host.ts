// Page-side host for the channel setup wizard: owns the RPC controller,
// per-step multiselect state, dirty-config guarding, and completion effects
// (config resync + WhatsApp QR handoff) so the page element stays thin.
import type { ApplicationContext } from "../../app/context.ts";
import {
  ChannelWizardController,
  type ChannelWizardNavigationDirection,
  type ChannelWizardState,
} from "./wizard-controller.ts";

type WizardHostDeps = {
  getContext: () => ApplicationContext | undefined;
  requestUpdate: () => void;
  /** Close any open detail overlay before the wizard modal opens. */
  clearSelection: () => void;
};

export class ChannelWizardHost {
  multiselect: unknown[] = [];
  blockedByDirtyConfig = false;
  private multiselectStepId: string | null = null;
  private readonly controller: ChannelWizardController;

  /** Account the completed wizard configured for WhatsApp QR pairing. */
  whatsappAccountId: string | undefined;

  constructor(private readonly deps: WizardHostDeps) {
    this.controller = new ChannelWizardController(
      () => deps.getContext()?.gateway.snapshot.client ?? null,
      () => this.handleControllerChange(),
      (value) =>
        deps
          .getContext()
          ?.channels.state.channelsSnapshot?.channelMeta?.some((entry) => entry.id === value) ??
        false,
      ({ accounts, completed }) => {
        void this.handlePersistedResult(accounts, completed);
      },
    );
  }

  get state(): ChannelWizardState {
    return this.controller.state;
  }

  startSetup(channel: string | null): void {
    // Wizard completion resyncs config from disk (discarding local drafts), so
    // refuse to start while the advanced form holds unsaved edits.
    if (this.deps.getContext()?.runtimeConfig.state.configFormDirty) {
      this.blockedByDirtyConfig = true;
      this.deps.requestUpdate();
      return;
    }
    this.blockedByDirtyConfig = false;
    this.whatsappAccountId = undefined;
    this.deps.clearSelection();
    void this.controller.start(channel);
  }

  close(): void {
    const phase = this.controller.state.phase;
    const hadActiveSession = this.controller.hasActiveSession;
    const cancellation = this.controller.cancel();
    if (phase === "starting" || phase === "step" || (phase === "error" && hadActiveSession)) {
      // A failed/absent cancel response has an unknown commit outcome. The
      // protocol normally reports retained writes; fall back to a safe resync.
      void cancellation.then((reportedPersistedResult) => {
        if (!reportedPersistedResult) {
          void this.handlePersistedResult([], false);
        }
      });
    }
  }

  /** Cancel (not just reset) on page teardown: the gateway keeps a running
   * WizardSession and rejects future wizard.start calls until cancelled. */
  cancelOnDisconnect(): void {
    const hadActiveSession = this.controller.hasActiveSession;
    const cancellation = this.controller.cancel();
    if (hadActiveSession) {
      // Teardown can happen after an intermediate plugin-install commit. Use a
      // safe resync only when the cancel response did not report that outcome.
      void cancellation.then((reportedPersistedResult) => {
        if (!reportedPersistedResult) {
          void this.handlePersistedResult([], false);
        }
      });
    }
  }

  answer(value: unknown): void {
    void this.controller.answer(value);
  }

  navigate(direction: ChannelWizardNavigationDirection): void {
    void this.controller.navigate(direction);
  }

  toggleMultiselect(value: unknown): void {
    this.multiselect = this.multiselect.includes(value)
      ? this.multiselect.filter((entry) => entry !== value)
      : [...this.multiselect, value];
    this.deps.requestUpdate();
  }

  private handleControllerChange(): void {
    // Pending multiselect toggles survive busy re-renders but reset per step.
    const wizard = this.controller.state;
    const stepId = wizard.phase === "step" ? wizard.step.id : null;
    if (stepId !== this.multiselectStepId) {
      this.multiselectStepId = stepId;
      this.multiselect =
        wizard.phase === "step" && Array.isArray(wizard.step.initialValue)
          ? [...wizard.step.initialValue]
          : [];
    }
    this.deps.requestUpdate();
  }

  private async handlePersistedResult(
    accounts: ReadonlyArray<{ channel: string; accountId: string }>,
    completed: boolean,
  ): Promise<void> {
    const context = this.deps.getContext();
    if (!context) {
      return;
    }
    // Preserve edits made while a protected cancellation was settling. A
    // normal refresh updates the snapshot but retains a dirty draft/base hash,
    // so a later save conflicts instead of overwriting the wizard commit.
    await context.runtimeConfig.refresh();
    await context.channels.refresh(true);
    const whatsapp = completed ? accounts.find((entry) => entry.channel === "whatsapp") : undefined;
    if (whatsapp) {
      // Jump straight into QR pairing for the account the wizard configured;
      // the wizard modal renders the QR phase.
      this.whatsappAccountId = whatsapp.accountId;
      await context.channels.startWhatsApp(false, whatsapp.accountId);
    }
  }
}

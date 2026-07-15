// Configured channel actions update, disable, or remove existing accounts.
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type {
  ChannelSetupConfiguredResult,
  ChannelSetupPlugin,
  ChannelSetupWizardAdapter,
  SetupChannelsOptions,
} from "../channels/plugins/setup-wizard-types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  formatAccountLabel,
  promptConfiguredAction,
  promptRemovalAccountId,
} from "./channel-setup.prompts.js";

export async function handleConfiguredChannel(params: {
  accountOverrides: Partial<Record<ChannelChoice, string>>;
  adapter: ChannelSetupWizardAdapter | undefined;
  applyCustomSetupResult: (result: ChannelSetupConfiguredResult) => Promise<void>;
  cfg: OpenClawConfig;
  channel: ChannelChoice;
  configureChannel: () => Promise<void>;
  forceAllowFrom: boolean;
  label: string;
  options: SetupChannelsOptions;
  plugin: ChannelSetupPlugin | undefined;
  prompter: WizardPrompter;
  refreshStatus: () => Promise<void>;
  runtime: RuntimeEnv;
  shouldPromptAccountIds: boolean;
  updateConfig: (cfg: OpenClawConfig) => void;
}): Promise<void> {
  const { adapter, channel, label, options, plugin, prompter } = params;
  if (adapter?.configureWhenConfigured) {
    const result = await adapter.configureWhenConfigured({
      cfg: params.cfg,
      runtime: params.runtime,
      prompter,
      options,
      accountOverrides: params.accountOverrides,
      shouldPromptAccountIds: params.shouldPromptAccountIds,
      forceAllowFrom: params.forceAllowFrom,
      configured: true,
      label,
    });
    await params.applyCustomSetupResult(result);
    return;
  }

  const supportsDisable = Boolean(
    options.allowDisable && (plugin?.config.setAccountEnabled || adapter?.disable),
  );
  const supportsDelete = Boolean(options.allowDisable && plugin?.config.deleteAccount);
  const action = await promptConfiguredAction({
    prompter,
    label,
    supportsDisable,
    supportsDelete,
  });
  if (action === "skip") {
    return;
  }
  if (action === "update") {
    await params.configureChannel();
    return;
  }
  if (!options.allowDisable) {
    return;
  }
  if (action === "delete" && !supportsDelete) {
    await prompter.note(
      t("wizard.channels.configuredDeleteUnsupported", { label }),
      t("wizard.channels.removeTitle"),
    );
    return;
  }

  const shouldPromptAccount =
    action === "delete"
      ? Boolean(plugin?.config.deleteAccount)
      : Boolean(plugin?.config.setAccountEnabled);
  const accountId = shouldPromptAccount
    ? await promptRemovalAccountId({
        cfg: params.cfg,
        prompter,
        label,
        channel,
        plugin,
      })
    : DEFAULT_ACCOUNT_ID;
  const resolvedAccountId =
    normalizeAccountId(accountId) ??
    (plugin ? resolveChannelDefaultAccountId({ plugin, cfg: params.cfg }) : DEFAULT_ACCOUNT_ID);
  const accountLabel = formatAccountLabel(resolvedAccountId);

  if (action === "delete") {
    const confirmed = await prompter.confirm({
      message: t("wizard.channels.deleteAccount", { label, account: accountLabel }),
      initialValue: false,
    });
    if (!confirmed) {
      return;
    }
    if (plugin?.config.deleteAccount) {
      params.updateConfig(
        plugin.config.deleteAccount({ cfg: params.cfg, accountId: resolvedAccountId }),
      );
    }
    await params.refreshStatus();
    return;
  }

  if (plugin?.config.setAccountEnabled) {
    params.updateConfig(
      plugin.config.setAccountEnabled({
        cfg: params.cfg,
        accountId: resolvedAccountId,
        enabled: false,
      }),
    );
  } else if (adapter?.disable) {
    params.updateConfig(adapter.disable(params.cfg));
  }
  await params.refreshStatus();
}

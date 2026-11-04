import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register usage commands without eagerly loading the report viewer. */
export function registerUsageCommand(pi: ExtensionAPI): void {
  if (process.env.PI_ENHANCED_DISCORD_GATEWAY_CHILD === "1") {
    pi.registerCommand("discord-usage", {
      description: "Collect a private Discord usage report",
      handler: async (args, ctx) => {
        const { collectUsageReports } = await import("./command.js");
        const { formatUsageText } = await import("./format.js");
        try {
          const withoutSession = args.trim() === "no-session";
          const model = withoutSession ? undefined : ctx.model;
          const result = await collectUsageReports({
            signal: ctx.signal,
            sessionId: withoutSession ? undefined : ctx.sessionManager?.getSessionId?.(),
            currentProvider: model?.provider,
            currentModelId: model ? `${model.provider}/${model.id}` : undefined,
          });
          ctx.ui.notify(result.reports.length
            ? formatUsageText(result.reports, { sessionInfo: result.sessionInfo, availableWidth: 70, colorize: false })
            : "No active provider accounts found to report usage for.");
        } catch {
          ctx.ui.notify("Failed to fetch usage reports.", "error");
        }
      },
    });
  }
  pi.registerCommand("usage", {
    description: "Display provider quota and rate limit status across all configured accounts",
    handler: async (_args, ctx) => {
      const { handleUsageCommand } = await import("./command.js");
      await handleUsageCommand(ctx);
    },
  });
}

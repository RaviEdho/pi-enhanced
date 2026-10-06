import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export function registerOutputCompressor(pi: ExtensionAPI): void {
  // Intercept tool results from bash/powershell to filter noisy output before LLM context
  pi.on("tool_result", async (event: ToolResultEvent) => {
    try {
      if (process.env.PI_COMPRESSOR_DISABLED === "1" || process.env.PI_FILTER_DISABLED === "1") {
        return;
      }

      if (event.toolName !== "bash" && event.toolName !== "powershell") {
        return;
      }

      const command = typeof event.input?.command === "string" ? event.input.command.trim() : "";
      if (!command) {
        return;
      }

      // Extract raw text from text blocks in result content
      const textBlocks = event.content.filter(
        (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string"
      );
      if (textBlocks.length === 0) {
        return;
      }

      const rawText = textBlocks.map((c) => c.text).join("\n");
      const { runFilterPipeline } = await import("./pipeline.js");
      const { RecallStore } = await import("./recall.js");
      const { GainTracker } = await import("./tracker.js");
      const tracker = GainTracker.getInstance();
      const recallStore = RecallStore.getInstance();
      const result = runFilterPipeline(command, rawText, event.isError);

      if (!result || result.text === rawText) {
        return;
      }

      // Record savings in tracker
      tracker.record(command, result.filterName, result.originalBytes, result.filteredBytes);

      // Save raw output in recall store.
      // ONLY attach /recall hint to LLM context when the compression is LOSSY (content truncated/omitted).
      // For lossless operations, quietly cache in memory (if > 150B) so user can still manually inspect,
      // but never pollute the model prompt with recall noise.
      let recallHint = "";
      if (result.lossy) {
        const recallId = recallStore.save(command, rawText, result.text, result.savedBytes);
        recallHint = `\n[full output: /recall ${recallId}]`;
      } else if (result.savedBytes > 150) {
        recallStore.save(command, rawText, result.text, result.savedBytes);
      }

      // Return compressed content back to Pi
      return {
        content: [{ type: "text", text: result.text + recallHint }],
        isError: event.isError,
      };
    } catch (err) {
      // Fail open: an error in filtering must never break command execution
      console.warn("[compressor] unexpected error in tool_result filter; passing raw output", err);
      return;
    }
  });

  // /recall command to inspect raw unfiltered command output
  pi.registerCommand("recall", {
    description: "Inspect the raw unfiltered output of a recent command: /recall [id]",
    handler: async (args, ctx) => {
      const { RecallStore } = await import("./recall.js");
      const recallStore = RecallStore.getInstance();
      const id = args?.trim();

      if (!id) {
        const recent = recallStore.list(10);
        if (recent.length === 0) {
          if (ctx.hasUI && ctx.mode === "tui") {
            ctx.ui.notify("No recent command outputs cached in recall store.", "info");
          } else {
            console.log("No recent command outputs cached in recall store.");
          }
          return;
        }

        if (ctx.hasUI && ctx.mode === "tui") {
          const options = recent.map((r) => {
            const ageSec = Math.round((Date.now() - r.timestamp) / 1000);
            return `${r.id} - ${r.command.slice(0, 45)} (${ageSec}s ago, saved ${r.savedBytes} B)`;
          });

          const selected = await ctx.ui.select("Select a cached command output to view:", options);
          if (!selected) return;

          const selectedId = selected.split(" - ")[0];
          const entry = recallStore.get(selectedId);
          if (entry) {
            await ctx.ui.editor(`Raw Output: ${entry.command}`, entry.rawText);
          }
        } else {
          console.log("Recent filtered command outputs:");
          for (const r of recent) {
            const ageSec = Math.round((Date.now() - r.timestamp) / 1000);
            console.log(`  ${r.id} - ${r.command.slice(0, 50)} (${ageSec}s ago, saved ${r.savedBytes} B)`);
          }
          console.log("\nRun `/recall <id>` to inspect full raw output.");
        }
        return;
      }

      const entry = recallStore.get(id);
      if (!entry) {
        if (ctx.hasUI && ctx.mode === "tui") {
          ctx.ui.notify(`Recall ID "${id}" not found in cache.`, "error");
        } else {
          console.error(`Recall ID "${id}" not found in cache.`);
        }
        return;
      }

      if (ctx.hasUI && ctx.mode === "tui") {
        await ctx.ui.editor(`Raw Output: ${entry.command}`, entry.rawText);
      } else {
        console.log(`=== Raw Output: ${entry.command} ===\n${entry.rawText}`);
      }
    },
  });

  // /gain command to view token savings analytics
  pi.registerCommand("gain", {
    description: "Display token savings achieved by native output filtering",
    handler: async (_args, ctx) => {
      const { GainTracker } = await import("./tracker.js");
      const tracker = GainTracker.getInstance();
      const summaryText = tracker.formatSummary();
      if (ctx.hasUI && ctx.mode === "tui") {
        ctx.ui.notify(summaryText, "info");
      } else {
        console.log(summaryText);
      }
    },
  });
}

// Backward-compatible alias
export const registerOutputFilter = registerOutputCompressor;


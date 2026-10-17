import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PlanModeManager } from "./manager.js";

/**
 * Checks whether an assistant message contains a structured implementation plan artifact.
 *
 * Looks for common plan headings followed by at least two ordered steps
 * (e.g. "1. ...", "2. ...") or task checkboxes (e.g. "- [ ] ...").
 */
export function hasPlanArtifact(text: string): boolean {
  if (!text || text.length < 40) return false;

  const headerRegex =
    /(?:^|\n)\s*(?:#+\s*|\*{1,2}|__)?\s*(?:Implementation\s+Plan|Execution\s+Plan|Action\s+Plan|Proposed\s+Plan|Plan)\s*(?::|\*{1,2}|__)*\s*(?:\n|$)/i;
  const match = text.match(headerRegex);
  if (!match || match.index === undefined) return false;

  const afterHeader = text.slice(match.index + match[0].length);
  const stepMatches = afterHeader.match(/^\s*(?:\d+[\.\)]|[-*+]\s+\[[ x]\])\s+\S+/gim);
  return !!(stepMatches && stepMatches.length >= 2);
}

/**
 * Extracts plain text from the latest assistant message.
 */
export function extractLastAssistantText(messages: AgentMessage[]): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return "";

  if (typeof lastAssistant.content === "string") {
    return lastAssistant.content;
  }

  if (Array.isArray(lastAssistant.content)) {
    return lastAssistant.content
      .filter((block): block is TextContent => (block as any).type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  return "";
}

/**
 * Intercepts turn settlement in Plan Mode.
 *
 * If the model has drafted a concrete implementation plan, presents an interactive
 * Human-in-the-Loop selection menu to execute, refine, or remain in planning mode.
 */
export async function handlePlanApprovalGate(
  event: AgentEndEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  const manager = PlanModeManager.getInstance();
  if (!manager.isEnabled()) return;
  if (!ctx.hasUI) return;

  const text = extractLastAssistantText(event.messages);
  if (!hasPlanArtifact(text)) return;

  const choice = await ctx.ui.select("Plan ready — choose action:", [
    "▶ Execute plan (restore write access & begin)",
    "✏ Refine plan (enter feedback or adjustments)",
    "■ Stay in plan mode (continue exploration)",
  ]);

  if (choice?.startsWith("▶ Execute")) {
    manager.disable(ctx, true);
    pi.sendUserMessage("Execute the approved implementation plan. Start with step 1.", {
      deliverAs: "followUp",
    });
  } else if (choice?.startsWith("✏ Refine")) {
    const refinement = await ctx.ui.editor("Refine plan (enter adjustments or feedback):", "");
    if (refinement?.trim()) {
      pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
    }
  }
}

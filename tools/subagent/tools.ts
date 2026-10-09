import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runSubagent } from "./runner.js";

const SubagentParametersSchema = Type.Object({
  task: Type.String({
    description: "Detailed instructions or prompt for the subagent to perform in its isolated context.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Short human-readable summary of the subagent's task (e.g. 'Inspect auth middleware').",
    })
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional list of tools the subagent is allowed to use (e.g. ['read', 'bash']). Defaults to ['read', 'bash', 'edit', 'write'].",
    })
  ),
});

export function createSubagentToolDefinition(): ToolDefinition<typeof SubagentParametersSchema, any> {
  return {
    name: "subagent",
    label: "subagent",
    description:
      "Delegate a task to an isolated subagent with its own clean context window. Inherits the current model and thinking effort of the parent session. Intermediate steps stay contained within the subagent, returning only the synthesized outcome back to the main conversation.",
    parameters: SubagentParametersSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.model) {
        return {
          content: [
            {
              type: "text",
              text: "Subagent error: No active model selected in Pi session. Please select a model first.",
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      try {
        const result = await runSubagent({
          task: params.task,
          description: params.description,
          tools: params.tools,
          cwd: ctx.cwd,
          model: ctx.model,
          thinkingLevel: ctx.thinkingLevel ?? "off",
          modelRuntime: (ctx.modelRegistry as any)?.runtime,
          signal,
          onUpdate: (prog) => {
            onUpdate?.({
              content: [{ type: "text", text: `[subagent] ${prog.status}` }],
              details: prog,
            });
          },
        });

        return {
          content: [{ type: "text", text: result.output }],
          details: result,
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Subagent error: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("subagent "));
      const label = args?.description || (args?.task ? args.task.slice(0, 60).replace(/\n/g, " ") : "");
      if (label) {
        text += theme.fg("accent", `"${label}"`);
      }
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
  };
}

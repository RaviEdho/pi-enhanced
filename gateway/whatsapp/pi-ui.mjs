const noop = () => {};
const nothing = async () => {};
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export const whatsappPiTransport = {
  name: "WhatsApp",
  childEnvironment: { PI_ENHANCED_WHATSAPP_GATEWAY_CHILD: "1" },
  systemPrompt: [
    "This is a private WhatsApp DM with the gateway's labeled sender. Each DM has its own saved Pi conversation.",
    "Only the text of accepted messages is forwarded. No chat history, quoted messages, or attachments are imported.",
    "Reply in plain text. This gateway cannot present interactive prompts or collect approvals. If a prompt is dismissed, do not proceed with actions that needed approval; explain what was blocked.",
    "Use the configured Pi workspace; WhatsApp does not support gateway workspace handoffs or management commands in chat.",
  ].join("\n"),
  notifyModelStatus(interaction, text) { return interaction.send(text); },
  createSessionUi(session) {
    // No progress cards, tool narration, arbitrary extension notifications or
    // approval controls. Only the final reply and shared model notices are sent.
    return {
      async handleRequest(request) {
        if (DIALOGS.has(request.method)) {
          if (session.interaction) session.interaction.promptDismissed = true;
          session.sendUiResponse(request.id, { cancelled: true });
        }
      },
      queueAssistantNarration: noop,
      queueToolActivity: noop,
      resetToolActivity: noop,
      resetPrompt: noop,
      stopCommitProgress: noop,
      flushToolActivity: nothing,
      flushNotifications: nothing,
      flushPendingAskUserCompletion: nothing,
      flushCommitMessageEdits: nothing,
      clearStatusMessages: nothing,
      close: nothing,
    };
  },
};

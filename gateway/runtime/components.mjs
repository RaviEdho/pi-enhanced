import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { truncateDiscordText, discordOptionLabel } from "./messages.mjs";

export function buildDiscordUiPayload(pending, statusText, responseValue = pending.result, disableControls = false) {
  const optionGuide = "Select an option below, or reply with its number or exact text.";
  const hasDropdownGuide =
    pending.isAskUser &&
    pending.method === "select" &&
    !pending.isAskUserReview &&
    pending.promptText.endsWith(`\n${optionGuide}`);
  const reviewInstruction = "\n\nSubmit or choose an answer to edit.";
  const hasReviewInstruction =
    pending.isAskUserReview && pending.promptText.endsWith(reviewInstruction);
  let promptContent = hasDropdownGuide
    ? pending.promptText.slice(0, -(optionGuide.length + 1))
    : statusText && hasReviewInstruction
      ? pending.promptText.slice(0, -reviewInstruction.length)
      : pending.promptText;
  if (statusText === "Response received." && pending.isAskUserReview) {
    const titleEnd = promptContent.indexOf("\n");
    const title = titleEnd < 0 ? promptContent : promptContent.slice(0, titleEnd);
    const body = titleEnd < 0 ? "" : promptContent.slice(titleEnd);
    promptContent = `${title.replace(/ — (?:Review your responses|Response):$/, "")}${body}`;
  }
  const responseText =
    statusText === "Response received." && pending.isAskUserQuestion && responseValue !== undefined
      ? `\n\n**Your answer:**\n> ${truncateDiscordText(String(responseValue), 500).replace(/\r?\n/g, "\n> ")}`
      : "";
  const content = statusText ? `${promptContent}${responseText}\n\n${statusText}` : pending.promptText;
  const controls = statusText ? [] : buildDiscordUiComponents(pending, disableControls);
  if (!pending.isAskUser) {
    return {
      content,
      components: controls,
      allowedMentions: { parse: [] },
    };
  }

  const showDropdownGuide = !statusText && hasDropdownGuide;
  const cardContent = showDropdownGuide ? promptContent : content;
  const requestTitle = typeof pending.request?.title === "string" ? pending.request.title : "";
  const questionBreak = requestTitle.indexOf("\n");
  let cardText;
  if (pending.isAskUserReview) {
    const [reviewTitle, ...reviewLines] = cardContent.split("\n");
    const formattedReviewLines = reviewLines.map((line) => {
      const questionMatch = /^(\d+)\.\s+(.+)$/.exec(line);
      if (questionMatch) return `### ${questionMatch[1]}. ${questionMatch[2]}`;
      const answerMatch = /^\s+Answer:\s*(.*)$/.exec(line);
      if (answerMatch) return `> **Answer:** ${answerMatch[1]}`;
      if (line === "Submit or choose an answer to edit.") return `-# ${line}`;
      return line;
    });
    cardText = `## ${reviewTitle}${formattedReviewLines.length ? `\n${formattedReviewLines.join("\n")}` : ""}`;
  } else if (
    requestTitle.startsWith("Ask User") &&
    questionBreak >= 0 &&
    cardContent.startsWith(requestTitle)
  ) {
    const heading = requestTitle.slice(0, questionBreak);
    const question = requestTitle.slice(questionBreak + 1).trim();
    const remainingText = cardContent.slice(requestTitle.length);
    cardText = `## ${heading}${question ? `\n### ${question}` : ""}${remainingText}`;
  } else {
    const firstBreak = cardContent.indexOf("\n");
    const firstLine = firstBreak < 0 ? cardContent : cardContent.slice(0, firstBreak);
    const remainingText = firstBreak < 0 ? "" : cardContent.slice(firstBreak + 1);
    cardText = firstLine.startsWith("Ask User")
      ? `### ${firstLine}${remainingText ? `\n${remainingText}` : ""}`
      : cardContent;
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(cardText));

  if (controls.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    if (showDropdownGuide) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(optionGuide));
    }
    for (const control of controls) container.addActionRowComponents(control);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  };
}

export function buildDiscordUiComponents(pending, disabled = false) {
  if (pending.isAskUserReview) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:review-submit`)
        .setLabel("Submit response")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:review-edit`)
        .setLabel("Edit answer")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    )];
  }

  if (pending.method === "select") {
    const pageSize = 25;
    const pageCount = Math.ceil(pending.options.length / pageSize);
    const pageStart = pending.page * pageSize;
    const visibleOptions = pending.options.slice(pageStart, pageStart + pageSize);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`piui:${pending.token}:select`)
      .setPlaceholder(truncateDiscordText(pageCount > 1 ? `Choose an option (page ${pending.page + 1}/${pageCount})` : "Choose an option", 150))
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(disabled)
      .addOptions(visibleOptions.map((option, index) => ({
        label: discordOptionLabel(option),
        value: String(pageStart + index),
      })));
    const rows = [new ActionRowBuilder().addComponents(menu)];
    const buttons = [];
    if (pageCount > 1) {
      buttons.push(new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:prev`)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || pending.page === 0));
      buttons.push(new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:next`)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || pending.page >= pageCount - 1));
    }
    buttons.push(new ButtonBuilder()
      .setCustomId(`piui:${pending.token}:cancel`)
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled));
    rows.push(new ActionRowBuilder().addComponents(buttons));
    return rows;
  }

  if (pending.method === "confirm") {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`piui:${pending.token}:yes`).setLabel("Yes").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`piui:${pending.token}:no`).setLabel("No").setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`piui:${pending.token}:cancel`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    )];
  }

  const buttonLabel = pending.method === "editor" ? "Open editor" : "Enter response";
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`piui:${pending.token}:open`).setLabel(buttonLabel).setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`piui:${pending.token}:cancel`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  )];
}

export function buildDiscordUiModal(pending) {
  const request = pending.request;
  const isEditor = pending.method === "editor";
  const textInput = new TextInputBuilder()
    .setCustomId("answer")
    .setLabel(isEditor ? "Your text" : "Your response")
    .setStyle(isEditor ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(4000);
  const placeholder = typeof request.placeholder === "string" ? request.placeholder : "";
  if (placeholder) textInput.setPlaceholder(truncateDiscordText(placeholder, 100));
  const prefill = isEditor && typeof request.prefill === "string" ? truncateDiscordText(request.prefill, 4000) : "";
  if (prefill) textInput.setValue(prefill);

  const rawTitle = typeof request.title === "string" ? request.title.replace(/\s+/g, " ").trim() : "";
  const modalTitle = truncateDiscordText(rawTitle || (isEditor ? "Edit text" : "Your response"), 45);
  return new ModalBuilder()
    .setCustomId(`piui:${pending.token}:submit`)
    .setTitle(modalTitle)
    .addComponents(new ActionRowBuilder().addComponents(textInput));
}

export function buildConversationSettingPayload(pending) {
  const pageSize = 25;
  const pageCount = Math.ceil(pending.options.length / pageSize);
  const start = pending.page * pageSize;
  const visibleOptions = pending.options.slice(start, start + pageSize);
  const isModel = pending.setting === "model";
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`picmd:${pending.token}:select`)
    .setPlaceholder(isModel ? "Choose a model" : "Choose a thinking level")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(visibleOptions.map((option, index) => {
      const value = isModel ? `${option?.provider}/${option?.id}` : String(option);
      const label = isModel ? (option?.name || value) : String(option);
      const isCurrent = value === pending.current;
      return {
        label: discordOptionLabel(`${label}${isCurrent ? " (current)" : ""}`),
        value: String(start + index),
        ...(isModel && typeof option?.id === "string" ? { description: discordOptionLabel(value) } : {}),
        default: isCurrent,
      };
    }));
  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (pageCount > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`picmd:${pending.token}:prev`)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pending.page === 0),
      new ButtonBuilder()
        .setCustomId(`picmd:${pending.token}:next`)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pending.page >= pageCount - 1),
    ));
  }
  const current = pending.current ? ` Current: ${pending.current}.` : "";
  return {
    content: `Choose a ${pending.setting === "model" ? "model" : "thinking level"} for this conversation.${current}${pageCount > 1 ? ` Page ${pending.page + 1}/${pageCount}.` : ""}`,
    components: rows,
    allowedMentions: { parse: [] },
  };
}

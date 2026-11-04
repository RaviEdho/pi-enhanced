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

export const ASK_USER_CUSTOM_GUIDE = "Select an option below, or reply with your answer";
export const ASK_USER_CHOICES_GUIDE = "Select an option below, or reply with its number or exact text.";
export const ASK_USER_INPUT_GUIDE = "Reply with your answer in chat.";

export function buildCommitCardPayload(text, { title = "Git commit", workspace, rows = [], statusText, notifyType = "info" } = {}) {
  const color = notifyType === "error" ? 0xed4245 : notifyType === "warning" ? 0xfee75c : 0x5865f2;
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${truncateDiscordText(title, 180)}${workspace ? `\n-# Workspace: ${truncateDiscordText(JSON.stringify(workspace), 500)}` : ""}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text || " "));
  if (statusText) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${truncateDiscordText(statusText, 500)}`));
  if (rows.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    for (const row of rows) container.addActionRowComponents(row);
  }
  return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
}

function buildCommitUiPayload(pending, statusText, responseValue, disableControls) {
  const pages = pending.cardPages || [pending.promptText];
  const page = pending.cardPage || 0;
  const rows = statusText || pending.readOnly ? [] : buildDiscordUiComponents(pending, disableControls);
  if (!statusText && pages.length > 1) {
    rows.unshift(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`piui:${pending.token}:card-prev`).setLabel("Previous page").setStyle(ButtonStyle.Secondary).setDisabled(disableControls || page === 0),
      new ButtonBuilder().setCustomId(`piui:${pending.token}:card-next`).setLabel("Next page").setStyle(ButtonStyle.Secondary).setDisabled(disableControls || page >= pages.length - 1),
    ));
  }
  const selected = statusText === "Response received." && pending.method === "select" && responseValue !== undefined
    ? ` Selected: ${responseValue}` : "";
  const pageLabel = pages.length > 1 ? `Page ${page + 1}/${pages.length}. ` : "";
  const instruction = pending.readOnly ? "" : pending.method === "editor" && (pending.request?.prefill?.length || 0) > 4000
    ? "Editing disabled: plan exceeds Discord's 4000-character limit."
    : pending.commitProposal ? "Review the details. Actions apply to the entire proposal, not just this page."
      : "Review the details before choosing an action.";
  return buildCommitCardPayload(pages[page], {
    title: pending.commitProposal ? "Commit proposal" : pending.request?.title || "Git commit",
    workspace: pending.workspace,
    notifyType: pending.notifyType,
    rows,
    statusText: `${pageLabel}${statusText || instruction}${selected}`,
  });
}

export function buildDiscordUiPayload(pending, statusText, responseValue = pending.result, disableControls = false) {
  if (pending.isCommit) return buildCommitUiPayload(pending, statusText, responseValue, disableControls);
  const optionGuide = [ASK_USER_CUSTOM_GUIDE, ASK_USER_CHOICES_GUIDE, ASK_USER_INPUT_GUIDE]
    .find((guide) => pending.promptText.endsWith(`\n${guide}`));
  const hasDropdownGuide =
    pending.isAskUser &&
    ["select", "input"].includes(pending.method) &&
    optionGuide !== undefined;
  const promptContent = hasDropdownGuide
    ? pending.promptText.slice(0, -(optionGuide.length + 1))
    : pending.promptText;
  const summary = statusText === "Response received." && responseValue !== undefined && Array.isArray(pending.askUserNavigation?.summary)
    ? pending.askUserNavigation.summary : undefined;
  const responseText =
    !summary && statusText === "Response received." && pending.isAskUserQuestion && responseValue !== undefined
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
  if (summary?.length) {
    cardText = "## Ask User\n-# Response received.";
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
  if (!statusText && pending.method === "input" && typeof pending.askUserNavigation?.answer?.response === "string") {
    cardText += `\n\n**Previous answer:**\n> ${truncateDiscordText(pending.askUserNavigation.answer.response, 500).replace(/\r?\n/g, "\n> ")}`;
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(cardText));

  if (summary?.length) {
    const lines = summary.slice(0, 6).map((item, index, items) => {
      const question = truncateDiscordText(String(item?.question ?? "Question").replace(/\s+/g, " "), 150);
      const answer = index === items.length - 1
        ? (responseValue === pending.askUserNavigation?.submitToken ? "(skipped)" : responseValue)
        : item?.response ?? "(skipped)";
      return `**${index + 1}. ${question}**\n> ${truncateDiscordText(String(answer).replace(/\s+/g, " "), 300)}`;
    });
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Answers\n${lines.join("\n\n")}`));
  }

  if (controls.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    if (showDropdownGuide) {
      const guide = pending.awaitingCustomAnswer ? "Reply with your custom answer in chat." : optionGuide;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${guide}`));
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
  if (pending.isCommit && pending.method === "select" && pending.options.length <= 4) {
    const buttons = pending.options.map((option, index) => {
      let label = option;
      let style = ButtonStyle.Primary;
      const stages = /^(?:Commit|Commit & Push) all (\d+) stages/i.exec(option)?.[1];
      if (/^Commit & Push/i.test(option)) label = stages ? `Commit & Push all (${stages})` : "Commit & Push";
      else if (/^Commit only staged/i.test(option)) label = "Staged only";
      else if (/^Commit only unstaged/i.test(option)) label = "Unstaged only";
      else if (/^Stage all and commit/i.test(option)) label = "Stage all";
      else if (/^Commit(?::| all)/i.test(option)) { label = stages ? `Commit all (${stages})` : "Commit"; style = ButtonStyle.Success; }
      else if (/^Edit commit/i.test(option)) { label = /plan/i.test(option) ? "Edit plan" : "Edit message"; style = ButtonStyle.Secondary; }
      return new ButtonBuilder().setCustomId(`piui:${pending.token}:choose-${index}`).setLabel(truncateDiscordText(label, 80)).setStyle(style).setDisabled(disabled);
    });
    buttons.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    return [new ActionRowBuilder().addComponents(buttons)];
  }
  if (pending.isAskUser && pending.method === "select") {
    const pageSize = pending.allowCustomAnswer ? 18 : 20;
    const pageCount = Math.ceil(pending.options.length / pageSize);
    const pageStart = pending.page * pageSize;
    const visibleOptions = pending.options.slice(pageStart, pageStart + pageSize);
    const rows = [];
    for (let start = 0; start < visibleOptions.length; start += 5) {
      const buttons = visibleOptions.slice(start, start + 5).map((option, index) =>
        new ButtonBuilder()
          .setCustomId(`piui:${pending.token}:choose-${pageStart + start + index}`)
          .setLabel(pending.askUserNavigation?.answer?.response === option && !pending.askUserNavigation.answer.isCustom
            ? `${truncateDiscordText(discordOptionLabel(option), 69)} [SELECTED]`
            : truncateDiscordText(discordOptionLabel(option), 80))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled));
      rows.push(new ActionRowBuilder().addComponents(buttons));
    }
    if (pending.allowCustomAnswer) {
      const addButton = (button) => {
        const last = rows[rows.length - 1];
        if (!last || last.components.length >= 5) rows.push(new ActionRowBuilder().addComponents(button));
        else last.addComponents(button);
      };
      const saved = pending.askUserNavigation?.answer;
      if (saved?.isCustom && typeof saved.response === "string" && saved.response.length > 0) {
        addButton(new ButtonBuilder().setCustomId(`piui:${pending.token}:custom-saved`).setLabel(`${truncateDiscordText(discordOptionLabel(saved.response), 69)} [SELECTED]`).setStyle(ButtonStyle.Success).setDisabled(disabled));
      }
      addButton(new ButtonBuilder().setCustomId(`piui:${pending.token}:custom`).setLabel(saved?.isCustom ? "Another custom answer" : "Custom answer").setStyle(ButtonStyle.Success).setDisabled(disabled || pending.awaitingCustomAnswer));
    }
    const navigation = [];
    if (typeof pending.askUserNavigation?.previousToken === "string") {
      navigation.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:question-prev`).setLabel("« Previous question").setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    }
    if (typeof pending.askUserNavigation?.nextToken === "string") {
      navigation.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:question-next`).setLabel("Next question »").setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    }
    if (typeof pending.askUserNavigation?.submitToken === "string") {
      navigation.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:question-submit`).setLabel("Submit answers").setStyle(ButtonStyle.Success).setDisabled(disabled));
    }
    if (pageCount > 1) {
      navigation.push(
        new ButtonBuilder().setCustomId(`piui:${pending.token}:prev`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(disabled || pending.page === 0),
        new ButtonBuilder().setCustomId(`piui:${pending.token}:next`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(disabled || pending.page >= pageCount - 1),
      );
    }
    navigation.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:cancel`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    rows.push(new ActionRowBuilder().addComponents(navigation));
    return rows;
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

  if (pending.isAskUser && pending.method === "input") {
    const buttons = [];
    if (typeof pending.askUserNavigation?.previousToken === "string") {
      buttons.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:question-prev`).setLabel("« Previous question").setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    }
    if (typeof pending.askUserNavigation?.nextToken === "string") {
      buttons.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:question-next`).setLabel("Next question »").setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    }
    if (typeof pending.askUserNavigation?.submitToken === "string") {
      buttons.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:question-submit`).setLabel("Submit answers").setStyle(ButtonStyle.Success).setDisabled(disabled));
    }
    buttons.push(new ButtonBuilder().setCustomId(`piui:${pending.token}:cancel`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    return [new ActionRowBuilder().addComponents(buttons)];
  }

  const buttonLabel = pending.method === "editor" ? "Open editor" : "Enter response";
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`piui:${pending.token}:open`).setLabel(buttonLabel).setStyle(ButtonStyle.Primary).setDisabled(disabled || (pending.isCommit && (pending.request?.prefill?.length || 0) > 4000)),
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
    content: `Choose a ${pending.setting === "model" ? "model" : "thinking level"} ${pending.defaultModel ? "as the default for new conversations" : "for this conversation"}.${current}${pageCount > 1 ? ` Page ${pending.page + 1}/${pageCount}.` : ""}`,
    components: rows,
    allowedMentions: { parse: [] },
  };
}

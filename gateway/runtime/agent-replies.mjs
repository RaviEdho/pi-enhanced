import { sendText } from "./messages.mjs";
import { log, safeErrorName } from "./logging.mjs";

const MAX_REPLY_IMAGES = 12;
const MAX_REPLY_BYTES = 16 * 1024 * 1024;

/** Display-only conversion of completed assistant text; never change Pi history. */
export async function sendAgentReply(channel, text, replyToMessageId, {
  loadRenderer = () => import("./table-renderer.mjs"),
  tableRendering = {},
} = {}) {
  if (!channel?.send) return;
  const source = String(text || "");
  // The master toggle bypasses parsing, rendering and every table attachment.
  // Keep text delivery outside the parser catch so failures are never retried.
  if (tableRendering.enabled !== true || !source.includes("|") || source.length > 200_000) {
    return sendText(channel, source, replyToMessageId);
  }
  let renderer;
  let parts;
  try {
    renderer = await loadRenderer();
    parts = renderer.partitionMarkdownTables(source);
  } catch (error) {
    log(`Could not parse Discord tables; keeping original text: ${safeErrorName(error)}`);
    return sendText(channel, source, replyToMessageId);
  }
  // Preserve the existing splitter behavior when there are no top-level tables.
  if (!parts.some((part) => part.type === "table")) return sendText(channel, source, replyToMessageId);
  let sent = false;
  let number = 0;
  let imageCount = 0;
  let bytes = 0;
  let pendingText = [];
  const flushText = async () => {
    const value = pendingText.join("");
    if (value.trim()) {
      await sendText(channel, value, sent ? undefined : replyToMessageId);
      sent = true;
    }
    pendingText = [];
  };
  for (const part of parts) {
    if (part.type !== "table") { pendingText.push(part.raw); continue; }
    number += 1;
    if (imageCount >= MAX_REPLY_IMAGES || bytes >= MAX_REPLY_BYTES) {
      pendingText.push(part.raw);
      continue;
    }
    let files;
    try {
      const original = tableRendering.attachMarkdown ? { attachment: Buffer.from(part.raw, "utf8"), name: `table-${number}.md` } : undefined;
      const sourceBytes = original?.attachment.length ?? 0;
      const images = await renderer.renderTable(part, {
        number, showTitleFooter: tableRendering.showTitleFooter === true,
        maxImages: Math.min(8, MAX_REPLY_IMAGES - imageCount), maxBytes: MAX_REPLY_BYTES - bytes - sourceBytes,
      });
      const size = images.reduce((sum, image) => sum + image.attachment.length, sourceBytes);
      if (!images.length || images.length > 8 || imageCount + images.length > MAX_REPLY_IMAGES || bytes + size > MAX_REPLY_BYTES) {
        throw new RangeError("Reply exceeds table attachment bounds");
      }
      files = original ? [...images, original] : images;
      imageCount += images.length;
      bytes += size;
    } catch (error) {
      log(`Could not render a Discord table; keeping original text: ${safeErrorName(error)}`);
      pendingText.push(part.raw);
      continue;
    }
    // Keep text delivery outside the upload catch: never retry failed text.
    await flushText();
    try {
      // One atomic message per table (at most eight PNGs plus optional source). Never retry an
      // image upload: a transport error may occur after Discord accepted it.
      await channel.send({
        files,
        allowedMentions: { parse: [], repliedUser: false },
        ...(!sent && replyToMessageId ? { reply: { messageReference: replyToMessageId, failIfNotExists: false } } : {}),
      });
      sent = true;
    } catch (error) {
      log(`Discord table upload failed or was uncertain: ${safeErrorName(error)}`);
      pendingText.push("Table image upload failed or could not be confirmed; showing the original table instead.\n\n", part.raw);
    }
  }
  // Coalesce adjacent fallbacks instead of creating one message per table when
  // a reply has many small tables or exhausts its rendering budget.
  await flushText();
}

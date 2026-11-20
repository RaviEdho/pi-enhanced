import { constants, readFileSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { isValidAllowlist } from "./config.mjs";
import { detectDiscordImageMimeType } from "./messages.mjs";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const deliveries = new WeakMap();
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
]) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export class ImageDeliveryError extends Error {}
const fail = (message) => { throw new ImageDeliveryError(message); };

export function isPublicImageAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function validateImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("Provide a valid public HTTPS image URL."); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      host === "localhost" || host.endsWith(".localhost") || (isIP(host) && !isPublicImageAddress(host))) {
    fail("Image URLs must use public HTTPS on port 443, without credentials or private-network addresses.");
  }
  return url;
}

// Pin the connection to a checked DNS answer. Recheck every redirect, never use
// an ambient proxy/pooled connection, and reject mixed public/private answers.
export function publicImageLookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error || !addresses?.length || addresses.some(({ address }) => !isPublicImageAddress(address))) {
      callback(new ImageDeliveryError("Image host is unavailable or resolves to a non-public network."));
      return;
    }
    const selected = addresses[0];
    if (options?.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  });
}

export async function downloadPublicImage(source, maxBytes, signal) {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)].filter(Boolean));
  let url = validateImageUrl(source);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    boundedSignal.throwIfAborted();
    const response = await new Promise((resolveResponse, reject) => {
      const req = httpsRequest(url, {
        method: "GET", agent: false, lookup: publicImageLookup, signal: boundedSignal,
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp", "Accept-Encoding": "identity" },
      }, resolveResponse);
      req.on("error", reject);
      req.end();
    });
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (!response.headers.location || redirects === 3) fail("Image URL redirected too many times or has no target.");
        url = validateImageUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.statusCode !== 200) fail("Image URL did not return a successful image response.");
      if (Number(response.headers["content-length"]) > maxBytes) fail("Image exceeds the upload size limit.");
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") fail("Compressed image responses are unsupported.");
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        boundedSignal.throwIfAborted();
        size += chunk.length;
        if (size > maxBytes) fail("Image exceeds the upload size limit.");
        chunks.push(chunk);
      }
      return { data: Buffer.concat(chunks, size), name: basename(url.pathname) };
    } finally { response.destroy(); }
  }
}

export async function readWorkspaceImage(source, cwd, maxBytes, signal) {
  const root = await realpath(cwd);
  const target = await realpath(resolve(cwd, source.replace(/^@/, "")));
  const path = relative(root, target);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) fail("Local images must be inside the active workspace, including symlink targets.");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("The image source must be a regular file.");
    if (stat.size > maxBytes) fail("Image exceeds the upload size limit.");
    const data = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < data.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) fail("Image exceeds the upload size limit.");
    return { data: data.subarray(0, size), name: basename(target) };
  } finally { await handle.close(); }
}

function imageFilename(name, mime) {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mime];
  const stem = name.replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70);
  return `${stem || "image"}.${extension}`;
}

// The caller cannot select a destination or supply authorization. Revalidate the
// daemon-owned active turn, allowlists, membership and permissions before upload.
async function authorizeDestination({ client, configPath, session, active, waiter, scope, toolCallId, signal }) {
  const check = () => {
    signal?.throwIfAborted();
    if (!session.running || !waiter || session.runWaiter !== waiter || session.interaction !== active || active.historyScope !== scope ||
        session.closed || session.stopping || session.replacingChild || active.workflow || !session.imageToolCalls?.has(toolCallId)) {
      fail("Image sending requires an active Discord message turn.");
    }
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const allowed = (list, id) => isValidAllowlist(list) && (list.includes("*") || list.includes(id));
    if (!allowed(config.allowedUserIds, active.userId)) fail("Image sending is not allowed for this requester.");
    if (scope?.kind === "dm") {
      if ((config.allowDirectMessages !== undefined && config.allowDirectMessages !== true) || scope.userId !== active.userId || scope.channelId !== active.channelId) fail("Image sending is unavailable for this DM.");
    } else if (scope?.kind === "thread") {
      if ((config.allowServerMessages !== undefined && config.allowServerMessages !== true) || !allowed(config.allowedChannelIds, scope.parentChannelId)) fail("Image sending is unavailable for this server conversation.");
    } else fail("Image sending is unavailable for this conversation.");
  };
  check();
  if (active.authorizeScheduledDelivery) {
    const channel = await active.authorizeScheduledDelivery({ attachFiles: true });
    check();
    return { channel, check };
  }
  const channel = await client.channels.fetch(active.channelId, { force: true });
  if (!channel?.send || channel.id !== active.channelId || !client.user?.id) fail("Discord destination unavailable.");
  if (scope.kind === "dm") {
    if (channel.type !== ChannelType.DM || channel.guild || channel.recipient?.id !== active.userId || active.userId === client.user.id) fail("DM recipient mismatch.");
  } else {
    if (!channel.guild || channel.guild.id !== scope.guildId ||
        (channel.isThread?.() ? channel.parentId !== scope.parentChannelId : channel.id !== scope.parentChannelId) ||
        (!channel.isThread?.() && ![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice].includes(channel.type))) {
      fail("Image destination does not match the active server conversation.");
    }
    const [member, bot] = await Promise.all([
      channel.guild.members.fetch({ user: active.userId, force: true }),
      channel.guild.members.fetch({ user: client.user.id, force: true }),
      channel.guild.roles.fetch(),
    ]);
    const userPermissions = channel.permissionsFor(member);
    const botPermissions = channel.permissionsFor(bot);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AttachFiles,
      channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages];
    if (!userPermissions?.has(PermissionFlagsBits.ViewChannel) || !required.every((p) => botPermissions?.has(p))) {
      fail("The bot needs View Channel, Send Messages and Attach Files permissions at the destination.");
    }
    if (channel.type === ChannelType.PrivateThread) {
      await Promise.all([[member, userPermissions], [bot, botPermissions]].map(async ([person, permissions]) => {
        if (!permissions.has(PermissionFlagsBits.ManageThreads)) await channel.members.fetch(person.id);
      }));
    }
  }
  check();
  return { channel, check };
}

export async function sendImage({ client, configPath, session, request, signal }) {
  const active = session.interaction;
  if (!active) fail("No active Discord requester.");
  const { toolCallId, source, caption, description } = request;
  if (typeof toolCallId !== "string" || typeof source !== "string" || !source.trim() || source.length > 2048 ||
      (caption !== undefined && (typeof caption !== "string" || caption.length > 1900)) ||
      (description !== undefined && (typeof description !== "string" || description.length > 1024))) fail("Invalid image request.");
  let state = deliveries.get(active);
  if (!state) { state = { count: 0, bytes: 0, calls: new Map() }; deliveries.set(active, state); }
  if (state.calls.has(toolCallId)) return state.calls.get(toolCallId);
  const context = { client, configPath, session, active, waiter: session.runWaiter, scope: active.historyScope, toolCallId, signal };
  const delivery = (async () => {
    try {
      await authorizeDestination(context);
      if (state.count >= 4 || state.bytes >= MAX_TOTAL_BYTES) fail("This request has reached its image limit (four images / 20 MiB).");
      state.count += 1; // Reserve an attempt before asynchronous reads.
      const maxBytes = Math.min(MAX_BYTES, MAX_TOTAL_BYTES - state.bytes);
      let image;
      try {
        image = /^[a-z][a-z0-9+.-]*:\/\//i.test(source)
          ? await downloadPublicImage(source, maxBytes, signal)
          : await readWorkspaceImage(source, session.cwd, maxBytes, signal);
      } catch (error) {
        if (error instanceof ImageDeliveryError) throw error;
        fail("Could not load the image. Check the workspace file or public HTTPS URL and try again.");
      }
      const mime = detectDiscordImageMimeType(image.data);
      if (!mime) fail("Only PNG, JPEG, GIF, and WebP images are supported (validated by file signature).");
      if (state.bytes + image.data.length > MAX_TOTAL_BYTES) fail("This request has reached its 20 MiB image limit.");
      state.bytes += image.data.length;
      const { channel, check } = await authorizeDestination(context);
      check();
      session.publicOutputStarted = true;
      session.noReplyRevoked = true;
      let message;
      try {
        message = await channel.send({
          ...(caption ? { content: caption } : {}),
          files: [{ attachment: image.data, name: imageFilename(image.name, mime), ...(description ? { description } : {}) }],
          allowedMentions: { parse: [], repliedUser: false },
          ...(active.replyToMessageId ? { reply: { messageReference: active.replyToMessageId, failIfNotExists: false } } : {}),
        });
      } catch { fail("Discord image upload failed; delivery may be uncertain. Check the conversation and bot Attach Files permission before retrying."); }
      active.onMessageSent?.(message);
      // A forced stop may finish while Discord's upload is already in flight.
      // Do not let its late completion affect a newer accepted turn.
      if (session.interaction === active && session.runWaiter === context.waiter) {
        session.sentImageCount = (session.sentImageCount || 0) + 1;
      }
      return { messageId: message.id, channelId: channel.id, filename: imageFilename(image.name, mime), bytes: image.data.length };
    } catch (error) {
      if (error instanceof ImageDeliveryError) throw error;
      fail("Image sending unavailable: the turn ended, access changed, or Discord could not verify permissions.");
    }
  })();
  state.calls.set(toolCallId, delivery);
  return delivery;
}

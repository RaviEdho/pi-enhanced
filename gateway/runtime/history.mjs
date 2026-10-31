import { createServer } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { isValidAllowlist } from "./config.mjs";

const snowflake = (s) => typeof s === "string" && /^\d{17,20}$/.test(s);

const channelTypes = new Map([
  [ChannelType.GuildText, "text"],
  [ChannelType.GuildAnnouncement, "announcement"],
  [ChannelType.GuildVoice, "voice"],
]);

function hasHistoryPermissions(channel, member, bot) {
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  if (channel.type === ChannelType.GuildVoice) required.push(PermissionFlagsBits.Connect);
  return required.every((permission) => channel.permissionsFor(member)?.has(permission) && channel.permissionsFor(bot)?.has(permission));
}

// All authority comes from the daemon's currently active interaction, never the IPC payload.
export async function readChannelHistory({ client, configPath, session, request }) {
  const active = session.interaction;
  if (!session.running || !active || !snowflake(active.userId)) throw new Error("No active Discord requester");
  const { channelId, before, limit = 20 } = request;
  if (!snowflake(channelId) || (before !== undefined && !snowflake(before)) || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Invalid history request");
  const scope = active.historyScope;
  const checkActive = () => {
    if (!session.running || session.interaction !== active || active.historyScope !== scope) throw new Error("Discord request has ended or changed");
  };
  const checkConfig = () => {
    checkActive();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isValidAllowlist(config.allowedChannelIds) || !(config.allowedChannelIds.includes("*") || config.allowedChannelIds.includes(channelId))) throw new Error("Channel is not allowed for history");
    if (!isValidAllowlist(config.allowedUserIds) || !(config.allowedUserIds.includes("*") || config.allowedUserIds.includes(active.userId))) throw new Error("Requester is not allowed");
    if (scope?.kind === "dm") {
      if (config.allowDirectMessages !== undefined && config.allowDirectMessages !== true) throw new Error("DM access disabled");
      if (scope.userId !== active.userId || scope.channelId !== active.channelId || channelId !== scope.channelId) throw new Error("History is unavailable for this DM");
    } else if (scope?.kind === "thread") {
      if (!snowflake(scope.guildId) || !snowflake(scope.parentChannelId) || (config.allowServerMessages !== undefined && config.allowServerMessages !== true) ||
          !isValidAllowlist(config.allowedChannelIds) || !(config.allowedChannelIds.includes("*") || config.allowedChannelIds.includes(scope.parentChannelId))) {
        throw new Error("History is unavailable for this thread");
      }
    } else throw new Error("History is unavailable for this conversation");
  };
  const authorize = async () => {
    checkConfig();
    const channel = await client.channels.fetch(channelId, { force: true });
    if (channel?.id !== channelId || !client.user?.id) throw new Error("History source unavailable");
    if (scope.kind === "dm") {
      if (channel.type !== ChannelType.DM || channel.guild || channel.recipient?.id !== active.userId || channel.recipient?.id === client.user.id) throw new Error("DM recipient mismatch");
    } else {
      // Never admit threads or channels from another server, even if listed.
      if (!channel.guild || channel.guild.id !== scope.guildId || !channelTypes.has(channel.type)) throw new Error("History source must be a supported channel in the active server");
      const guild = channel.guild;
      const [member, bot] = await Promise.all([
        guild.members.fetch({ user: active.userId, force: true }),
        guild.members.fetch({ user: client.user.id, force: true }),
      ]);
      if (!hasHistoryPermissions(channel, member, bot)) throw new Error("Requester and bot must both have channel history permissions");
    }
    checkActive();
    return channel;
  };
  const channel = await authorize();
  const messages = await channel.messages.fetch({ limit, ...(before ? { before } : {}), cache: false });
  await authorize();
  const items = [...messages.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0).map((m) => ({
    id: m.id, timestamp: m.createdAt?.toISOString(), author: { id: m.author?.id, username: String(m.author?.username || "").slice(0, 100) },
    content: String(m.content || "").slice(0, 1200), contentTruncated: (m.content?.length || 0) > 1200,
    attachmentCount: m.attachments?.size || 0,
  }));
  // Discord permission lookups await network I/O; config may have changed while
  // they were in flight. Revalidate without another await before disclosure.
  checkConfig();
  return { untrusted: true, channelId, messages: items, nextBefore: items.length === limit ? items.at(-1)?.id : null };
}

// Discovery uses only the current thread's daemon-owned scope; the request has no
// authority-bearing arguments. Fetch roles as well as members for permissionsFor.
export async function listChannels({ client, configPath, session }) {
  const active = session.interaction;
  const scope = active?.historyScope;
  const checkConfig = () => {
    if (!session.running || !active || session.interaction !== active || active.historyScope !== scope ||
        !snowflake(active.userId) || scope?.kind !== "thread" || !snowflake(scope.guildId) || !snowflake(scope.parentChannelId)) {
      throw new Error("No active server thread requester");
    }
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if ((config.allowServerMessages !== undefined && config.allowServerMessages !== true) ||
        !isValidAllowlist(config.allowedUserIds) || !(config.allowedUserIds.includes("*") || config.allowedUserIds.includes(active.userId)) ||
        !isValidAllowlist(config.allowedChannelIds) || !(config.allowedChannelIds.includes("*") || config.allowedChannelIds.includes(scope.parentChannelId))) {
      throw new Error("Discovery access denied");
    }
    return config;
  };
  checkConfig();
  if (!client.user?.id) throw new Error("Bot unavailable");
  const guild = await client.guilds.fetch({ guild: scope.guildId, force: true });
  checkConfig();
  if (!guild || guild.id !== scope.guildId) throw new Error("Server unavailable");
  const [member, bot, channels] = await Promise.all([
    guild.members.fetch({ user: active.userId, force: true }),
    guild.members.fetch({ user: client.user.id, force: true }),
    guild.channels.fetch(),
    guild.roles.fetch(),
  ]);
  const config = checkConfig();
  const allowed = [...channels.values()].filter((channel) =>
    channel && channel.guild?.id === scope.guildId && snowflake(channel.id) &&
    channelTypes.has(channel.type) &&
    (config.allowedChannelIds.includes("*") || config.allowedChannelIds.includes(channel.id)) &&
    hasHistoryPermissions(channel, member, bot)
  ).sort((a, b) => a.id.localeCompare(b.id));
  const items = allowed.slice(0, 50).map((channel) => ({ id: channel.id, name: String(channel.name || "").slice(0, 100), type: channelTypes.get(channel.type) }));
  // No await between the final configuration check and returning data.
  checkConfig();
  return { untrusted: true, channels: items, truncated: allowed.length > items.length, ...(allowed.length > items.length ? { note: "Only the first 50 authorized channels are shown." } : {}) };
}

export async function createHistoryIpc({ client, configPath, session }) {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    // An inactivity timeout alone permits slow clients to hold all slots by
    // trickling bytes. Bound total connection lifetime too (not DoS protection).
    const deadline = setTimeout(() => socket.destroy(), 15000);
    deadline.unref();
    socket.on("close", () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.setTimeout(15000, () => socket.destroy());
    let data = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 4096) return socket.destroy();
      if (!data.includes("\n")) return;
      socket.pause();
      void (async () => {
        try {
          const request = JSON.parse(data.slice(0, data.indexOf("\n")));
          const supplied = typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0);
          const expected = Buffer.from(token);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Unauthorized");
          const result = request.operation === undefined || request.operation === "history"
            ? await readChannelHistory({ client, configPath, session, request })
            : request.operation === "list_channels"
              ? await listChannels({ client, configPath, session })
              : (() => { throw new Error("Unknown operation"); })();
          socket.end(JSON.stringify({ result }) + "\n");
        } catch { socket.end(JSON.stringify({ error: "History unavailable or access denied." }) + "\n"); }
      })();
    });
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, token, close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { sendAgentReply } from "./agent-replies.mjs";
import { readGatewayConfig } from "./config.mjs";
import { replyEphemeral } from "./interactions.mjs";
import { log, safeErrorName } from "./logging.mjs";
import { sendText } from "./messages.mjs";
import { ScheduleError } from "./schedule-time.mjs";
import { createScheduler, isScheduleDelivery, scheduleUsesWorkspace, snowflake } from "./scheduler.mjs";
import { runScheduledShell } from "./scheduled-shell.mjs";
import { getThreadSessionKey } from "./threads.mjs";
import { validateWorkspaceDirectory } from "./workspace.mjs";

const serverTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice];
const accessDenied = () => new ScheduleError("Schedules require an allowed DM, server channel, or thread that you can view and the bot can post in.");
const deliveryUnavailable = () => new ScheduleError("The requested delivery destination is unavailable or not authorized. No alternate destination will be used.");
const stopping = () => new ScheduleError("The gateway is stopping. Try again once it reconnects.");
const includes = (list, id) => list.includes("*") || list.includes(id);
const timestamp = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;

function scopeFor(channel, userId) {
  if (!snowflake(channel?.id) || !snowflake(userId)) throw accessDenied();
  if (channel.type === ChannelType.DM) return { userId, channelId: channel.id, guildId: null, parentChannelId: null };
  const guildId = channel.guildId;
  const parentChannelId = channel.isThread?.() ? channel.parentId : channel.id;
  if (!snowflake(guildId) || !snowflake(parentChannelId)) throw accessDenied();
  return { userId, channelId: channel.id, guildId, parentChannelId };
}

function configFor(configPath, scope, home = false) {
  let config;
  try { config = readGatewayConfig(configPath); } catch { throw accessDenied(); }
  if (!includes(config.allowedUserIds, scope.userId) || (scope.guildId === null ? !config.allowDirectMessages
    : !config.allowServerMessages || !(home ? config.homeChannelId === scope.channelId : includes(config.allowedChannelIds, scope.parentChannelId)))) throw accessDenied();
  return config;
}

/** Reconstruct authority from Discord and the saved config, never tool arguments. */
export async function authorizeScheduleDestination({ client, configPath, scope, home = false, attachFiles = false, fetchedChannel }) {
  const check = () => configFor(configPath, scope, home);
  check();
  try {
    const botId = client.user?.id;
    const channel = fetchedChannel ?? await client.channels.fetch(scope.channelId, { force: true });
    if (!botId || scope.userId === botId || channel?.id !== scope.channelId || typeof channel.send !== "function") throw accessDenied();
    if (scope.guildId === null) {
      if (channel.type !== ChannelType.DM || channel.guild || channel.recipient?.id !== scope.userId) throw accessDenied();
    } else {
      const thread = channel.isThread?.();
      if (channel.guild?.id !== scope.guildId || (thread ? channel.parentId !== scope.parentChannelId
        : channel.id !== scope.parentChannelId || !serverTypes.includes(channel.type))) throw accessDenied();
      const [member, bot] = await Promise.all([
        channel.guild.members.fetch({ user: scope.userId, force: true }),
        channel.guild.members.fetch({ user: botId, force: true }),
        channel.guild.roles.fetch(),
      ]);
      const userPerms = channel.permissionsFor(member);
      const botPerms = channel.permissionsFor(bot);
      const required = [PermissionFlagsBits.ViewChannel];
      if (channel.type === ChannelType.GuildVoice) required.push(PermissionFlagsBits.Connect);
      if (!required.every((p) => userPerms?.has(p) && botPerms?.has(p)) ||
          !botPerms?.has(thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages) ||
          (attachFiles && !botPerms?.has(PermissionFlagsBits.AttachFiles))) throw accessDenied();
      if (channel.type === ChannelType.PrivateThread) {
        await Promise.all([[member, userPerms], [bot, botPerms]].map(async ([person, permissions]) => {
          if (!permissions.has(PermissionFlagsBits.ManageThreads)) await channel.members.fetch({ member: person.id, force: true });
        }));
      }
      if (thread && channel.archived && channel.locked && !botPerms.has(PermissionFlagsBits.ManageThreads)) throw accessDenied();
    }
    check();
    return channel;
  } catch { throw accessDenied(); }
}

export function createScheduledJobs({ client, configPath, path, sessions, lifecycle, threads, channelSessions, scheduledReplies }) {
  const toolCalls = new WeakMap();
  const shellShutdown = new AbortController();
  const activeShells = new Set();
  const scheduler = createScheduler({ path, run, withRunSlot: sessions.withRunSlot, trackTask: lifecycle.trackTask,
    canRun: () => client.isReady() && !lifecycle.isStopping() });

  async function resolveDelivery(origin, mode, originChannel) {
    if (!isScheduleDelivery(mode)) throw new ScheduleError("Delivery must be default, here, home, dm, or a Discord channel ID.");
    const config = configFor(configPath, origin);
    const home = mode === "home" || (mode === "default" && !!config.homeChannelId);
    const usesHomeSetting = mode === "home" || mode === "default";
    const expectedHome = config.homeChannelId;
    let channel = originChannel;
    try {
      if (mode === "dm") {
        if (!config.allowDirectMessages || origin.userId === client.user?.id) throw deliveryUnavailable();
        if (origin.guildId !== null) channel = await client.users.createDM(origin.userId, { force: true });
        if (channel?.type !== ChannelType.DM || channel.recipient?.id !== origin.userId) throw deliveryUnavailable();
      } else if (home || snowflake(mode)) {
        const id = home ? expectedHome : mode;
        if (!id || !config.allowServerMessages) throw deliveryUnavailable();
        channel = id === originChannel.id ? originChannel : await client.channels.fetch(id, { force: true });
        if (channel?.id !== id || channel.type === ChannelType.DM || (home && channel.isThread?.())) throw deliveryUnavailable();
      }
      const scope = scopeFor(channel, origin.userId);
      const checkSelection = () => {
        if (usesHomeSetting && configFor(configPath, origin).homeChannelId !== expectedHome) throw deliveryUnavailable();
      };
      const authorize = async ({ attachFiles = false, fetchedChannel } = {}) => {
        checkSelection();
        const authorized = await authorizeScheduleDestination({ client, configPath, scope, home, attachFiles, fetchedChannel });
        checkSelection();
        return authorized;
      };
      if (scope.channelId !== origin.channelId || home) await authorize({ fetchedChannel: channel });
      checkSelection();
      return { authorize, channelId: scope.channelId, target: scope.guildId === null ? "dm" : scope.channelId };
    } catch { throw deliveryUnavailable(); }
  }

  async function run(job) {
    const authorizeOrigin = async () => {
      if (lifecycle.isShuttingDown()) throw stopping();
      return authorizeScheduleDestination({ client, configPath, scope: job });
    };
    async function startRun() {
      const origin = await authorizeOrigin();
      // Resolve once per run. A change mid-run must not split delivery across channels.
      const delivery = await resolveDelivery(job, job.delivery ?? "here", origin);
      const authorizeDelivery = async (options) => {
        await authorizeOrigin();
        const destination = await delivery.authorize(options);
        if (lifecycle.isShuttingDown()) throw stopping();
        configFor(configPath, job);
        return destination;
      };
      const replyKey = job.kind === "agent" ? scheduledReplies?.start(delivery.channelId) : undefined;
      const onMessageSent = replyKey ? (sent) => scheduledReplies.remember(delivery.channelId, replyKey, sent) : undefined;
      const target = { send: async (payload) => {
        const sent = await (await authorizeDelivery({ attachFiles: !!payload.files?.length })).send(payload);
        onMessageSent?.(sent);
        return sent;
      } };
      if (job.kind === "reminder") {
        await sendText(target, `**Reminder**\n${job.text}`);
        return "sent";
      }
      if (job.kind === "shell") {
        await authorizeDelivery();
        const status = await runShell(job);
        if (!shellShutdown.signal.aborted) await sendText(target, `**Scheduled shell** · \`${job.id}\`\n${status.message}`);
        return status.outcome;
      }
      let result;
      try {
        result = await sessions.withFreshSession(job.cwd, async (session, signal) => {
          const current = await authorizeOrigin();
          signal.throwIfAborted();
          const historyScope = job.guildId === null ? { kind: "dm", channelId: job.channelId, userId: job.userId }
            : { kind: "thread", guildId: job.guildId, parentChannelId: job.parentChannelId };
          const whileRunning = (authorize) => async (options) => {
            signal.throwIfAborted();
            const channel = await authorize(options);
            signal.throwIfAborted();
            return channel;
          };
          const audience = delivery.target === "dm" ? "a DM to the requester" : `Discord channel or thread ID ${delivery.target}`;
          const text = await session.promptAndWait(`Scheduled task set by Discord user ID ${job.userId} (job ${job.id}). This is a fresh unattended run; there is no earlier conversation. Results and images go to ${audience}. Do not disclose sensitive information to a shared audience.\n\n${job.text}`, {
            channel: current, channelId: job.channelId, userId: job.userId, historyScope, onMessageSent,
            authorizeScheduledOrigin: whileRunning(authorizeOrigin),
            authorizeScheduledDelivery: whileRunning(authorizeDelivery),
          });
          signal.throwIfAborted();
          return { text, outcome: session.scheduledPromptDismissed ? "blocked" : session.scheduledFailed ? "failed" : "completed" };
        });
      } catch (error) {
        if (error instanceof ScheduleError) throw error;
        log(`Scheduled Pi run ${job.id} failed: ${safeErrorName(error)}`);
        result = { outcome: "failed" };
      }
      const note = {
        "timed out": "The run exceeded its 10-minute time limit and was stopped.",
        failed: "The run failed. Check the gateway logs and Pi configuration.",
        blocked: "The run requested interactive input or approval. The prompt was dismissed; review the result for unfinished work.",
        completed: "The agent finished without a text response.",
      }[result.outcome];
      if (result.text === undefined && result.outcome === "completed") return result.outcome; // Image-only delivery.
      const text = result.text?.trim();
      await sendAgentReply(target, `**Scheduled agent** · \`${job.id}\`\n${text && result.outcome === "completed" ? text : [note, text].filter(Boolean).join("\n\n")}`,
        undefined, { tableRendering: configFor(configPath, job).tableRendering });
      return result.outcome;
    }
    try { return await startRun(); }
    catch (error) {
      if (error instanceof ScheduleError) return "access denied";
      throw error;
    }
  }

  async function runShell(job) {
    let cwd;
    try { cwd = validateWorkspaceDirectory(job.cwd); }
    catch { return { outcome: "failed", message: "The saved workspace is unavailable." }; }
    const execution = runScheduledShell(job.text, cwd, { signal: shellShutdown.signal });
    activeShells.add(execution);
    try {
      const { outcome, code } = await execution;
      const message = outcome === "completed" ? "Completed (exit code 0)."
        : outcome === "timed out" ? "The shell command exceeded its 10-minute time limit and was stopped."
        : outcome === "interrupted" ? "The shell command was interrupted."
        : code === undefined ? "The shell command could not start or was terminated."
        : `Failed (exit code ${code}).`;
      return { outcome, message };
    } finally {
      activeShells.delete(execution);
    }
  }

  async function createJob(scope, input, resolveWorkspace, origin, check) {
    const delivery = await resolveDelivery(scope, input.delivery === undefined ? "default" : input.delivery, origin);
    check();
    const config = configFor(configPath, scope);
    let cwd;
    if (scheduleUsesWorkspace(input.kind)) {
      try { cwd = resolveWorkspace(config); } catch { throw new ScheduleError("The current workspace is unavailable."); }
    }
    // Persist the resolved zone so changing the gateway configuration only
    // affects new jobs, not the recurrence of jobs already saved.
    const job = scheduler.create(scope, input, cwd, config.channelSessions.timezone);
    return { ...job, deliveryTarget: delivery.target };
  }

  async function handleCommand(interaction) {
    let deferred = false;
    const respond = (content) => deferred ? interaction.editReply({ content, allowedMentions: { parse: [] } }) : replyEphemeral(interaction, content);
    try {
      if (lifecycle.isStopping()) throw stopping();
      const scope = scopeFor(interaction.channel, interaction.user?.id);
      configFor(configPath, scope);
      await interaction.deferReply({ ephemeral: true });
      deferred = true;
      const channel = await authorizeScheduleDestination({ client, configPath, scope });
      if (lifecycle.isStopping()) throw stopping();
      const action = interaction.options.getSubcommand();
      if (action === "list") {
        const result = scheduler.list(scope, interaction.options.getInteger("page") ?? 1);
        return await respond(formatList(result));
      }
      if (action === "cancel") {
        const result = scheduler.cancel(scope, interaction.options.getString("id", true).trim().toLowerCase());
        return await respond(cancelMessage(result));
      }
      if (action !== "create") throw new ScheduleError("Unknown schedule action.");
      const input = { kind: interaction.options.getString("kind", true), when: interaction.options.getString("when", true),
        text: interaction.options.getString("text", true), timezone: interaction.options.getString("timezone") ?? undefined,
        delivery: interaction.options.getString("delivery")?.trim().toLowerCase() };
      const job = await createJob(scope, input, (config) => {
        const registration = channel.isThread?.() ? threads.get(channel.id) : undefined;
        const key = scope.guildId === null ? `dm:${scope.channelId}:${scope.userId}` : channel.isThread?.()
          ? (registration ? getThreadSessionKey(channel.id, registration) : undefined)
          : channelSessions.peekCurrent(scope.guildId, scope.channelId);
        return sessions.workspaceFor(key, config.cwd);
      }, channel, () => { if (lifecycle.isStopping()) throw stopping(); });
      const timezone = job.schedule.timezone ? ` Timezone: \`${job.schedule.timezone}\`.` : "";
      const destination = job.deliveryTarget === "dm" ? "your DM" : `<#${job.deliveryTarget}>`;
      await respond(`Scheduled ${job.kind} job \`${job.id}\`. Next run: ${timestamp(job.nextAt)}.${timezone} Delivery: ${destination}.`);
    } catch (error) {
      if (!(error instanceof ScheduleError)) log(`Discord /schedule failed: ${safeErrorName(error)}`);
      await respond(error instanceof ScheduleError ? error.message : "Could not manage schedules. Check the gateway logs.");
    }
  }

  async function handleTool({ session, request, signal }) {
    const active = session.interaction;
    const waiter = session.runWaiter;
    const historyScope = active?.historyScope;
    const toolCallId = request.toolCallId;
    const check = () => {
      signal.throwIfAborted();
      if (lifecycle.isStopping()) throw stopping();
      if (!active?.channel || !waiter || session.runWaiter !== waiter || !session.running || session.closed || session.stopping ||
          session.replacingChild || session.interaction !== active || active.workflow || session.scheduled ||
          !historyScope || historyScope.kind === "revoked" || active.historyScope !== historyScope ||
          typeof toolCallId !== "string" || !session.scheduleToolCalls?.has(toolCallId)) {
        throw new ScheduleError("Schedule tools require an active, interactive Discord message turn.");
      }
    };
    check();
    const scope = scopeFor(active.channel, active.userId);
    if (scope.channelId !== active.channelId) throw accessDenied();
    let calls = toolCalls.get(active);
    if (!calls) { calls = new Map(); toolCalls.set(active, calls); }
    const authorize = async () => {
      const origin = await authorizeScheduleDestination({ client, configPath, scope });
      check();
      return origin;
    };
    if (calls.has(toolCallId)) {
      await authorize();
      return calls.get(toolCallId);
    }
    if (calls.size >= 12) throw new ScheduleError("This turn has reached its schedule tool limit.");
    const action = (async () => {
      const origin = await authorize();
      if (request.action === "clock") return { now: new Date().toISOString(), timezone: configFor(configPath, scope).channelSessions.timezone };
      if (request.action === "list") return scheduler.list(scope, request.page);
      if (request.action === "cancel") return scheduler.cancel(scope, typeof request.id === "string" ? request.id.trim().toLowerCase() : undefined);
      if (request.action !== "create") throw new ScheduleError("Unknown schedule action.");
      return createJob(scope, request, () => validateWorkspaceDirectory(session.cwd), origin, check);
    })();
    calls.set(toolCallId, action);
    return action;
  }

  return { ...scheduler, handleCommand, handleTool, close() {
    scheduler.close();
    shellShutdown.abort();
    return Promise.allSettled(activeShells);
  } };
}

function cancelMessage({ id, running }) {
  return running ? `Cancelled future runs for \`${id}\`. The current run will finish.` : `Cancelled \`${id}\`.`;
}

function formatList({ jobs, page, pages }) {
  if (!jobs.length) return pages ? `No jobs on page ${page}. Choose a page between 1 and ${pages}.` : "You have no scheduled jobs in this conversation.";
  const escape = (text) => text.replace(/[\\`*_~|<>\[\]#@]/g, "\\$&");
  return [`**Your jobs** · Page ${page}/${pages}`, ...jobs.map(({ id, kind, preview, schedule, nextAt, last, cancelled, delivery }) => {
    const recurrence = schedule.kind === "cron" ? ` · \`${schedule.expression}\` (${schedule.timezone})`
      : schedule.kind === "interval" ? ` · every ${schedule.ms / 60_000}m` : ` · once${schedule.timezone ? ` (${schedule.timezone})` : ""}`;
    const status = cancelled ? " · cancelled" : nextAt !== null ? ` · next ${timestamp(nextAt)}` : " · no future runs";
    const destination = snowflake(delivery) ? `<#${delivery}>` : { default: "home if set", here: "this conversation", home: "home", dm: "your DM" }[delivery];
    return `\`${id}\` · ${kind}${recurrence}\n${escape(preview.slice(0, 56))}${status} · delivery: ${destination}${last ? ` · last: ${last.outcome} <t:${Math.floor(last.at / 1000)}:R>` : ""}`;
  })].join("\n\n");
}

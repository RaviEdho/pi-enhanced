# WhatsApp gateway (experimental)

[← pi-enhanced](../README.md)

The WhatsApp gateway connects private text DMs to Pi. It uses the same saved-session and queueing runtime as the [Discord gateway](discord.md), but has separate credentials, settings, and conversations.

**Account risk:** [Baileys](https://baileys.wiki/docs/intro/) uses WhatsApp's Linked Devices feature and is not endorsed by WhatsApp. Protocol changes can break the gateway, and using an unofficial client can put the account at risk. Use a dedicated account rather than your primary number. This is not the WhatsApp Business Cloud API.

**Local access:** Anyone you allow can ask Pi to edit files, run shell commands, and use its configured tools with your OS user's permissions. Only allow people you trust with that access. The workspace is a starting directory, **not a sandbox**. The gateway does not auto-approve trust-gated Pi project files and cancels interactive Pi dialogs; it does not turn normal tool execution into an approval workflow.

## Setup

1. Open a local interactive Pi terminal on a Node.js version supported by Pi and Baileys (Baileys requires Node.js 20 or later). Run `/whatsapp` or `/whatsapp setup`.
2. Choose a workspace and enter the allowed senders as comma-separated international phone numbers, including country code (for example, `+15551234567`). Leave the list empty to grant no access. Wildcards are not supported. Setup captures the current Pi model and thinking level as the defaults for new conversations when available.
3. In the account you want Pi to use, open **Settings → Linked Devices → Link a device** and scan the QR shown in Pi’s pairing dialog. If Pi can't display inline images and the text QR doesn't fit, the pairing screen shows the required columns and rows. Enlarge the terminal or zoom out; the code appears without restarting setup. Do not screen-share, record, or copy the code. The gateway doesn't write it to disk and refuses pairing when Pi terminal debugging is enabled. Press **Esc** to cancel pairing and return to the editor.
4. When pairing succeeds the daemon stays running after you close Pi. Send a new text DM **from a different, allowlisted account**. Self-messages do not trigger the gateway. Use `/whatsapp status` if you're not sure whether the gateway is ready.

## Management

`/whatsapp` opens setup if there is no saved link, including after a cancelled setup or a revoked link. Once paired, it opens the actions menu with **Start** when stopped or **Restart** and **Stop** when running. `/whatsapp status` shows the connection state, and `/whatsapp logs` shows recent gateway events without message text or credentials. Open **Settings** from `/whatsapp`, or run `/whatsapp configure`. Like Discord’s settings, the list is searchable. Press Enter to open a setting or cycle **Default thinking**, and Esc to return from a field without saving. Edit **Allowed users**, **Workspace**, **Default model**, and **Default thinking** independently. The allowlist applies immediately to new work, queued work, and reply delivery; removing a sender does not stop tools that already started. Restart to apply workspace, model, and thinking changes to new conversations; saved ones keep their settings.

`/whatsapp start` starts the detached daemon with its saved link. It doesn't start at boot. `/whatsapp stop` and `/whatsapp restart` allow up to 30 seconds for accepted work to finish before cancelling the remaining runs. Transient disconnects reconnect with backoff. If WhatsApp revokes the link, run `/whatsapp setup` again. Setup replaces the saved link; remove an obsolete device from WhatsApp's Linked Devices screen.

`/whatsapp teardown` stops the daemon and deletes local pairing credentials and config, keeping Pi conversations and logs. It does **not** revoke the device on your phone: unlink it in WhatsApp as well. If you cancel after scanning a QR, check Linked Devices and remove that device.

## Idle context rollover

Open `/whatsapp configure` → **DM sessions** to turn **Overnight rollover** on or off and set the **Timezone**, **Reset hour**, and **Inactivity window**. It is on by default, with the machine's timezone, a **04:00** reset, and **6 hours** of inactivity. Like Discord, the timezone picker asks for a UTC offset first, then a city whose local daylight saving rules apply. Run `/whatsapp restart` once if the gateway was already running before this feature was installed. After that, settings changes apply to incoming DMs without a restart.

The gateway checks each sender's conversation the next time they message. The check uses inactivity **before the daily reset hour**, not before the new message. If a DM arrived exactly at the inactivity cutoff, or a turn was still running or queued at the reset hour, that day's reset is skipped. On an eligible day, the next DM starts with fresh context and keeps the previous session's workspace, model (if still available), and thinking level. Old Pi session files and WhatsApp messages are not deleted, and quoting an old reply does not reopen the previous Pi session. Existing conversations establish their rollover baseline on the first accepted DM after upgrading.

## What gets through

- Fresh plain-text DMs only. No groups, media, chat history import, quote text, commands in chat, schedules, or Discord controls. Offline or stale messages aren't replayed: resend when the gateway is ready. A turn interrupted by a disconnect may not receive a reply.
- WhatsApp sometimes supplies a private identifier (LID) rather than a phone number. The gateway requires a phone-number address or a mapping from trusted WhatsApp metadata available to Baileys. If it can't match a number on your allowlist, or mappings disagree, it ignores the message.
- The gateway marks an allowlisted DM as read when Pi starts processing it, not while it waits in the queue. Senders see blue ticks only if the linked account’s WhatsApp read receipts are enabled.
- Turns queue in arrival order within each DM. Each sender's saved Pi conversation is scoped to the linked account, so a different account does not get the old context. Replies go only to the originating DM. WhatsApp shows a typing indicator in that DM while Pi handles the active turn, not while messages wait in the queue. The indicator does not mark the linked account globally online. No interactive approvals or intermediate tool output are posted.

Credentials, allowlist, and Pi sessions are kept under `~/.pi/agent/whatsapp-gateway/` (or your configured Pi agent directory). Treat them as sensitive. Accepted text and the labeled sender identity may be sent to your selected Pi model provider and are saved in Pi session history independently of WhatsApp's message deletion or retention settings.

Implementation references: [Baileys QR and auth](https://baileys.wiki/docs/socket/connecting/), [message events](https://baileys.wiki/docs/socket/receiving-updates/), [chat presence](https://baileys.wiki/docs/socket/presence-receipts/), and [v7 phone/LID addressing](https://baileys.wiki/docs/migration/to-v7.0.0/).

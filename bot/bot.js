import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    PermissionsBitField,
    ChannelType,
    REST,
    Routes,
    SlashCommandBuilder
} from "discord.js";

// BASE PATHS
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.join(__dirname, "config.json");

// CREATE CONFIG IF MISSING
if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ guilds: {} }, null, 2));
}

// LOAD CONFIG
function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
        return { guilds: {} };
    }
}

// SAVE CONFIG
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ENSURE GUILD CONFIG
function getGuildConfig(guildId) {
    const config = loadConfig();

    if (!config.guilds[guildId]) {
        config.guilds[guildId] = {
            panelChannelId: null,
            panelMessageId: null,
            logChannelId: null,
            ticketCategoryId: null,
            supportRoleId: null,
            archiveCategoryId: null,
            categories: [],
            priorities: [],
            cooldown: 600,
            autoCloseHours: 48,
            autoClaim: true,
            autoDeleteSystemMessages: false,
            ticketTemplate: [],
            ticketCount: 0,
            openTickets: [],
            blacklist: [],
            panelTitle: "Support Tickets",
            panelDescription: "Click the button below to open a ticket.",
            panelColor: 0x2f3136,
            panelButtonText: "Create Ticket",
            settingsComplete: false
        };
        saveConfig(config);
    }

    return config.guilds[guildId];
}

// DISCORD CLIENT
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User]
});

// TEMP CACHE FOR CATEGORY → PRIORITY
const tempTicketCache = new Map();

// DASHBOARD API
const botApi = express();
botApi.use(express.json());
const BOT_API_PORT = process.env.BOT_API_PORT || 3001;

botApi.post("/refreshPanel", async (req, res) => {
    const guildId = req.body.guildId;
    if (!guildId) return res.json({ success: false, error: "Missing guildId" });

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.json({ success: false, error: "Guild not found" });

    try {
        await refreshTicketPanel(guild);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

botApi.post("/reloadConfig", (req, res) => {
    try {
        loadConfig();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

botApi.listen(BOT_API_PORT, () =>
    console.log(`[BOT API] Listening at http://localhost:${BOT_API_PORT}`)
);

// CONFIG COMPLETENESS CHECK
function isGuildConfigured(guildId) {
    const cfg = getGuildConfig(guildId);
    if (!cfg.settingsComplete) return false;
    if (!cfg.panelChannelId) return false;
    if (!cfg.ticketCategoryId) return false;
    if (!cfg.supportRoleId) return false;
    if (!cfg.categories.length) return false;
    return true;
}

async function sendNotConfiguredMessage(i) {
    return i.reply({
        content: "This server is not configured yet. Please finish setup in the dashboard.",
        ephemeral: true
    });
}

// LOGGING
async function sendLog(guild, embed) {
    const cfg = getGuildConfig(guild.id);
    const logChannel = guild.channels.cache.get(cfg.logChannelId);
    if (!logChannel) return;
    logChannel.send({ embeds: [embed] }).catch(() => {});
}

// PANEL BUILDER
function buildTicketPanel(cfg) {
    const embed = new EmbedBuilder()
        .setTitle(cfg.panelTitle)
        .setDescription(cfg.panelDescription)
        .setColor(cfg.panelColor);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("ticket_create_button")
            .setLabel(cfg.panelButtonText)
            .setStyle(ButtonStyle.Primary)
    );

    return { embed, row };
}

// REFRESH PANEL
async function refreshTicketPanel(guild) {
    const cfg = getGuildConfig(guild.id);
    if (!isGuildConfigured(guild.id)) return;

    const ch = guild.channels.cache.get(cfg.panelChannelId);
    if (!ch) return;

    if (cfg.panelMessageId) {
        try {
            const old = await ch.messages.fetch(cfg.panelMessageId);
            await old.delete().catch(() => {});
        } catch {}
    }

    const { embed, row } = buildTicketPanel(cfg);
    const msg = await ch.send({ embeds: [embed], components: [row] });

    const config = loadConfig();
    config.guilds[guild.id].panelMessageId = msg.id;
    saveConfig(config);
}

// TICKET NUMBER GENERATOR
function generateTicketNumber(guildId) {
    const config = loadConfig();
    config.guilds[guildId].ticketCount++;
    saveConfig(config);
    return config.guilds[guildId].ticketCount.toString().padStart(4, "0");
}

// BLACKLIST CHECK
function isUserBlacklisted(gid, uid) {
    return getGuildConfig(gid).blacklist.includes(uid);
}

// COOLDOWN SYSTEM
const ticketCooldowns = new Map();
function isOnCooldown(gid, uid) {
    const key = `${gid}-${uid}`;
    const end = ticketCooldowns.get(key);
    return end && Date.now() < end;
}
function applyCooldown(gid, uid) {
    const cfg = getGuildConfig(gid);
    ticketCooldowns.set(`${gid}-${uid}`, Date.now() + cfg.cooldown * 1000);
}

// RETURN USER’S OPEN TICKETS
function getOpenTickets(gid, uid) {
    return getGuildConfig(gid).openTickets.filter(t => t.userId === uid);
}

// CATEGORY DROPDOWN
async function showCategoryDropdown(i) {
    const cfg = getGuildConfig(i.guild.id);
    if (!cfg.categories.length) {
        return i.reply({
            content: "No ticket categories configured.",
            ephemeral: true
        });
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId("ticket_category_select")
        .setPlaceholder("Select a category")
        .addOptions(cfg.categories.map(x => ({ label: x.name, value: x.id })));

    return i.reply({
        content: "Choose a category:",
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
    });
}

// CREATE TICKET (WITH PRIORITY)
async function createTicket(interaction, categoryId, priority = "Normal") {
    const guild = interaction.guild;
    const user = interaction.user;
    const gid = guild.id;
    const cfg = getGuildConfig(gid);

    if (isUserBlacklisted(gid, user.id))
        return interaction.editReply({ content: "You are blacklisted.", components: [] });

    if (isOnCooldown(gid, user.id))
        return interaction.editReply({ content: "You are on cooldown.", components: [] });

    if (getOpenTickets(gid, user.id).length >= 1)
        return interaction.editReply({ content: "You already have an open ticket.", components: [] });

    applyCooldown(gid, user.id);

    const num = generateTicketNumber(gid);
    const parent = guild.channels.cache.get(cfg.ticketCategoryId);
    if (!parent) return interaction.editReply("Ticket category invalid.");

    const channel = await guild.channels.create({
        name: `ticket-${num}-${user.username}`.toLowerCase(),
        type: ChannelType.GuildText,
        parent: parent.id,
        permissionOverwrites: [
            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { 
                id: user.id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            },
            { id: cfg.supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel] }
        ]
    });

    const config = loadConfig();
    config.guilds[gid].openTickets.push({
        channelId: channel.id,
        userId: user.id,
        categoryId,
        priority,
        ticketNumber: num,
        createdAt: Date.now(),
        status: "open",
        claimedBy: cfg.autoClaim ? user.id : null
    });
    saveConfig(config);

    await channel.send({
        content: `<@${user.id}> your ticket has been created.`,
        embeds: [
            new EmbedBuilder()
                .setTitle(`Ticket #${num}`)
                .setDescription(`Category: **${categoryId}**\nPriority: **${priority}**`)
                .setColor(0x2f3136)
        ]
    });

    return interaction.editReply({
        content: `Your ticket has been created: <#${channel.id}>`,
        components: []
    });
}

// GET TICKET BY CHANNEL
function getTicketByChannel(gid, cid) {
    return getGuildConfig(gid).openTickets.find(t => t.channelId === cid);
}

// REMOVE TICKET FROM CONFIG
function removeTicket(gid, cid) {
    const config = loadConfig();
    config.guilds[gid].openTickets = config.guilds[gid].openTickets.filter(t => t.channelId !== cid);
    saveConfig(config);
}

// CLAIM TICKET
async function claimTicket(i) {
    const gid = i.guild.id;
    const cfg = getGuildConfig(gid);
    const t = getTicketByChannel(gid, i.channel.id);

    if (!t) return i.reply({ content: "Not a ticket.", ephemeral: true });
    if (!i.member.roles.cache.has(cfg.supportRoleId))
        return i.reply({ content: "No permission.", ephemeral: true });

    t.claimedBy = i.user.id;

    const config = loadConfig();
    config.guilds[gid].openTickets = config.guilds[gid].openTickets.map(x =>
        x.channelId === t.channelId ? t : x
    );
    saveConfig(config);

    await i.reply(`<@${i.user.id}> claimed this ticket.`);
}

// TRANSCRIPT
async function generateTranscript(channel) {
    const msgs = await channel.messages.fetch({ limit: 250 });
    const sorted = [...msgs.values()].reverse();

    let html = `
    <html><head><meta charset="UTF-8"><title>${channel.name}</title>
    <style>body{background:#1e1e1e;color:white;font-family:Arial;padding:20px;}
    .msg{margin-bottom:12px;}.author{color:#4ea1ff;font-weight:bold;}
    .timestamp{color:#aaa;font-size:12px;}.content{margin-top:4px;}
    </style></head><body><h1>Transcript – ${channel.name}</h1><hr>`;

    for (const m of sorted) {
        html += `<div class="msg">
            <div class="author">${m.author.tag}</div>
            <div class="timestamp">${m.createdAt.toUTCString()}</div>
            <div class="content">${m.content || "<i>No content</i>"}</div>
        </div>`;
    }

    html += "</body></html>";

    const file = path.join(__dirname, `transcript-${channel.id}.html`);
    fs.writeFileSync(file, html);
    return file;
}

// CLOSE TICKET
async function closeTicket(i) {
    const gid = i.guild.id;
    const t = getTicketByChannel(gid, i.channel.id);
    if (!t) return i.reply({ content: "Not a ticket.", ephemeral: true });

    const file = await generateTranscript(i.channel);
    await i.reply("Ticket closed.");
    await i.channel.send({ files: [file] });

    removeTicket(gid, i.channel.id);

    setTimeout(() => i.channel.delete().catch(() => {}), 3000);
}

// ARCHIVE TICKET
async function archiveTicket(i) {
    const gid = i.guild.id;
    const cfg = getGuildConfig(gid);
    const t = getTicketByChannel(gid, i.channel.id);

    if (!t) return i.reply({ content: "Not a ticket.", ephemeral: true });
    if (!cfg.archiveCategoryId)
        return i.reply({ content: "Archive not configured.", ephemeral: true });

    const cat = i.guild.channels.cache.get(cfg.archiveCategoryId);
    if (!cat) return i.reply({ content: "Archive invalid.", ephemeral: true });

    await i.channel.setParent(cat.id);
    removeTicket(gid, i.channel.id);

    await i.reply("Ticket archived.");
}

// UI ANTI-SPAM
const uiCooldown = new Map();
function isUiSpam(i) {
    const key = `${i.guild.id}-${i.user.id}`;
    const now = Date.now();
    const last = uiCooldown.get(key);
    if (last && now - last < 1200) return true;
    uiCooldown.set(key, now);
    return false;
}

// INTERACTION ROUTER
client.on("interactionCreate", async i => {
    if (!i.guild || i.user.bot) return;

    if (i.isButton() || i.isStringSelectMenu()) {
        if (isUiSpam(i)) {
            return i.reply({ content: "Slow down.", ephemeral: true }).catch(() => {});
        }
    }

    const gid = i.guild.id;
    const cfg = getGuildConfig(gid);

    if (!isGuildConfigured(gid)) {
        if (i.isButton() || i.isStringSelectMenu())
            return sendNotConfiguredMessage(i);
    }

    // BUTTONS
    if (i.isButton()) {
        if (i.customId === "ticket_create_button")
            return showCategoryDropdown(i);

        if (i.customId === "ticket_claim")
            return claimTicket(i);

        if (i.customId === "ticket_close")
            return closeTicket(i);

        if (i.customId === "ticket_transcript") {
            const f = await generateTranscript(i.channel);
            return i.reply({ files: [f] });
        }

        if (i.customId === "ticket_archive")
            return archiveTicket(i);
    }

    // SELECT MENUS
    if (i.isStringSelectMenu()) {
        if (i.customId === "ticket_category_select") {
            const categoryId = i.values[0];

            tempTicketCache.set(`${gid}-${i.user.id}`, { categoryId });

            if (!cfg.priorities.length) {
                cfg.priorities = ["Normal", "High", "Critical"];
                saveConfig(loadConfig());
            }

            const menu = new StringSelectMenuBuilder()
                .setCustomId("ticket_priority_select")
                .setPlaceholder("Select ticket priority")
                .addOptions(cfg.priorities.map(p => ({ label: p, value: p })));

            return i.update({
                content: `Category selected: **${categoryId}**\nNow choose a priority:`,
                components: [new ActionRowBuilder().addComponents(menu)]
            });
        }

        if (i.customId === "ticket_priority_select") {
            const priority = i.values[0];
            const temp = tempTicketCache.get(`${gid}-${i.user.id}`);

            if (!temp) {
                return i.reply({ content: "Category missing.", ephemeral: true });
            }

            tempTicketCache.delete(`${gid}-${i.user.id}`);

            await i.update({ content: "Creating your ticket...", components: [] });
            return createTicket(i, temp.categoryId, priority);
        }
    }

    // SLASH COMMANDS
    if (i.isChatInputCommand()) {
        if (i.commandName !== "ticketpanel") return;
        if (!i.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return i.reply({ content: "Admins only.", ephemeral: true });

        if (i.options.getSubcommand() === "status") {
            const embed = new EmbedBuilder()
                .setTitle("Ticket Panel Status")
                .setColor(0x2f3136)
                .addFields(
                    { name: "Panel Channel", value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : "None" },
                    { name: "Ticket Category", value: cfg.ticketCategoryId ? `<#${cfg.ticketCategoryId}>` : "None" },
                    { name: "Support Role", value: cfg.supportRoleId ? `<@&${cfg.supportRoleId}>` : "None" },
                    { name: "Categories", value: cfg.categories.length ? cfg.categories.map(c => c.name).join(", ") : "None" },
                    { name: "Priorities", value: cfg.priorities.join(", ") || "None" }
                );

            return i.reply({ embeds: [embed], ephemeral: true });
        }

        if (i.options.getSubcommand() === "refresh") {
            await refreshTicketPanel(i.guild);
            return i.reply({ content: "Panel refreshed.", ephemeral: true });
        }

        if (i.options.getSubcommand() === "send") {
            const ch = i.guild.channels.cache.get(cfg.panelChannelId);
            if (!ch)
                return i.reply({ content: "Invalid panel channel.", ephemeral: true });

            const { embed, row } = buildTicketPanel(cfg);
            await ch.send({ embeds: [embed], components: [row] });

            return i.reply({ content: "Panel sent.", ephemeral: true });
        }
    }
});

// AUTO-CLOSE INACTIVE TICKETS
async function autoCloseInactiveTickets() {
    const config = loadConfig();

    for (const [gid, data] of Object.entries(config.guilds)) {
        const guild = client.guilds.cache.get(gid);
        if (!guild) continue;

        const inactivityLimit = data.autoCloseHours * 3600000;

        for (const t of [...data.openTickets]) {
            const ch = guild.channels.cache.get(t.channelId);
            if (!ch) continue;

            const lastMsg = (await ch.messages.fetch({ limit: 1 })).first();
            const lastActivity = lastMsg ? lastMsg.createdTimestamp : t.createdAt;

            if (Date.now() - lastActivity >= inactivityLimit) {
                await ch.send("Ticket closed due to inactivity.");
                await ch.delete();

                removeTicket(gid, t.channelId);
            }
        }
    }
}

setInterval(autoCloseInactiveTickets, 300000);

// READY EVENT
client.once("ready", () => {
    console.log("=====================================");
    console.log(`BOT READY: ${client.user.tag}`);
    console.log("=====================================");

    const config = loadConfig();

    for (const [gid, data] of Object.entries(config.guilds)) {
        const guild = client.guilds.cache.get(gid);
        if (guild && data.panelChannelId && data.settingsComplete) {
            refreshTicketPanel(guild);
        }
    }
});

// REGISTER SLASH COMMANDS
async function registerSlashCommands() {
    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

    const commands = [
        new SlashCommandBuilder()
            .setName("ticketpanel")
            .setDescription("Ticket panel management")
            .addSubcommand(s => s.setName("refresh").setDescription("Refresh panel"))
            .addSubcommand(s => s.setName("send").setDescription("Send panel"))
            .addSubcommand(s => s.setName("status").setDescription("Show panel status"))
    ].map(c => c.toJSON());

    await rest.put(
        Routes.applicationCommands(process.env.APPLICATION_ID),
        { body: commands }
    );

    console.log("Slash commands registered.");
}

// STARTUP
(async () => {
    await registerSlashCommands();
    await client.login(process.env.TOKEN);
})();

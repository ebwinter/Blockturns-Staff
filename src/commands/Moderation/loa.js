import { 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags 
} from 'discord.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

// 🛠️ CONFIGURATION: Replace these values with your server IDs
const MANAGER_ROLE_ID = "1328564530329944094";   // Role that can approve/deny requests
const LOA_LOG_CHANNEL_ID = "1510447959592931468"; // Channel where requests are sent
const LOA_ROLE_ID = "1510449050095194267";        // Role given to the user when APPROVED

export default {
    data: new SlashCommandBuilder()
        .setName("loa-request")
        .setDescription("Submit a Leave of Absence (LOA) request to staff")
        .setDMPermission(false),
    category: "moderation",

    async execute(interaction, config, client) {
        // 1. Setup the popup fields modal
        const modal = new ModalBuilder()
            .setCustomId(`loa_modal_${interaction.user.id}`)
            .setTitle('LOA Request Form');

        const durationInput = new TextInputBuilder()
            .setCustomId('loa_duration')
            .setLabel('Duration / Timeframe')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., June 24th to July 5th (2 weeks)')
            .setMaxLength(100)
            .setRequired(true);

        const reasonInput = new TextInputBuilder()
            .setCustomId('loa_reason')
            .setLabel('Reason for Leave')
            .setStyle(TextInputStyle.Paragraph) // Multi-line text box
            .setPlaceholder('Provide a detailed reason for your leave of absence...')
            .setMaxLength(1000)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(durationInput),
            new ActionRowBuilder().addComponents(reasonInput)
        );

        // 2. Present the form to the user
        await interaction.showModal(modal);

        // 3. Catch the modal submit data
        try {
            const filter = (i) => i.customId === `loa_modal_${interaction.user.id}` && i.user.id === interaction.user.id;
            const submitted = await interaction.awaitModalSubmit({ filter, time: 300000 }); // 5 minutes

            await submitted.deferReply({ flags: [MessageFlags.Ephemeral] });

            const duration = submitted.fields.getTextInputValue('loa_duration');
            const reason = submitted.fields.getTextInputValue('loa_reason');

            const logChannel = interaction.guild.channels.cache.get(LOA_LOG_CHANNEL_ID);
            if (!logChannel) {
                logger.error(`LOA System Error: Target log channel ${LOA_LOG_CHANNEL_ID} not found.`);
                return await submitted.editReply({ content: "❌ System configuration error. Staff log channel not found." });
            }

            // 4. Build the manager review embed card
            const requestEmbed = createEmbed({
                title: "⏳ New LOA Request Pending",
                description: `A new leave of absence request has been filed for review.`,
                color: "#F1C40F", // Yellow for pending status
            })
            .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
            .addFields(
                { name: "👤 Requester", value: `${interaction.user} (${interaction.user.id})` },
                { name: "⏰ Duration", value: duration },
                { name: "📝 Reason", value: reason }
            )
            .setTimestamp();

            // Create Accept & Deny action row components
            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`loa_approve_${interaction.user.id}`)
                    .setLabel('Approve Request')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId(`loa_deny_${interaction.user.id}`)
                    .setLabel('Deny Request')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('❌')
            );

            // Send notification to the manager log channel, pinging the manager role
            await logChannel.send({
                content: `<@&${MANAGER_ROLE_ID}>`,
                embeds: [requestEmbed],
                components: [actionRow]
            });

            // Confirm submission back to the user privately
            return await submitted.editReply({
                embeds: [
                    successEmbed(
                        "LOA Request Submitted",
                        "Your request has been forwarded directly to management for evaluation. You will receive a direct message once a decision is finalized."
                    )
                ]
            });

        } catch (error) {
            if (error.code === 'InteractionCollectorError') return; // Closed out/Timed out
            logger.error("Error collecting LOA modal data:", error);
        }
    }
};

// --- ACTION BUTTON COLLECTOR ROUTER SYSTEM (Hook into interactionCreate.js) ---
export async function handleLOAButtons(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('loa_')) return;

    // Verify user has the manager role needed to click action items
    if (!interaction.member.roles.cache.has(MANAGER_ROLE_ID)) {
        return await interaction.reply({ 
            content: "❌ You do not have the designated Manager permissions required to process LOA filings.", 
            flags: [MessageFlags.Ephemeral] 
        });
    }

    await interaction.deferUpdate();

    const [,, targetUserId] = interaction.customId.split('_');
    const isApproved = interaction.customId.startsWith('loa_approve_');

    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    
    // Grab previous layout elements
    const originalEmbed = interaction.message.embeds[0];
    const updatedEmbed = createEmbed({
        title: isApproved ? "✅ LOA Request Approved" : "❌ LOA Request Denied",
        description: originalEmbed.description,
        color: isApproved ? "#2ECC71" : "#E74C3C"
    })
    .setAuthor({ name: originalEmbed.author?.name || "Requester", iconURL: originalEmbed.author?.iconURL })
    .addFields(originalEmbed.fields)
    .addFields({ name: "Processed By", value: `${interaction.user} on <t:${Math.floor(Date.now() / 1000)}:F>` })
    .setTimestamp();

    // Remove buttons from log message channel
    await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

    // Handle user DM update alerts
    if (targetUser) {
        const dmEmbed = createEmbed({
            title: isApproved ? "🟢 Your LOA Request Was Approved" : "🔴 Your LOA Request Was Denied",
            description: isApproved 
                ? `Management has reviewed and **approved** your leave of absence request.\nYour LOA role status has been automatically updated in **${interaction.guild.name}**.`
                : `Management has reviewed and **denied** your leave of absence request.\nIf you have questions, please reach out to a manager directly inside **${interaction.guild.name}**.`,
            color: isApproved ? "#2ECC71" : "#E74C3C"
        }).setTimestamp();

        await targetUser.send({ embeds: [dmEmbed] }).catch(() => {
            logger.warn(`Could not DM user ${targetUserId} their LOA update notice.`);
        });
    }

    // Give role to target if approved
    if (isApproved && targetMember) {
        try {
            await targetMember.roles.add(LOA_ROLE_ID);
        } catch (roleError) {
            logger.error(`Failed to automatically assign LOA role to user:`, roleError);
        }
    }
}

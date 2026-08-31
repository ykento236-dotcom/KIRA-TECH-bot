// ============================================================
//  KIRA TECH BOT 🌹 - WhatsApp + Telegram (Pairing Code)
//  Auteur : Mr KIRA_TECH
//  Version : 1.0.0
// ============================================================

require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Pino = require('pino');
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const ytdl = require('ytdl-core');
const translate = require('google-translate-api-x');
const gTTS = require('gtts');
const OpenAI = require('openai');
const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const fetch = require('node-fetch');
const { fileTypeFromBuffer } = require('file-type');
const mime = require('mime-types');

// ============================================================
//  CONFIGURATION
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8717824473:AAFt2phoLICy9tBdKnAdnvn0tOguz7YVZH4';
const OWNER_NUMBER = process.env.OWNER_NUMBER || ''; // sera défini lors du pairing
const PREFIX = '.'; // préfixe principal
const SESSION_DIR = './auth_info';
const WELCOME_IMAGE_URL = 'https://i.ibb.co/hJqtxPrb/52-C1-EBD9-25-DC-44-E8-894-E-BE9755-E9-CB2-A.jpg';
const CHANNEL_WA = 'https://whatsapp.com/channel/0029Vb7WJzp84OmBD0fEEJ2X';
const CHANNEL_TG = 'https://t.me/+mQ3aQpCsEqI0YmY0';
const AUTHOR_TG = 'https://t.me/+242061167625';

// ============================================================
//  ÉTAT GLOBAL
// ============================================================
let sock = null;                // socket WhatsApp
let isWhatsAppReady = false;
let botOwnerNumber = '';        // numéro qui a fait le pairing (propriétaire)
let sudoList = [];             // admins supplémentaires
let groupSettings = {};        // { groupId: { antilink, antibadword, antispam, antitag, antibot, welcomeMsg, goodbyeMsg, antidelete, mute } }
let chatStates = {};           // pour antispam (timestamps)
let deletedMessages = {};      // pour antidelete
let pairingCodeCache = null;   // pour stocker le code généré

// ============================================================
//  LOGGER
// ============================================================
const logger = Pino({ level: 'info' });

// ============================================================
//  TELEGRAM BOT
// ============================================================
const tgBot = new Telegraf(TELEGRAM_TOKEN);

// ============================================================
//  FONCTIONS UTILITAIRES
// ============================================================
function formatNumber(num) {
    return num.replace(/[^0-9]/g, '');
}

function getTime() {
    return new Date().toLocaleString();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadFile(url, outputPath) {
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// ============================================================
//  COMMANDES WHATSAPP - DÉFINITION
// ============================================================
const commands = {};

// ---- GROUPE ----
commands.add = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    if (!args[0]) return sendText(from, '❗ Utilisation : .add <numéro>');
    const num = formatNumber(args[0]) + '@s.whatsapp.net';
    try {
        await sock.groupParticipantsUpdate(from, [num], 'add');
        sendText(from, `✅ ${args[0]} a été ajouté(e).`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.kick = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const target = mention || (args[0] ? formatNumber(args[0]) + '@s.whatsapp.net' : null);
    if (!target) return sendText(from, '❗ Mentionnez ou donnez le numéro.');
    try {
        await sock.groupParticipantsUpdate(from, [target], 'remove');
        sendText(from, `✅ Utilisateur expulsé.`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.promote = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const target = mention || (args[0] ? formatNumber(args[0]) + '@s.whatsapp.net' : null);
    if (!target) return sendText(from, '❗ Mentionnez ou donnez le numéro.');
    try {
        await sock.groupParticipantsUpdate(from, [target], 'promote');
        sendText(from, `✅ Utilisateur promu administrateur.`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.demote = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const target = mention || (args[0] ? formatNumber(args[0]) + '@s.whatsapp.net' : null);
    if (!target) return sendText(from, '❗ Mentionnez ou donnez le numéro.');
    try {
        await sock.groupParticipantsUpdate(from, [target], 'demote');
        sendText(from, `✅ Administrateur rétrogradé.`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.tag = async (msg, args, from, sender) => {
    const text = args.join(' ') || '';
    const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentions.length === 0) return sendText(from, '❗ Mentionnez au moins une personne.');
    sendTextWithMentions(from, text, mentions);
};

commands.tagall = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Seul un admin peut utiliser tagall.');
    const groupMeta = await sock.groupMetadata(from);
    const participants = groupMeta.participants.map(p => p.id);
    const text = args.join(' ') || '📢 Message à tous :';
    sendTextWithMentions(from, text, participants);
};

commands.mute = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const duration = args[0] || 'infini';
    // On stocke dans les settings
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].mute = true;
    await saveSettings();
    sendText(from, `🔇 Groupe muet (${duration}).`);
};

commands.unmute = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].mute = false;
    await saveSettings();
    sendText(from, `🔊 Groupe réactivé.`);
};

commands.welcome = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const text = args.join(' ') || 'Bienvenue @user !';
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].welcomeMsg = text;
    await saveSettings();
    sendText(from, `✅ Message de bienvenue mis à jour.`);
};

commands.goodbye = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const text = args.join(' ') || 'Au revoir @user !';
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].goodbyeMsg = text;
    await saveSettings();
    sendText(from, `✅ Message de départ mis à jour.`);
};

commands.link = async (msg, args, from, sender) => {
    try {
        const code = await sock.groupInviteCode(from);
        sendText(from, `🔗 Lien d'invitation : https://chat.whatsapp.com/${code}`);
    } catch (e) {
        sendText(from, `❌ Impossible d'obtenir le lien.`);
    }
};

commands.resetlink = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    try {
        await sock.groupRevokeInvite(from);
        const code = await sock.groupInviteCode(from);
        sendText(from, `✅ Nouveau lien : https://chat.whatsapp.com/${code}`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.groupinfo = async (msg, args, from, sender) => {
    try {
        const meta = await sock.groupMetadata(from);
        const info = `📋 *Informations du groupe*\n` +
            `📛 Nom : ${meta.subject}\n` +
            `📝 Description : ${meta.desc || 'Aucune'}\n` +
            `👥 Membres : ${meta.participants.length}\n` +
            `🛡️ Admins : ${meta.participants.filter(p => p.admin).map(p => p.id.split('@')[0]).join(', ')}\n` +
            `📅 Créé le : ${new Date(meta.creation * 1000).toLocaleDateString()}`;
        sendText(from, info);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.listadmin = async (msg, args, from, sender) => {
    try {
        const meta = await sock.groupMetadata(from);
        const admins = meta.participants.filter(p => p.admin).map(p => p.id.split('@')[0]);
        sendText(from, `👑 Administrateurs : ${admins.join(', ')}`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.groupname = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const name = args.join(' ');
    if (!name) return sendText(from, '❗ Spécifiez un nom.');
    try {
        await sock.groupUpdateSubject(from, name);
        sendText(from, `✅ Nom du groupe mis à jour.`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.setgdesc = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const desc = args.join(' ');
    if (!desc) return sendText(from, '❗ Spécifiez une description.');
    try {
        await sock.groupUpdateDescription(from, desc);
        sendText(from, `✅ Description mise à jour.`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.ppgroup = async (msg, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    // Récupérer l'image de la réponse ou du message
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    let imageBuffer = null;
    if (quoted?.imageMessage) {
        const stream = await sock.downloadMediaMessage(msg.message.extendedTextMessage.contextInfo.quotedMessage);
        imageBuffer = await streamToBuffer(stream);
    } else if (msg.message?.imageMessage) {
        const stream = await sock.downloadMediaMessage(msg);
        imageBuffer = await streamToBuffer(stream);
    }
    if (!imageBuffer) return sendText(from, '❗ Envoyez une image avec la commande ou répondez à une image.');
    try {
        await sock.updateProfilePicture(from, imageBuffer);
        sendText(from, `✅ Photo de profil du groupe mise à jour.`);
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.staff = async (msg, args, from, sender) => {
    const text = `👥 *Staff du bot*\n` +
        `👑 Propriétaire : ${botOwnerNumber || 'Non défini'}\n` +
        `🛡️ Sudo : ${sudoList.join(', ') || 'Aucun'}`;
    sendText(from, text);
};

commands.antilink = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const state = args[0]?.toLowerCase();
    if (state !== 'on' && state !== 'off') return sendText(from, '❗ Utilisation : .antilink on/off');
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].antilink = (state === 'on');
    await saveSettings();
    sendText(from, `✅ Anti‑lien ${state === 'on' ? 'activé' : 'désactivé'}.`);
};

commands.antibadword = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const state = args[0]?.toLowerCase();
    if (state !== 'on' && state !== 'off') return sendText(from, '❗ Utilisation : .antibadword on/off');
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].antibadword = (state === 'on');
    await saveSettings();
    sendText(from, `✅ Anti‑gros mots ${state === 'on' ? 'activé' : 'désactivé'}.`);
};

commands.antispam = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const state = args[0]?.toLowerCase();
    if (state !== 'on' && state !== 'off') return sendText(from, '❗ Utilisation : .antispam on/off');
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].antispam = (state === 'on');
    await saveSettings();
    sendText(from, `✅ Anti‑spam ${state === 'on' ? 'activé' : 'désactivé'}.`);
};

commands.antitag = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const state = args[0]?.toLowerCase();
    if (state !== 'on' && state !== 'off') return sendText(from, '❗ Utilisation : .antitag on/off');
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].antitag = (state === 'on');
    await saveSettings();
    sendText(from, `✅ Anti‑mentions ${state === 'on' ? 'activé' : 'désactivé'}.`);
};

commands.antibot = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const state = args[0]?.toLowerCase();
    if (state !== 'on' && state !== 'off') return sendText(from, '❗ Utilisation : .antibot on/off');
    if (!groupSettings[from]) groupSettings[from] = {};
    groupSettings[from].antibot = (state === 'on');
    await saveSettings();
    sendText(from, `✅ Anti‑bot ${state === 'on' ? 'activé' : 'désactivé'}.`);
};

commands.del = async (msg, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return sendText(from, '❗ Répondez au message à supprimer.');
    try {
        const key = msg.message.extendedTextMessage.contextInfo.stanzaId;
        await sock.sendMessage(from, { delete: { remoteJid: from, fromMe: false, id: key, participant: msg.message.extendedTextMessage.contextInfo.participant } });
        sendText(from, '✅ Message supprimé.');
    } catch (e) {
        sendText(from, `❌ Erreur : ${e.message}`);
    }
};

commands.purge = async (msg, args, from, sender) => {
    if (!isAdmin(from, sender)) return sendText(from, '❌ Vous devez être administrateur.');
    const count = parseInt(args[0]);
    if (!count || count < 1) return sendText(from, '❗ Spécifiez un nombre valide.');
    // Récupération des messages (non implémenté facilement, on peut faire un déluge)
    sendText(from, `⚠️ Purge non implémentée pour l'instant.`);
};

// ---- FUN ----
commands.blague = async (msg, args, from, sender) => {
    try {
        const res = await axios.get('https://api.blagues-api.fr/random', { headers: { 'Authorization': 'Bearer ' + process.env.BLAGUE_API_KEY } });
        sendText(from, `😂 ${res.data.joke}\n${res.data.answer}`);
    } catch (e) {
        sendText(from, `😆 Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon ils tombent dans le bateau.`);
    }
};

commands.fact = async (msg, args, from, sender) => {
    try {
        const res = await axios.get('https://uselessfacts.jsph.pl/random.json?language=fr');
        sendText(from, `🔍 ${res.data.text}`);
    } catch (e) {
        sendText(from, `🔍 Les fourmis ne dorment jamais.`);
    }
};

commands.meme = async (msg, args, from, sender) => {
    try {
        const res = await axios.get('https://meme-api.com/gimme');
        const meme = res.data;
        await sock.sendMessage(from, { image: { url: meme.url }, caption: `😄 ${meme.title}` });
    } catch (e) {
        sendText(from, `😄 Désolé, pas de mème pour l'instant.`);
    }
};

commands.quote = async (msg, args, from, sender) => {
    try {
        const res = await axios.get('https://api.quotable.io/random');
        sendText(from, `💬 "${res.data.content}" — ${res.data.author}`);
    } catch (e) {
        sendText(from, `💬 "La vie est un mystère qu'il faut vivre."`);
    }
};

commands.gif = async (msg, args, from, sender) => {
    const query = args.join(' ');
    if (!query) return sendText(from, '❗ Spécifiez un mot-clé.');
    try {
        const res = await axios.get(`https://api.giphy.com/v1/gifs/translate?api_key=${process.env.GIPHY_API_KEY}&s=${encodeURIComponent(query)}`);
        const url = res.data.data.images.original.url;
        await sock.sendMessage(from, { gif: { url } });
    } catch (e) {
        sendText(from, `❌ GIF introuvable.`);
    }
};

commands.ship = async (msg, args, from, sender) => {
    if (args.length < 2) return sendText(from, '❗ Utilisation : .ship nom1 nom2');
    const p1 = args[0], p2 = args[1];
    const percent = Math.floor(Math.random() * 101);
    sendText(from, `💕 ${p1} ❤️ ${p2} : ${percent}% de compatibilité !`);
};

commands.truth = async (msg, args, from, sender) => {
    const truths = ['Quelle est votre plus grande peur ?', 'Avez-vous déjà menti à un ami proche ?', 'Quel est votre secret le plus embarrassant ?'];
    sendText(from, `🔮 ${truths[Math.floor(Math.random() * truths.length)]}`);
};

commands.dare = async (msg, args, from, sender) => {
    const dares = ['Faites 10 pompes.', 'Chantez une chanson en public.', 'Imitez un animal pendant 30 secondes.'];
    sendText(from, `🔥 ${dares[Math.floor(Math.random() * dares.length)]}`);
};

commands.compliment = async (msg, args, from, sender) => {
    const compliments = ['Tu es génial(e) !', 'Ta présence illumine la pièce.', 'Tu as un sourire magnifique.'];
    const target = args[0] || 'toi';
    sendText(from, `💖 ${target} : ${compliments[Math.floor(Math.random() * compliments.length)]}`);
};

commands.goodnight = async (msg, args, from, sender) => {
    sendText(from, `🌙 Bonne nuit, fais de beaux rêves !`);
};

commands.roseday = async (msg, args, from, sender) => {
    sendText(from, `🌹 Joyeuse Journée de la Rose ! Que l'amour fleurisse.`);
};

commands.valentine = async (msg, args, from, sender) => {
    sendText(from, `❤️ Joyeuse Saint-Valentin ! Tu es l'amour de ma vie.`);
};

// ---- OWNER ----
commands.ban = async (msg, args, from, sender) => {
    if (!isOwner(sender)) return sendText(from, '❌ Seul le propriétaire peut exécuter cette commande.');
    // Implémentation simplifiée
    sendText(from, `⚠️ Fonction ban non implémentée.`);
};

commands.unban = async (msg, args, from, sender) => {
    if (!isOwner(sender)) return sendText(from, '❌ Seul le propriétaire peut exécuter cette commande.');
    sendText(from, `⚠️ Fonction unban non implémentée.`);
};

commands.block = async (msg, args, from, sender) => {
    if (!isOwner(sender)) return sendText(from, '❌ Seul le propriétaire peut exécuter cette commande.');
    const num = args[0];
    if (!num) return sendText(from, '❗ Spécifiez un numéro.');
    try {
        await sock.updateBlockStatus(format
                                

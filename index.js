const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const mongoose = require('mongoose');
const express = require('express');
const crypto = require('crypto');

// --- 1. WEB SUNUCUSU (Lisans Kontrol API) ---
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- 2. VERİTABANI MODELİ ---
const licenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    durationDays: { type: Number, required: true },
    hwid: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    createdBy: { type: String, default: 'Admin' }
});

const License = mongoose.model('License', licenseSchema);

// --- 3. LİSANS DOĞRULAMA API ---
app.post('/api/verify', async (req, res) => {
    try {
        const { key, hwid } = req.body;

        if (!key || !hwid) {
            return res.status(400).json({ success: false, message: 'Anahtar veya HWID eksik.' });
        }

        const license = await License.findOne({ key: key.trim() });

        if (!license) {
            return res.status(404).json({ success: false, message: 'Gecersiz lisans anahtari.' });
        }

        // İlk aktivasyon
        if (!license.activatedAt) {
            const now = new Date();
            license.activatedAt = now;
            license.hwid = hwid;
            license.expiresAt = new Date(now.getTime() + license.durationDays * 24 * 60 * 60 * 1000);
            await license.save();

            return res.json({
                success: true,
                message: 'Lisans basariyla aktive edildi!',
                expiresAt: license.expiresAt
            });
        }

        // Süre kontrolü
        if (new Date() > license.expiresAt) {
            return res.status(403).json({ success: false, message: 'Lisans sureniz dolmustur.' });
        }

        // HWID kontrolü
        if (license.hwid !== hwid) {
            return res.status(403).json({ success: false, message: 'Bu lisans baska bir bilgisayara kayitli!' });
        }

        return res.json({
            success: true,
            message: 'Lisans gecerli.',
            expiresAt: license.expiresAt
        });

    } catch (err) {
        return res.status(500).json({ success: false, message: 'Sunucu hatasi meydana geldi.' });
    }
});

app.get('/', (req, res) => res.send('Lisans Dogrulama Sunucusu Calisiyor.'));

// --- 4. DISCORD BOTU ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const commands = [
    new SlashCommandBuilder()
        .setName('lisans-olustur')
        .setDescription('Yeni bir lisans anahtarı üretir')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addIntegerOption(opt => 
            opt.setName('gun')
               .setDescription('Lisans süresi kaç gün olacak?')
               .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('lisans-bilgi')
        .setDescription('Lisans durumunu sorgular')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt => 
            opt.setName('anahtar')
               .setDescription('Sorgulanacak lisans anahtarı')
               .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('hwid-sifirla')
        .setDescription('Lisansın donanım kilidini sıfırlar')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt => 
            opt.setName('anahtar')
               .setDescription('HWID sıfırlanacak lisans anahtarı')
               .setRequired(true)
        )
];

async function registerCommands(token, clientId) {
    const rest = new REST({ version: '10' }).setToken(token);
    try {
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log('Komutlar Discord API ye kaydedildi.');
    } catch (error) {
        console.error('Komut kayit hatasi:', error);
    }
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'lisans-olustur') {
        const gun = interaction.options.getInteger('gun');
        const randomKey = 'KEY-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();

        const newLicense = new License({
            key: randomKey,
            durationDays: gun,
            createdBy: interaction.user.tag
        });

        await newLicense.save();

        const embed = new EmbedBuilder()
            .setTitle('🔑 Yeni Lisans Oluşturuldu')
            .setColor(0x00FF7F)
            .addFields(
                { name: 'Lisans Anahtarı', value: `\`${randomKey}\``, inline: false },
                { name: 'Süre', value: `${gun} Gün`, inline: true },
                { name: 'Oluşturan', value: `<@${interaction.user.id}>`, inline: true }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'lisans-bilgi') {
        const key = interaction.options.getString('anahtar').trim();
        const license = await License.findOne({ key });

        if (!license) {
            return interaction.reply({ content: '❌ Belirtilen lisans bulunamadı.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle('📋 Lisans Bilgileri')
            .setColor(0x3498DB)
            .addFields(
                { name: 'Anahtar', value: `\`${license.key}\``, inline: false },
                { name: 'Tanımlı Gün', value: `${license.durationDays} Gün`, inline: true },
                { name: 'Durum', value: license.activatedAt ? 'Aktif' : 'Beklemede (Kullanılmadı)', inline: true },
                { name: 'Bağlı HWID', value: license.hwid ? `\`${license.hwid}\`` : 'Yok', inline: false },
                { name: 'Bitiş Tarihi', value: license.expiresAt ? license.expiresAt.toLocaleString('tr-TR') : 'Başlatılmadı', inline: false }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'hwid-sifirla') {
        const key = interaction.options.getString('anahtar').trim();
        const license = await License.findOne({ key });

        if (!license) {
            return interaction.reply({ content: '❌ Belirtilen lisans bulunamadı.', ephemeral: true });
        }

        license.hwid = null;
        await license.save();

        return interaction.reply({ content: `✅ \`${key}\` lisansının donanım kilidi (HWID) sıfırlandı.`, ephemeral: true });
    }
});

// --- 5. BAŞLATMA ---
async function start() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB baglantisi basarili.');

        app.listen(PORT, () => {
            console.log(`Sunucu ${PORT} portunda dinleniyor.`);
        });

        await client.login(process.env.DISCORD_TOKEN);
        console.log(`Bot giris yapti: ${client.user.tag}`);

        await registerCommands(process.env.DISCORD_TOKEN, client.user.id);
    } catch (err) {
        console.error('Sistem baslatma hatasi:', err);
    }
}

start();

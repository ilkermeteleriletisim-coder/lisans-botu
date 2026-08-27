const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const express = require('express');
const crypto = require('crypto');

// --- EXPRESS WEB SUNUCUSU (Render & Minecraft Mod API) ---
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Lisans Dogrulama Sunucusu Calisiyor.');
});

// --- MONGODB LİSANS ŞEMASI ---
const licenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    days: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    hwid: { type: String, default: null },
    createdBy: { type: String, required: true },
    status: { type: String, default: 'active' } // active, expired
});

const License = mongoose.model('License', licenseSchema);

// --- MOD İÇİN LİSANS DOĞRULAMA API'Sİ ---
app.post('/api/verify', async (req, res) => {
    try {
        const { licenseKey, hwid } = req.body;

        if (!licenseKey) {
            return res.status(400).json({ valid: false, message: 'Lisans anahtari gerekli.' });
        }

        const cleanKey = licenseKey.trim().toUpperCase();
        const license = await License.findOne({ key: cleanKey });

        if (!license) {
            return res.status(404).json({ valid: false, message: 'Gecersiz lisans anahtari.' });
        }

        const now = new Date();

        // Süre kontrolü
        if (license.expiresAt && now > license.expiresAt) {
            license.status = 'expired';
            await license.save();
            return res.status(403).json({ valid: false, message: 'Lisans suresi dolmus.' });
        }

        // İlk aktivasyon
        if (!license.activatedAt) {
            license.activatedAt = now;
            const expireDate = new Date(now.getTime() + license.days * 24 * 60 * 60 * 1000);
            license.expiresAt = expireDate;
            license.hwid = hwid || null;
            await license.save();

            return res.json({ 
                valid: true, 
                message: 'Lisans basariyla aktive edildi.', 
                owner: license.createdBy,
                expiresAt: license.expiresAt 
            });
        }

        // Donanım (HWID) kontrolü
        if (license.hwid && hwid && license.hwid !== hwid) {
            return res.status(403).json({ valid: false, message: 'Bu lisans baska bir cihaza baglidir.' });
        }

        return res.json({ 
            valid: true, 
            message: 'Lisans gecerli.', 
            owner: license.createdBy,
            expiresAt: license.expiresAt 
        });

    } catch (error) {
        console.error('API Dogrulama Hatasi:', error);
        return res.status(500).json({ valid: false, message: 'Sunucu hatasi.' });
    }
});

// --- DISCORD BOTU VE KOMUTLARI ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('lisans-olustur')
        .setDescription('Yeni bir lisans anahtarı üretir')
        .addIntegerOption(option => 
            option.setName('gun')
                .setDescription('Lisans süresi (gün olarak)')
                .setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('lisans-bilgi')
        .setDescription('Lisans durumunu sorgular')
        .addStringOption(option => 
            option.setName('anahtar')
                .setDescription('Sorgulanacak lisans anahtarı')
                .setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('lisans-sil')
        .setDescription('Bir lisans anahtarını veritabanından tamamen siler')
        .addStringOption(option => 
            option.setName('anahtar')
                .setDescription('Silinecek lisans anahtarı')
                .setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('hwid-sifirla')
        .setDescription('Lisansın donanım kilidini sıfırlar')
        .addStringOption(option => 
            option.setName('anahtar')
                .setDescription('HWID sıfırlanacak lisans anahtarı')
                .setRequired(true))
        .toJSON()
];

// --- DISCORD ETKİLEŞİM YÖNETİCİSİ ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'lisans-olustur') {
        const gun = options.getInteger('gun');
        const randomPart1 = crypto.randomBytes(4).toString('hex').toUpperCase();
        const randomPart2 = crypto.randomBytes(4).toString('hex').toUpperCase();
        const licenseKey = `KEY-${randomPart1}-${randomPart2}`;

        try {
            const newLicense = new License({
                key: licenseKey,
                days: gun,
                createdBy: interaction.user.tag
            });

            await newLicense.save();

            const embed = new EmbedBuilder()
                .setTitle('🔑 Yeni Lisans Oluşturuldu')
                .setColor(0x2ecc71)
                .addFields(
                    { name: 'Lisans Anahtarı', value: `\`${licenseKey}\``, inline: false },
                    { name: 'Süre', value: `${gun} Gün`, inline: true },
                    { name: 'Oluşturan', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Lisans Olusturma Hatasi:', error);
            await interaction.reply({ content: 'Lisans oluşturulurken hata oluştu.', ephemeral: true });
        }
    }

    if (commandName === 'lisans-bilgi') {
        const key = options.getString('anahtar').trim().toUpperCase();

        try {
            const license = await License.findOne({ key });

            if (!license) {
                return interaction.reply({ content: '❌ Belirtilen lisans anahtarı bulunamadı.', ephemeral: true });
            }

            let durumText = '🟡 Beklemede (Kullanılmadı)';
            if (license.activatedAt) {
                durumText = (license.expiresAt && new Date() > license.expiresAt) ? '🔴 Süresi Dolmuş' : '🟢 Aktif';
            }

            const embed = new EmbedBuilder()
                .setTitle('📄 Lisans Bilgileri')
                .setColor(0x3498db)
                .addFields(
                    { name: 'Anahtar', value: `\`${license.key}\``, inline: false },
                    { name: 'Tanımlı Gün', value: `${license.days} Gün`, inline: true },
                    { name: 'Durum', value: durumText, inline: true },
                    { name: 'Bağlı HWID', value: license.hwid ? `\`${license.hwid}\`` : 'Bağlı Değil', inline: false },
                    { name: 'Oluşturan', value: license.createdBy, inline: true }
                )
                .setTimestamp();

            if (license.expiresAt) {
                embed.addFields({ name: 'Bitiş Tarihi', value: `<t:${Math.floor(license.expiresAt.getTime() / 1000)}:F>`, inline: false });
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Lisans Bilgi Hatasi:', error);
            await interaction.reply({ content: 'Sorgulama yapılırken hata oluştu.', ephemeral: true });
        }
    }

    if (commandName === 'lisans-sil') {
        const key = options.getString('anahtar').trim().toUpperCase();

        try {
            const deleted = await License.findOneAndDelete({ key });

            if (!deleted) {
                return interaction.reply({ content: '❌ Silinmek istenen lisans anahtarı veritabanında bulunamadı.', ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setTitle('🗑️ Lisans Silindi')
                .setColor(0xe74c3c)
                .setDescription(`\`${key}\` anahtarı veritabanından tamamen silindi.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Lisans Silme Hatasi:', error);
            await interaction.reply({ content: 'Lisans silinirken hata oluştu.', ephemeral: true });
        }
    }

    if (commandName === 'hwid-sifirla') {
        const key = options.getString('anahtar').trim().toUpperCase();

        try {
            const license = await License.findOne({ key });

            if (!license) {
                return interaction.reply({ content: '❌ Belirtilen lisans anahtarı bulunamadı.', ephemeral: true });
            }

            license.hwid = null;
            await license.save();

            const embed = new EmbedBuilder()
                .setTitle('🔄 HWID Kilidi Sıfırlandı')
                .setColor(0xf1c40f)
                .setDescription(`\`${key}\` lisansına ait donanım kilidi sıfırlandı. Yeni cihazda kullanılabilir.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('HWID Sifirlama Hatasi:', error);
            await interaction.reply({ content: 'HWID sıfırlanırken hata oluştu.', ephemeral: true });
        }
    }
});

// --- BAŞLATMA FONKSİYONU ---
async function startServer() {
    try {
        const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;
        const discordToken = process.env.DISCORD_TOKEN || process.env.TOKEN;
        const clientId = process.env.CLIENT_ID || process.env.APPLICATION_ID;

        if (!mongoUri) {
            console.error('HATA: MongoDB bağlantı linki bulunamadı! Render Environment Variables kısmını kontrol edin.');
            return;
        }

        await mongoose.connect(mongoUri);
        console.log('MongoDB baglantisi basarili.');

        app.listen(PORT, () => {
            console.log(`Sunucu ${PORT} portunda dinleniyor.`);
        });

        if (discordToken && clientId) {
            const rest = new REST({ version: '10' }).setToken(discordToken);
            console.log('Komutlar Discord API ye kaydediliyor...');
            await rest.put(
                Routes.applicationCommands(clientId),
                { body: commands }
            );
            console.log('Komutlar Discord API ye kaydedildi.');

            await client.login(discordToken);
            console.log(`Bot giris yapti: ${client.user.tag}`);
        } else {
            console.warn('UYARI: DISCORD_TOKEN veya CLIENT_ID eksik olduğu için bot başlatılamadı.');
        }

    } catch (err) {
        console.error('Baslatma hatasi:', err);
    }
}

startServer();

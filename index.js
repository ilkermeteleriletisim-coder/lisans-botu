const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ── HMAC İmza Sistemi ──────────────────────────────────────────────────────
// Render'da HMAC_SECRET environment variable olarak ayarla
const HMAC_SECRET = process.env.HMAC_SECRET;
if (!HMAC_SECRET) {
    console.error('[GÜVENLİK] UYARI: HMAC_SECRET ortam değişkeni tanımlı değil!');
}

/**
 * /api/verify yanıtlarını imzalar.
 * payload: licenseKey + "|" + valid + "|" + expiresAt (ISO string veya "null")
 */
function signResponse(licenseKey, valid, expiresAt) {
    if (!HMAC_SECRET) return 'NO_SECRET';
    const expStr = expiresAt ? new Date(expiresAt).toISOString() : 'null';
    const payload = `${licenseKey.trim().toUpperCase()}|${valid}|${expStr}`;
    return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

// ── ANASAYFA ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send('Lisans ve Guncelleme Sunucusu Calisiyor.');
});

// ── VERİTABANI ŞEMALARI ───────────────────────────────────────────────────
const licenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    days: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    hwid: { type: String, default: null },
    createdBy: { type: String, required: true },
    status: { type: String, default: 'active' }
});

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    latestVersion: { type: String, default: '1.0.0' },
    downloadUrl: { type: String, default: '' },
    forceUpdate: { type: Boolean, default: true }
});

const License = mongoose.model('License', licenseSchema);
const Config  = mongoose.model('Config', configSchema);

// ── API: SÜRÜM & GÜNCELLEME KONTROLÜ ─────────────────────────────────────
app.get('/api/version', async (req, res) => {
    try {
        let conf = await Config.findOne({ key: 'mod_config' });
        if (!conf) {
            conf = await Config.create({ key: 'mod_config', latestVersion: '1.0.0', downloadUrl: '' });
        }
        return res.json({
            latestVersion: conf.latestVersion,
            downloadUrl: conf.downloadUrl,
            forceUpdate: conf.forceUpdate
        });
    } catch (err) {
        return res.status(500).json({ error: 'Sunucu hatasi' });
    }
});

// ── API: LİSANS DOĞRULAMA (HMAC İMZALI) ─────────────────────────────────
app.post('/api/verify', async (req, res) => {
    try {
        const { licenseKey, hwid } = req.body;
        if (!licenseKey) {
            const sig = signResponse('', false, null);
            return res.status(400).json({ valid: false, message: 'Lisans anahtari gerekli.', signature: sig });
        }

        const cleanKey = licenseKey.trim().toUpperCase();
        const license  = await License.findOne({ key: cleanKey });

        if (!license) {
            const sig = signResponse(cleanKey, false, null);
            return res.status(404).json({ valid: false, message: 'Gecersiz lisans.', signature: sig });
        }

        const now = new Date();

        // Süresi dolmuş mu?
        if (license.expiresAt && now > license.expiresAt) {
            license.status = 'expired';
            await license.save();
            const sig = signResponse(cleanKey, false, license.expiresAt);
            return res.status(403).json({ valid: false, message: 'Lisans suresi dolmus.', expiresAt: license.expiresAt, signature: sig });
        }

        // İlk aktivasyon
        if (!license.activatedAt) {
            license.activatedAt = now;
            license.expiresAt   = new Date(now.getTime() + license.days * 24 * 60 * 60 * 1000);
            license.hwid        = hwid || null;
            await license.save();
            const sig = signResponse(cleanKey, true, license.expiresAt);
            return res.json({ valid: true, message: 'Lisans aktive edildi.', expiresAt: license.expiresAt, signature: sig });
        }

        // HWID kilit kontrolü
        if (license.hwid && hwid && license.hwid !== hwid) {
            const sig = signResponse(cleanKey, false, null);
            return res.status(403).json({ valid: false, message: 'Baska cihaza bagli.', signature: sig });
        }

        // Geçerli lisans
        const sig = signResponse(cleanKey, true, license.expiresAt);
        return res.json({ valid: true, message: 'Lisans gecerli.', expiresAt: license.expiresAt, signature: sig });

    } catch (error) {
        console.error('[/api/verify] Hata:', error);
        const sig = signResponse(req.body?.licenseKey || '', false, null);
        return res.status(500).json({ valid: false, message: 'Sunucu hatasi.', signature: sig });
    }
});

// ── DISCORD KOMUTLARI ─────────────────────────────────────────────────────
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('lisans-olustur')
        .setDescription('Yeni bir lisans anahtarı üretir')
        .addIntegerOption(opt => opt.setName('gun').setDescription('Süre').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('lisans-bilgi')
        .setDescription('Lisans durumunu sorgular')
        .addStringOption(opt => opt.setName('anahtar').setDescription('Lisans').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('lisans-sil')
        .setDescription('Lisansı veritabanından siler')
        .addStringOption(opt => opt.setName('anahtar').setDescription('Lisans').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('hwid-sifirla')
        .setDescription('Donanım kilidini sıfırlar')
        .addStringOption(opt => opt.setName('anahtar').setDescription('Lisans').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('guncelleme-ayarla')
        .setDescription('Modun yeni sürümünü ve indirme linkini belirler')
        .addStringOption(opt => opt.setName('surum').setDescription('Örn: 1.0.1').setRequired(true))
        .addStringOption(opt => opt.setName('link').setDescription('Yeni .jar dosyasının doğrudan indirme linki').setRequired(true))
        .toJSON()
];

discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options } = interaction;

    if (commandName === 'guncelleme-ayarla') {
        const surum = options.getString('surum').trim();
        const link  = options.getString('link').trim();
        await Config.findOneAndUpdate(
            { key: 'mod_config' },
            { latestVersion: surum, downloadUrl: link },
            { upsert: true }
        );
        const embed = new EmbedBuilder()
            .setTitle('🚀 Yeni Güncelleme Yayında!')
            .setColor(0x9b59b6)
            .addFields(
                { name: 'Yeni Sürüm', value: `\`${surum}\``, inline: true },
                { name: 'İndirme Linki', value: `[Dosyayı Gör](${link})`, inline: false }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'lisans-olustur') {
        const gun = options.getInteger('gun');
        const key = `KEY-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        await License.create({ key, days: gun, createdBy: interaction.user.tag });
        const embed = new EmbedBuilder()
            .setTitle('🔑 Yeni Lisans Oluşturuldu')
            .setColor(0x2ecc71)
            .addFields(
                { name: 'Lisans Anahtarı', value: `\`${key}\``, inline: false },
                { name: 'Süre', value: `${gun} Gün`, inline: true }
            );
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'lisans-bilgi') {
        const key     = options.getString('anahtar').trim().toUpperCase();
        const license = await License.findOne({ key });
        if (!license) return interaction.reply({ content: '❌ Lisans bulunamadı.', ephemeral: true });

        const now    = new Date();
        const durum  = !license.activatedAt ? '🟡 Beklemede'
                     : now > license.expiresAt ? '🔴 Bitti'
                     : '🟢 Aktif';
        const kalan  = license.expiresAt
                     ? `<t:${Math.floor(license.expiresAt.getTime() / 1000)}:R>`
                     : 'Bilinmiyor';

        const embed = new EmbedBuilder()
            .setTitle('📄 Lisans Bilgileri')
            .setColor(0x3498db)
            .addFields(
                { name: 'Anahtar', value: `\`${license.key}\`` },
                { name: 'Durum', value: durum, inline: true },
                { name: 'Kalan Süre', value: kalan, inline: true },
                { name: 'HWID Bağlı', value: license.hwid ? '🔒 Evet' : '🔓 Hayır', inline: true }
            );
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'lisans-sil') {
        const key = options.getString('anahtar').trim().toUpperCase();
        await License.findOneAndDelete({ key });
        return interaction.reply({ content: `\`${key}\` silindi.`, ephemeral: true });
    }

    if (commandName === 'hwid-sifirla') {
        const key = options.getString('anahtar').trim().toUpperCase();
        await License.findOneAndUpdate({ key }, { hwid: null });
        return interaction.reply({ content: `\`${key}\` HWID sıfırlandı.`, ephemeral: true });
    }
});

// ── BAŞLATMA ───────────────────────────────────────────────────────────────
async function startServer() {
    const mongoUri     = process.env.MONGODB_URI || process.env.MONGO_URI;
    const discordToken = process.env.DISCORD_TOKEN || process.env.TOKEN;
    const clientId     = process.env.CLIENT_ID;

    await mongoose.connect(mongoUri);
    app.listen(PORT, () => console.log(`API ${PORT} portunda aktif.`));

    const rest = new REST({ version: '10' }).setToken(discordToken);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    await discordClient.login(discordToken);
}

startServer();

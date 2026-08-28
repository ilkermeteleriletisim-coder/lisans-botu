const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const HMAC_SECRET = process.env.HMAC_SECRET;

if (!HMAC_SECRET) {
    console.error('[GÜVENLİK] UYARI: HMAC_SECRET ortam değişkeni tanımlı değil!');
}

function signResponse(licenseKey, valid, expiresAt) {
    if (!HMAC_SECRET) return 'NO_SECRET';
    const expStr = expiresAt ? new Date(expiresAt).toISOString() : 'null';
    const payload = `${licenseKey.trim().toUpperCase()}|${valid}|${expStr}`;
    return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

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
    allowedAccounts: { type: [String], default: [] },
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

// ── API: LİSANS DOĞRULAMA (1 HWID + 2 HESAP SINIRI) ──────────────────────
app.post('/api/verify', async (req, res) => {
    try {
        const { licenseKey, hwid, username } = req.body;
        if (!licenseKey) {
            const sig = signResponse('', false, null);
            return res.status(400).json({ valid: false, message: 'Lisans anahtarı gerekli.', signature: sig });
        }

        const cleanKey = licenseKey.trim().toUpperCase();
        const license  = await License.findOne({ key: cleanKey });

        if (!license) {
            const sig = signResponse(cleanKey, false, null);
            return res.status(404).json({ valid: false, message: 'Geçersiz lisans anahtarı.', signature: sig });
        }

        const now = new Date();

        if (license.expiresAt && now > license.expiresAt) {
            license.status = 'expired';
            await license.save();
            const sig = signResponse(cleanKey, false, license.expiresAt);
            return res.status(403).json({ valid: false, message: 'Lisans süreniz doldu.', expiresAt: license.expiresAt, signature: sig });
        }

        const cleanUser = (username || '').trim().toLowerCase();

        // İlk Aktivasyon
        if (!license.activatedAt) {
            license.activatedAt = now;
            license.expiresAt   = new Date(now.getTime() + license.days * 24 * 60 * 60 * 1000);
            license.hwid        = hwid || null;
            if (cleanUser) license.allowedAccounts = [cleanUser];
            await license.save();

            const sig = signResponse(cleanKey, true, license.expiresAt);
            return res.json({ valid: true, message: 'Lisans aktive edildi.', expiresAt: license.expiresAt, signature: sig });
        }

        // 1. Kural: HWID Cihaz Kilidi Kontrolü
        if (license.hwid && hwid && license.hwid !== hwid) {
            const sig = signResponse(cleanKey, false, null);
            return res.status(403).json({ valid: false, message: 'Bu lisans başka bir cihaza kilitli!', signature: sig });
        }

        // 2. Kural: Maksimum 2 Hesap Kontrolü
        if (cleanUser) {
            if (!license.allowedAccounts) license.allowedAccounts = [];
            
            const isRegistered = license.allowedAccounts.includes(cleanUser);
            if (!isRegistered) {
                if (license.allowedAccounts.length >= 2) {
                    const sig = signResponse(cleanKey, false, license.expiresAt);
                    return res.status(403).json({ 
                        valid: false, 
                        message: 'Bu lisans için maksimum 2 hesap sınırına ulaşıldı!', 
                        signature: sig 
                    });
                }
                license.allowedAccounts.push(cleanUser);
                await license.save();
            }
        }

        if (!license.hwid && hwid) {
            license.hwid = hwid;
            await license.save();
        }

        const sig = signResponse(cleanKey, true, license.expiresAt);
        return res.json({ valid: true, message: 'Lisans onaylandı.', expiresAt: license.expiresAt, signature: sig });

    } catch (error) {
        console.error('[/api/verify] Hata:', error);
        const sig = signResponse(req.body?.licenseKey || '', false, null);
        return res.status(500).json({ valid: false, message: 'Sunucu hatası.', signature: sig });
    }
});

// ── DISCORD KOMUTLARI ─────────────────────────────────────────────────────
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('lisans-olustur')
        .setDescription('Yeni bir lisans anahtarı üretir')
        .addIntegerOption(opt => opt.setName('gun').setDescription('Süre (Gün)').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('lisans-bilgi')
        .setDescription('Lisans durumunu ve kalan süreyi detaylı sorgular')
        .addStringOption(opt => opt.setName('anahtar').setDescription('Lisans Anahtarı').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('lisans-sil')
        .setDescription('Lisansı veritabanından siler')
        .addStringOption(opt => opt.setName('anahtar').setDescription('Lisans Anahtarı').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('hwid-sifirla')
        .setDescription('Donanım kilidini ve kayıtlı hesapları sıfırlar')
        .addStringOption(opt => opt.setName('anahtar').setDescription('Lisans Anahtarı').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('guncelleme-ayarla')
        .setDescription('Modun yeni sürümünü ve indirme linkini belirler')
        .addStringOption(opt => opt.setName('surum').setDescription('Örn: 1.0.1').setRequired(true))
        .addStringOption(opt => opt.setName('link').setDescription('Yeni .jar linki').setRequired(true))
        .toJSON()
];

discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options } = interaction;

    try {
        if (commandName === 'lisans-olustur') {
            const gun = options.getInteger('gun');
            const key = `KEY-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            await License.create({ key, days: gun, createdBy: interaction.user.tag });
            const embed = new EmbedBuilder()
                .setTitle('🔑 Yeni Lisans Oluşturuldu')
                .setColor(0x2ecc71)
                .addFields(
                    { name: 'Lisans Anahtarı', value: `\`${key}\``, inline: false },
                    { name: 'Süre', value: `${gun} Gün`, inline: true },
                    { name: 'Kural', value: '1 Cihaz / Max 2 Hesap', inline: true }
                );
            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === 'lisans-bilgi') {
            const key     = options.getString('anahtar').trim().toUpperCase();
            const license = await License.findOne({ key });
            if (!license) return interaction.reply({ content: '❌ Lisans bulunamadı.', ephemeral: true });

            const now = new Date();
            let durum = '🟢 Aktif';
            let kalanMetin = 'Bilinmiyor';
            let countdownLive = '';

            if (!license.activatedAt) {
                durum = '🟡 Beklemede (Henüz Aktive Edilmedi)';
                kalanMetin = `${license.days} Gün`;
                countdownLive = 'Oyun içinde giriş yapılınca başlar';
            } else if (license.expiresAt) {
                const diffMs = new Date(license.expiresAt).getTime() - now.getTime();
                if (diffMs > 0) {
                    const days    = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    const hours   = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

                    kalanMetin = `${days}g ${hours}s ${minutes}d ${seconds}sn`;
                    countdownLive = `<t:${Math.floor(license.expiresAt.getTime() / 1000)}:R>`;
                } else {
                    durum = '🔴 Süresi Doldu';
                    kalanMetin = '0g 0s 0d 0sn';
                    countdownLive = 'Süre bitti';
                }
            }

            const hesaplar = (license.allowedAccounts && license.allowedAccounts.length > 0)
                         ? license.allowedAccounts.join(', ')
                         : 'Henüz hesap kaydedilmedi';

            const embed = new EmbedBuilder()
                .setTitle('📄 Lisans Bilgileri & Canlı Sayaç')
                .setColor(0x3498db)
                .addFields(
                    { name: '🔑 Anahtar', value: `\`${license.key}\``, inline: false },
                    { name: '📊 Durum', value: durum, inline: true },
                    { name: '⏱️ Kalan Süre', value: `\`${kalanMetin}\``, inline: true },
                    { name: '⏳ Canlı Sayaç', value: countdownLive, inline: true },
                    { name: '🔒 HWID Kilidi', value: license.hwid ? '🔒 Kilitli' : '🔓 Serbest', inline: true },
                    { name: '👥 Kayıtlı Hesaplar (Max 2)', value: `\`${hesaplar}\``, inline: false }
                )
                .setFooter({ text: 'AutoMarket Lisans Yönetimi' })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === 'hwid-sifirla') {
            const key = options.getString('anahtar').trim().toUpperCase();
            await License.findOneAndUpdate({ key }, { hwid: null, allowedAccounts: [] });
            return interaction.reply({ content: `\`${key}\` cihaz kilidi ve kayıtlı hesapları sıfırlandı.`, ephemeral: true });
        }

        if (commandName === 'lisans-sil') {
            const key = options.getString('anahtar').trim().toUpperCase();
            await License.findOneAndDelete({ key });
            return interaction.reply({ content: `\`${key}\` silindi.`, ephemeral: true });
        }

        if (commandName === 'guncelleme-ayarla') {
            const surum = options.getString('surum').trim();
            const link  = options.getString('link').trim();
            await Config.findOneAndUpdate(
                { key: 'mod_config' },
                { latestVersion: surum, downloadUrl: link },
                { upsert: true }
            );
            const embed = new EmbedBuilder()
                .setTitle('🚀 Güncelleme Kaydedildi')
                .setColor(0x9b59b6)
                .addFields(
                    { name: 'Yeni Sürüm', value: `\`${surum}\``, inline: true },
                    { name: 'İndirme Linki', value: `[Dosyayı Gör](${link})`, inline: false }
                );
            return interaction.reply({ embeds: [embed] });
        }
    } catch (cmdErr) {
        console.error('Komut çalıştırma hatası:', cmdErr);
        if (!interaction.replied && !interaction.deferred) {
            return interaction.reply({ content: '❌ Komut işlenirken bir hata oluştu.', ephemeral: true });
        }
    }
});

async function startServer() {
    try {
        const mongoUri     = process.env.MONGODB_URI || process.env.MONGO_URI;
        const discordToken = process.env.DISCORD_TOKEN || process.env.TOKEN;
        const clientId     = process.env.CLIENT_ID;

        if (mongoUri) {
            await mongoose.connect(mongoUri);
            console.log('[Mongo] Veritabanı bağlandı.');
        }

        app.listen(PORT, () => console.log(`API ${PORT} portunda aktif.`));

        if (discordToken && clientId) {
            const rest = new REST({ version: '10' }).setToken(discordToken);
            console.log('[Discord] Slash komutları kaydediliyor...');
            await rest.put(Routes.applicationCommands(clientId), { body: commands });
            console.log('[Discord] Slash komutları başarıyla kaydedildi.');
            await discordClient.login(discordToken);
            console.log('[Discord] Bot giriş yaptı.');
        }
    } catch (err) {
        console.error('[Başlatma Hatası]:', err);
    }
}

startServer();

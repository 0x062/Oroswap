// telegram_reporter.js
import axios from 'axios'; // ✅ Gunakan axios
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramReport(summary) {
    if (!token || !chatId) {
        // Diganti dengan format log baru
        console.log('[~] Kredensial Telegram tidak diatur, laporan tidak dikirim.');
        return;
    }

    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const message = `
🤖 **Laporan Bot OROSWAP** 🤖
-----------------------------------
*Waktu Selesai:* ${timestamp}
-----------------------------------

**Ringkasan Aktivitas:**
${summary.join('\n')}
    `;
    
    // ✅ URL untuk API sendMessage Telegram
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
        // ✅ Kirim pesan menggunakan axios.post
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[+] Laporan ringkasan berhasil dikirim ke Telegram.');
    } catch (error) {
        // Menampilkan pesan error yang lebih informatif dari axios
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.log(`[-] Gagal mengirim laporan Telegram: ${errorMessage}`);
    }
}

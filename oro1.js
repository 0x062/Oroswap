import chalk from "chalk";
import dotenv from 'dotenv';
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, coins } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { sendTelegramReport } from "./telegram_reporter.js";

dotenv.config({ quiet: true });

// ===================================================================================
// ⚙️ PENGATURAN & KONSTANTA
// ===================================================================================
const SEED_PHRASE = process.env.SEED_PHRASE;

const config = {
    swap: {
        repetitions: 4,
        delayBetweenActions: { min: 10, max: 20 },
        randomAmountRanges: {
            ZIG_ORO: { ZIG: { min: 0.01, max: 0.2 }, ORO: { min: 0.01, max: 0.2 } },
            ZIG_BEE: { ZIG: { min: 1.0, max: 1.5 }, BEE: { min: 0.00001, max: 0.002 } },
        },
    },
    addLp: {
        repetitions: 8,
        autoStakeAfterAddLp: true,
        smart: {
            ORO_ZIG: { minBalance: 0.001, lpPercentToUse: { min: 10, max: 40 } },
            ZIG_BEE: { minBalance: 0.000001, lpPercentToUse: { min: 10, max: 40 } }
        }
    },
    retry: {
        maxRetries: 5,
        delaySeconds: 34,
        sequenceMismatchDelaySeconds: 60
    }
};

const chainInfo = {
    RPC_URL: "https://testnet-rpc.zigchain.com/",
    GAS_PRICE: GasPrice.fromString("0.03uzig"),
    contracts: {
        ORO_ZIG: "zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg",
        ZIG_BEE: "zig1r50m5lafnmctat4xpvwdpzqndynlxt2skhr4fhzh76u0qar2y9hqu74u5h"
    },
    denoms: {
        ORO: "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro",
        ZIG: "uzig",
        BEE: "coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee"
    },
    decimals: {
        "uzig": 6,
        "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro": 6,
        "coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee": 6
    }
};

// ===================================================================================
// 🛠️ FUNGSI UTILITY
// ===================================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRandomDelay = () => (Math.floor(Math.random() * (config.swap.delayBetweenActions.max - config.swap.delayBetweenActions.min + 1)) + config.swap.delayBetweenActions.min) * 1000;
const getShortAddress = (address) => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "N/A");

function addLog(message, type = "info") {
    let symbol;
    let coloredMessage;
    switch (type) {
        case "success": symbol = chalk.greenBright('[+]'); coloredMessage = chalk.white(message); break;
        case "error": symbol = chalk.redBright('[-]'); coloredMessage = chalk.redBright(message); break;
        case "wait": symbol = chalk.yellowBright('[~]'); coloredMessage = chalk.yellow(message); break;
        case "swap": symbol = chalk.magentaBright('[>]'); coloredMessage = chalk.white(message); break;
        default: symbol = chalk.cyanBright('[i]'); coloredMessage = chalk.white(message); break;
    }
    console.log(`${symbol} ${coloredMessage}`);
}

function getSymbolFromDenom(denom) {
    if (denom === chainInfo.denoms.ZIG) return "ZIG";
    if (denom === chainInfo.denoms.ORO) return "ORO";
    if (denom === chainInfo.denoms.BEE) return "BEE";
    return "UNKNOWN";
}

const toMicroUnitsString = (amount, denom) => {
    const decimals = chainInfo.decimals[denom] || 6;
    // Menggunakan toFixed(0) untuk menghindari notasi ilmiah dan memastikan output adalah string integer
    return (amount * (10 ** decimals)).toFixed(0);
}

async function initializeClient() {
    if (!SEED_PHRASE) throw new Error("SEED_PHRASE tidak ditemukan di file .env Anda.");
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(SEED_PHRASE, { prefix: "zig" });
    const [acc] = await wallet.getAccounts();
    const address = acc.address;
    const client = await SigningCosmWasmClient.connectWithSigner(chainInfo.RPC_URL, wallet, { gasPrice: chainInfo.GAS_PRICE });
    return { client, address };
}

// ===================================================================================
// 🚀 FUNGSI INTI
// ===================================================================================

async function getBalance(client, address, denom) {
    try {
        const { amount } = await client.getBalance(address, denom);
        const decimals = chainInfo.decimals[denom] || 6;
        // Konversi ke `Number` di sini aman karena hanya untuk TAMPILAN
        return Number(amount) / 10 ** decimals;
    } catch (error) {
        addLog(`Gagal mengambil balance untuk ${getSymbolFromDenom(denom)}. Error: ${error.message}`, "error");
        throw error;
    }
}

async function getPoolInfo(client, contractAddress) {
    try {
        return await client.queryContractSmart(contractAddress, { pool: {} });
    } catch (error) {
        addLog(`Gagal mengambil info pool dari ${contractAddress}. Error: ${error.message}`, "error");
        throw error;
    }
}

function calculateBeliefPrice(poolInfo, fromDenom, toDenom) {
    if (!poolInfo?.assets || poolInfo.assets.length !== 2) {
        throw new Error("Data pool tidak valid untuk menghitung belief_price.");
    }

    const assetFrom = poolInfo.assets.find(a => a.info.native_token.denom === fromDenom);
    const assetTo = poolInfo.assets.find(a => a.info.native_token.denom === toDenom);

    if (!assetFrom || !assetTo) {
        throw new Error(`Aset untuk ${fromDenom} atau ${toDenom} tidak ditemukan di pool.`);
    }

    const amountFrom = BigInt(assetFrom.amount);
    const amountTo = BigInt(assetTo.amount);

    if (amountTo === 0n) {
        throw new Error("Aset 'To' dalam pool memiliki jumlah nol, tidak dapat menghitung harga.");
    }

    const precision = 10n ** 18n;
    const beliefPriceBigInt = (amountFrom * precision) / amountTo;

    // Format kembali ke string desimal
    let beliefPriceString = beliefPriceBigInt.toString();
    if (beliefPriceString.length > 18) {
        return beliefPriceString.slice(0, -18) + "." + beliefPriceString.slice(-18);
    } else {
        return "0." + beliefPriceString.padStart(18, '0');
    }
}

async function performSwap(client, address, { fromDenom, toDenom, amount, contractAddress }) {
    const poolInfo = await getPoolInfo(client, contractAddress);
    const beliefPrice = calculateBeliefPrice(poolInfo, fromDenom, toDenom);
    addLog(`Harga pool saat ini (belief_price): ${beliefPrice}`, "info");

    const microAmount = toMicroUnitsString(amount, fromDenom);
    const fromSymbol = getSymbolFromDenom(fromDenom);
    const toSymbol = getSymbolFromDenom(toDenom);

    addLog(`Mencoba swap: ${amount} ${fromSymbol} ➯ ${toSymbol}`, "swap");
    const msg = { swap: { belief_price: beliefPrice, max_spread: "0.5", offer_asset: { amount: microAmount, info: { native_token: { denom: fromDenom } } } } };
    const funds = coins(microAmount, fromDenom);

    const result = await client.execute(address, contractAddress, msg, "auto", `Swap ${fromSymbol} to ${toSymbol}`, funds);
    addLog(`Swap berhasil! Tx: ${result.transactionHash}`, "success");
    return `✅ Swap *${amount} ${fromSymbol}* ➯ *${toSymbol}* berhasil.`;
}

// PERBAIKAN BIGINT: Fungsi ini sekarang menggunakan BigInt untuk semua kalkulasi rasio.
async function addLiquidity(client, address, { contract, tokenDenom, tokenAmount }) {
    const tokenSymbol = getSymbolFromDenom(tokenDenom);
    const poolInfo = await getPoolInfo(client, contract);

    const zigAssetAmount = BigInt(poolInfo.assets.find(a => a.info.native_token.denom === chainInfo.denoms.ZIG).amount);
    const tokenAssetAmount = BigInt(poolInfo.assets.find(a => a.info.native_token.denom === tokenDenom).amount);
    const tokenMicro = BigInt(toMicroUnitsString(tokenAmount, tokenDenom));

    // Kalkulasi rasio yang dibutuhkan menggunakan BigInt, ini bagian terpenting.
    const zigMicroNeeded = (tokenMicro * zigAssetAmount) / tokenAssetAmount;

    // Konversi ke `Number` hanya untuk validasi dan logging, bukan untuk transaksi.
    const zigNeededForDisplay = Number(zigMicroNeeded) / (10 ** chainInfo.decimals.uzig);

    addLog(`Mencoba Add LP ke ${tokenSymbol}-ZIG: ${tokenAmount.toFixed(6)} ${tokenSymbol} dan ~${zigNeededForDisplay.toFixed(6)} ZIG`, "info");
    const balanceZIG = await getBalance(client, address, chainInfo.denoms.ZIG);
    if (balanceZIG < zigNeededForDisplay) throw new Error(`Saldo ZIG tidak cukup. Butuh: ${zigNeededForDisplay.toFixed(6)}, Saldo: ${balanceZIG.toFixed(6)}`);

    // Gunakan .toString() untuk mengirim nilai BigInt ke dalam pesan transaksi.
    const msg = { provide_liquidity: { assets: [{ amount: tokenMicro.toString(), info: { native_token: { denom: tokenDenom } } }, { amount: zigMicroNeeded.toString(), info: { native_token: { denom: chainInfo.denoms.ZIG } } }], auto_stake: config.addLp.autoStakeAfterAddLp, slippage_tolerance: "0.5" } };
    const funds = [{ denom: tokenDenom, amount: tokenMicro.toString() }, { denom: chainInfo.denoms.ZIG, amount: zigMicroNeeded.toString() }];
    
    const result = await client.execute(address, contract, msg, "auto", `Add Liquidity ${tokenSymbol}-ZIG`, funds);
    const logMessage = config.addLp.autoStakeAfterAddLp ? 'Add LP & Auto-Stake' : 'Add LP';
    addLog(`${logMessage} ${tokenSymbol}-ZIG berhasil! Tx: ${result.transactionHash}`, "success");
    return `✅ ${logMessage} *${tokenAmount.toFixed(4)} ${tokenSymbol}* & *${zigNeededForDisplay.toFixed(4)} ZIG* berhasil.`;
}

async function withRetry(client, address, action, onReset) {
    let currentClient = client;
    let currentAddress = address;

    for (let i = 0; i <= config.retry.maxRetries; i++) {
        try {
            // Menjalankan 'action' dengan client & address terbaru
            return await action(currentClient, currentAddress);
        } catch (error) {
            addLog(`Aksi gagal: ${error.message}`, "error");

            if (i === config.retry.maxRetries) {
                addLog("Gagal maksimal, menyerah pada aksi ini.", "error");
                throw new Error(`Aksi gagal setelah ${config.retry.maxRetries} percobaan: ${error.message}`);
            }

            if (error.message.includes('account sequence mismatch')) {
                addLog("Terdeteksi account sequence mismatch. Mereset koneksi...", "wait");
                try {
                    // Panggil onReset untuk mendapatkan client & address baru
                    const { client: newClient, address: newAddress } = await onReset();
                    currentClient = newClient;
                    currentAddress = newAddress;
                    
                    addLog("Koneksi berhasil di-reset.", "success");
                    const quarantineTime = config.retry.sequenceMismatchDelaySeconds;
                    addLog(`Masuk mode karantina selama ${quarantineTime} detik...`, "wait");
                    await sleep(quarantineTime * 1000);
                    addLog("Karantina selesai. Mencoba lagi...", "info");
                    continue; // Lanjut ke iterasi berikutnya untuk mencoba lagi dengan client baru
                } catch (resetError) {
                    addLog(`Gagal me-reset koneksi: ${resetError.message}`, "error");
                }
            }
            
            addLog(`Mencoba lagi dalam ${config.retry.delaySeconds} detik... (${i + 1}/${config.retry.maxRetries})`, "wait");
            await sleep(config.retry.delaySeconds * 1000);
        }
    }
}

async function autoSwap(client, address, pair) {
    const ranges = config.swap.randomAmountRanges[pair];
    const contract = pair === "ZIG_ORO" ? chainInfo.contracts.ORO_ZIG : chainInfo.contracts.ZIG_BEE;
    const otherTokenDenom = pair === "ZIG_ORO" ? chainInfo.denoms.ORO : chainInfo.denoms.BEE;
    const otherTokenSymbol = getSymbolFromDenom(otherTokenDenom);

    const zigAmountToSwap = (Math.random() * (ranges.ZIG.max - ranges.ZIG.min) + ranges.ZIG.min);
    const zigBalance = await getBalance(client, address, chainInfo.denoms.ZIG);
    addLog(`Mengecek swap ZIG -> ${otherTokenSymbol}. Butuh: ${zigAmountToSwap.toFixed(4)}, Saldo: ${zigBalance.toFixed(4)}`, "info");
    if (zigBalance >= zigAmountToSwap) {
        return performSwap(client, address, { fromDenom: chainInfo.denoms.ZIG, toDenom: otherTokenDenom, amount: zigAmountToSwap, contractAddress: contract });
    }

    addLog(`Saldo ZIG tidak cukup. Mencoba arah sebaliknya.`, "wait");
    const otherTokenAmountToSwap = (Math.random() * (ranges[otherTokenSymbol].max - ranges[otherTokenSymbol].min) + ranges[otherTokenSymbol].min);
    const otherTokenBalance = await getBalance(client, address, otherTokenDenom);
    addLog(`Mengecek swap ${otherTokenSymbol} -> ZIG. Butuh: ${otherTokenAmountToSwap.toFixed(4)}, Saldo: ${otherTokenBalance.toFixed(4)}`, "info");
    if (otherTokenBalance >= otherTokenAmountToSwap) {
        return performSwap(client, address, { fromDenom: otherTokenDenom, toDenom: chainInfo.denoms.ZIG, amount: otherTokenAmountToSwap, contractAddress: contract });
    }

    throw new Error(`Saldo ZIG & ${otherTokenSymbol} tidak mencukupi untuk swap.`);
}

async function handleAddLiquidity(client, address, poolType) {
    const isOroZig = poolType === 'ORO_ZIG';
    const lpConfig = isOroZig ? config.addLp.smart.ORO_ZIG : config.addLp.smart.ZIG_BEE;
    const tokenDenom = isOroZig ? chainInfo.denoms.ORO : chainInfo.denoms.BEE;
    const tokenSymbol = isOroZig ? 'ORO' : 'BEE';
    const contract = isOroZig ? chainInfo.contracts.ORO_ZIG : chainInfo.contracts.ZIG_BEE;

    const balance = await getBalance(client, address, tokenDenom);
    addLog(`Mengecek saldo ${tokenSymbol}. Saldo saat ini: ${balance.toFixed(6)} ${tokenSymbol}`, "info");

    if (balance >= lpConfig.minBalance) {
        const percent = (Math.random() * (lpConfig.lpPercentToUse.max - lpConfig.lpPercentToUse.min) + lpConfig.lpPercentToUse.min);
        const amountToLp = balance * (percent / 100);
        addLog(`Saldo ${tokenSymbol} mencukupi. Akan menggunakan ${Math.round(percent)}% untuk LP.`, "info");
        return addLiquidity(client, address, { contract, tokenDenom, tokenAmount: amountToLp });
    } else {
        const waitMessage = `Saldo ${tokenSymbol} (${balance.toFixed(6)}) di bawah ambang batas minimum (${lpConfig.minBalance}). Melewatkan Add LP.`;
        addLog(waitMessage, "wait");
        return `🟡 ${waitMessage}`;
    }
}

async function runCycle(client, address, onReset, reportSummary) {
    addLog(`Memulai siklus untuk wallet: ${getShortAddress(address)}`, "info");
    // Hapus baris wrappedRetry yang lama

    if (config.swap.repetitions > 0) {
        addLog(`--- Tahap 1: Melakukan ${config.swap.repetitions} Swap Acak ---`, "info");
        for (let i = 0; i < config.swap.repetitions; i++) {
            addLog(`--- Swap Acak ke-${i + 1} dari ${config.swap.repetitions} ---`, "info");
            const pair = Math.random() < 0.5 ? "ZIG_ORO" : "ZIG_BEE";
            try {
                // PANGGIL withRetry DENGAN CARA BARU
                const result = await withRetry(
                    client, 
                    address, 
                    (currentClient, currentAddress) => autoSwap(currentClient, currentAddress, pair), 
                    onReset
                );
                if (result) reportSummary.push(result);
            } catch (e) {
                const errorMessage = `❌ Gagal melakukan swap acak: ${e.message}`;
                addLog(errorMessage, 'error');
                reportSummary.push(errorMessage);
            }

            if (i < config.swap.repetitions - 1) {
                const delay = getRandomDelay();
                addLog(`Menunggu ${delay / 1000} detik...`, "wait");
                await sleep(delay);
            }
        }
    }

    if (config.addLp.repetitions > 0) {
        const delay = getRandomDelay();
        addLog(`Menunggu ${delay / 1000} detik sebelum Add LP...`, "wait");
        await sleep(delay);
        addLog(`--- Tahap 2: Melakukan ${config.addLp.repetitions} Smart Add Liquidity Acak ---`, "info");

        for (let i = 0; i < config.addLp.repetitions; i++) {
            addLog(`--- Add LP Acak ke-${i + 1} dari ${config.addLp.repetitions} ---`, "info");
            const chosenPool = Math.random() < 0.5 ? 'ORO_ZIG' : 'ZIG_BEE';
            addLog(`Memilih pool LP secara acak: ${chosenPool}`, "info");
            try {
                // UBAH PANGGILAN INI JUGA
                const result = await withRetry(
                    client, 
                    address, 
                    (currentClient, currentAddress) => handleAddLiquidity(currentClient, currentAddress, chosenPool), 
                    onReset
                );
                if (result) reportSummary.push(result);
            } catch(e) {
                const errorMessage = `❌ Gagal Add LP untuk ${chosenPool}: ${e.message}`;
                addLog(errorMessage, 'error');
                reportSummary.push(errorMessage);
            }

            if (i < config.addLp.repetitions - 1) {
                const lpDelay = getRandomDelay();
                addLog(`Menunggu ${lpDelay / 1000} detik...`, "wait");
                await sleep(lpDelay);
            }
        }
    }
}

async function startBot() {
    addLog("🤖 OROSWAP AUTO BOT DIMULAI 🤖", "success");
    let client, address;
    const reportSummary = [];

    // Fungsi ini sekarang harus me-return client dan address baru
    const resetConnection = async () => {
        const newConnection = await initializeClient();
        client = newConnection.client; // Perbarui variabel di scope luar
        address = newConnection.address; // Perbarui variabel di scope luar
        return newConnection;
    };

    try {
        await resetConnection(); // Panggilan awal untuk mengisi client dan address
        const shortAddress = getShortAddress(address);
        addLog(`Wallet berhasil dimuat: ${shortAddress}`, "success");
        reportSummary.push(`- Wallet: *${shortAddress}*`);

        // Kirim client, address, dan fungsi reset ke runCycle
        await runCycle(client, address, resetConnection, reportSummary);

        addLog("✅ Semua tugas telah selesai. Bot akan berhenti.", "success");
        // Cek jika ada error di laporan sebelum menyatakan berhasil
        const hasFailedTasks = reportSummary.some(msg => msg.startsWith('❌'));
        if (hasFailedTasks) {
            reportSummary.push("\n*Status Akhir: Selesai dengan beberapa kegagalan* ⚠️");
        } else {
            reportSummary.push("\n*Status Akhir: Berhasil* 👍");
        }
        await sendTelegramReport(reportSummary);
        process.exit(0);
    } catch (error) {
        addLog(`Terjadi error fatal yang tidak bisa dipulihkan: ${error.message}`, "error");
        console.error(error);
        reportSummary.push(`\n❌ *Status Akhir: Gagal Total*\n- Alasan: ${error.message}`);
        await sendTelegramReport(reportSummary);
        process.exit(1);
    }
}

startBot();

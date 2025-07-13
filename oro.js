import chalk from "chalk";
import dotenv from 'dotenv';
import axios from "axios";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, coins } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { sendTelegramReport } from "./telegram_reporter.js";

dotenv.config({ quiet: true });

// ===================================================================================
// ⚙️ PENGATURAN UTAMA
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
            ORO_ZIG: { minBalance: 0.01, lpPercentToUse: { min: 10, max: 40 } },
            ZIG_BEE: { minBalance: 0.000001, lpPercentToUse: { min: 10, max: 40 } }
        }
    },
    retry: {
        maxRetries: 5,
        delaySeconds: 15,
        sequenceMismatchDelaySeconds: 60
    }
};
// ===================================================================================
// 🛑 JANGAN UBAH APAPUN DI BAWAH GARIS INI 🛑
// ===================================================================================

const RPC_URL = "https://rpc.zigscan.net";
const ORO_ZIG_CONTRACT = "zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg";
const ZIG_BEE_CONTRACT = "zig1r50m5lafnmctat4xpvwdpzqndynlxt2skhr4fhzh76u0qar2y9hqu74u5h";
const DENOM_ORO = "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro";
const DENOM_ZIG = "uzig";
const DENOM_BEE = "coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee";
const GAS_PRICE = GasPrice.fromString("0.03uzig");
const TOKEN_DECIMALS = { uzig: 6, "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro": 6, "coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee": 6 };

let client;
let address;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function addLog(message, type = "info") { let symbol; let coloredMessage = chalk.white(message); switch (type) { case "success": symbol = chalk.greenBright('[+]'); break; case "error": symbol = chalk.redBright('[-]'); coloredMessage = chalk.redBright(message); break; case "wait": symbol = chalk.yellowBright('[~]'); coloredMessage = chalk.yellow(message); break; case "swap": symbol = chalk.magentaBright('[>]'); break; case "info": default: symbol = chalk.cyanBright('[i]'); break; } console.log(`${symbol} ${coloredMessage}`); }
const getShortAddress = (address) => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "N/A");
const toMicroUnits = (amount, denom) => Math.floor(parseFloat(amount) * 10 ** (TOKEN_DECIMALS[denom] || 6));
const getRandomDelay = () => (Math.floor(Math.random() * (config.swap.delayBetweenActions.max - config.swap.delayBetweenActions.min + 1)) + config.swap.delayBetweenActions.min) * 1000;

async function initializeClient() {
    if (!SEED_PHRASE) throw new Error("SEED_PHRASE tidak ditemukan di file .env Anda.");
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(SEED_PHRASE, { prefix: "zig" });
    const [acc] = await wallet.getAccounts();
    address = acc.address;
    client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE });
}

async function getBalance(denom) { try { const { amount } = await client.getBalance(address, denom); return Number(amount / 10 ** TOKEN_DECIMALS[denom]); } catch (error) { throw new Error(`Gagal mengambil balance untuk ${denom}: ${error.message}`); } }
async function getPoolInfo(contractAddress) { try { return await client.queryContractSmart(contractAddress, { pool: {} }); } catch (error) { throw new Error(`Gagal mengambil info pool untuk ${contractAddress}: ${error.message}`); } }
function calculateBeliefPrice(poolInfo, contractAddress) { if (!poolInfo?.assets || poolInfo.assets.length !== 2) throw new Error("Data pool tidak valid."); const assetZIG = poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG); const otherAsset = poolInfo.assets.find(a => a.info.native_token.denom !== DENOM_ZIG); const zigAmount = parseInt(assetZIG.amount); const otherAmount = parseInt(otherAsset.amount); if (contractAddress === ZIG_BEE_CONTRACT) return (zigAmount / otherAmount).toFixed(18); else return (otherAmount / zigAmount).toFixed(18); }

// Ganti fungsi withRetry yang lama dengan yang ini
async function withRetry(action) {
    for (let i = 0; i <= config.retry.maxRetries; i++) {
        try {
            return await action(); // Coba jalankan aksi
        } catch (error) {
            addLog(`Aksi gagal: ${error.message}`, "error");

            if (i === config.retry.maxRetries) {
                addLog("Gagal maksimal, menyerah pada aksi ini.", "error");
                return `❌ Aksi gagal total: ${error.message}`;
            }

            // ✅ LOGIKA KARANTINA CERDAS
            if (error.message.includes('account sequence mismatch')) {
                addLog("Terdeteksi account sequence mismatch. Mereset koneksi...", "wait");
                try {
                    await initializeClient();
                    addLog("Koneksi berhasil di-reset.", "success");
                    // Masuk mode karantina untuk memberi waktu RPC sinkronisasi
                    const quarantineTime = config.retry.sequenceMismatchDelaySeconds;
                    addLog(`Masuk mode karantina selama ${quarantineTime} detik...`, "wait");
                    await sleep(quarantineTime * 1000);
                    addLog("Karantina selesai. Mencoba lagi...", "info");
                    continue; // Langsung ke percobaan berikutnya
                } catch (resetError) {
                    addLog(`Gagal me-reset koneksi: ${resetError.message}`, "error");
                }
            }
            
            // Retry biasa untuk error lainnya
            addLog(`Mencoba lagi dalam ${config.retry.delaySeconds} detik... (${i + 1}/${config.retry.maxRetries})`, "wait");
            await sleep(config.retry.delaySeconds * 1000);
        }
    }
}

// ✅ Fungsi transaksi dibuat simpel, error akan ditangani 'withRetry'
async function performSwap(fromDenom, toDenom, amount, contractAddress) {
    const poolInfo = await getPoolInfo(contractAddress);
    const beliefPrice = calculateBeliefPrice(poolInfo, contractAddress);
    addLog(`Harga pool saat ini (belief_price): ${beliefPrice}`, "info");
    const microAmount = toMicroUnits(amount, fromDenom);
    const fromSymbol = fromDenom === DENOM_ZIG ? "ZIG" : fromDenom === DENOM_ORO ? "ORO" : "BEE";
    const toSymbol = toDenom === DENOM_ZIG ? "ZIG" : toDenom === DENOM_ORO ? "ORO" : "BEE";
    addLog(`Mencoba swap: ${amount} ${fromSymbol} ➯ ${toSymbol}`, "swap");
    const msg = { swap: { belief_price: beliefPrice, max_spread: "0.5", offer_asset: { amount: microAmount.toString(), info: { native_token: { denom: fromDenom } } } } };
    const funds = coins(microAmount, fromDenom);
    const result = await client.execute(address, contractAddress, msg, "auto", `Swap ${fromSymbol} to ${toSymbol}`, funds);
    addLog(`Swap berhasil! Tx: ${result.transactionHash}`, "success");
    return `✅ Swap *${amount} ${fromSymbol}* ➯ *${toSymbol}* berhasil.`;
}

async function addLiquidity(contract, tokenDenom, tokenSymbol, tokenAmount) {
    const poolInfo = await getPoolInfo(contract);
    if (!poolInfo) throw new Error(`Gagal mengambil info pool untuk ${tokenSymbol}-ZIG.`);
    const ratio = parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG).amount) / parseInt(poolInfo.assets.find(a => a.info.native_token.denom === tokenDenom).amount);
    const tokenMicro = toMicroUnits(tokenAmount, tokenDenom);
    const zigMicroNeeded = Math.floor(tokenMicro * ratio);
    const zigNeeded = zigMicroNeeded / 10 ** TOKEN_DECIMALS.uzig;
    addLog(`Mencoba Add LP ke ${tokenSymbol}-ZIG: ${tokenAmount.toFixed(6)} ${tokenSymbol} dan ~${zigNeeded.toFixed(6)} ZIG`, "info");
    const balanceZIG = await getBalance(DENOM_ZIG);
    if (balanceZIG < zigNeeded) throw new Error(`Saldo ZIG tidak cukup. Butuh: ${zigNeeded.toFixed(6)}, Saldo: ${balanceZIG.toFixed(6)}`);
    const msg = { provide_liquidity: { assets: [{ amount: tokenMicro.toString(), info: { native_token: { denom: tokenDenom } } }, { amount: zigMicroNeeded.toString(), info: { native_token: { denom: DENOM_ZIG } } }], auto_stake: config.addLp.autoStakeAfterAddLp, slippage_tolerance: "0.5" } };
    const funds = [{ denom: tokenDenom, amount: tokenMicro.toString() }, { denom: DENOM_ZIG, amount: zigMicroNeeded.toString() }];
    const result = await client.execute(address, contract, msg, "auto", `Add Liquidity ${tokenSymbol}-ZIG`, funds);
    const logMessage = config.addLp.autoStakeAfterAddLp ? 'Add LP & Auto-Stake' : 'Add LP';
    addLog(`${logMessage} ${tokenSymbol}-ZIG berhasil! Tx: ${result.transactionHash}`, "success");
    return `✅ ${logMessage} *${tokenAmount.toFixed(4)} ${tokenSymbol}* & *${zigNeeded.toFixed(4)} ZIG* berhasil.`;
}

const addLiquidityOroZig = (oroAmount) => addLiquidity(ORO_ZIG_CONTRACT, DENOM_ORO, 'ORO', oroAmount);
const addLiquidityZigBee = (beeAmount) => addLiquidity(ZIG_BEE_CONTRACT, DENOM_BEE, 'BEE', beeAmount);

async function autoSwap(pair) {
    const ranges = config.swap.randomAmountRanges[pair];
    const contract = pair === "ZIG_ORO" ? ORO_ZIG_CONTRACT : ZIG_BEE_CONTRACT;
    const otherTokenDenom = pair === "ZIG_ORO" ? DENOM_ORO : DENOM_BEE;
    const otherTokenSymbol = pair === "ZIG_ORO" ? "ORO" : "BEE";
    const zigAmountToSwap = (Math.random() * (ranges.ZIG.max - ranges.ZIG.min) + ranges.ZIG.min).toFixed(4);
    const zigBalance = await getBalance(DENOM_ZIG);
    addLog(`Mengecek swap ZIG -> ${otherTokenSymbol}. Butuh: ${zigAmountToSwap}, Saldo: ${zigBalance.toFixed(4)}`, "info");
    if (zigBalance >= zigAmountToSwap) {
        return await performSwap(DENOM_ZIG, otherTokenDenom, zigAmountToSwap, contract);
    }
    addLog(`Saldo ZIG tidak cukup. Mencoba arah sebaliknya.`, "wait");
    const otherTokenAmountToSwap = (Math.random() * (ranges[otherTokenSymbol].max - ranges[otherTokenSymbol].min) + ranges[otherTokenSymbol].min).toFixed(4);
    const otherTokenBalance = await getBalance(otherTokenDenom);
    addLog(`Mengecek swap ${otherTokenSymbol} -> ZIG. Butuh: ${otherTokenAmountToSwap}, Saldo: ${otherTokenBalance.toFixed(4)}`, "info");
    if (otherTokenBalance >= otherTokenAmountToSwap) {
        return await performSwap(otherTokenDenom, DENOM_ZIG, otherTokenAmountToSwap, contract);
    } else {
        throw new Error(`Saldo juga tidak cukup untuk swap ${otherTokenSymbol} -> ZIG.`);
    }
}

async function runCycle(reportSummary) {
    addLog(`Memulai siklus untuk wallet: ${getShortAddress(address)}`, "info");
    if (config.swap.repetitions > 0) {
        addLog(`--- Tahap 1: Melakukan ${config.swap.repetitions} Swap Acak ---`, "info");
        for (let i = 0; i < config.swap.repetitions; i++) {
            addLog(`--- Swap Acak ke-${i + 1} dari ${config.swap.repetitions} ---`, "info");
            const pair = Math.random() < 0.5 ? "ZIG_ORO" : "ZIG_BEE";
            const result = await withRetry(() => autoSwap(pair));
            if(result) reportSummary.push(result);
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
            if (chosenPool === 'ORO_ZIG') {
                const lpConfig = config.addLp.smart.ORO_ZIG;
                const oroBalance = await getBalance(DENOM_ORO);
                addLog(`Mengecek saldo ORO. Saldo saat ini: ${oroBalance.toFixed(4)} ORO`, "info");
                if (oroBalance >= lpConfig.minBalance) {
                    const percent = (Math.random() * (lpConfig.lpPercentToUse.max - lpConfig.lpPercentToUse.min) + lpConfig.lpPercentToUse.min) / 100;
                    const oroAmountToLp = oroBalance * percent;
                    addLog(`Saldo ORO mencukupi. Akan menggunakan ${Math.round(percent*100)}% untuk LP.`, "info");
                    const result = await withRetry(() => addLiquidityOroZig(oroAmountToLp));
                    if(result) reportSummary.push(result);
                } else {
                    const waitMessage = `Saldo ORO (${oroBalance.toFixed(4)}) di bawah ambang batas minimum (${lpConfig.minBalance}). Melewatkan Add LP ORO-ZIG.`;
                    addLog(waitMessage, "wait");
                    reportSummary.push(`🟡 ${waitMessage}`);
                }
            } else {
                const lpConfig = config.addLp.smart.ZIG_BEE;
                const beeBalance = await getBalance(DENOM_BEE);
                addLog(`Mengecek saldo BEE. Saldo saat ini: ${beeBalance.toFixed(4)} BEE`, "info");
                if (beeBalance >= lpConfig.minBalance) {
                    const percent = (Math.random() * (lpConfig.lpPercentToUse.max - lpConfig.lpPercentToUse.min) + lpConfig.lpPercentToUse.min) / 100;
                    const beeAmountToLp = beeBalance * percent;
                    addLog(`Saldo BEE mencukupi. Akan menggunakan ${Math.round(percent*100)}% untuk LP.`, "info");
                    const result = await withRetry(() => addLiquidityZigBee(beeAmountToLp));
                    if(result) reportSummary.push(result);
                } else {
                    const waitMessage = `Saldo BEE (${beeBalance.toFixed(4)}) di bawah ambang batas minimum (${lpConfig.minBalance}). Melewatkan Add LP ZIG-BEE.`;
                    addLog(waitMessage, "wait");
                    reportSummary.push(`🟡 ${waitMessage}`);
                }
            }
            if (i < config.addLp.repetitions - 1) {
                const delay = getRandomDelay();
                addLog(`Menunggu ${delay / 1000} detik...`, "wait");
                await sleep(delay);
            }
        }
    }
}

async function startBot() {
    addLog("🤖 OROSWAP AUTO BOT DIMULAI 🤖", "success");
    const reportSummary = [];
    try {
        await initializeClient();
        const shortAddress = getShortAddress(address);
        addLog(`Wallet berhasil dimuat: ${shortAddress}`, "success");
        reportSummary.push(`- Wallet: *${shortAddress}*`);
        await runCycle(reportSummary);
        addLog("✅ Semua tugas telah selesai. Bot akan berhenti.", "success");
        reportSummary.push("\n*Status Akhir: Berhasil* 👍");
        await sendTelegramReport(reportSummary);
        console.log(chalk.blueBright("===================================================="));
        process.exit(0);
    } catch (error) {
        addLog(`Terjadi error fatal yang tidak bisa dipulihkan: ${error.message}`, "error");
        reportSummary.push(`\n❌ *Status Akhir: Gagal Total*\n- Alasan: ${error.message}`);
        await sendTelegramReport(reportSummary);
        process.exit(1);
    }
}

startBot();

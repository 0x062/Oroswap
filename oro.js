import chalk from "chalk";
import dotenv from 'dotenv';
import axios from "axios";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, coins } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { sendTelegramReport } from "./telegram_reporter.js";

dotenv.config({ quiet: true });

// ===================================================================================
// ⚙️ PENGATURAN UTAMA - HANYA EDIT BAGIAN INI ⚙️
// ===================================================================================
const SEED_PHRASE = process.env.SEED_PHRASE;

const config = {
    swap: {
        repetitions: 4,
        delayBetweenActions: { min: 10, max: 50 },
        randomAmountRanges: {
            ZIG_ORO: { 
                ZIG: { min: 0.01, max: 0.05 },
                ORO: { min: 0.1, max: 0.2 } 
            },
            ZIG_BEE: { 
                ZIG: { min: 1.0, max: 1.5 },
                BEE: { min: 0.001, max: 0.002 }
            },
        },
    },
    // ✅ PENGATURAN ADD LP BARU DENGAN PENGATURAN PER-POOL
    addLp: {
        repetitions: 10,
        autoStakeAfterAddLp: true,
        smart: {
            ORO_ZIG: {
                minBalance: 0.0001, // Minimum ORO untuk mencoba LP di pool ini
                lpPercentToUse: { min: 15, max: 65 }
            },
            ZIG_BEE: {
                minBalance: 0.000001, // Minimum BEE untuk mencoba LP di pool ini
                lpPercentToUse: { min: 15, max: 58 }
            }
        }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function addLog(message, type = "info") { let symbol; let coloredMessage = chalk.white(message); switch (type) { case "success": symbol = chalk.greenBright('[+]'); break; case "error": symbol = chalk.redBright('[-]'); coloredMessage = chalk.redBright(message); break; case "wait": symbol = chalk.yellowBright('[~]'); coloredMessage = chalk.yellow(message); break; case "swap": symbol = chalk.magentaBright('[>]'); break; case "info": default: symbol = chalk.cyanBright('[i]'); break; } console.log(`${symbol} ${coloredMessage}`); }
const getShortAddress = (address) => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "N/A");
const toMicroUnits = (amount, denom) => Math.floor(parseFloat(amount) * 10 ** (TOKEN_DECIMALS[denom] || 6));
const getRandomDelay = () => (Math.floor(Math.random() * (config.swap.delayBetweenActions.max - config.swap.delayBetweenActions.min + 1)) + config.swap.delayBetweenActions.min) * 1000;
async function getCosmosClient(seedPhrase) { if (!seedPhrase) throw new Error("SEED_PHRASE tidak ditemukan di file .env Anda."); const wallet = await DirectSecp256k1HdWallet.fromMnemonic(seedPhrase, { prefix: "zig" }); const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE }); const [account] = await wallet.getAccounts(); return { client, address: account.address }; }
async function getBalance(client, address, denom) { try { const { amount } = await client.getBalance(address, denom); return Number(amount / 10 ** TOKEN_DECIMALS[denom]); } catch (error) { addLog(`Gagal mengambil balance untuk ${denom}: ${error.message}`, "error"); return 0; } }
async function getPoolInfo(client, contractAddress) { try { return await client.queryContractSmart(contractAddress, { pool: {} }); } catch (error) { addLog(`Gagal mengambil info pool untuk ${contractAddress}: ${error.message}`, "error"); return null; } }
function calculateBeliefPrice(poolInfo, contractAddress) { if (!poolInfo?.assets || poolInfo.assets.length !== 2) throw new Error("Data pool tidak valid."); const assetZIG = poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG); const otherAsset = poolInfo.assets.find(a => a.info.native_token.denom !== DENOM_ZIG); const zigAmount = parseInt(assetZIG.amount); const otherAmount = parseInt(otherAsset.amount); if (contractAddress === ZIG_BEE_CONTRACT) return (zigAmount / otherAmount).toFixed(18); else return (otherAmount / zigAmount).toFixed(18); }

async function performSwap(client, address, fromDenom, toDenom, amount, contractAddress) {
    try {
        const poolInfo = await getPoolInfo(client, contractAddress);
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
    } catch (error) {
        const errorMessage = `Swap gagal: ${error.message}`;
        addLog(errorMessage, "error");
        return `❌ ${errorMessage}`;
    }
}

async function addLiquidityOroZig(client, address, oroAmount) {
    try {
        const poolInfo = await getPoolInfo(client, ORO_ZIG_CONTRACT);
        if (!poolInfo) return "❌ Gagal mengambil info pool untuk Add LP ORO-ZIG.";
        const ratio = parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG).amount) / parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ORO).amount);
        const oroMicro = toMicroUnits(oroAmount, DENOM_ORO);
        const zigMicroNeeded = Math.floor(oroMicro * ratio);
        const zigNeeded = zigMicroNeeded / 10 ** TOKEN_DECIMALS.uzig;
        addLog(`Mencoba Add LP ke ORO-ZIG: ${oroAmount.toFixed(6)} ORO dan ~${zigNeeded.toFixed(6)} ZIG`, "info");
        const balanceZIG = await getBalance(client, address, DENOM_ZIG);
        if (balanceZIG < zigNeeded) {
            const errorMessage = `Saldo ZIG tidak cukup untuk Add LP. Butuh: ${zigNeeded.toFixed(6)}, Saldo: ${balanceZIG.toFixed(6)}`;
            addLog(errorMessage, "error");
            return `❌ ${errorMessage}`;
        }
        const msg = { provide_liquidity: { assets: [{ amount: oroMicro.toString(), info: { native_token: { denom: DENOM_ORO } } }, { amount: zigMicroNeeded.toString(), info: { native_token: { denom: DENOM_ZIG } } }], auto_stake: config.addLp.autoStakeAfterAddLp, slippage_tolerance: "0.5" } };
        const funds = [{ denom: DENOM_ORO, amount: oroMicro.toString() }, { denom: DENOM_ZIG, amount: zigMicroNeeded.toString() }];
        const result = await client.execute(address, ORO_ZIG_CONTRACT, msg, "auto", "Add Liquidity ORO-ZIG", funds);
        const logMessage = config.addLp.autoStakeAfterAddLp ? 'Add LP & Auto-Stake' : 'Add LP';
        addLog(`${logMessage} ORO-ZIG berhasil! Tx: ${result.transactionHash}`, "success");
        return `✅ ${logMessage} *${oroAmount.toFixed(4)} ORO* & *${zigNeeded.toFixed(4)} ZIG* berhasil.`;
    } catch (error) {
        const errorMessage = `Add LP ORO-ZIG gagal: ${error.message}`;
        addLog(errorMessage, "error");
        return `❌ ${errorMessage}`;
    }
}

// ✅ FUNGSI BARU UNTUK ADD LP ZIG-BEE
async function addLiquidityZigBee(client, address, beeAmount) {
    try {
        const poolInfo = await getPoolInfo(client, ZIG_BEE_CONTRACT);
        if (!poolInfo) return "❌ Gagal mengambil info pool untuk Add LP ZIG-BEE.";
        const ratio = parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG).amount) / parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_BEE).amount);
        const beeMicro = toMicroUnits(beeAmount, DENOM_BEE);
        const zigMicroNeeded = Math.floor(beeMicro * ratio);
        const zigNeeded = zigMicroNeeded / 10 ** TOKEN_DECIMALS.uzig;
        addLog(`Mencoba Add LP ke ZIG-BEE: ${beeAmount.toFixed(6)} BEE dan ~${zigNeeded.toFixed(6)} ZIG`, "info");
        const balanceZIG = await getBalance(client, address, DENOM_ZIG);
        if (balanceZIG < zigNeeded) {
            const errorMessage = `Saldo ZIG tidak cukup untuk Add LP. Butuh: ${zigNeeded.toFixed(6)}, Saldo: ${balanceZIG.toFixed(6)}`;
            addLog(errorMessage, "error");
            return `❌ ${errorMessage}`;
        }
        const msg = { provide_liquidity: { assets: [{ amount: beeMicro.toString(), info: { native_token: { denom: DENOM_BEE } } }, { amount: zigMicroNeeded.toString(), info: { native_token: { denom: DENOM_ZIG } } }], auto_stake: config.addLp.autoStakeAfterAddLp, slippage_tolerance: "0.5" } };
        const funds = [{ denom: DENOM_BEE, amount: beeMicro.toString() }, { denom: DENOM_ZIG, amount: zigMicroNeeded.toString() }];
        const result = await client.execute(address, ZIG_BEE_CONTRACT, msg, "auto", "Add Liquidity ZIG-BEE", funds);
        const logMessage = config.addLp.autoStakeAfterAddLp ? 'Add LP & Auto-Stake' : 'Add LP';
        addLog(`${logMessage} ZIG-BEE berhasil! Tx: ${result.transactionHash}`, "success");
        return `✅ ${logMessage} *${beeAmount.toFixed(4)} BEE* & *${zigNeeded.toFixed(4)} ZIG* berhasil.`;
    } catch (error) {
        const errorMessage = `Add LP ZIG-BEE gagal: ${error.message}`;
        addLog(errorMessage, "error");
        return `❌ ${errorMessage}`;
    }
}

async function autoSwap(client, address, pair) {
    const ranges = config.swap.randomAmountRanges[pair];
    const contract = pair === "ZIG_ORO" ? ORO_ZIG_CONTRACT : ZIG_BEE_CONTRACT;
    const otherTokenDenom = pair === "ZIG_ORO" ? DENOM_ORO : DENOM_BEE;
    const otherTokenSymbol = pair === "ZIG_ORO" ? "ORO" : "BEE";
    const zigAmountToSwap = (Math.random() * (ranges.ZIG.max - ranges.ZIG.min) + ranges.ZIG.min).toFixed(4);
    const zigBalance = await getBalance(client, address, DENOM_ZIG);
    addLog(`Mengecek swap ZIG -> ${otherTokenSymbol}. Butuh: ${zigAmountToSwap}, Saldo: ${zigBalance.toFixed(4)}`, "info");
    if (zigBalance >= zigAmountToSwap) {
        return await performSwap(client, address, DENOM_ZIG, otherTokenDenom, zigAmountToSwap, contract);
    }
    addLog(`Saldo ZIG tidak cukup. Mencoba arah sebaliknya.`, "wait");
    const otherTokenAmountToSwap = (Math.random() * (ranges[otherTokenSymbol].max - ranges[otherTokenSymbol].min) + ranges[otherTokenSymbol].min).toFixed(4);
    const otherTokenBalance = await getBalance(client, address, otherTokenDenom);
    addLog(`Mengecek swap ${otherTokenSymbol} -> ZIG. Butuh: ${otherTokenAmountToSwap}, Saldo: ${otherTokenBalance.toFixed(4)}`, "info");
    if (otherTokenBalance >= otherTokenAmountToSwap) {
        return await performSwap(client, address, otherTokenDenom, DENOM_ZIG, otherTokenAmountToSwap, contract);
    } else {
        const errorMessage = `Saldo juga tidak cukup untuk swap ${otherTokenSymbol} -> ZIG.`;
        addLog(errorMessage, "error");
        return `❌ ${errorMessage}`;
    }
}

async function runCycle(client, address, reportSummary) {
    addLog(`Memulai siklus untuk wallet: ${getShortAddress(address)}`, "info");
    
    if (config.swap.repetitions > 0) {
        addLog(`--- Tahap 1: Melakukan ${config.swap.repetitions} Swap Acak ---`, "info");
        for (let i = 0; i < config.swap.repetitions; i++) {
            addLog(`--- Swap Acak ke-${i + 1} dari ${config.swap.repetitions} ---`, "info");
            const pair = Math.random() < 0.5 ? "ZIG_ORO" : "ZIG_BEE";
            const result = await autoSwap(client, address, pair);
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
            
            // ✅ MEMILIH POOL SECARA ACAK
            const chosenPool = Math.random() < 0.5 ? 'ORO_ZIG' : 'ZIG_BEE';
            addLog(`Memilih pool LP secara acak: ${chosenPool}`, "info");

            if (chosenPool === 'ORO_ZIG') {
                const lpConfig = config.addLp.smart.ORO_ZIG;
                const oroBalance = await getBalance(client, address, DENOM_ORO);
                addLog(`Mengecek saldo ORO. Saldo saat ini: ${oroBalance.toFixed(4)} ORO`, "info");
                if (oroBalance >= lpConfig.minBalance) {
                    const percent = (Math.random() * (lpConfig.lpPercentToUse.max - lpConfig.lpPercentToUse.min) + lpConfig.lpPercentToUse.min) / 100;
                    const oroAmountToLp = oroBalance * percent;
                    addLog(`Saldo ORO mencukupi. Akan menggunakan ${Math.round(percent*100)}% untuk LP.`, "info");
                    const result = await addLiquidityOroZig(client, address, oroAmountToLp);
                    if(result) reportSummary.push(result);
                } else {
                    const waitMessage = `Saldo ORO (${oroBalance.toFixed(4)}) di bawah ambang batas minimum (${lpConfig.minBalance}). Melewatkan Add LP ORO-ZIG.`;
                    addLog(waitMessage, "wait");
                    reportSummary.push(`🟡 ${waitMessage}`);
                }
            } else { // chosenPool === 'ZIG_BEE'
                const lpConfig = config.addLp.smart.ZIG_BEE;
                const beeBalance = await getBalance(client, address, DENOM_BEE);
                addLog(`Mengecek saldo BEE. Saldo saat ini: ${beeBalance.toFixed(4)} BEE`, "info");
                if (beeBalance >= lpConfig.minBalance) {
                    const percent = (Math.random() * (lpConfig.lpPercentToUse.max - lpConfig.lpPercentToUse.min) + lpConfig.lpPercentToUse.min) / 100;
                    const beeAmountToLp = beeBalance * percent;
                    addLog(`Saldo BEE mencukupi. Akan menggunakan ${Math.round(percent*100)}% untuk LP.`, "info");
                    const result = await addLiquidityZigBee(client, address, beeAmountToLp);
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
        const { client, address } = await getCosmosClient(SEED_PHRASE);
        const shortAddress = getShortAddress(address);
        addLog(`Wallet berhasil dimuat: ${shortAddress}`, "success");
        reportSummary.push(`- Wallet: *${shortAddress}*`);
        await runCycle(client, address, reportSummary);
        addLog("✅ Semua tugas telah selesai. Bot akan berhenti.", "success");
        reportSummary.push("\n*Status Akhir: Berhasil* 👍");
        await sendTelegramReport(reportSummary);
        console.log(chalk.blueBright("===================================================="));
        process.exit(0);
    } catch (error) {
        addLog(`Terjadi error fatal: ${error.message}`, "error");
        reportSummary.push(`\n❌ *Status Akhir: Gagal Total*\n- Alasan: ${error.message}`);
        await sendTelegramReport(reportSummary);
        process.exit(1);
    }
}

startBot();

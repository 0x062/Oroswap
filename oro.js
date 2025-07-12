import chalk from "chalk";
import dotenv from 'dotenv';
import axios from "axios";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, coins } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";

dotenv.config({ quiet: true });

// ===================================================================================
// ⚙️ PENGATURAN UTAMA - HANYA EDIT BAGIAN INI ⚙️
// ===================================================================================
const SEED_PHRASE = process.env.SEED_PHRASE;

const config = {
    // ✅ Tentukan total swap acak yang ingin dilakukan
    swapRepetitions: 4, 
    // ✅ Tentukan berapa kali ingin Add LP
    addLpRepetitions: 2, 
    
    delayBetweenActions: { min: 10, max: 20 },
    
    randomAmountRanges: {
        ZIG_ORO: { 
            ZIG: { min: 0.1, max: 0.5 },
            ORO: { min: 0.1, max: 0.3 } 
        },
        ZIG_BEE: { 
            ZIG: { min: 0.001, max: 0.01 },
            BEE: { min: 0.001, max: 0.002 }
        },
    },
    smartAddLp: {
        minOroBalanceForLp: 0.1, 
        lpPercentToUse: { min: 50, max: 90 },
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
const TOKEN_DECIMALS = {
    uzig: 6,
    "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro": 6,
    "coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee": 6,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function addLog(message, type = "info") {
    let symbol;
    let coloredMessage = chalk.white(message);

    switch (type) {
        case "success":
            symbol = chalk.greenBright('[+]');
            break;
        case "error":
            symbol = chalk.redBright('[-]');
            coloredMessage = chalk.redBright(message);
            break;
        case "info":
        case "wait":
        case "swap":
        default:
            symbol = chalk.cyanBright('[info]');
            break;
    }
    console.log(`${symbol} ${coloredMessage}`);
}

const getShortAddress = (address) => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "N/A");
const toMicroUnits = (amount, denom) => Math.floor(parseFloat(amount) * 10 ** (TOKEN_DECIMALS[denom] || 6));
const getRandomDelay = () => (Math.floor(Math.random() * (config.delayBetweenActions.max - config.delayBetweenActions.min + 1)) + config.delayBetweenActions.min) * 1000;

async function getCosmosClient(seedPhrase) {
    if (!seedPhrase) throw new Error("SEED_PHRASE tidak ditemukan di file .env Anda.");
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(seedPhrase, { prefix: "zig" });
    const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE });
    const [account] = await wallet.getAccounts();
    return { client, address: account.address };
}

async function getBalance(client, address, denom) {
    try {
        const { amount } = await client.getBalance(address, denom);
        return Number(amount / 10 ** TOKEN_DECIMALS[denom]);
    } catch (error) {
        addLog(`Gagal mengambil balance untuk ${denom}: ${error.message}`, "error");
        return 0;
    }
}

async function getPoolInfo(client, contractAddress) {
    try {
        return await client.queryContractSmart(contractAddress, { pool: {} });
    } catch (error) {
        addLog(`Gagal mengambil info pool untuk ${contractAddress}: ${error.message}`, "error");
        return null;
    }
}

function calculateBeliefPrice(poolInfo, contractAddress) {
    if (!poolInfo?.assets || poolInfo.assets.length !== 2) throw new Error("Data pool tidak valid.");
    const assetZIG = poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG);
    const otherAsset = poolInfo.assets.find(a => a.info.native_token.denom !== DENOM_ZIG);
    const zigAmount = parseInt(assetZIG.amount);
    const otherAmount = parseInt(otherAsset.amount);
    if (contractAddress === ZIG_BEE_CONTRACT) return (zigAmount / otherAmount).toFixed(18);
    else return (otherAmount / zigAmount).toFixed(18);
}

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
        return result;
    } catch (error) {
        addLog(`Swap gagal: ${error.message}`, "error");
        return null;
    }
}

async function addLiquidityOroZig(client, address, oroAmount) {
    try {
        const poolInfo = await getPoolInfo(client, ORO_ZIG_CONTRACT);
        if (!poolInfo) return null;
        const ratio = parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG).amount) / parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ORO).amount);
        const oroMicro = toMicroUnits(oroAmount, DENOM_ORO);
        const zigMicroNeeded = Math.floor(oroMicro * ratio);
        const zigNeeded = zigMicroNeeded / 10 ** TOKEN_DECIMALS.uzig;
        addLog(`Mencoba Add LP: ${oroAmount.toFixed(6)} ORO dan ~${zigNeeded.toFixed(6)} ZIG`, "info");
        const balanceZIG = await getBalance(client, address, DENOM_ZIG);
        if (balanceZIG < zigNeeded) {
            addLog(`Saldo ZIG tidak cukup untuk Add LP. Butuh: ${zigNeeded.toFixed(6)}, Saldo: ${balanceZIG.toFixed(6)}`, "error");
            return null;
        }
        const msg = { provide_liquidity: { assets: [{ amount: oroMicro.toString(), info: { native_token: { denom: DENOM_ORO } } }, { amount: zigMicroNeeded.toString(), info: { native_token: { denom: DENOM_ZIG } } }], auto_stake: false, slippage_tolerance: "0.5" } };
        const funds = [{ denom: DENOM_ORO, amount: oroMicro.toString() }, { denom: DENOM_ZIG, amount: zigMicroNeeded.toString() }];
        const result = await client.execute(address, ORO_ZIG_CONTRACT, msg, "auto", "Add Liquidity ORO-ZIG", funds);
        addLog(`Add LP berhasil! Tx: ${result.transactionHash}`, "success");
    } catch (error) {
        addLog(`Add LP gagal: ${error.message}`, "error");
    }
}

// ✅ FUNGSI INI DIKEMBALIKAN untuk menangani swap bolak-balik secara cerdas
async function autoSwap(client, address, pair) {
    const ranges = config.randomAmountRanges[pair];
    const contract = pair === "ZIG_ORO" ? ORO_ZIG_CONTRACT : ZIG_BEE_CONTRACT;
    const otherTokenDenom = pair === "ZIG_ORO" ? DENOM_ORO : DENOM_BEE;
    const otherTokenSymbol = pair === "ZIG_ORO" ? "ORO" : "BEE";

    // Prioritas 1: Coba swap ZIG -> Token Lain
    const zigAmountToSwap = (Math.random() * (ranges.ZIG.max - ranges.ZIG.min) + ranges.ZIG.min).toFixed(4);
    const zigBalance = await getBalance(client, address, DENOM_ZIG);
    addLog(`Mengecek swap ZIG -> ${otherTokenSymbol}. Butuh: ${zigAmountToSwap}, Saldo: ${zigBalance.toFixed(4)}`, "info");

    if (zigBalance >= zigAmountToSwap) {
        await performSwap(client, address, DENOM_ZIG, otherTokenDenom, zigAmountToSwap, contract);
        return; 
    }
    
    // Prioritas 2: Jika ZIG tidak cukup, coba Token Lain -> ZIG
    addLog(`Saldo ZIG tidak cukup. Mencoba arah sebaliknya.`, "wait");
    const otherTokenAmountToSwap = (Math.random() * (ranges[otherTokenSymbol].max - ranges[otherTokenSymbol].min) + ranges[otherTokenSymbol].min).toFixed(4);
    const otherTokenBalance = await getBalance(client, address, otherTokenDenom);
    addLog(`Mengecek swap ${otherTokenSymbol} -> ZIG. Butuh: ${otherTokenAmountToSwap}, Saldo: ${otherTokenBalance.toFixed(4)}`, "info");

    if (otherTokenBalance >= otherTokenAmountToSwap) {
        await performSwap(client, address, otherTokenDenom, DENOM_ZIG, otherTokenAmountToSwap, contract);
    } else {
        addLog(`Saldo juga tidak cukup untuk swap ${otherTokenSymbol} -> ZIG. Melewatkan.`, "error");
    }
}

// ✅ LOGIKA SIKLUS diubah menjadi acak
async function runCycle(client, address) {
    addLog(`Memulai siklus untuk wallet: ${getShortAddress(address)}`, "info");
    
    // Tahap 1: Melakukan Swap Acak Bolak-Balik
    addLog(`--- Tahap 1: Melakukan ${config.swapRepetitions} Swap Acak ---`, "info");
    for (let i = 0; i < config.swapRepetitions; i++) {
        addLog(`--- Swap Acak ke-${i + 1} dari ${config.swapRepetitions} ---`, "info");
        const pair = Math.random() < 0.5 ? "ZIG_ORO" : "ZIG_BEE";
        await autoSwap(client, address, pair);

        if (i < config.swapRepetitions - 1 || config.addLpRepetitions > 0) {
            const delay = getRandomDelay();
            addLog(`Menunggu ${delay / 1000} detik...`, "wait");
            await sleep(delay);
        }
    }

    // Tahap 2: Smart Add Liquidity
    if (config.addLpRepetitions > 0) {
        addLog(`--- Tahap 2: Melakukan ${config.addLpRepetitions} Smart Add Liquidity ---`, "info");
        for (let i = 0; i < config.addLpRepetitions; i++) {
            addLog(`--- Add LP ke-${i + 1} dari ${config.addLpRepetitions} ---`, "info");
            const oroBalance = await getBalance(client, address, DENOM_ORO);
            addLog(`Mengecek saldo ORO. Saldo saat ini: ${oroBalance.toFixed(4)} ORO`, "info");

            if (oroBalance >= config.smartAddLp.minOroBalanceForLp) {
                const percent = (Math.random() * (config.smartAddLp.lpPercentToUse.max - config.smartAddLp.lpPercentToUse.min) + config.smartAddLp.lpPercentToUse.min) / 100;
                const oroAmountToLp = oroBalance * percent;
                addLog(`Saldo ORO mencukupi. Akan menggunakan ${Math.round(percent*100)}% dari saldo untuk Add LP.`, "info");
                await addLiquidityOroZig(client, address, oroAmountToLp);
            } else {
                addLog(`Saldo ORO (${oroBalance.toFixed(4)}) di bawah ambang batas minimum (${config.smartAddLp.minOroBalanceForLp}). Melewatkan Add LP.`, "wait");
            }

            if (i < config.addLpRepetitions - 1) {
                const delay = getRandomDelay();
                addLog(`Menunggu ${delay / 1000} detik...`, "wait");
                await sleep(delay);
            }
        }
    }
}

async function startBot() {
    addLog("🤖 OROSWAP AUTO BOT DIMULAI 🤖", "success");
    try {
        const { client, address } = await getCosmosClient(SEED_PHRASE);
        addLog(`Wallet berhasil dimuat: ${getShortAddress(address)}`, "success");
        await runCycle(client, address);
        addLog("✅ Semua tugas telah selesai. Bot akan berhenti.", "success");
        console.log(chalk.blueBright("===================================================="));
        process.exit(0);
    } catch (error) {
        addLog(`Terjadi error fatal: ${error.message}`, "error");
        process.exit(1);
    }
}

startBot();

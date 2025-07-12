import chalk from "chalk";
import dotenv from 'dotenv';
import axios from "axios";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, coins } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";

// Menghilangkan log dotenv
dotenv.config({ quiet: true });

// ===================================================================================
// ⚙️ PENGATURAN UTAMA - HANYA EDIT BAGIAN INI ⚙️
// ===================================================================================

const SEED_PHRASE = process.env.SEED_PHRASE;

const config = {
    swapRepetitions: 2,
    addLpRepetitions: 1,
    delayBetweenActions: { min: 30, max: 60 },
    delayBetweenCyclesHours: 24,
    randomAmountRanges: {
        ZIG_ORO: {
            ZIG: { min: 0.001, max: 0.002 },
            ORO: { min: 0.001, max: 0.002 },
        },
        ZIG_BEE: {
            ZIG: { min: 1, max: 2 },
            BEE: { min: 0.001, max: 0.003 },
        },
    },
    addLpOroRange: { min: 0.5, max: 1.0 },
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
    const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
    let coloredMessage;
    switch (type) {
        case "error": coloredMessage = chalk.redBright(`[ERROR] ${message}`); break;
        case "success": coloredMessage = chalk.greenBright(`[SUCCESS] ${message}`); break;
        case "wait": coloredMessage = chalk.yellowBright(`[WAIT] ${message}`); break;
        case "info": coloredMessage = chalk.cyanBright(`[INFO] ${message}`); break;
        case "swap": coloredMessage = chalk.magentaBright(`[SWAP] ${message}`); break;
        default: coloredMessage = chalk.white(message);
    }
    console.log(`[${timestamp}] ${coloredMessage}`);
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

// ✅ FUNGSI BARU: Untuk mengambil info pool
async function getPoolInfo(client, contractAddress) {
    try {
        return await client.queryContractSmart(contractAddress, { pool: {} });
    } catch (error) {
        addLog(`Gagal mengambil info pool untuk ${contractAddress}: ${error.message}`, "error");
        return null;
    }
}

// ✅ FUNGSI BARU: Untuk menghitung harga berdasarkan data pool
function calculateBeliefPrice(poolInfo, fromDenom) {
    if (!poolInfo?.assets || poolInfo.assets.length !== 2) {
        throw new Error("Data pool tidak valid untuk menghitung harga.");
    }
    const asset1 = poolInfo.assets[0];
    const asset2 = poolInfo.assets[1];

    const asset1Denom = asset1.info.native_token.denom;
    const asset1Amount = parseInt(asset1.amount);
    
    const asset2Denom = asset2.info.native_token.denom;
    const asset2Amount = parseInt(asset2.amount);

    if (fromDenom === asset1Denom) {
        return (asset2Amount / asset1Amount).toFixed(18);
    } else {
        return (asset1Amount / asset2Amount).toFixed(18);
    }
}

async function performSwap(client, address, fromDenom, toDenom, amount, contractAddress) {
    try {
        // ✅ PERBAIKAN: Mengambil info pool dan menghitung belief_price secara dinamis
        const poolInfo = await getPoolInfo(client, contractAddress);
        const beliefPrice = calculateBeliefPrice(poolInfo, fromDenom);
        addLog(`Harga pool saat ini (belief_price): ${beliefPrice}`, "info");

        const microAmount = toMicroUnits(amount, fromDenom);
        const fromSymbol = fromDenom === DENOM_ZIG ? "ZIG" : fromDenom === DENOM_ORO ? "ORO" : "BEE";
        const toSymbol = toDenom === DENOM_ZIG ? "ZIG" : toDenom === DENOM_ORO ? "ORO" : "BEE";

        addLog(`Mencoba swap: ${amount} ${fromSymbol} ➯ ${toSymbol}`, "swap");

        const msg = {
            swap: {
                belief_price: beliefPrice,
                max_spread: "0.5",
                offer_asset: { amount: microAmount.toString(), info: { native_token: { denom: fromDenom } } },
            },
        };

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

        const oroMicro = toMicroUnits(oroAmount, DENOM_ORO);
        const ratio = parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ZIG).amount) / parseInt(poolInfo.assets.find(a => a.info.native_token.denom === DENOM_ORO).amount);
        const zigMicroNeeded = Math.floor(oroMicro * ratio);
        const zigNeeded = zigMicroNeeded / 10 ** TOKEN_DECIMALS.uzig;

        addLog(`Mencoba Add LP: ${oroAmount} ORO dan ~${zigNeeded.toFixed(6)} ZIG`, "info");
        const balanceZIG = await getBalance(client, address, DENOM_ZIG);
        if (balanceZIG < zigNeeded) {
            addLog(`Saldo ZIG tidak cukup untuk Add LP. Butuh: ${zigNeeded.toFixed(6)}, Saldo: ${balanceZIG.toFixed(6)}`, "error");
            return null;
        }

        const msg = {
            provide_liquidity: {
                assets: [
                    { amount: oroMicro.toString(), info: { native_token: { denom: DENOM_ORO } } },
                    { amount: zigMicroNeeded.toString(), info: { native_token: { denom: DENOM_ZIG } } },
                ], auto_stake: false, slippage_tolerance: "0.5",
            },
        };
        const funds = [
            { denom: DENOM_ORO, amount: oroMicro.toString() },
            { denom: DENOM_ZIG, amount: zigMicroNeeded.toString() },
        ];
        const result = await client.execute(address, ORO_ZIG_CONTRACT, msg, "auto", "Add Liquidity ORO-ZIG", funds);
        addLog(`Add LP berhasil! Tx: ${result.transactionHash}`, "success");
        return result;
    } catch (error) {
        addLog(`Add LP gagal: ${error.message}`, "error");
        return null;
    }
}

async function autoSwap(client, address, pair) {
    const ranges = config.randomAmountRanges[pair];
    const contract = pair === "ZIG_ORO" ? ORO_ZIG_CONTRACT : ZIG_BEE_CONTRACT;
    const otherTokenDenom = pair === "ZIG_ORO" ? DENOM_ORO : DENOM_BEE;
    const otherTokenSymbol = pair === "ZIG_ORO" ? "ORO" : "BEE";

    const zigAmountToSwap = (Math.random() * (ranges.ZIG.max - ranges.ZIG.min) + ranges.ZIG.min).toFixed(4);
    const zigBalance = await getBalance(client, address, DENOM_ZIG);

    addLog(`Mengecek swap ZIG -> ${otherTokenSymbol}. Butuh: ${zigAmountToSwap}, Saldo: ${zigBalance.toFixed(4)}`, "info");
    if (zigBalance >= zigAmountToSwap) {
        await performSwap(client, address, DENOM_ZIG, otherTokenDenom, zigAmountToSwap, contract);
        return;
    }
    
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

async function runCycle(client, address) {
    addLog(`Memulai siklus untuk wallet: ${getShortAddress(address)}`, "info");
    for (let i = 0; i < config.swapRepetitions; i++) {
        addLog(`--- Swap ke-${i + 1} dari ${config.swapRepetitions} ---`, "info");
        const pair = Math.random() < 0.5 ? "ZIG_ORO" : "ZIG_BEE";
        await autoSwap(client, address, pair);
        if (i < config.swapRepetitions - 1 || config.addLpRepetitions > 0) {
            const delay = getRandomDelay();
            addLog(`Menunggu ${delay / 1000} detik sebelum aksi berikutnya...`, "wait");
            await sleep(delay);
        }
    }
    for (let i = 0; i < config.addLpRepetitions; i++) {
        addLog(`--- Add LP ke-${i + 1} dari ${config.addLpRepetitions} ---`, "info");
        const oroAmount = (Math.random() * (config.addLpOroRange.max - config.addLpOroRange.min) + config.addLpOroRange.min).toFixed(6);
        const oroBalance = await getBalance(client, address, DENOM_ORO);
        if (oroBalance >= oroAmount) {
            await addLiquidityOroZig(client, address, oroAmount);
        } else {
            addLog(`Saldo ORO tidak cukup untuk Add LP (${oroBalance.toFixed(4)} < ${oroAmount}). Melewatkan.`, "error");
        }
        if (i < config.addLpRepetitions - 1) {
            const delay = getRandomDelay();
            addLog(`Menunggu ${delay / 1000} detik sebelum Add LP berikutnya...`, "wait");
            await sleep(delay);
        }
    }
}

async function startBot() {
    addLog("🤖 OROSWAP AUTO BOT (SINGLE ACCOUNT) DIMULAI 🤖", "success");
    let client, address;
    try {
        ({ client, address } = await getCosmosClient(SEED_PHRASE));
        addLog(`Wallet berhasil dimuat: ${getShortAddress(address)}`, "success");
    } catch (error) {
        addLog(`Bot berhenti: ${error.message}`, "error");
        return;
    }
    while (true) {
        try {
            await runCycle(client, address);
            const delayHours = config.delayBetweenCyclesHours;
            const delayMs = delayHours * 60 * 60 * 1000;
            addLog(`Siklus selesai. Siklus berikutnya akan dimulai dalam ${delayHours} jam.`, "success");
            console.log(chalk.blueBright("===================================================="));
            await sleep(delayMs);
        } catch (error) {
            addLog(`Terjadi error pada siklus utama: ${error.message}`, "error");
            addLog("Mencoba lagi setelah 15 detik...", "wait");
            await sleep(15 * 1000); 
        }
    }
}

startBot();

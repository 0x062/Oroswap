import chalk from "chalk";
import dotenv from 'dotenv';
import fs from "fs";
import axios from "axios";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, coins } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";

// ===================================================================================
// ⚙️ PENGATURAN UTAMA - HANYA EDIT BAGIAN INI ⚙️
// ===================================================================================

// Masukkan 12 atau 24 kata seed phrase wallet-mu di sini
const SEED_PHRASE = process.env.SEED_KEY;

const config = {
  // Jumlah swap yang akan dilakukan setiap siklus
  swapRepetitions: 2,
  // Jumlah add liquidity yang akan dilakukan setiap siklus
  addLpRepetitions: 1,

  // Jeda waktu antar aksi (dalam detik)
  delayBetweenActions: {
    min: 30,
    max: 60,
  },

  // Jeda waktu antar siklus (dalam jam)
  delayBetweenCyclesHours: 24,

  // Pengaturan jumlah acak untuk setiap pair swap
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

  // Pengaturan jumlah acak untuk Add Liquidity (dalam ORO)
  addLpOroRange: {
    min: 0.5,
    max: 1.0,
  },
};

// ===================================================================================
// 🛑 JANGAN UBAH APAPUN DI BAWAH GARIS INI 🛑
// ===================================================================================

// --- KONSTANTA JARINGAN ---
const RPC_URL = "https://rpc.zigscan.net";
const API_URL = "https://testnet-api.oroswap.org/api";
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

// --- VARIABEL GLOBAL ---
let lastSwapDirectionZigOro = "ORO_TO_ZIG";
let lastSwapDirectionZigBee = "BEE_TO_ZIG";

// --- FUNGSI UTILITAS ---
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

// --- FUNGSI BLOCKCHAIN ---
async function getCosmosClient(seedPhrase) {
  try {
    if (!seedPhrase || seedPhrase === "YOUR_SEED_PHRASE_HERE") {
      throw new Error("Seed phrase belum diatur. Silakan edit skrip dan masukkan seed phrase Anda.");
    }
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(seedPhrase, { prefix: "zig" });
    const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE });
    const [account] = await wallet.getAccounts();
    return { client, address: account.address };
  } catch (error) {
    addLog(`Gagal menginisialisasi Cosmos client: ${error.message}`, "error");
    throw error;
  }
}

async function getBalance(client, address, denom) {
  try {
    const balance = await client.getBalance(address, denom);
    return Number(balance.amount / 10 ** TOKEN_DECIMALS[denom]);
  } catch (error) {
    addLog(`Gagal mengambil balance untuk ${denom}: ${error.message}`, "error");
    return 0;
  }
}

async function getPoolInfo(client, contractAddress) {
  try {
    return await client.queryContractSmart(contractAddress, { pool: {} });
  } catch (error) {
    addLog(`Gagal mengambil info pool untuk kontrak ${contractAddress}: ${error.message}`, "error");
    return null;
  }
}

async function performSwap(client, address, fromDenom, toDenom, amount, contractAddress) {
  try {
    const microAmount = toMicroUnits(amount, fromDenom);
    const fromSymbol = fromDenom === DENOM_ZIG ? "ZIG" : fromDenom === DENOM_ORO ? "ORO" : "BEE";
    const toSymbol = toDenom === DENOM_ZIG ? "ZIG" : toDenom === DENOM_ORO ? "ORO" : "BEE";
    
    addLog(`Mencoba swap: ${amount} ${fromSymbol} ➯ ${toSymbol}`, "swap");

    const msg = {
      swap: {
        belief_price: "1", // Belief price disederhanakan, karena slippage diatur
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
    if (!poolInfo?.assets || poolInfo.assets.length !== 2) throw new Error("Info pool ORO-ZIG tidak valid");

    const [asset1, asset2] = poolInfo.assets;
    let oroInPool, zigInPool;

    if (asset1.info.native_token?.denom === DENOM_ORO) {
      oroInPool = parseInt(asset1.amount);
      zigInPool = parseInt(asset2.amount);
    } else {
      oroInPool = parseInt(asset2.amount);
      zigInPool = parseInt(asset1.amount);
    }
    if (oroInPool <= 0 || zigInPool <= 0) throw new Error("Jumlah pool ORO-ZIG tidak valid");

    const oroMicro = toMicroUnits(oroAmount, DENOM_ORO);
    const zigMicroNeeded = Math.floor((oroMicro * zigInPool) / oroInPool);
    const zigNeeded = zigMicroNeeded / 10**TOKEN_DECIMALS.uzig;

    addLog(`Mencoba Add LP: ${oroAmount} ORO dan ~${zigNeeded.toFixed(6)} ZIG`, "info");
    
    const balanceZIG = await getBalance(client, address, DENOM_ZIG);
    if(balanceZIG < zigNeeded) {
        addLog(`Saldo ZIG tidak cukup untuk Add LP. Butuh: ${zigNeeded.toFixed(6)}, Saldo: ${balanceZIG.toFixed(6)}`, "error");
        return null;
    }

    const msg = {
      provide_liquidity: {
        assets: [
          { amount: oroMicro.toString(), info: { native_token: { denom: DENOM_ORO } } },
          { amount: zigMicroNeeded.toString(), info: { native_token: { denom: DENOM_ZIG } } },
        ],
        auto_stake: false,
        slippage_tolerance: "0.5",
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


// --- LOGIKA UTAMA AUTO-BOT ---

async function autoSwap(client, address, pair) {
    const ranges = config.randomAmountRanges[pair];
    const contract = pair === "ZIG_ORO" ? ORO_ZIG_CONTRACT : ZIG_BEE_CONTRACT;
    const fromDenom = pair === "ZIG_ORO" ? (lastSwapDirectionZigOro === "ZIG_TO_ORO" ? DENOM_ZIG : DENOM_ORO) : (lastSwapDirectionZigBee === "ZIG_TO_BEE" ? DENOM_ZIG : DENOM_BEE);
    const toDenom = pair === "ZIG_ORO" ? (lastSwapDirectionZigOro === "ZIG_TO_ORO" ? DENOM_ORO : DENOM_ZIG) : (lastSwapDirectionZigBee === "ZIG_TO_BEE" ? DENOM_BEE : DENOM_ZIG);
    const fromSymbol = fromDenom === DENOM_ZIG ? "ZIG" : (fromDenom === DENOM_ORO ? "ORO" : "BEE");
    const toSymbol = toDenom === DENOM_ZIG ? "ZIG" : (toDenom === DENOM_ORO ? "ORO" : "BEE");

    const amount = (Math.random() * (ranges[fromSymbol].max - ranges[fromSymbol].min) + ranges[fromSymbol].min).toFixed(4);
    const balance = await getBalance(client, address, fromDenom);
    
    addLog(`Mengecek swap ${fromSymbol} -> ${toSymbol}. Butuh: ${amount}, Saldo: ${balance.toFixed(4)}`, "info");

    if (balance >= amount) {
        await performSwap(client, address, fromDenom, toDenom, amount, contract);
        if (pair === "ZIG_ORO") lastSwapDirectionZigOro = lastSwapDirectionZigOro === "ZIG_TO_ORO" ? "ORO_TO_ZIG" : "ZIG_TO_ORO";
        if (pair === "ZIG_BEE") lastSwapDirectionZigBee = lastSwapDirectionZigBee === "ZIG_TO_BEE" ? "BEE_TO_ZIG" : "ZIG_TO_BEE";
    } else {
        addLog(`Saldo tidak cukup untuk swap ${fromSymbol} -> ${toSymbol}. Mencoba arah sebaliknya.`, "wait");
        // Coba arah sebaliknya
        const reverseFromDenom = toDenom;
        const reverseToDenom = fromDenom;
        const reverseFromSymbol = toSymbol;
        const reverseToSymbol = fromSymbol;
        
        const reverseAmount = (Math.random() * (ranges[reverseFromSymbol].max - ranges[reverseFromSymbol].min) + ranges[reverseFromSymbol].min).toFixed(4);
        const reverseBalance = await getBalance(client, address, reverseFromDenom);
        
        addLog(`Mengecek swap ${reverseFromSymbol} -> ${reverseToSymbol}. Butuh: ${reverseAmount}, Saldo: ${reverseBalance.toFixed(4)}`, "info");

        if(reverseBalance >= reverseAmount) {
            await performSwap(client, address, reverseFromDenom, reverseToDenom, reverseAmount, contract);
             if (pair === "ZIG_ORO") lastSwapDirectionZigOro = lastSwapDirectionZigOro === "ZIG_TO_ORO" ? "ORO_TO_ZIG" : "ZIG_TO_ORO";
             if (pair === "ZIG_BEE") lastSwapDirectionZigBee = lastSwapDirectionZigBee === "ZIG_TO_BEE" ? "BEE_TO_ZIG" : "ZIG_TO_BEE";
        } else {
            addLog(`Saldo juga tidak cukup untuk swap ${reverseFromSymbol} -> ${reverseToSymbol}. Melewatkan swap kali ini.`, "error");
        }
    }
}


async function runCycle(client, address) {
  addLog(`Memulai siklus untuk wallet: ${getShortAddress(address)}`, "info");

  // --- Proses Swap ---
  for (let i = 0; i < config.swapRepetitions; i++) {
    addLog(`--- Swap ke-${i + 1} dari ${config.swapRepetitions} ---`, "info");
    const pair = Math.random() < 0.5 ? "ZIG_ORO" : "ZIG_BEE"; // Pilih pair secara acak
    await autoSwap(client, address, pair);

    if (i < config.swapRepetitions - 1) {
      const delay = getRandomDelay();
      addLog(`Menunggu ${delay / 1000} detik sebelum aksi berikutnya...`, "wait");
      await sleep(delay);
    }
  }

  // --- Proses Add Liquidity ---
  if(config.addLpRepetitions > 0) {
    const delay = getRandomDelay();
    addLog(`Menunggu ${delay / 1000} detik sebelum memulai Add Liquidity...`, "wait");
    await sleep(delay);
  }

  for (let i = 0; i < config.addLpRepetitions; i++) {
    addLog(`--- Add LP ke-${i + 1} dari ${config.addLpRepetitions} ---`, "info");
    const oroAmount = (Math.random() * (config.addLpOroRange.max - config.addLpOroRange.min) + config.addLpOroRange.min).toFixed(6);
    const oroBalance = await getBalance(client, address, DENOM_ORO);

    addLog(`Mengecek Add LP. Butuh: ${oroAmount} ORO, Saldo: ${oroBalance.toFixed(4)}`, "info");

    if(oroBalance >= oroAmount) {
        await addLiquidityOroZig(client, address, oroAmount);
    } else {
        addLog(`Saldo ORO tidak cukup untuk Add LP. Melewatkan.`, "error");
    }

    if (i < config.addLpRepetitions - 1) {
      const delay = getRandomDelay();
      addLog(`Menunggu ${delay / 1000} detik sebelum Add LP berikutnya...`, "wait");
      await sleep(delay);
    }
  }
}

async function startBot() {
  addLog("🤖 OROSWAP AUTO BOT DIMULAI 🤖", "success");
  let client, address;

  try {
    ({ client, address } = await getCosmosClient(SEED_PHRASE));
    addLog(`Wallet berhasil dimuat: ${getShortAddress(address)}`, "success");
    const zigBalance = await getBalance(client, address, DENOM_ZIG);
    const oroBalance = await getBalance(client, address, DENOM_ORO);
    const beeBalance = await getBalance(client, address, DENOM_BEE);
    addLog(`Saldo awal: ${zigBalance.toFixed(4)} ZIG, ${oroBalance.toFixed(4)} ORO, ${beeBalance.toFixed(4)} BEE`, "info");
  } catch (error) {
    addLog("Bot berhenti karena gagal memuat wallet. Periksa seed phrase dan koneksi.", "error");
    return;
  }

  while (true) {
    try {
      await runCycle(client, address);
      const delayHours = config.delayBetweenCyclesHours;
      const delayMs = delayHours * 60 * 60 * 1000;
      addLog(`Siklus selesai. Siklus berikutnya akan dimulai dalam ${delayHours} jam.`, "success");
      await sleep(delayMs);
    } catch (error) {
      addLog(`Terjadi error pada siklus utama: ${error.message}`, "error");
      addLog("Mencoba lagi setelah 1 jam...", "wait");
      await sleep(1 * 60 * 60 * 1000); // Tunggu 1 jam jika ada error
    }
  }
}

startBot();

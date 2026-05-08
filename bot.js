import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const DISCORD_WEBHOOK_DORMANT = process.env.DISCORD_WEBHOOK_DORMANT;

const DORMANT_DAYS = Number(process.env.DORMANT_DAYS || 20);
const MIN_SWAP_SOL = Number(process.env.MIN_SWAP_SOL || 10);
const MIN_FUNDED_SOL = Number(process.env.MIN_FUNDED_SOL || 10);

const ALLOWED_DEXES = (process.env.ALLOWED_DEXES || 'pump,raydium,meteora')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

const seen = new Map();

function short(addr) {
  if (!addr) return 'N/A';
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return 'N/A';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Number(n).toFixed(2)}`;
}

function isDuplicate(wallet, mint) {
  const key = `${wallet}:${mint}`;
  const now = Date.now();
  const last = seen.get(key);

  if (last && now - last < 6 * 60 * 60 * 1000) return true;

  seen.set(key, now);

  if (seen.size > 10000) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [k, v] of seen.entries()) {
      if (v < cutoff) seen.delete(k);
    }
  }

  return false;
}

async function heliusRpc(method, params) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method,
      params
    })
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Helius RPC error');
  return json.result;
}

async function getBalanceSol(address) {
  const result = await heliusRpc('getBalance', [address, { commitment: 'confirmed' }]);
  return (result?.value || 0) / 1e9;
}

async function getWalletHistory(wallet, limit = 100) {
  const url = new URL(`https://api.helius.xyz/v1/wallet/${wallet}/history`);
  url.searchParams.set('api-key', HELIUS_API_KEY);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`wallet history failed ${res.status}`);
  return await res.json();
}

function getDormantDaysFromHistory(history, currentSignature) {
  if (!Array.isArray(history) || history.length === 0) return null;

  const previousTx = history.find(tx => tx.signature !== currentSignature);
  if (!previousTx?.timestamp) return null;

  const previousTsMs = Number(previousTx.timestamp) * 1000;
  return (Date.now() - previousTsMs) / 86400000;
}

async function getDexInfo(mint) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!res.ok) return null;

  const data = await res.json();
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const pair = pairs.find(p => p.chainId === 'solana') || pairs[0];

  if (!pair) return null;

  return {
    name: pair.baseToken?.name || 'Unknown',
    symbol: pair.baseToken?.symbol || '???',
    mcap: Number(pair.fdv || 0),
    liq: Number(pair.liquidity?.usd || 0),
    vol24: Number(pair.volume?.h24 || 0),
    change24: pair.priceChange?.h24 == null ? null : Number(pair.priceChange.h24),
    pairUrl: pair.url || `https://dexscreener.com/solana/${mint}`
  };
}

function detectDex(event) {
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('pump')) return 'pump';
  if (raw.includes('raydium')) return 'raydium';
  if (raw.includes('meteora')) return 'meteora';

  const source = String(event?.source || '').toLowerCase();
  if (source.includes('pump')) return 'pump';
  if (source.includes('raydium')) return 'raydium';
  if (source.includes('meteora')) return 'meteora';

  return null;
}

function extractSwapInfo(event) {
  const wallet = event?.feePayer || event?.signer;
  const signature = event?.signature;

  if (!wallet || !signature) return null;

  let mint = null;
  let swapSol = null;

  const tokenTransfers = Array.isArray(event?.tokenTransfers) ? event.tokenTransfers : [];
  for (const t of tokenTransfers) {
    if (t?.mint) {
      mint = t.mint;
      break;
    }
  }

  const nativeTransfers = Array.isArray(event?.nativeTransfers) ? event.nativeTransfers : [];
  let lamportsMoved = 0;

  for (const t of nativeTransfers) {
    if (t?.fromUserAccount === wallet || t?.toUserAccount === wallet) {
      lamportsMoved += Math.abs(Number(t.amount || 0));
    }
  }

  if (lamportsMoved > 0) {
    swapSol = lamportsMoved / 1e9;
  } else if (Array.isArray(event?.accountData)) {
    const accountEntry = event.accountData.find(a => a.account === wallet);
    if (accountEntry?.nativeBalanceChange != null) {
      swapSol = Math.abs(Number(accountEntry.nativeBalanceChange)) / 1e9;
    }
  }

  return { wallet, signature, mint, swapSol };
}

async function sendDiscordAlert({ dex, wallet, mint, swapSol, fundedSol, dormantDays, token, signature }) {
  const change24 = token?.change24;

  const payload = {
    embeds: [
      {
        title: `😴 Dormant wallet buy detected on ${dex}`,
        color: 16753920,
        description:
          `A dormant wallet just made a qualifying swap.\n\n` +
          `**Wallet:** \`${wallet}\`\n` +
          `**CA:** \`${mint || 'unknown'}\`\n` +
          `**Signature:** \`${signature}\`\n` +
          `[DexScreener](${token?.pairUrl || `https://dexscreener.com/solana/${mint}`}) · ` +
          `[Axiom](https://axiom.trade/meme/${mint})`,
        fields: [
          { name: 'DEX', value: dex || 'unknown', inline: true },
          { name: 'Swap Size', value: swapSol != null ? `${swapSol.toFixed(3)} SOL` : 'N/A', inline: true },
          { name: 'Funded', value: `${fundedSol.toFixed(2)} SOL`, inline: true },
          { name: 'Dormant', value: `${Math.round(dormantDays)} days`, inline: true },
          { name: 'Mcap', value: fmtUsd(token?.mcap), inline: true },
          { name: 'Liquidity', value: fmtUsd(token?.liq), inline: true },
          { name: '24h Vol', value: fmtUsd(token?.vol24), inline: true },
          {
            name: '24h %',
            value: change24 == null ? 'N/A' : `${change24 >= 0 ? '+' : ''}${change24.toFixed(1)}%`,
            inline: true
          },
          { name: 'Wallet Short', value: short(wallet), inline: true }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  };

  const res = await fetch(DISCORD_WEBHOOK_DORMANT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`discord webhook failed ${res.status}: ${txt}`);
  }
}

app.get('/', (_req, res) => {
  res.send('Bot is running');
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('ok');

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      if (event?.type !== 'SWAP') continue;

      const dex = detectDex(event);
      if (!dex || !ALLOWED_DEXES.includes(dex)) continue;

      const parsed = extractSwapInfo(event);
      if (!parsed?.wallet || !parsed?.signature) continue;

      const { wallet, signature, mint, swapSol } = parsed;

      if (!mint) continue;
      if (swapSol == null || swapSol < MIN_SWAP_SOL) continue;
      if (isDuplicate(wallet, mint)) continue;

      const fundedSol = await getBalanceSol(wallet);
      if (fundedSol < MIN_FUNDED_SOL) continue;

      const history = await getWalletHistory(wallet, 100);
      const dormantDays = getDormantDaysFromHistory(history, signature);
      if (dormantDays == null || dormantDays < DORMANT_DAYS) continue;

      const token = await getDexInfo(mint);

      await sendDiscordAlert({
        dex,
        wallet,
        mint,
        swapSol,
        fundedSol,
        dormantDays,
        token,
        signature
      });

      console.log(`[ALERT] ${dex} ${wallet} ${mint} ${swapSol} SOL dormant=${Math.round(dormantDays)}d`);
    }
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err?.message || err);
  }
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});

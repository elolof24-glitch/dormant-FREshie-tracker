import 'dotenv/config';
import express from 'express';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import fetch from 'node-fetch';

// ── Config ───────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const DISCORD_FRESH   = process.env.DISCORD_WEBHOOK_FRESH;
const DISCORD_DORMANT = process.env.DISCORD_WEBHOOK_DORMANT;
const HELIUS_KEY      = process.env.HELIUS_API_KEY;
const DORMANT_DAYS    = parseInt(process.env.DORMANT_DAYS || '20');
const FRESH_DAYS      = parseInt(process.env.FRESH_DAYS   || '7');
const SOL_MINT        = 'So11111111111111111111111111111111111111112';

// ── Dedupe ───────────────────────────────────────────────────────────────────
const recentlySeen = new Map();
function isDupe(wallet, mint) {
  const key = `${wallet}:${mint}`;
  const last = recentlySeen.get(key);
  if (last && Date.now() - last < 3_600_000) return true;
  recentlySeen.set(key, Date.now());
  return false;
}

// ── Discord webhook clients ──────────────────────────────────────────────────
const freshHook   = DISCORD_FRESH   ? new WebhookClient({ url: DISCORD_FRESH })   : null;
const dormantHook = DISCORD_DORMANT ? new WebhookClient({ url: DISCORD_DORMANT }) : null;

// ── Token info (DexScreener) ─────────────────────────────────────────────────
async function getTokenInfo(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data?.pairs?.find(p => p.chainId === 'solana') || data?.pairs?.[0];
    if (!pair) return null;
    return {
      name:          pair.baseToken?.name   || 'Unknown',
      symbol:        pair.baseToken?.symbol || '???',
      mcap:          pair.fdv,
      pairCreatedAt: pair.pairCreatedAt,
      imageUrl:      pair.info?.imageUrl   || null,
      venue:         pair.dexId            || null,
    };
  } catch { return null; }
}

// ── Wallet profile (Helius) ──────────────────────────────────────────────────
async function getWalletProfile(address) {
  try {
    const url = `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=100`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const txs = await res.json();
    if (!Array.isArray(txs) || txs.length === 0)
      return { firstTxTimestamp: null, lastTxTimestamp: null, txCount: 0, fundedStr: '—', solBalance: null, dormantDays: null };

    const newest = txs[0].timestamp * 1000;
    const oldest = txs[txs.length - 1].timestamp * 1000;

    let fundedStr = '—';
    for (let i = txs.length - 1; i >= 0; i--) {
      const inbound = txs[i].nativeTransfers?.find(t => t.toUserAccount === address && t.amount > 0);
      if (inbound) {
        const daysAgo = Math.floor((Date.now() - txs[i].timestamp * 1000) / 86_400_000);
        fundedStr = `${daysAgo}d ago`;
        break;
      }
    }

    let solBalance = null;
    try {
      const balRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
      });
      const balData = await balRes.json();
      if (balData?.result?.value != null) solBalance = balData.result.value / 1e9;
    } catch {}

    return {
      firstTxTimestamp: oldest,
      lastTxTimestamp:  newest,
      txCount:          txs.length,
      mightBeOlder:     txs.length === 100,
      fundedStr,
      solBalance,
      dormantDays: (Date.now() - newest) / 86_400_000,
    };
  } catch { return null; }
}

function classifyWallet(profile) {
  if (!profile || profile.txCount === 0) return 'fresh';
  const ageDays    = (Date.now() - profile.firstTxTimestamp) / 86_400_000;
  const dormant    = (Date.now() - profile.lastTxTimestamp)  / 86_400_000;
  if (ageDays  <= FRESH_DAYS)   return 'fresh';
  if (dormant  >= DORMANT_DAYS) return 'dormant';
  return null;
}

// ── Embed builder ────────────────────────────────────────────────────────────
function fmtMcap(n) {
  if (!n && n !== 0) return 'N/A';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function shortAddr(addr) { return `${addr.slice(0,4)}…${addr.slice(-4)}`; }

function buildEmbed({ wallet, token, mint, swapSol, profile, color }) {
  const wAgeDays = profile?.firstTxTimestamp
    ? Math.floor((Date.now() - profile.firstTxTimestamp) / 86_400_000)
    : null;
  const tAgeDays = token?.pairCreatedAt
    ? Math.floor((Date.now() - token.pairCreatedAt) / 86_400_000)
    : null;

  const tags = [];
  if (token?.mcap && token.mcap < 500_000) tags.push('LOW MC');
  if (swapSol && parseFloat(swapSol) >= 10) tags.push('BIG BUY');
  if (wAgeDays !== null && wAgeDays <= 7)   tags.push('FRESH WALLET');

  const solBal = profile?.solBalance != null ? `${profile.solBalance.toFixed(2)} SOL` : 'N/A';

  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: tags.join(' · ') || 'SIGNAL' })
    .setTitle(`🐋 ${token?.name || shortAddr(mint)} · ${swapSol ? swapSol + ' SOL' : 'N/A'}`)
    .setThumbnail(token?.imageUrl || null)
    .addFields(
      { name: '🪙 Token', value: '​', inline: false },
      { name: 'MC',       value: fmtMcap(token?.mcap),                      inline: true },
      { name: 'Age',      value: tAgeDays != null ? `${tAgeDays}d` : 'N/A', inline: true },
      { name: 'Contract', value: `\`${mint}\``,                              inline: false },

      { name: '👛 Wallet', value:
          `[👤 ${shortAddr(wallet)}](https://solscan.io/account/${wallet})\n` +
          `Age ${wAgeDays != null ? wAgeDays + 'd' : '?'} · Tx ${profile?.txCount ?? '?'}\n` +
          `Funded ${profile?.fundedStr ?? '—'}`,
        inline: false
      },
      { name: 'SOL Balance', value: solBal,                                          inline: true },
      { name: 'Buy Amount',  value: swapSol ? `${swapSol} SOL` : 'N/A',             inline: true },
      { name: 'Dormant',     value: profile?.dormantDays != null ? `${Math.round(profile.dormantDays)}d` : '—', inline: true },
    )
    .setFooter({ text: `${token?.venue || 'pump.fun'} · ${new Date().toUTCString()}` })
    .setTimestamp();
}

function buildComponents(mint, sig) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 5, label: 'Solscan', url: `https://solscan.io/tx/${sig}` },
      { type: 2, style: 5, label: 'Axiom',   url: `https://axiom.trade/t/${mint}` },
    ],
  }];
}

// ── Helius webhook handler ───────────────────────────────────────────────────
async function handleHeliusEvent(events) {
  if (!Array.isArray(events)) events = [events];

  for (const event of events) {
    if (event.type !== 'SWAP') continue;

    const swap   = event.swap;
    const wallet = event.feePayer;
    const sig    = event.signature;
    if (!wallet) continue;

    let mint = null;
    let swapSol = null;

    if (swap?.tokenInputs?.length && swap?.tokenOutputs?.length) {
      const outMint = swap.tokenOutputs[0]?.mint;
      const inMint  = swap.tokenInputs[0]?.mint;
      if (outMint && outMint !== SOL_MINT)      mint = outMint;
      else if (inMint && inMint !== SOL_MINT)   mint = inMint;

      const nativeDelta = event.accountData?.find(a => a.account === wallet)?.nativeBalanceChange;
      if (nativeDelta) swapSol = Math.abs(nativeDelta / 1e9).toFixed(3);
    }

    if (!mint) continue;
    if (isDupe(wallet, mint)) continue;

    console.log(`[SCAN] wallet=${wallet.slice(0,8)}… mint=${mint.slice(0,8)}…`);

    const profile = await getWalletProfile(wallet);
    const type    = classifyWallet(profile);
    if (!type) continue;

    const token      = await getTokenInfo(mint);
    const components = buildComponents(mint, sig);

    if (type === 'fresh' && freshHook) {
      const embed = buildEmbed({ wallet, token, mint, swapSol, profile, color: 0x00e5ff });
      await freshHook.send({ embeds: [embed], components }).catch(console.error);
      console.log(`[FRESH] sent for ${wallet.slice(0,8)}…`);
    }

    if (type === 'dormant' && dormantHook) {
      const embed = buildEmbed({ wallet, token, mint, swapSol, profile, color: 0xff9800 });
      await dormantHook.send({ embeds: [embed], components }).catch(console.error);
      console.log(`[DORMANT] sent for ${wallet.slice(0,8)}… (${Math.round(profile?.dormantDays || DORMANT_DAYS)}d idle)`);
    }
  }
}

// ── Express server ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'dormant-freshie-tracker' }));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try { await handleHeliusEvent(req.body); }
  catch (err) { console.error('[WEBHOOK ERROR]', err.message); }
});

app.listen(PORT, () => {
  console.log(`✅ dormant-FREshie-tracker running on port ${PORT}`);
  console.log(`   Fresh webhook:     ${freshHook   ? '✓' : '✗ NOT SET'}`);
  console.log(`   Dormant webhook:   ${dormantHook ? '✓' : '✗ NOT SET'}`);
  console.log(`   Dormant threshold: ${DORMANT_DAYS}d`);
  console.log(`   Fresh threshold:   ${FRESH_DAYS}d`);
});

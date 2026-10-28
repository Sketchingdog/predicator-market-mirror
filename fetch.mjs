#!/usr/bin/env node
/**
 * 市场镜像抓取器：在 GitHub Actions（境外网络）运行。
 * 抓取 Polymarket / Metaculus 的开放热门题，归一化后写入 data/questions.json。
 * 任何单源失败不影响其他源；全部失败时退出码非零（Actions 会标红）。
 */
import fs from 'node:fs';

const NOW = Date.now();
const MIN_CLOSE_MS = 12 * 3600_000;      // 至少 12 小时后才结算
const MAX_CLOSE_MS = 45 * 24 * 3600_000; // 最多 45 天内结算（周期太长对训练没意义）

const norm = (s) => String(s ?? '').trim();
const inWindow = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t - NOW > MIN_CLOSE_MS && t - NOW < MAX_CLOSE_MS;
};
const clampProb = (p) => Math.min(99, Math.max(1, Math.round(p)));

async function fetchJson(url, label) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'predicator-market-mirror/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.json();
}

async function fetchPolymarket() {
  // 拉 200 条按 24h 成交量排序的活跃市场，给类别多样性留出余量
  const data = await fetchJson(
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false',
    'polymarket',
  );
  const out = [];
  for (const m of Array.isArray(data) ? data : []) {
    try {
      const outcomes = JSON.parse(m.outcomes ?? '[]');
      const prices = JSON.parse(m.outcomePrices ?? '[]');
      const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(norm(o)));
      if (yesIdx < 0 || prices[yesIdx] == null) continue;
      const prob = Number(prices[yesIdx]) * 100;
      if (!Number.isFinite(prob)) continue;
      if (!inWindow(m.endDate)) continue;
      const volume = Number(m.volume ?? m.volumeNum ?? 0);
      if (volume < 20000) continue; // 太冷清的市场价格没参考价值
      out.push({
        source: 'polymarket',
        sourceId: norm(m.conditionId ?? m.id),
        title: norm(m.question),
        category: norm(m.category ?? ''),
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
        probability: clampProb(prob),
        closesAt: new Date(m.endDate).toISOString(),
        volume,
      });
    } catch { /* 单条畸形跳过 */ }
  }
  return out;
}

/** 从 Polymarket 事件里提取二元市场的通用归一化。 */
function toMarket(m, slug) {
  try {
    const title = norm(m.question);
    // 只要自带对阵双方的"谁赢/平局"类题；比分、让分、进球数盘缺上下文且重复
    if (/^(exact score|spread|total|both teams|first team|clean sheet|over\/under|anytime|correct score)/i.test(title)) return null;
    const outcomes = JSON.parse(m.outcomes ?? '[]');
    const prices = JSON.parse(m.outcomePrices ?? '[]');
    const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(norm(o)));
    if (yesIdx < 0 || prices[yesIdx] == null) return null;
    const prob = Number(prices[yesIdx]) * 100;
    if (!Number.isFinite(prob)) return null;
    if (!inWindow(m.endDate)) return null;
    const volume = Number(m.volume ?? m.volumeNum ?? 0);
    if (volume < 20000) return null;
    return {
      source: 'polymarket',
      sourceId: norm(m.conditionId ?? m.id),
      title,
      category: 'soccer',
      url: slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com',
      probability: clampProb(prob),
      closesAt: new Date(m.endDate).toISOString(),
      volume,
    };
  } catch {
    return null;
  }
}

/** 专项抓足球赛事：tag_slug=soccer + 限定 45 天内结算（避免全是联赛冠军远期盘）。 */
async function fetchPolymarketSoccer() {
  const endMax = new Date(NOW + MAX_CLOSE_MS).toISOString();
  const events = await fetchJson(
    `https://gamma-api.polymarket.com/events?tag_slug=soccer&closed=false&limit=40&order=volume24hr&ascending=false&end_date_max=${encodeURIComponent(endMax)}`,
    'polymarket-soccer',
  );
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    for (const m of e.markets ?? []) {
      const item = toMarket(m, e.slug);
      if (item) out.push(item);
    }
  }
  return out;
}

async function fetchMetaculus() {
  const data = await fetchJson(
    'https://www.metaculus.com/api/posts/?statuses=open&order_by=-activity&limit=60',
    'metaculus',
  );
  const out = [];
  for (const p of data?.results ?? []) {
    try {
      if (p.question?.type !== 'binary') continue;
      // 社区概率在不同 API 版本里位置不同，逐个尝试
      const cp =
        p.question?.aggregations?.recency_weighted?.latest?.centers?.[0] ??
        p.question?.community_prediction?.full?.q2 ??
        null;
      if (cp == null || !Number.isFinite(Number(cp))) continue;
      const closeIso = p.scheduled_close_time ?? p.question?.scheduled_close_time;
      if (!inWindow(closeIso)) continue;
      out.push({
        source: 'metaculus',
        sourceId: String(p.id),
        title: norm(p.title),
        category: '',
        url: `https://www.metaculus.com/questions/${p.id}/`,
        probability: clampProb(Number(cp) * 100),
        closesAt: new Date(closeIso).toISOString(),
        volume: Number(p.nr_forecasters ?? p.forecasters_count ?? 0),
      });
    } catch { /* 单条畸形跳过 */ }
  }
  return out;
}

const results = [];
const errors = [];
for (const [name, fn] of [
  ['polymarket', fetchPolymarket],
  ['polymarket-soccer', fetchPolymarketSoccer],
  ['metaculus', fetchMetaculus],
]) {
  try {
    const items = await fn();
    console.log(`${name}: ${items.length} 条可用`);
    results.push(...items);
  } catch (err) {
    console.error(`${name} 抓取失败: ${err.message}`);
    errors.push(name);
  }
}

// 按 source:sourceId 去重（热门榜和足球专项可能重叠）
const seen = new Set();
const deduped = results.filter((q) => {
  const key = `${q.source}:${q.sourceId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

deduped.sort((a, b) => b.volume - a.volume);
const payload = {
  fetchedAt: new Date(NOW).toISOString(),
  failedSources: errors,
  questions: deduped.slice(0, 140),
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/questions.json', JSON.stringify(payload, null, 2));
console.log(`写入 data/questions.json，共 ${payload.questions.length} 条`);
if (results.length === 0) process.exit(1);

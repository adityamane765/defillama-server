import { readRouteData } from "../cache/file-cache";
import { cache } from "../cache";
import { craftProtocolV2 } from "../utils/craftProtocolV2";
import { craftParentProtocolV2 } from "../utils/craftParentProtocolV2";
import sluggify from "../../utils/sluggify";
import { AdapterType, AdaptorRecordType } from "../../adaptors/data/types";

const MAX_PROTOCOLS = 10;
const MAX_METRICS = 5;

const TVL_METRICS = new Set(["tvl"]);

const DIMENSION_METRIC_MAP: Record<string, { adapterType: AdapterType; recordType: AdaptorRecordType }> = {
  fees: { adapterType: AdapterType.FEES, recordType: AdaptorRecordType.dailyFees },
  revenue: { adapterType: AdapterType.FEES, recordType: AdaptorRecordType.dailyRevenue },
  volume: { adapterType: AdapterType.DEXS, recordType: AdaptorRecordType.dailyVolume },
  "derivatives-volume": { adapterType: AdapterType.DERIVATIVES, recordType: AdaptorRecordType.dailyVolume },
  "active-users": { adapterType: AdapterType.ACTIVE_USERS, recordType: AdaptorRecordType.dailyActiveUsers },
  "open-interest": { adapterType: AdapterType.OPEN_INTEREST, recordType: AdaptorRecordType.openInterestAtEnd },
};

const ALLOWED_METRICS = new Set([...TVL_METRICS, ...Object.keys(DIMENSION_METRIC_MAP)]);

const SECONDS_PER_DAY = 86400;
const AGGREGATION_WINDOWS: Record<string, number> = {
  daily: SECONDS_PER_DAY,
  weekly: 7 * SECONDS_PER_DAY,
  monthly: 30 * SECONDS_PER_DAY,
};

type Series = [number, number][];

async function getTvlSeries(slug: string): Promise<Series | null> {
  try {
    const data = await readRouteData(`charts/${slug}`, { skipErrorLog: true });
    if (!Array.isArray(data)) return null;
    return data.map(([date, tvl]: any) => [Number(date), Number(tvl)]);
  } catch {
    return null;
  }
}

async function getTvlSeriesFromProtocolData(slug: string): Promise<Series | null> {
  try {
    const protocolData = (cache as any)["protocolSlugMap"][slug];
    if (!protocolData) {
      const parentProtocol = (cache as any)["parentProtocolSlugMap"][slug];
      if (!parentProtocol) return null;
      const full = await craftParentProtocolV2({ parentProtocol, skipAggregatedTvl: false, restrictResponseSize: false, feMini: false });
      return extractTvlSeries(full);
    }
    const full = await craftProtocolV2({ protocolData, useNewChainNames: true, skipAggregatedTvl: false, restrictResponseSize: false, feMini: false });
    return extractTvlSeries(full);
  } catch {
    return null;
  }
}

function extractTvlSeries(protocolDataFull: any): Series {
  const itemByDates: Record<number, number> = {};
  for (const [chainAndKey, chainData] of Object.entries(protocolDataFull.chainTvls ?? {})) {
    const parts = (chainAndKey as string).split("-");
    const keyFilter = parts[1] ?? "tvl";
    if (keyFilter !== "tvl") continue;
    for (const tvlItem of Object.values((chainData as any).tvl ?? {})) {
      const date = Number((tvlItem as any).date);
      itemByDates[date] = (itemByDates[date] ?? 0) + Number((tvlItem as any).totalLiquidityUSD);
    }
  }
  return Object.entries(itemByDates).map(([date, v]) => [Number(date), v]);
}

async function getDimensionSeries(slug: string, adapterType: AdapterType, recordType: AdaptorRecordType): Promise<Series | null> {
  try {
    const routeFile = `dimensions/${adapterType}/${recordType}-protocol/${slug}chart`;
    const data = await readRouteData(routeFile, { skipErrorLog: true });
    if (!data) return null;
    const chart: any[] = data.totalDataChart ?? data.chart ?? [];
    if (!Array.isArray(chart)) return null;
    return chart.map(([date, val]: any) => [Number(date), Number(val)]);
  } catch {
    return null;
  }
}

function applyTimeFilter(series: Series, from?: number, to?: number): Series {
  if (!from && !to) return series;
  return series.filter(([ts]) => (!from || ts >= from) && (!to || ts <= to));
}

function aggregate(series: Series, windowSeconds: number): Series {
  if (windowSeconds <= SECONDS_PER_DAY) return series;
  const buckets: Record<number, { sum: number; count: number }> = {};
  for (const [ts, val] of series) {
    const bucket = Math.floor(ts / windowSeconds) * windowSeconds;
    if (!buckets[bucket]) buckets[bucket] = { sum: 0, count: 0 };
    buckets[bucket].sum += val;
    buckets[bucket].count += 1;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([ts, { sum, count }]) => [Number(ts), sum / count]);
}

function computeSummary(series: Series): { latest: number | null; change7d: number | null; change30d: number | null } {
  if (series.length === 0) return { latest: null, change7d: null, change30d: null };
  const sorted = [...series].sort(([a], [b]) => a - b);
  const latest = sorted[sorted.length - 1][1];
  const now = sorted[sorted.length - 1][0];

  function findClosest(targetTs: number): number | null {
    const tolerance = 2 * SECONDS_PER_DAY;
    let best: [number, number] | null = null;
    for (const [ts, val] of sorted) {
      if (Math.abs(ts - targetTs) <= tolerance) {
        if (!best || Math.abs(ts - targetTs) < Math.abs(best[0] - targetTs)) best = [ts, val];
      }
    }
    return best ? best[1] : null;
  }

  const val7d = findClosest(now - 7 * SECONDS_PER_DAY);
  const val30d = findClosest(now - 30 * SECONDS_PER_DAY);

  return {
    latest,
    change7d: val7d !== null && val7d !== 0 ? ((latest - val7d) / Math.abs(val7d)) * 100 : null,
    change30d: val30d !== null && val30d !== 0 ? ((latest - val30d) / Math.abs(val30d)) * 100 : null,
  };
}

function buildWideFormat(slugs: string[], seriesMap: Record<string, Series>): [number, ...number[]][] {
  const allTimestamps = new Set<number>();
  for (const series of Object.values(seriesMap)) {
    for (const [ts] of series) allTimestamps.add(ts);
  }
  const valueBySlug: Record<string, Record<number, number>> = {};
  for (const slug of slugs) {
    valueBySlug[slug] = {};
    for (const [ts, val] of seriesMap[slug] ?? []) valueBySlug[slug][ts] = val;
  }
  return [...allTimestamps]
    .sort((a, b) => a - b)
    .map((ts) => [ts, ...slugs.map((slug) => valueBySlug[slug][ts] ?? 0)] as [number, ...number[]]);
}

export async function getCompareProtocols(req: any, res: any) {
  const {
    protocols: protocolsParam,
    metrics: metricsParam,
    from: fromParam,
    to: toParam,
    aggregate: aggregateParam,
    format,
    category: categoryParam,
  } = req.query_parameters;

  if (!metricsParam) return res.status(400).json({ error: "metrics parameter is required" });

  const metrics = metricsParam.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
  if (metrics.length === 0) return res.status(400).json({ error: "at least one metric is required" });
  if (metrics.length > MAX_METRICS) return res.status(400).json({ error: `max ${MAX_METRICS} metrics allowed` });

  const invalidMetrics = metrics.filter((m: string) => !ALLOWED_METRICS.has(m));
  if (invalidMetrics.length > 0)
    return res.status(400).json({ error: `unsupported metrics: ${invalidMetrics.join(", ")}. Allowed: ${[...ALLOWED_METRICS].join(", ")}` });

  const from = fromParam ? Number(fromParam) : undefined;
  const to = toParam ? Number(toParam) : undefined;
  if (fromParam && isNaN(from!)) return res.status(400).json({ error: "from must be a unix timestamp" });
  if (toParam && isNaN(to!)) return res.status(400).json({ error: "to must be a unix timestamp" });

  const windowSeconds = aggregateParam ? AGGREGATION_WINDOWS[aggregateParam as string] : SECONDS_PER_DAY;
  if (aggregateParam && !windowSeconds)
    return res.status(400).json({ error: `unsupported aggregate: ${aggregateParam}. Allowed: ${Object.keys(AGGREGATION_WINDOWS).join(", ")}` });

  const useWideFormat = format === "wide";
  const includeSummary = format !== "wide";

  let protocolSlugs: string[] = [];

  if (categoryParam) {
    const allProtocols: any[] = Object.values((cache as any)["protocolSlugMap"] ?? {});
    protocolSlugs = allProtocols
      .filter((p: any) => p.category?.toLowerCase() === (categoryParam as string).toLowerCase())
      .map((p: any) => p.slug ?? sluggify({ name: p.name } as any))
      .slice(0, MAX_PROTOCOLS);
    if (protocolSlugs.length === 0)
      return res.status(404).json({ error: `no protocols found for category: ${categoryParam}` });
  } else {
    if (!protocolsParam) return res.status(400).json({ error: "protocols or category parameter is required" });
    protocolSlugs = protocolsParam.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    if (protocolSlugs.length === 0) return res.status(400).json({ error: "at least one protocol is required" });
    if (protocolSlugs.length > MAX_PROTOCOLS) return res.status(400).json({ error: `max ${MAX_PROTOCOLS} protocols allowed` });
  }

  const protocolMeta = protocolSlugs.map((slug: string) => {
    const normalized = sluggify({ name: slug } as any);
    const protocol = (cache as any)["protocolSlugMap"]?.[normalized];
    const parent = (cache as any)["parentProtocolSlugMap"]?.[normalized];
    if (protocol) return { slug: normalized, name: protocol.name, category: protocol.category ?? null, found: true };
    if (parent) return { slug: normalized, name: parent.name, category: null, found: true };
    return { slug: normalized, name: slug, category: null, found: false };
  });

  const missing: string[] = [];

  const tasks = protocolMeta.flatMap(({ slug, found }) =>
    metrics.map(async (metric: string) => {
      if (!found) {
        missing.push(`${slug}:${metric}`);
        return { slug, metric, series: null as Series | null };
      }
      let series: Series | null = null;
      if (TVL_METRICS.has(metric)) {
        series = await getTvlSeries(slug) ?? await getTvlSeriesFromProtocolData(slug);
      } else {
        const dim = DIMENSION_METRIC_MAP[metric];
        series = await getDimensionSeries(slug, dim.adapterType, dim.recordType);
      }
      if (!series) {
        missing.push(`${slug}:${metric}`);
        return { slug, metric, series: null as Series | null };
      }
      series = applyTimeFilter(series, from, to);
      series = aggregate(series, windowSeconds);
      return { slug, metric, series };
    })
  );

  const results = await Promise.all(tasks);

  const seriesMap: Record<string, Record<string, Series>> = {};
  const summaryMap: Record<string, Record<string, ReturnType<typeof computeSummary>>> = {};
  for (const metric of metrics) {
    seriesMap[metric] = {};
    summaryMap[metric] = {};
  }

  for (const { slug, metric, series } of results) {
    if (series !== null) {
      seriesMap[metric][slug] = series;
      if (includeSummary) summaryMap[metric][slug] = computeSummary(series);
    }
  }

  const slugs = protocolMeta.map((p) => p.slug);
  const finalSeries: Record<string, any> = {};
  for (const metric of metrics) {
    if (useWideFormat) {
      finalSeries[metric] = {
        columns: ["timestamp", ...slugs],
        data: buildWideFormat(slugs, seriesMap[metric]),
      };
    } else {
      finalSeries[metric] = seriesMap[metric];
    }
  }

  return res.status(200).json({
    protocols: protocolMeta.map(({ slug, name, category }) => ({ slug, name, category })),
    metrics,
    series: finalSeries,
    ...(includeSummary ? { summary: summaryMap } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  });
}

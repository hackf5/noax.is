import { z } from "zod";

const DAY = 86_400_000;
export const MAX_REPORT_DAYS = 30;
export const DEFAULT_REPORT_DAYS = 7;
export const TRAFFIC_REPORT_TOOL = "get_traffic_report";

const pageFilter = `datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host,
  requestSource: "eyeball", clientRequestHTTPMethodName: "GET", edgeResponseStatus: 200,
  edgeResponseContentTypeName: "html", OR: [{ clientRequestPath: "/" }, { clientRequestPath_like: "/posts/%" }]`;
const breakdowns = {
  pages: "clientRequestPath",
  devices: "clientDeviceType",
  browsers: "userAgentBrowser",
  operating_systems: "userAgentOS",
  countries: "clientCountryName",
} as const;

const query = `query TrafficReport($zone: string, $host: string, $start: Time, $end: Time) {
  viewer { zones(filter: { zoneTag: $zone }) {
    daily: httpRequestsAdaptiveGroups(limit: ${MAX_REPORT_DAYS}, orderBy: [date_ASC], filter: { ${pageFilter} }) {
      count dimensions { value: date }
    }
    ${Object.entries(breakdowns).map(([name, field]) => `${name}: httpRequestsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { ${pageFilter} }) {
      count dimensions { value: ${field} }
    }`).join("\n")}
  } }
}`;

const requests = z.number().int().nonnegative();
const labeledRequests = z.object({ label: z.string(), estimated_requests: requests });
export const trafficReportSchema = z.object({
  hostname: z.string(),
  start_date: z.iso.date(),
  end_date_exclusive: z.iso.date(),
  estimated_total: requests,
  daily: z.array(z.object({ date: z.iso.date(), estimated_requests: requests })),
  pages: z.array(labeledRequests),
  devices: z.array(labeledRequests),
  browsers: z.array(labeledRequests),
  operating_systems: z.array(labeledRequests),
  countries: z.array(labeledRequests),
});

const group = z.object({ count: requests, dimensions: z.object({ value: z.string().nullable() }) });
const reports = z.object({
  daily: z.array(group.extend({ dimensions: z.object({ value: z.iso.date() }) })),
  pages: z.array(group), devices: z.array(group), browsers: z.array(group),
  operating_systems: z.array(group), countries: z.array(group),
});
const cloudflareResult = z.object({
  errors: z.array(z.unknown()).nullish(),
  data: z.object({ viewer: z.object({ zones: z.tuple([reports]) }) }).nullish(),
});

export class AnalyticsError extends Error {
  readonly code = "analytics_unavailable";
}

export async function getTrafficReport(
  { zone, hostname, token }: { zone: string; hostname: string; token: string },
  days = DEFAULT_REPORT_DAYS,
  now = new Date(),
): Promise<z.infer<typeof trafficReportSchema>> {
  const end = new Date(now.getTime());
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - days * DAY);
  let response: Response;
  try {
    response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ query, variables: { zone, host: hostname, start: start.toISOString(), end: end.toISOString() } }),
    });
  } catch {
    throw new AnalyticsError("Could not connect to Cloudflare Analytics. Try the report again.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new AnalyticsError("Cloudflare rejected the analytics credential. Check Zone → Analytics → Read for this zone.");
  }
  if (!response.ok) throw new AnalyticsError(`Cloudflare Analytics returned HTTP ${response.status}.`);
  const result = cloudflareResult.safeParse(await response.json().catch(() => undefined));
  if (!result.success) throw new AnalyticsError("Cloudflare Analytics returned an invalid report.");
  if (result.data.errors?.length || !result.data.data) {
    throw new AnalyticsError("Cloudflare could not produce this report. Check the blog's zone and Analytics Read scope.");
  }

  const groups = result.data.data.viewer.zones[0];
  const counts = new Map(groups.daily.map(({ count, dimensions }) => [dimensions.value, count]));
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY).toISOString().slice(0, 10);
    return { date, estimated_requests: counts.get(date) ?? 0 };
  });
  const labeled = (rows: z.infer<typeof group>[]) => rows.map(({ count, dimensions }) => ({
    label: dimensions.value || "Unknown", estimated_requests: count,
  }));
  return {
    hostname,
    start_date: start.toISOString().slice(0, 10),
    end_date_exclusive: end.toISOString().slice(0, 10),
    estimated_total: daily.reduce((total, day) => total + day.estimated_requests, 0),
    daily,
    pages: labeled(groups.pages),
    devices: labeled(groups.devices),
    browsers: labeled(groups.browsers),
    operating_systems: labeled(groups.operating_systems),
    countries: labeled(groups.countries),
  };
}

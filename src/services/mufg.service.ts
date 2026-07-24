import { XMLParser } from "fast-xml-parser";
import { redisCache } from "../utils/cache.helper.js";

interface MufgIpoItem {
  companyId: string;
  companyName: string;
}

const MUFG_CACHE_KEY = "mufg_ipos";
const MUFG_CACHE_TTL = 60 * 60 * 3; // 3 hours

export async function getCachedMufgIpoList(): Promise<MufgIpoItem[]> {
  const cached = (await redisCache.get(MUFG_CACHE_KEY)) as MufgIpoItem[] | null;

  if (cached) {
    return cached;
  }

  return await refreshMufgIpoList();
}

export async function refreshMufgIpoList(): Promise<MufgIpoItem[]> {
  const response = await fetch(
    "https://in.mpms.mufg.com/Initial_Offer/IPO.aspx/GetDetails",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
      },
    }
  );

  const body = await response.text();
  const parsed = JSON.parse(body);
  const xml = parsed.d;

  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });

  const parsedXml = parser.parse(xml);
  const rows = parsedXml?.NewDataSet?.Table || [];

  const list: MufgIpoItem[] = Array.isArray(rows)
    ? rows.map((row: any) => ({
        companyId: String(
          row.company_id ||
            row.companyId ||
            row.CompanyId ||
            ""
        ).trim(),
        companyName: String(
          row.companyname ||
            row.companyName ||
            row.CompanyName ||
            ""
        ).trim(),
      }))
    : [];

  await redisCache.set(MUFG_CACHE_KEY, list, MUFG_CACHE_TTL);

  return list;
}

export async function generateMufgToken(): Promise<string> {
  const res = await fetch(
    "https://in.mpms.mufg.com/Initial_Offer/IPO.aspx/generateToken",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
      },
    }
  );

  const body = await res.text();
  const parsed = JSON.parse(body);

  return String(parsed.d || "");
}

export async function checkMufgAllotmentStatus(
  companyId: string,
  pan: string
) {
  const token = await generateMufgToken();

  const response = await fetch(
    "https://in.mpms.mufg.com/Initial_Offer/IPO.aspx/SearchOnPan",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
      },
      body: JSON.stringify({
        clientid: companyId,
        PAN: pan,
        IFSC: "",
        CHKVAL: "1",
        token,
      }),
    }
  );

  const body = await response.text();
  console.log("[MUFG RAW RESPONSE]", body);

  const parsed = JSON.parse(body);
  const xml = parsed.d || "";

  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });

  const parsedXml = parser.parse(xml);

  return {
    provider: "mufg",
    companyId,
    pan,
    response: parsedXml,
  };
}
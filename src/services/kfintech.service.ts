import { chromium } from "playwright";
import { redisCache } from "../utils/cache.helper.ts";

interface KfintechIpoItem {
  clientId: string;
  name: string;
}

const KFINTECH_CACHE_KEY = "kfintech_ipos";
const KFINTECH_CACHE_TTL = 60 * 60 * 3; // 3 hours

export async function getCachedKfintechIpoList(): Promise<KfintechIpoItem[]> {
  const cached = redisCache.get(KFINTECH_CACHE_KEY) as KfintechIpoItem[] | null;
  if (cached) return cached;
  const list = await refreshKfintechIpoList();
  return list;
}

export async function refreshKfintechIpoList(): Promise<KfintechIpoItem[]> {
  let browser: any = null;
  let page: any = null;
  console.log('[KFINTECH] refreshKfintechIpoList start');

  // Try a lightweight HTML fetch+regex first (avoids Playwright runtime issues)
  let list: { clientId: string; name: string }[] = [];
  const seen = new Set();
  try {
    const resp = await fetch("https://ipostatus.kfintech.com/", {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    const html = await resp.text();

      // Attempt to locate the main JS bundle that may contain an inlined IPO array (rf)
      const mainMatch = html.match(/<script[^>]*src=["']([^"']*main\.[^"']+\.js)["'][^>]*>/i);
      if (mainMatch && mainMatch[1]) {
        try {
          const rel = mainMatch[1];
          const jsUrl = rel.startsWith('http')
            ? rel
            : rel.startsWith('/')
            ? `https://ipostatus.kfintech.com${rel}`
            : `https://ipostatus.kfintech.com/${rel.replace(/^\.\//, '')}`;
          console.log('[KFINTECH] attempting bundle fetch', jsUrl);
          const jsResp = await fetch(jsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36', 'Accept': 'application/javascript, text/javascript, */*;q=0.1' } });
          if (jsResp.ok) {
            const jsText = await jsResp.text();
            // look for rf = [...] or var rf=[...]
            const arrMatch = jsText.match(/\brf\s*=\s*(\[[\s\S]*?\])\s*[,;]/);
              if (arrMatch && arrMatch[1]) {
                console.log('[KFINTECH] found rf array via regex');
              try {
                const parsed = JSON.parse(arrMatch[1]);
                if (Array.isArray(parsed)) {
                  parsed.forEach((item: any) => {
                    if (item && item.clientId && item.name) {
                      const cid = String(item.clientId).trim();
                      const name = String(item.name).trim();
                      if (cid && name && !seen.has(cid + '::' + name)) {
                        seen.add(cid + '::' + name);
                        list.push({ clientId: cid, name });
                      }
                    }
                  });
                }
              } catch (e) {
                // ignore JSON parse issues
              }
            } else {
              // fallback: locate first occurrence of "clientId" and extract surrounding array
              const idx = jsText.indexOf('"clientId"');
              if (idx !== -1) {
                // find opening '[' before idx
                const openIdx = jsText.lastIndexOf('[', idx);
                if (openIdx !== -1) {
                  // find matching closing bracket
                  let depth = 0;
                  let closeIdx = -1;
                  for (let i = openIdx; i < jsText.length; i++) {
                    const ch = jsText[i];
                    if (ch === '[') depth++;
                    else if (ch === ']') {
                      depth--;
                      if (depth === 0) { closeIdx = i; break; }
                    }
                  }
                  if (closeIdx !== -1) {
                    const arrText = jsText.slice(openIdx, closeIdx + 1);
                    try {
                      const parsed2 = JSON.parse(arrText);
                      if (Array.isArray(parsed2)) {
                        parsed2.forEach((item: any) => {
                          if (item && item.clientId && item.name) {
                            const cid = String(item.clientId).trim();
                            const name = String(item.name).trim();
                            if (cid && name && !seen.has(cid + '::' + name)) {
                              seen.add(cid + '::' + name);
                              list.push({ clientId: cid, name });
                            }
                          }
                        });
                      }
                    } catch (e) {
                      // ignore
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          // ignore main bundle fetch errors
        }
      }

    

    // 1) data-clientid="..." attributes
    const attrRe = /data-clientid=["']?(\d+)["']?[^>]*>([^<]*)</g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(html))) {
      const cid = m[1];
      const name = (m[2] || '').trim();
      if (cid && name && !seen.has(cid + '::' + name)) {
        seen.add(cid + '::' + name);
        list.push({ clientId: cid, name });
      }
    }

    // 2) table rows
    const rowRe = /<tr[^>]*>\s*<td[^>]*>\s*(\d{5,})\s*<\/td>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/g;
    while ((m = rowRe.exec(html))) {
      const cid = m[1];
      const name = (m[2] || '').trim();
      if (cid && name && !seen.has(cid + '::' + name)) {
        seen.add(cid + '::' + name);
        list.push({ clientId: cid, name });
      }
    }

    // 3) JSON blobs inside scripts
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g;
    while ((m = scriptRe.exec(html))) {
      const txt = m[1];
      const jsonMatch = txt.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (!jsonMatch) continue;
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const stack = [parsed];
        while (stack.length) {
          const node = stack.pop();
          if (!node) continue;
          if (Array.isArray(node)) {
            node.forEach((n: any) => stack.push(n));
            continue;
          }
          if (typeof node === 'object') {
            if ((node.clientId || node.clientid) && (node.name || node.company)) {
              const cid = String(node.clientId || node.clientid);
              const name = String(node.name || node.company || '').trim();
              if (cid && name && !seen.has(cid + '::' + name)) {
                seen.add(cid + '::' + name);
                list.push({ clientId: cid, name });
              }
            }
            Object.values(node).forEach((v) => { if (typeof v === 'object') stack.push(v); });
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    }
  } catch (err) {
    // fall back to Playwright DOM scraping if direct fetch fails
      try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      // capture JSON responses to look for clientId payloads
      page.on('response', async (resp) => {
        try {
          const ct = resp.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const text = await resp.text();
            if (text && text.includes('clientId') || text.includes('clientid') || text.includes('client_id')) {
              try {
                const parsed = JSON.parse(text);
                console.log('[KFINTECH-RESP]', resp.url(), JSON.stringify(parsed).slice(0,200));
              } catch (e) {
                console.log('[KFINTECH-RESP-RAW]', resp.url(), text.slice(0,200));
              }
            }
          }
        } catch (e) {}
      });
      page.on("console", async (msg: any) => {
        const vals = await Promise.all(
          msg.args().map((a: any) => a.jsonValue().catch(() => a.toString()))
        );
        console.log(...vals);
      });
      await page.goto("https://ipostatus.kfintech.com/", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(8000);
      try {
        const scraped = await page.evaluate(function () {
          try {
            var results = [];
            var nodes = document.querySelectorAll('[data-clientid], [data-client-id], [clientid], [client-id]');
            nodes.forEach(function (n) {
              try {
                var el = n;
                var cid = (el.getAttribute && (el.getAttribute('data-clientid') || el.getAttribute('data-client-id') || el.getAttribute('clientid') || el.getAttribute('client-id'))) || ((el as HTMLElement & { dataset?: { clientid?: string; clientId?: string } }).dataset && ((el as HTMLElement & { dataset?: { clientid?: string; clientId?: string } }).dataset.clientid || (el as HTMLElement & { dataset?: { clientid?: string; clientId?: string } }).dataset.clientId));
                var name = (el.textContent && el.textContent.trim()) || '';
                if (cid && name) results.push({ clientId: cid, name: name });
              } catch (e) {}
            });
            return results;
          } catch (e) {
            return [];
          }
        });
        list = scraped || [];
      } catch (e) {
        console.error('GET /api/allotment/kfintech/list page.evaluate error', e);
        list = [];
      }
    } catch (e) {
      console.error('GET /api/allotment/kfintech/list Playwright fallback failed', e);
      list = [];
    }
  }
  // If fetch-based parsing yielded no items but the HTML looks like an SPA shell, run Playwright to execute JS
  if (list.length === 0) {
    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      page.on('response', async (resp) => {
        try {
          const ct = resp.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const text = await resp.text();
            if (text && (text.includes('clientId') || text.includes('clientid') || text.includes('client_id'))) {
              try {
                const parsed = JSON.parse(text);
                console.log('[KFINTECH-RESP]', resp.url(), JSON.stringify(parsed).slice(0,200));
              } catch (e) {
                console.log('[KFINTECH-RESP-RAW]', resp.url(), text.slice(0,200));
              }
            }
          }
        } catch (e) {}
      });
      await page.goto("https://ipostatus.kfintech.com/", { waitUntil: "networkidle" });
      await page.waitForTimeout(5000);
      const scraped = await page.evaluate(function () {
        try {
          var results = [];
          var nodes = document.querySelectorAll('[data-clientid], [data-client-id], [clientid], [client-id]');
          nodes.forEach(function (n) {
            try {
              var el = n as HTMLElement & { dataset?: { clientid?: string; clientId?: string } };
              var cid = (el.getAttribute && (el.getAttribute('data-clientid') || el.getAttribute('data-client-id') || el.getAttribute('clientid') || el.getAttribute('client-id'))) || (el.dataset && (el.dataset.clientid || el.dataset.clientId));
              var name = (el.textContent && el.textContent.trim()) || '';
              if (cid && name) results.push({ clientId: cid, name: name });
            } catch (e) {}
          });
          return results;
        } catch (e) { return []; }
      });
      if (scraped && scraped.length) list = scraped;
    } catch (e) {
      console.error('Playwright final fallback failed', e);
    }
  }
  if (page) {
    try { await page.close(); } catch (e) {}
  }
  if (browser) {
    try { await browser.close(); } catch (e) {}
  }
  redisCache.set(KFINTECH_CACHE_KEY, list, KFINTECH_CACHE_TTL);
  return list;
}

export async function checkKfintechAllotmentStatus(clientId: string, pan: string) {
  const response = await fetch("https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query?type=pan", {
    method: "GET",
    headers: {
      client_id: clientId,
      reqparam: pan,
    },
  });

  const body = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    parsed = { raw: body };
  }

  return { provider: "kfintech", clientId, pan, response: parsed };
}

import axios from "axios";

// Exchange rates, for reconciling a group tab that ended up in two currencies.
//
// Source is Frankfurter (ECB reference rates): free, no key, and a source anyone
// can check. ECB publishes on business days only, so a weekend or holiday returns
// the last working day's rate — the response carries that date and we pass it on,
// because "at Friday's rate" is a materially different statement from "at today's".

const API = "https://api.frankfurter.dev/v1";

// Rates move once a day at most, so a short cache keeps a burst of conversions
// from hammering a free service. Per-process: a cold instance just refetches.
const cache = new Map<string, { rate: number; date: string; at: number }>();
const CACHE_MS = 60 * 60 * 1000;

export async function getRate(from: string, to: string): Promise<{ rate: number; date: string } | null> {
    const a = String(from || "").toUpperCase(), b = String(to || "").toUpperCase();
    if (!a || !b) return null;
    if (a === b) return { rate: 1, date: "" };

    const key = `${a}->${b}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { rate: hit.rate, date: hit.date };

    try {
        const res = await axios.get(`${API}/latest`, { params: { base: a, symbols: b }, timeout: 8000 });
        const rate = res.data?.rates?.[b];
        const date = res.data?.date || "";
        if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
            console.error(`No usable ${key} rate in the response:`, JSON.stringify(res.data).slice(0, 200));
            return null;
        }
        cache.set(key, { rate, date, at: Date.now() });
        return { rate, date };
    } catch (error: any) {
        // Returning null lets the caller say "I couldn't get a rate" instead of
        // silently converting at a number it made up.
        console.error(`Exchange rate ${key} failed:`, error.response?.data || error.message || error);
        return null;
    }
}

export default { getRate };

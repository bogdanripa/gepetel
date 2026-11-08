// Gepetel for Chrome's id (the fork in chrome/). The Chrome Web Store build's
// is the default; a Mac running the unpacked development build says so in
// agent.json ("chrome_extension_id": DEV_EXTENSION_ID), and an environment
// variable still overrides both for tests.
export const STORE_EXTENSION_ID = "fegpkhbbnkdhfkjmmpcjhekmpembllbk";
export const DEV_EXTENSION_ID = "djcknkphaapdnflmmomgfcleihhckgdf";
export const STORE_URL = `https://chromewebstore.google.com/detail/gepetel-for-chrome/${STORE_EXTENSION_ID}`;

export function extensionId(config?: { chrome_extension_id?: string } | null): string {
    const configured = String(config?.chrome_extension_id || "");
    return process.env.GEPETEL_EXTENSION_ID || (/^[a-p]{32}$/.test(configured) ? configured : STORE_EXTENSION_ID);
}

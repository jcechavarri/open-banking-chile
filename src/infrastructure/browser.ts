import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { DebugLog, findChrome, saveScreenshot, toSystemUserAgent } from "../utils.js";

export interface BrowserOptions {
  chromePath?: string;
  headful?: boolean;
  /** Force headless mode off (e.g., Banco Estado TLS fingerprinting) */
  forceHeadful?: boolean;
  extraArgs?: string[];
  viewport?: { width: number; height: number };
  /** Callback invocado en cada línea de debug en tiempo real */
  onDebug?: (line: string) => void;
}

export interface BrowserSession {
  browser: Browser;
  page: Page;
  debugLog: string[];
  /** Save a named screenshot (noop if screenshots disabled) */
  screenshot: (page: Page, name: string) => Promise<void>;
}

const DEFAULT_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1280,900",
  "--disable-blink-features=AutomationControlled",
];

/**
 * Sends the host system's real User-Agent instead of a hardcoded one.
 * Chrome already reports the real OS and version; only headless mode needs
 * fixing ("HeadlessChrome"). Overriding the UA without metadata drops the
 * Sec-CH-UA client hints, so they are read from Chrome itself and re-applied.
 */
async function applySystemUserAgent(browser: Browser, page: Page): Promise<void> {
  const browserUserAgent = await browser.userAgent();
  if (!browserUserAgent.includes("HeadlessChrome/")) return;

  // navigator.userAgentData is only exposed in secure contexts (not about:blank)
  await page.goto("chrome://version");
  const userAgentMetadata = await page.evaluate(() =>
    (navigator as any).userAgentData.getHighEntropyValues([
      "architecture", "bitness", "fullVersionList", "model", "platformVersion", "wow64",
    ]),
  );
  await page.setUserAgent({ userAgent: toSystemUserAgent(browserUserAgent), userAgentMetadata });
}

/**
 * Launches a browser session for scraping.
 *
 * NOTE — Lightpanda (https://lightpanda.io) as a future alternative:
 * Lightpanda is a headless browser written in Zig that uses ~10-20x less memory
 * and runs ~10x faster than Chrome. It supports the Chrome DevTools Protocol (CDP),
 * so swapping would only require changing this function to use puppeteer.connect():
 *
 *   const browser = await puppeteer.connect({
 *     browserWSEndpoint: "ws://127.0.0.1:9222", // Lightpanda serving CDP
 *   });
 *
 * It is NOT integrated yet because (as of early 2026) it is still in beta and has
 * two blockers for banking scrapers:
 *   1. iframe support is incomplete (BCI and Santander rely on iframes)
 *   2. No cookie import/export API (issue #335) — breaks session persistence
 * Worth revisiting once it hits v1.0.
 */
export async function launchBrowser(
  options: BrowserOptions,
  saveScreenshots: boolean,
): Promise<BrowserSession> {
  const { chromePath, headful, forceHeadful, extraArgs, viewport, onDebug } = options;
  const debugLog: string[] = onDebug ? new DebugLog(onDebug) : [];

  // Some banks (e.g. BancoEstado) block headless browsers via TLS fingerprinting
  // and require a visible Chrome window. On Linux this needs a display server.
  if (forceHeadful && process.platform === "linux") {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error(
        "Este banco requiere modo headful (Chrome visible) pero no se detectó display.\n" +
          "  Opciones: exporta DISPLAY=:0, usa una sesión con GUI, o configura Xvfb:\n" +
          "  Xvfb: Xvfb :99 -screen 0 1280x900x24 & export DISPLAY=:99",
      );
    }
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    throw new Error(
      "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n" +
        "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
        "  macOS: brew install --cask google-chrome",
    );
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: forceHeadful ? false : !headful,
    args: [...DEFAULT_ARGS, ...(extraArgs || [])],
  });

  const page = await browser.newPage();
  const vp = viewport || { width: 1280, height: 900 };
  await page.setViewport(vp);
  await applySystemUserAgent(browser, page);

  // Hide automation signals
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const doSave = async (p: Page, name: string) =>
    saveScreenshot(p, name, saveScreenshots, debugLog);

  return { browser, page, debugLog, screenshot: doSave };
}

// Bezoekersmeting met Swetrix.
//
// De meting draait op grondslag "gerechtvaardigd belang" en niet op toestemming:
// er worden geen cookies geplaatst en er wordt niets uit de browseropslag gelezen,
// dus de cookiebepaling (art. 11.7a Telecommunicatiewet) is niet van toepassing.
// Wat daar wel bij hoort is een echte bezwaarmogelijkheid (art. 21 AVG), en die
// staat hier. Let op: het `swetrix_ignore`-mechanisme uit oudere versies van de
// Swetrix-client bestaat niet meer in de huidige `swetrix.js` — de opt-out is
// daarom van ons, niet van hen.
//
// Wie bezwaar heeft gemaakt of Do Not Track / Global Privacy Control aan heeft
// staan, laadt `swetrix.js` helemaal niet. Dat is strenger dan de `respectDNT`-
// optie van Swetrix zelf, die het script wel laadt en pas daarna zwijgt: zo gaat
// er voor deze bezoeker geen enkel verzoek naar een derde partij.

const SWETRIX_PROJECT_ID = "n4xyH2Fb2m2z";
const SWETRIX_SCRIPT_URL = "https://swetrix.org/swetrix.js";
const OPT_OUT_STORAGE_KEY = "woozi.analyticsOptOut";

type SwetrixTracker = { stop: () => void };

type SwetrixGlobal = {
  init: (projectId: string, options?: Record<string, unknown>) => unknown;
  trackViews: () => Promise<SwetrixTracker>;
};

let tracker: SwetrixTracker | null = null;
let scriptLoad: Promise<SwetrixGlobal | null> | null = null;
let running = false;

function swetrixGlobal(): SwetrixGlobal | null {
  const candidate = (window as unknown as { swetrix?: SwetrixGlobal }).swetrix;
  return candidate && typeof candidate.init === "function" ? candidate : null;
}

/** Do Not Track en zijn opvolger Global Privacy Control tellen als bezwaar. */
export function browserSignalsNoTracking(): boolean {
  const nav = window.navigator as Navigator & {
    doNotTrack?: string | null;
    msDoNotTrack?: string | null;
    globalPrivacyControl?: boolean;
  };
  const legacy = (window as unknown as { doNotTrack?: string | null }).doNotTrack;
  return (
    nav.doNotTrack === "1" ||
    nav.msDoNotTrack === "1" ||
    legacy === "1" ||
    nav.globalPrivacyControl === true
  );
}

export function analyticsOptedOut(): boolean {
  try {
    return window.localStorage.getItem(OPT_OUT_STORAGE_KEY) === "1";
  } catch {
    // Zonder werkende opslag valt niet vast te stellen dát er bezwaar is gemaakt.
    // De meting blijft dan aan, maar de knop werkt nog wel voor deze sessie.
    return false;
  }
}

function loadSwetrix(): Promise<SwetrixGlobal | null> {
  scriptLoad ??= new Promise<SwetrixGlobal | null>((resolve) => {
    const script = document.createElement("script");
    script.src = SWETRIX_SCRIPT_URL;
    script.defer = true;
    // Een blokker of een storing bij Swetrix mag de app niet raken: bij een
    // mislukte load meten we gewoon niets.
    script.addEventListener("load", () => resolve(swetrixGlobal()));
    script.addEventListener("error", () => resolve(null));
    document.head.appendChild(script);
  });
  return scriptLoad;
}

export function startAnalytics(): void {
  if (running || analyticsOptedOut() || browserSignalsNoTracking()) {
    return;
  }
  running = true;
  void loadSwetrix().then((swetrix) => {
    if (!running || !swetrix) {
      return;
    }
    swetrix.init(SWETRIX_PROJECT_ID, { respectDNT: true });
    return swetrix.trackViews().then((handle) => {
      if (!running) {
        // Er is bezwaar gemaakt terwijl het script nog laadde.
        handle.stop();
        return;
      }
      tracker = handle;
    });
  });
}

export function stopAnalytics(): void {
  running = false;
  tracker?.stop();
  tracker = null;
}

export function setAnalyticsOptOut(optOut: boolean): void {
  try {
    if (optOut) {
      window.localStorage.setItem(OPT_OUT_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(OPT_OUT_STORAGE_KEY);
    }
  } catch {
    // Opslag geblokkeerd: de keuze geldt dan alleen voor deze sessie.
  }
  if (optOut) {
    stopAnalytics();
  } else {
    startAnalytics();
  }
}

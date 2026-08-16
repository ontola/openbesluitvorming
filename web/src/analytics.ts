// Bezoekersmeting met Swetrix.
//
// De meting draait op grondslag "gerechtvaardigd belang" en niet op toestemming:
// er worden geen cookies geplaatst en er wordt niets uit de browseropslag gelezen,
// dus de cookiebepaling (art. 11.7a Telecommunicatiewet) is niet van toepassing.
// Wat daar wel bij hoort is een echte bezwaarmogelijkheid (art. 21 AVG), en die
// staat hier. Let op: het `swetrix_ignore`-mechanisme uit oudere versies van de
// Swetrix-client bestaat niet meer in de huidige client — de opt-out is
// daarom van ons, niet van hen.
//
// Wie bezwaar heeft gemaakt of Do Not Track / Global Privacy Control aan heeft
// staan, laadt de client helemaal niet. Dat is strenger dan de `respectDNT`-
// optie van Swetrix zelf, die wel laadt en pas daarna zwijgt: zo gaat er voor
// deze bezoeker geen enkel verzoek naar een derde partij.
//
// De client komt uit de npm-dependency en niet van `swetrix.org` — die URL is
// een 302 naar jsDelivr, dus dat waren twee derde partijen per bezoek. Hij zit
// achter een dynamische import zodat hij pas over de lijn komt als er ook
// werkelijk gemeten wordt. `@rrweb/record` (session replay) hangt er wel aan
// maar wordt door de client zelf lui geladen, dus dat kost hier niets.

const SWETRIX_PROJECT_ID = "n4xyH2Fb2m2z";
const OPT_OUT_STORAGE_KEY = "woozi.analyticsOptOut";

type SwetrixTracker = { stop: () => void };

type SwetrixClient = {
  init: (projectId: string, options?: Record<string, unknown>) => unknown;
  trackViews: () => Promise<SwetrixTracker>;
};

let tracker: SwetrixTracker | null = null;
let clientLoad: Promise<SwetrixClient | null> | null = null;
let running = false;

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

function loadSwetrix(): Promise<SwetrixClient | null> {
  // Een mislukte chunk mag de app niet raken: dan meten we gewoon niets.
  clientLoad ??= import("swetrix").then(
    (module) => module as SwetrixClient,
    () => null,
  );
  return clientLoad;
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
        // Er is bezwaar gemaakt terwijl de client nog laadde.
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

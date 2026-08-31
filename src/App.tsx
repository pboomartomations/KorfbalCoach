import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

// --- Herbruikbare Button component -----------------------------------------
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-xl font-medium transition active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-2";
  const sizes = {
    sm: "px-2 py-1 text-sm",
    md: "px-3 py-2 text-base",
  } as const;
  const variants = {
    primary:
      "bg-blue-600 text-white hover:bg-blue-700 border border-transparent focus:ring-blue-600",
    secondary:
      "bg-white text-gray-900 border border-gray-300 hover:bg-gray-50 focus:ring-gray-300",
    ghost:
      "border border-transparent text-gray-700 hover:bg-gray-100 focus:ring-gray-300",
    danger:
      "bg-red-600 text-white hover:bg-red-700 border border-transparent focus:ring-red-600",
  } as const;

  const cls = `${base} ${sizes[size]} ${variants[variant]} ${className}`;
  return <button className={cls} {...props} />;
}

// =============================================================
// KorbIQ – volledige TSX app (tabs + vakindeling + wedstrijd)
// =============================================================
// - Sanitizer voor oude localStorage → voorkomt NaN (halfMinuten etc.)
// - Wissels worden gelogd (Wissel in/uit, positie 1..4)
// - Kans(aanvallend)+Gescoord ⇒ Thuis +1; Gemis(verdedigend)+Doorgelaten ⇒ Uit +1
// - Countdown zichtbaar; intern loopt verstreken tijd op
// - Duur instelbaar met −/+ (1..60), disable tijdens lopen
// - Log toont Verstreken, Resterend, Wedstrijdminuut, Vak, Soort, Reden, Positie, Speler
// - CSV export, Log leegmaken, Reset alles (incl. localStorage)
// =============================================================

// --- Helpers ---------------------------------------------------------------
const GESLACHTEN: readonly ["Dame", "Heer"] = ["Dame", "Heer"];
const TEGENSTANDER_ID = "__tegenstander__";

const TEAM_LABELS: Record<"thuis" | "uit", string> = {
  thuis: "Korbis",
  uit: "Tegenstander",
};

type FieldEvent = {
  id: string;
  vak: VakSide;
  x: number; // 0–100
  y: number; // 0–100
  tijdSeconden: number;
  attackId?: string;
  markerGroup: number;

  actie?: "schot" | "doorloop" | "strafworp" | "vrije";
  resultaat?: "raak" | "mis" | "korf" | "verdedigd";
};


type ShotZone = "Korte kans" | "Afstandsschot" | "Ver afstandsschot";

// Centrale schotzone-helper: gebruikt door zowel live coachsignalen als Insights.
const getShotZone = (ev: FieldEvent): ShotZone => {
  const leftEllipse =
    Math.pow((ev.x - 30.2) / 12.5, 2) +
    Math.pow((ev.y - 50.0) / 13.0, 2);

  const rightEllipse =
    Math.pow((ev.x - 46.1) / 13.9, 2) +
    Math.pow((ev.y - 50.0) / 13.0, 2);

  const zoneDistance = Math.sqrt(Math.min(leftEllipse, rightEllipse));

  if (zoneDistance <= 1) return "Korte kans";
  if (zoneDistance <= 2) return "Afstandsschot";
  return "Ver afstandsschot";
};

type Geslacht = (typeof GESLACHTEN)[number];

type PlayerStatus = "Basisspeler" | "Gast";

type Player = {
  id: string;
  naam: string;
  geslacht: Geslacht;
  status: PlayerStatus;
  actief: boolean;
  foto?: string;
};

type VakSide = "aanvallend" | "verdedigend";

type PieSlice = {
  label: string;
  value: number;
  color: string;
};

type LogReden =
  | "Bal onderschept"
  | "Bal uit"
  | "overtreding"
  | "Doorgelaten"
  | "Gescoord"
  | "Wissel in"
  | "Wissel uit"
  | "Pass Onderschept"
  | "Vrijebal"
  | "Vrije bal tegen"
  | "Strafworp"
  | "Strafworp tegen"
  | "Schot afgevangen"
  | "Gemist Schot"
  | "Rebound"
  | "Geen Rebound"
  | "Korf"
  | "Doelpunt"
  | "Verdedigd";


type AttackTeam = "thuis" | "uit";

type VakId = 1 | 2;

type AttackMeta = {
  id: string;              // interne id
  index: number;           // 1,2,3,... (aanvalnummer)
  team: AttackTeam;        // thuis of uit
  vak: VakSide;            // aanvallend / verdedigend
  vakId?: VakId;           // vast teamvak: Vak 1 of Vak 2
  startSeconden: number;   // starttijd vd aanval (wedstrijdseconden)
  endSeconden?: number;    // optional: eindtijd
};

type LogEvent = {
  id: string;
  tijdSeconden: number;
  vak?: VakSide;
  soort: "Gemis" | "Kans" | "Wissel" | "Balbezit" | "Schot" | "Rebound";
  actie?: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp";
  reden: LogReden;
  spelerId?: string;
  resterendSeconden?: number;
  wedstrijdMinuut?: number;
  pos?: number;
  team?: "thuis" | "uit";
  possThuis?: number;
  possUit?: number;
  type?: "Schot" | "Rebound";
  resultaat?: "Raak" | "Mis" | "Korf" | "Verdedigd";   
  attackId?: string;
  attackIndex?: number;
  vakId?: VakId;
};

type TeamFileV1 = {
  version: 1;
  createdAt: string;
  spelers: Player[];
};

type DatabaseSheetsData = {
  events: any[];
  attacks: any[];
  wissels: any[];
  matches: any[];
  spelers?: any[];
  team?: any[];
  vakindeling?: any[];
  instellingen?: any[];
  databaseInfo?: any[];
};

type DatabaseSheets = DatabaseSheetsData | null;

const DATABASE_VERSION = 2;
const APP_DATABASE_LABEL = "fase-6";
const IDB_NAME = "korfbal-coach-db";
const IDB_STORE = "appdata";
const IDB_KEY = "season-database";

function openCoachDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveDatabaseToBrowser(data: DatabaseSheetsData | null) {
  if (!data || typeof indexedDB === "undefined") return;
  const db = await openCoachDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(data, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadDatabaseFromBrowser(): Promise<DatabaseSheetsData | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openCoachDb();
  const value = await new Promise<DatabaseSheetsData | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const request = tx.objectStore(IDB_STORE).get(IDB_KEY);
    request.onsuccess = () => resolve((request.result as DatabaseSheetsData | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

async function clearDatabaseFromBrowser() {
  if (typeof indexedDB === "undefined") return;
  const db = await openCoachDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

type MatchType = "Competitie" | "Oefenwedstrijd" | "Toernooi";

type AppState = {
  spelers: Player[];
  aanval: (string | null)[];
  verdediging: (string | null)[];
  scoreThuis: number;
  scoreUit: number;
  tijdSeconden: number;               // loopt over beide helften door
  klokLoopt: boolean;
  halfMinuten: number;
  log: LogEvent[];
  possessionOwner: "thuis" | "uit" | null;
  possessionThuisSeconden: number;
  possessionUitSeconden: number;
  speelSeconden: Record<string, number>;
  autoVakWisselNa2: boolean;
  goalsSinceLastSwitch: number;
  aanvalLinks: boolean;
  currentHalf: 1 | 2;
  activeVak: VakSide;                 // waar is nu de bal
  vak1Aanvallend: boolean;            // identiteit van de vakken blijft behouden bij vakwissels
  attacks: AttackMeta[];
  currentAttackId: string | null;
  fieldEvents: FieldEvent[];  
  markerGroup: number;
  opponentName: string;
  homeAway: "" | "thuis" | "uit";
  season: string;
  seasonOptions: string[];
  matchType: MatchType;
  matchEnded: boolean;  
};

const DEFAULT_STATE: AppState = {
  spelers: [],
  aanval: [null, null, null, null],
  verdediging: [null, null, null, null],
  scoreThuis: 0,
  scoreUit: 0,
  tijdSeconden: 0,
  klokLoopt: false,
  halfMinuten: 25,
  log: [],
  possessionOwner: null,
  possessionThuisSeconden: 0,
  possessionUitSeconden: 0,
  speelSeconden: {},
  autoVakWisselNa2: false,
  goalsSinceLastSwitch: 0,
  aanvalLinks: true,
  currentHalf: 1,
  activeVak: "aanvallend",
  vak1Aanvallend: true,
  attacks: [],
  currentAttackId: null,
  fieldEvents: [], 
  markerGroup: 0,
  opponentName: "",   
  homeAway: "",
  season: "Veld najaar 2026",
  seasonOptions: ["Veld najaar 2026", "Zaal 2026/2027", "Veld voorjaar 2027"],
  matchType: "Competitie",
  matchEnded: false,    
};

const STORAGE_KEY = "korfbal_coach_state_v1";

function startAttackForVak(prev: AppState, vak: VakSide): AppState {
  const now = prev.tijdSeconden;

  const team: AttackTeam = vak === "aanvallend" ? "thuis" : "uit";
  const vakId: VakId =
    vak === "aanvallend"
      ? prev.vak1Aanvallend
        ? 1
        : 2
      : prev.vak1Aanvallend
      ? 2
      : 1;

  const attacks = [...prev.attacks];

  // oude aanval afsluiten (als er één loopt)
  if (prev.currentAttackId) {
    const idx = attacks.findIndex((a) => a.id === prev.currentAttackId);
    if (idx >= 0 && attacks[idx].endSeconden == null) {
      attacks[idx] = { ...attacks[idx], endSeconden: now };
    }
  }

  // nieuwe aanval aanmaken
  const newId = uid("att");
  const newAttack: AttackMeta = {
    id: newId,
    index: attacks.length + 1,
    team,
    vak,
    vakId,
    startSeconden: now,
  };
  attacks.push(newAttack);

  return {
    ...prev,
    activeVak: vak,
    possessionOwner: team,
    attacks,
    currentAttackId: newId,
  };
}

function formatTime(secs: number) {
  const clamped = Math.max(0, Math.floor(secs));
  const m = Math.floor(clamped / 60).toString().padStart(2, "0");
  const s = Math.floor(clamped % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function encodeStateForShare(s: AppState): string {
  const json = JSON.stringify(s);
  return encodeURIComponent(btoa(json));
}

function decodeStateFromShare(encoded: string): AppState | null {
  try {
    const json = atob(decodeURIComponent(encoded));
    const raw = JSON.parse(json);
    return sanitizeState(raw);
  } catch {
    return null;
  }
}

function getCurrentAttackInfo(state: AppState) {
  if (!state.currentAttackId) return { attackId: undefined, attackIndex: undefined as number | undefined };
  const a = state.attacks.find((x) => x.id === state.currentAttackId);
  if (!a) return { attackId: undefined, attackIndex: undefined as number | undefined };
  return { attackId: a.id, attackIndex: a.index };
}


function getSharedStateFromUrl(): AppState | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get("s");
    if (!encoded) return null;
    return decodeStateFromShare(encoded);
  } catch {
    return null;
  }
}

function detectVakForSpeler(state: AppState, spelerId?: string): VakSide | undefined {
  if (!spelerId) return undefined;
  if (state.aanval.includes(spelerId)) return "aanvallend";
  if (state.verdediging.includes(spelerId)) return "verdedigend";
  return undefined;
}

function getTeamDisplayName(
  team: "thuis" | "uit",
  opponentName: string
) {
  if (team === "thuis") return TEAM_LABELS.thuis;
  return opponentName || TEAM_LABELS.uit;
}


//////////////////////////////////////////////////////////////////////////////
// -- Hydration/migratie helper ----------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function sanitizeState(raw: any): AppState {
  const s: any = typeof raw === "object" && raw ? raw : {};
  const toArr4 = (a: any): (string | null)[] =>
    Array.isArray(a)
      ? [a[0] ?? null, a[1] ?? null, a[2] ?? null, a[3] ?? null]
      : [null, null, null, null];
  const num = (v: any, d: number) => (Number.isFinite(v) ? Number(v) : d);
  const bool = (v: any, d: boolean) => (typeof v === "boolean" ? v : d);



  return {
    spelers: Array.isArray(s.spelers)
      ? s.spelers.map((p: any) => ({
          ...p,
          status: p?.status === "Gast" ? "Gast" : "Basisspeler",
          actief: p?.actief !== false,
        })) as Player[]
      : [],
    aanval: toArr4(s.aanval),
    verdediging: toArr4(s.verdediging),
    scoreThuis: num(s.scoreThuis, DEFAULT_STATE.scoreThuis),
    scoreUit: num(s.scoreUit, DEFAULT_STATE.scoreUit),
    tijdSeconden: num(s.tijdSeconden, DEFAULT_STATE.tijdSeconden),
    klokLoopt: bool(s.klokLoopt, DEFAULT_STATE.klokLoopt),
    halfMinuten: num(s.halfMinuten, DEFAULT_STATE.halfMinuten),
    log: Array.isArray(s.log) ? (s.log as LogEvent[]) : [],

    fieldEvents: Array.isArray(s.fieldEvents)
      ? (s.fieldEvents as FieldEvent[])
      : DEFAULT_STATE.fieldEvents,
    
    markerGroup: num(
      s.markerGroup,
      DEFAULT_STATE.markerGroup
    ),
    
    possessionOwner:
      s.possessionOwner === "thuis" || s.possessionOwner === "uit"
        ? s.possessionOwner
        : null,
    possessionThuisSeconden: num(
      s.possessionThuisSeconden,
      DEFAULT_STATE.possessionThuisSeconden
    ),
    possessionUitSeconden: num(
      s.possessionUitSeconden,
      DEFAULT_STATE.possessionUitSeconden
    ),

    speelSeconden:
      s.speelSeconden && typeof s.speelSeconden === "object"
        ? Object.fromEntries(
            Object.entries(s.speelSeconden).map(([id, value]) => [
              id,
              Number.isFinite(Number(value)) ? Number(value) : 0,
            ])
          )
        : {},
    autoVakWisselNa2: bool(s.autoVakWisselNa2, DEFAULT_STATE.autoVakWisselNa2),
    goalsSinceLastSwitch: num(
      s.goalsSinceLastSwitch,
      DEFAULT_STATE.goalsSinceLastSwitch
    ),

    aanvalLinks:
      typeof s.aanvalLinks === "boolean"
        ? s.aanvalLinks
        : DEFAULT_STATE.aanvalLinks,
    currentHalf: s.currentHalf === 2 ? 2 : 1,

    activeVak: s.activeVak === "verdedigend" ? "verdedigend" : "aanvallend",
    vak1Aanvallend: bool(s.vak1Aanvallend, DEFAULT_STATE.vak1Aanvallend),

    // aanvallen + huidige aanval
    attacks: Array.isArray(s.attacks)
      ? (s.attacks as AttackMeta[])
      : DEFAULT_STATE.attacks,
      currentAttackId:
      typeof s.currentAttackId === "string"
        ? s.currentAttackId
        : DEFAULT_STATE.currentAttackId,

        opponentName:
        typeof s.opponentName === "string" ? s.opponentName : "",
      homeAway:
        s.homeAway === "uit" || s.homeAway === "thuis"
          ? s.homeAway
          : "",
      season:
        typeof s.season === "string" && s.season.trim()
          ? s.season.trim()
          : DEFAULT_STATE.season,
      seasonOptions:
        Array.isArray(s.seasonOptions)
          ? Array.from(new Set([
              ...DEFAULT_STATE.seasonOptions,
              ...s.seasonOptions.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim()),
              ...(typeof s.season === "string" && s.season.trim() ? [s.season.trim()] : []),
            ]))
          : DEFAULT_STATE.seasonOptions,
      matchType:
        s.matchType === "Oefenwedstrijd" || s.matchType === "Toernooi" || s.matchType === "Competitie"
          ? s.matchType
          : DEFAULT_STATE.matchType,
      matchEnded: bool(s.matchEnded, DEFAULT_STATE.matchEnded),
    };
  }

const formatImportedDate = (value: any) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
    }
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  const nl = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (nl) return `${nl[1].padStart(2, "0")}-${nl[2].padStart(2, "0")}-${nl[3]}`;
  return raw.slice(0, 10);
};

//////////////////////////////////////////////////////////////////////////////
// --- Main component --------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////


function KorbIQLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center select-none">
      <div className="leading-none">
        <div className={`${compact ? "text-xl" : "text-3xl"} font-extrabold tracking-tight text-[#124a98]`}>
          Korb<span className="text-blue-600">IQ</span>
        </div>
        {!compact && <div className="mt-1 text-[10px] font-medium tracking-wide text-slate-500">Inzicht in elke actie</div>}
      </div>
    </div>
  );
}

function SignalDot({ tone }: { tone: "green" | "orange" | "red" | "blue" }) {
  const cls = tone === "green" ? "bg-emerald-500" : tone === "orange" ? "bg-orange-500" : tone === "red" ? "bg-red-500" : "bg-blue-500";
  return <span className={`mt-[0.42rem] h-2.5 w-2.5 shrink-0 rounded-full ${cls} shadow-[0_0_0_3px_rgba(255,255,255,.75)]`} aria-hidden="true" />;
}

function NavGlyph({ type }: { type: "match" | "insights" | "season" | "players" | "settings" | "export" | "backup" | "share" | "reset" }) {
  const common = "h-5 w-5 shrink-0";
  if (type === "players") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="3"/><path d="M5 20c.8-4 3.1-6 7-6s6.2 2 7 6"/></svg>;
  if (type === "settings") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"/></svg>;
  if (type === "insights") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3"/></svg>;
  if (type === "season") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>;
  if (type === "export") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"/></svg>;
  if (type === "backup") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21V9m0 0 4 4m-4-4-4 4M5 5h14"/></svg>;
  if (type === "share") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>;
  if (type === "reset") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/></svg>;
  return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>;
}


function MatchInfoGlyph({ type }: { type: "shirt" | "trophy" | "calendar" | "clock" | "score" }) {
  const common = "h-7 w-7 text-blue-600 shrink-0";
  if (type === "shirt") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 4 5 6l-3 4 4 2 1-2v10h10V10l1 2 4-2-3-4-3-2c-.7 1.3-2 2-4 2s-3.3-.7-4-2Z"/></svg>;
  if (type === "trophy") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 4h8v4c0 4-1.8 6-4 6s-4-2-4-6V4Z"/><path d="M8 6H4v2c0 2.5 1.5 4 4 4M16 6h4v2c0 2.5-1.5 4-4 4M12 14v4M8 20h8"/></svg>;
  if (type === "calendar") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>;
  if (type === "clock") return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>;
  return <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h3M14 10h3M8 14h8"/></svg>;
}

export default function App() {
  const [state, setState] = useState<AppState>(() => {
    // 1. eerst kijken of er een gedeelde state in de URL zit
    const shared = getSharedStateFromUrl();
    if (shared) return shared;

    // 2. anders uit localStorage
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return sanitizeState(JSON.parse(raw));
    } catch {}

    // 3. anders default
    return { ...DEFAULT_STATE };
  });

  const [tab, setTab] =
  useState<"spelers" | "vakken" | "wedstrijd" | "verslag" | "insights" | "seizoen">("spelers");
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setMobileMenuOpen(false);
  }, [tab]);
  useEffect(() => {
    // De standaard Vite-CSS centreert #root soms verticaal bij korte tabs.
    // Forceer de webapp altijd vanaf de bovenkant van het venster.
    document.body.style.display = "block";
    document.body.style.minHeight = "100vh";
    const root = document.getElementById("root");
    if (root) {
      root.style.width = "100%";
      root.style.minHeight = "100vh";
    }
  }, []);
  //const [popup, setPopup] = useState<null | { vak: VakSide; soort: "Gemis" | "Kans" }>(null);
  const [possPopup, setPossPopup] = useState<null | { team: "thuis" | "uit" }>(null);
  const [shotPopup, setShotPopup] = useState<null | { type: "Schot" | "Rebound" }>(null);
  const [vakActionPopup, setVakActionPopup] =
  useState<null | { vak: VakSide }>(null);

  const [reboundPopup, setReboundPopup] =
    useState<null | {}>(null);

const [stealPopup, setStealPopup] = useState<null | {}>(null);
  const teamFileInputRef = useRef<HTMLInputElement | null>(null);
  const [dbSheets, setDbSheets] = useState<DatabaseSheets>(null);
  const [databaseReady, setDatabaseReady] = useState(false);
  const [databaseSetupOpen, setDatabaseSetupOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  const dbFileInputRef = useRef<HTMLInputElement | null>(null);

  // Seizoensdatabase uit IndexedDB herstellen. Als er niets staat, laat de app
  // bewust kiezen tussen een back-up herstellen en een nieuwe database starten.
  useEffect(() => {
    let mounted = true;
    loadDatabaseFromBrowser()
      .then((saved) => {
        if (!mounted) return;
        if (saved) {
          setDbSheets(saved);
          setDatabaseSetupOpen(false);
        } else {
          setDatabaseSetupOpen(true);
        }
      })
      .catch((err) => {
        console.warn("Kon browserdatabase niet laden", err);
        if (mounted) setDatabaseSetupOpen(true);
      })
      .finally(() => { if (mounted) setDatabaseReady(true); });
    return () => { mounted = false; };
  }, []);

  // Ook later in de sessie bewaken: zonder database mag niet ongemerkt
  // een nieuwe wedstrijd worden gestart. Een bewust nieuwe, lege database
  // is wél een geldig DatabaseSheetsData-object en triggert dit dus niet.
  useEffect(() => {
    if (databaseReady && !dbSheets) setDatabaseSetupOpen(true);
  }, [databaseReady, dbSheets]);

  useEffect(() => {
    if (!databaseReady || !dbSheets) return;
    saveDatabaseToBrowser(dbSheets).catch((err) =>
      console.warn("Kon browserdatabase niet opslaan", err)
    );
  }, [dbSheets, databaseReady]);

  // Persist
  // Timer (intern: op-tellen; UI toont resterend) + balbezit
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  
  if (!state.klokLoopt) return;

  const id = window.setInterval(() => {
    setState((prev) => {
      const halfMinuten = Number.isFinite(prev.halfMinuten)
        ? prev.halfMinuten
        : DEFAULT_STATE.halfMinuten;
      const halfTotal = halfMinuten * 60;
    
      const currentHalfEnd = prev.currentHalf * halfTotal;
      const nextTime = Math.min(prev.tijdSeconden + 1, currentHalfEnd);
    
      let updated: AppState = {
        ...prev,
        tijdSeconden: nextTime,
      };
    
      // speelminuten: iedere seconde dat de klok loopt telt voor spelers die in het veld staan
      const veldIds = Array.from(
        new Set(
          [...prev.aanval, ...prev.verdediging].filter(
            (id): id is string => Boolean(id)
          )
        )
      );
      if (veldIds.length > 0) {
        const speelSeconden = { ...prev.speelSeconden };
        veldIds.forEach((id) => {
          speelSeconden[id] = (speelSeconden[id] ?? 0) + 1;
        });
        updated.speelSeconden = speelSeconden;
      }

      // balbezit-tijd ophogen
      if (prev.possessionOwner === "thuis") {
        updated.possessionThuisSeconden = prev.possessionThuisSeconden + 1;
      } else if (prev.possessionOwner === "uit") {
        updated.possessionUitSeconden = prev.possessionUitSeconden + 1;
      }
    
      // helft vol → klok stoppen en aanval afsluiten
      if (nextTime >= currentHalfEnd) {
        updated.klokLoopt = false;
    
        if (prev.currentAttackId) {
          const attacks = [...prev.attacks];
          const idx = attacks.findIndex((a) => a.id === prev.currentAttackId);
          if (idx >= 0 && attacks[idx].endSeconden == null) {
            attacks[idx] = { ...attacks[idx], endSeconden: nextTime };
          }
          updated.attacks = attacks;
          updated.currentAttackId = null;
        }
      }
      return updated;
    });
  }, 1000);

  return () => clearInterval(id);
}, [state.klokLoopt, state.halfMinuten, state.currentHalf]);

  const spelersMap = useMemo(() => {
    const m = new Map<string, Player>();
    state.spelers.forEach((p) => m.set(p.id, p));
    return m;
  }, [state.spelers]);

  const veldSpelers = useMemo(() => {
    const ids = new Set<string>();
    state.aanval.forEach((id) => id && ids.add(id));
    state.verdediging.forEach((id) => id && ids.add(id));
    return state.spelers.filter((p) => ids.has(p.id));
  }, [state.spelers, state.aanval, state.verdediging]);

  const toegewezenIds = useMemo(
    () =>
      new Set<string>([
        ...state.aanval.filter((x): x is string => Boolean(x)),
        ...state.verdediging.filter((x): x is string => Boolean(x)),
      ]),
    [state.aanval, state.verdediging]
  );

  const bank = state.spelers.filter((p) => p.actief && !toegewezenIds.has(p.id));

  //////////////////////////////////////////////////////////////////////////////
  // Actions -------------------------------------------------------------------
  //////////////////////////////////////////////////////////////////////////////

  const addSpeler = (
    naam: string,
    geslacht: Geslacht,
    status: PlayerStatus,
    foto?: string
  ) => {
    const p: Player = { id: uid("sp"), naam, geslacht, status, actief: true, foto };
    setState((s) => ({ ...s, spelers: [...s.spelers, p] }));
  };

  const updateSpelerStatus = (id: string, status: PlayerStatus) => {
    setState((s) => ({
      ...s,
      spelers: s.spelers.map((p) => (p.id === id ? { ...p, status } : p)),
    }));
  };

  const updateSpelerActief = (id: string, actief: boolean) => {
    setState((s) => ({
      ...s,
      spelers: s.spelers.map((p) => (p.id === id ? { ...p, actief } : p)),
      aanval: actief ? s.aanval : s.aanval.map((x) => (x === id ? null : x)),
      verdediging: actief ? s.verdediging : s.verdediging.map((x) => (x === id ? null : x)),
    }));
  };

  const delSpeler = (id: string) => {
    setState((s) => ({
      ...s,
      spelers: s.spelers.filter((p) => p.id !== id),
      aanval: s.aanval.map((x) => (x === id ? null : x)),
      verdediging: s.verdediging.map((x) => (x === id ? null : x)),
    }));
  };

  const setVakPos = (
    vak: VakSide,
    pos: number,
    spelerId: string | null,
    logWissel: boolean = true // 👈 optioneel
  ) => {
    setState((s) => {
      const arr = vak === "aanvallend" ? [...s.aanval] : [...s.verdediging];
      const prevId = arr[pos] || null;
      arr[pos] = spelerId;
  
      const logs: LogEvent[] = [];
  
      // ✅ alleen wissels loggen als logWissel = true
      if (logWissel) {
        const halfMinuten = Number.isFinite(s.halfMinuten)
          ? s.halfMinuten
          : DEFAULT_STATE.halfMinuten;
        const halfTotal = halfMinuten * 60;
  
        const resterend = Math.max(halfTotal - s.tijdSeconden, 0);
        const minuut = Math.max(1, Math.ceil(s.tijdSeconden / 60));
  
        if (prevId && prevId !== spelerId) {
          logs.push({
            id: uid("ev"),
            tijdSeconden: s.tijdSeconden,
            vak,
            soort: "Wissel",
            reden: "Wissel uit",
            spelerId: prevId,
            resterendSeconden: resterend,
            wedstrijdMinuut: minuut,
            pos: pos + 1,
            team: vak === "aanvallend" ? "thuis" : "uit",
            vakId:
              vak === "aanvallend"
                ? s.vak1Aanvallend
                  ? 1
                  : 2
                : s.vak1Aanvallend
                ? 2
                : 1,
          });
        }
  
        if (spelerId && prevId !== spelerId) {
          logs.push({
            id: uid("ev"),
            tijdSeconden: s.tijdSeconden,
            vak,
            soort: "Wissel",
            reden: "Wissel in",
            spelerId,
            resterendSeconden: resterend,
            wedstrijdMinuut: minuut,
            pos: pos + 1,
            team: vak === "aanvallend" ? "thuis" : "uit",
            vakId:
              vak === "aanvallend"
                ? s.vak1Aanvallend
                  ? 1
                  : 2
                : s.vak1Aanvallend
                ? 2
                : 1,
          });
        }
      }
  
      const next =
        vak === "aanvallend"
          ? { ...s, aanval: arr }
          : { ...s, verdediging: arr };
  
      return logs.length ? { ...next, log: [...logs, ...s.log] } : next;
    });
  };

  const wisselVakken = () =>
  setState((s) => ({
    ...s,
    aanval: s.verdediging,
    verdediging: s.aanval,
    vak1Aanvallend: !s.vak1Aanvallend,
    goalsSinceLastSwitch: 0,

    // nieuwe veldperiode -> oude markers niet meer tonen
    markerGroup: s.markerGroup + 1,
  }));

  const toggleKlok = (aan: boolean) =>
  setState((s) => {
    // Bij de allereerste start hoort de bal direct bij het actieve vak.
    // Zo lopen balbezit en aanvalstijd vanaf seconde 1 mee, ook vóór de eerste geregistreerde actie.
    if (aan && !s.klokLoopt && !s.currentAttackId && s.attacks.length === 0 && s.tijdSeconden === 0) {
      return { ...startAttackForVak(s, s.activeVak), klokLoopt: true };
    }
    return { ...s, klokLoopt: aan };
  });

  // 🔹 LOSSE functie voor gewone Gemis/Kans/Wissel events
  const logEvent = (
    vak: VakSide,
    soort: "Gemis" | "Kans" | "Wissel",
    reden: LogReden,
    spelerId?: string,
    actie?: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp",
    resultaat?: "Raak" | "Mis" | "Korf" | "Verdedigd"
  ) => {
    const halfMinuten = Number.isFinite(state.halfMinuten)
      ? state.halfMinuten
      : DEFAULT_STATE.halfMinuten;
    const resterend = Math.max(halfMinuten * 60 - state.tijdSeconden, 0);
    const minuut = Math.max(1, Math.ceil(state.tijdSeconden / 60));

    const { attackId, attackIndex } = getCurrentAttackInfo(state);

    const e: LogEvent = {
      id: uid("ev"),
      tijdSeconden: state.tijdSeconden,
      vak,
      soort,
      reden,
      spelerId,
      team: vak === "aanvallend" ? "thuis" : "uit",  // aanval = Korbis, verdediging = Tegenstander
      actie,
      resultaat,
      resterendSeconden: resterend,
      wedstrijdMinuut: minuut,
      attackId,
      attackIndex,
      vakId:
        vak === "aanvallend"
          ? state.vak1Aanvallend
            ? 1
            : 2
          : state.vak1Aanvallend
          ? 2
          : 1,
    };

    setState((s) => {
      let next: AppState = { ...s, log: [e, ...s.log] };
      let goalScored = false;

      // 🔹 doelpunt-logica nu ook voor Korf/Doelpunt
      const isThuisGoal =
        soort === "Kans" &&
        vak === "aanvallend" &&
        (reden === "Gescoord" || reden === "Doelpunt");

      const isUitGoal =
        soort === "Gemis" &&
        vak === "verdedigend" &&
        (reden === "Doorgelaten" || reden === "Doelpunt");

      if (isThuisGoal) {
        next.scoreThuis = s.scoreThuis + 1;
        goalScored = true;
      }
      if (isUitGoal) {
        next.scoreUit = s.scoreUit + 1;
        goalScored = true;
      }

      // 🔁 auto-wissel na 2 doelpunten
      if (goalScored && s.autoVakWisselNa2) {
        const goalsTotaal = s.goalsSinceLastSwitch + 1;
        if (goalsTotaal >= 2) {
          next = {
            ...next,
            aanval: next.verdediging,
            verdediging: next.aanval,
            vak1Aanvallend: !next.vak1Aanvallend,
            goalsSinceLastSwitch: 0,
          };
        } else {
          next.goalsSinceLastSwitch = goalsTotaal;
        }
      }

      // 🔄 Na doelpunt OF verdedigd eindigt de aanval
      const aanvalEindigt = goalScored || resultaat === "Verdedigd";

      if (aanvalEindigt) {
        const nextVak: VakSide =
          s.activeVak === "aanvallend" ? "verdedigend" : "aanvallend";

        next = startAttackForVak(next, nextVak);
      }

      return next;
    });
  };

  const logSteal = (spelerId?: string) => {
    setState((s) => {
      const halfMinuten = Number.isFinite(s.halfMinuten)
        ? s.halfMinuten
        : DEFAULT_STATE.halfMinuten;
      const totalSeconds = halfMinuten * 60;
      const resterend = Math.max(totalSeconds - s.tijdSeconden, 0);
      const minuut = Math.max(1, Math.ceil(s.tijdSeconden / 60));
      const { attackId, attackIndex } = getCurrentAttackInfo(s);
  
      // Steal loggen als balbezit-event
      const e: LogEvent = {
        id: uid("ev"),
        tijdSeconden: s.tijdSeconden,
        vak: "verdedigend",
        soort: "Balbezit",
        reden: "Schot afgevangen",
        spelerId,
        resterendSeconden: resterend,
        wedstrijdMinuut: minuut,
        team: "thuis",
        attackId,
        attackIndex,
        vakId: s.vak1Aanvallend ? 2 : 1,
      };
  
      // log + balbezit naar Korbis
      let next: AppState = {
        ...s,
        log: [e, ...s.log],
        possessionOwner: "thuis",
      };
  
      // nieuwe aanval starten in het aanvallende vak
      next = startAttackForVak(next, "aanvallend");
  
      return next;
    });
  };

  const logStealAgainstUs = (spelerId?: string) => {
    setState((s) => {
      const halfMinuten = Number.isFinite(s.halfMinuten)
        ? s.halfMinuten
        : DEFAULT_STATE.halfMinuten;
      const totalSeconds = halfMinuten * 60;
      const resterend = Math.max(totalSeconds - s.tijdSeconden, 0);
      const minuut = Math.max(1, Math.ceil(s.tijdSeconden / 60));
      const { attackId, attackIndex } = getCurrentAttackInfo(s);
  
      const e: LogEvent = {
        id: uid("ev"),
        tijdSeconden: s.tijdSeconden,
        vak: "aanvallend",
        soort: "Balbezit",
        reden: "Schot afgevangen",
        spelerId,                       // op wie de steal was
        resterendSeconden: resterend,
        wedstrijdMinuut: minuut,
        team: "uit",                    // bal gaat naar tegenstander
        attackId,
        attackIndex,
        vakId: s.vak1Aanvallend ? 1 : 2,
      };
  
      let next: AppState = { ...s, log: [e, ...s.log] };
  
      // Na steal tegen ons → wij gaan verdedigen
      next = startAttackForVak(next, "verdedigend");
  
      return next;
    });
  };
  
  const handleVakActieLog = (
    vak: VakSide,
    actie: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp",
    uitkomst: "Korf" | "Mis" | "Raak" | "Verdedigd",
    spelerId?: string
  ) => {
    let soort: "Kans" | "Gemis";
    let reden: LogReden;
  
    if (vak === "aanvallend") {
      soort = "Kans";
      if (uitkomst === "Raak") {
        reden = "Gescoord";
      } else if (uitkomst === "Korf") {
        reden = "Korf";
      } else if (uitkomst === "Verdedigd") {
        reden = "Verdedigd";
      } else {
        // Mis
        reden = "Gemist Schot";
      }
    } else {
      soort = "Gemis";
      if (uitkomst === "Raak") {
        reden = "Doorgelaten";
      } else if (uitkomst === "Korf") {
        reden = "Korf";
      } else if (uitkomst === "Verdedigd") {
        reden = "Verdedigd";
      } else {
        reden = "Gemist Schot";
      }
    }
  
    // 🔹 veld-event updaten (laatste punt in dit vak)
    setState((s) => {
      const fe = [...s.fieldEvents];
  
      if (fe.length > 0) {
        for (let i = fe.length - 1; i >= 0; i--) {
          if (fe[i].vak === vak) {
            fe[i] = {
              ...fe[i],
              actie:
                actie === "Schot"
                  ? "schot"
                  : actie === "Doorloop"
                  ? "doorloop"
                  : actie === "Strafworp"
                  ? "strafworp"
                  : "vrije",
              resultaat: uitkomst.toLowerCase() as FieldEvent["resultaat"],
            };
            break;
          }
        }
      }
  
      return { ...s, fieldEvents: fe };
    });
  
    // 🔹 normale logregel (score, auto-wissel etc.) + uitkomst meegeven
    logEvent(vak, soort, reden, spelerId, actie, uitkomst);
  
    console.log("Actie:", actie);
  };
  
  const logRebound = (spelerId?: string) => {
    setState((s) => {
      const halfMinuten = Number.isFinite(s.halfMinuten)
        ? s.halfMinuten
        : DEFAULT_STATE.halfMinuten;
  
      const totalSeconds = halfMinuten * 60;
      const resterend = Math.max(totalSeconds - s.tijdSeconden, 0);
      const minuut = Math.max(1, Math.ceil(s.tijdSeconden / 60));
  
      const { attackId, attackIndex } = getCurrentAttackInfo(s);
  
      const e: LogEvent = {
        id: uid("ev"),
        tijdSeconden: s.tijdSeconden,
        vak: "aanvallend",
        soort: "Rebound",
        reden: spelerId ? "Rebound" : "Geen Rebound",
        spelerId,
        team: "thuis",
        resterendSeconden: resterend,
        wedstrijdMinuut: minuut,
        type: "Rebound",
        attackId,
        attackIndex,
      };
  
      return {
        ...s,
        log: [e, ...s.log],
      };
    });
  };

  const logSchotOfRebound = (
    type: "Schot" | "Rebound",
    resultaat: "Raak" | "Mis",
    spelerId?: string
  ) => {
    const halfMinuten = Number.isFinite(state.halfMinuten)
      ? state.halfMinuten
      : DEFAULT_STATE.halfMinuten;
    const totalSeconds = halfMinuten * 60;
  
    const resterend = Math.max(totalSeconds - state.tijdSeconden, 0);
    const minuut = Math.max(1, Math.ceil(state.tijdSeconden / 60));
  
    // vak bepalen obv speler (als geen speler: aanvallend aanhouden)
    const vak = detectVakForSpeler(state, spelerId) ?? "aanvallend";
    const team: "thuis" | "uit" = vak === "aanvallend" ? "thuis" : "uit";

    // reden voor in de log
    const reden: LogReden =
      type === "Schot"
        ? resultaat === "Raak"
          ? "Gescoord"
          : "Gemist Schot"
        : "Rebound";
    const { attackId, attackIndex } = getCurrentAttackInfo(state);
    const e: LogEvent = {
      id: uid("ev"),
      tijdSeconden: state.tijdSeconden,
      vak,
      soort: type, // "Schot" of "Rebound"
      reden,
      spelerId,
      team,
      resterendSeconden: resterend,
      wedstrijdMinuut: minuut,
      type,
      resultaat,
      attackId,
      attackIndex,
    };
  
    setState((s) => ({ ...s, log: [e, ...s.log] }));
  };


  
  // 🔹 LOSSE functie voor Balbezit-events (GEEN vak, maar wel snapshot poss%)
  const logBalbezit = (
    team: "thuis" | "uit",
    reden: LogReden,
    spelerId?: string
  ) => {
    const halfMinuten = Number.isFinite(state.halfMinuten)
      ? state.halfMinuten
      : DEFAULT_STATE.halfMinuten;
    const totalSeconds = halfMinuten * 60;
    const resterend = Math.max(totalSeconds - state.tijdSeconden, 0);
    const minuut = Math.max(1, Math.ceil(state.tijdSeconden / 60));
  
    // virtuele "Tegenstander" als team=uit en geen speler gekozen
    const effectiveSpelerId =
      team === "uit" && !spelerId ? TEGENSTANDER_ID : spelerId;
    const { attackId, attackIndex } = getCurrentAttackInfo(state);
  
    const e: LogEvent = {
      id: uid("ev"),
      tijdSeconden: state.tijdSeconden,
      soort: "Balbezit",
      reden,
      spelerId: effectiveSpelerId,
      resterendSeconden: resterend,
      wedstrijdMinuut: minuut,
      team,
      attackId,
      attackIndex,
    };
  
    setState((s) => {
      // bepaal in welk vak de aanval hoort
      const vak: VakSide = team === "thuis" ? "aanvallend" : "verdedigend";
  
      // log + balbezit eigenaar bijwerken
      let next: AppState = {
        ...s,
        log: [e, ...s.log],
        possessionOwner: team,
      };
  
      // nieuwe aanval starten voor dit vak/team
      next = startAttackForVak(next, vak);
  
      return next;
    });
  };

const triggerImportTeam = () => {
  teamFileInputRef.current?.click();
};

const handleImportTeamFile = (
  e: React.ChangeEvent<HTMLInputElement>
) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const text = reader.result as string;
      const raw = JSON.parse(text);

      // heel simpele check
      if (!raw || !Array.isArray(raw.spelers)) {
        throw new Error("Geen geldige team-export");
      }

      const spelers = raw.spelers.map((p: any) => ({
        ...p,
        status: p?.status === "Gast" ? "Gast" : "Basisspeler",
        actief: p?.actief !== false,
      })) as Player[];

      setState((s) => ({
        ...s,
        spelers,
        // posities leegmaken zodat oude IDs niet blijven hangen
        aanval: [null, null, null, null],
        verdediging: [null, null, null, null],
      }));

      alert("Team succesvol geladen ✅");
    } catch (err) {
      console.error(err);
      alert("Kon dit bestand niet als team inladen 😅");
    } finally {
      // zelfde bestand later opnieuw kunnen kiezen
      e.target.value = "";
    }
  };

  reader.readAsText(file);
};

const exportTeam = () => {
  const data: TeamFileV1 = {
    version: 1,
    createdAt: new Date().toISOString(),
    spelers: state.spelers,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `korfbal-team-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

const handleImportDatabaseFile = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = (event) => {
    try {
      const data = new Uint8Array(event.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      const rows = (name: string) =>
        wb.Sheets[name] ? (XLSX.utils.sheet_to_json(wb.Sheets[name]) as any[]) : [];

      const imported: DatabaseSheetsData = {
        events: rows("Events"),
        attacks: rows("Attacks"),
        wissels: rows("Wissels"),
        matches: rows("Wedstrijden"),
        spelers: rows("Spelers"),
        team: rows("Team"),
        vakindeling: rows("Vakindeling"),
        instellingen: rows("Instellingen"),
        databaseInfo: rows("DatabaseInfo"),
      };

      const info = imported.databaseInfo?.[0] ?? {};
      const settings = imported.instellingen?.[0] ?? {};
      const hasFullBackup = (imported.spelers?.length ?? 0) > 0;
      const importedPlayers: Player[] = hasFullBackup
        ? (imported.spelers ?? []).map<Player>((p: any) => ({
            id: String(p.speler_id ?? p.id ?? ""),
            naam: String(p.naam ?? p.spelerNaam ?? ""),
            geslacht: p.geslacht === "Heer" ? "Heer" : "Dame",
            status: p.status === "Gast" ? "Gast" : "Basisspeler",
            actief: !(
              p.actief === false ||
              Number(p.actief) === 0 ||
              ["nee", "inactief", "false"].includes(String(p.actief ?? "").trim().toLowerCase())
            ),
            foto: typeof p.foto === "string" && p.foto ? p.foto : undefined,
          })).filter((p) => Boolean(p.id && p.naam))
        : [];

      const vak1Rows = (imported.vakindeling ?? [])
        .filter((r: any) => Number(r.vak_id) === 1)
        .sort((a: any, b: any) => Number(a.positie ?? 0) - Number(b.positie ?? 0));
      const vak2Rows = (imported.vakindeling ?? [])
        .filter((r: any) => Number(r.vak_id) === 2)
        .sort((a: any, b: any) => Number(a.positie ?? 0) - Number(b.positie ?? 0));
      const toVak = (vakRows: any[]) => Array.from({ length: 4 }, (_, i) => {
        const row = vakRows.find((r: any) => Number(r.positie) === i + 1) ?? vakRows[i];
        const id = row?.speler_id ?? row?.spelerId ?? "";
        return id ? String(id) : null;
      });

      const activeImportedIds = new Set(importedPlayers.filter((p) => p.actief).map((p) => p.id));
      const restoredVak1 = toVak(vak1Rows).map((id) => id && activeImportedIds.has(id) ? id : null);
      const restoredVak2 = toVak(vak2Rows).map((id) => id && activeImportedIds.has(id) ? id : null);
      const restoredVak1Aanvallend =
        settings.vak1_aanvallend === false || String(settings.vak1_aanvallend).toLowerCase() === "nee"
          ? false
          : true;
      const seasonOptionsFromFile = (() => {
        try {
          const parsed = JSON.parse(String(settings.seizoen_opties_json ?? "[]"));
          return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x.trim()) : [];
        } catch { return []; }
      })();

      setDbSheets(imported);
      setDatabaseSetupOpen(false);

      if (hasFullBackup) {
        setState((prev) => ({
          ...prev,
          spelers: importedPlayers,
          aanval: restoredVak1Aanvallend ? restoredVak1 : restoredVak2,
          verdediging: restoredVak1Aanvallend ? restoredVak2 : restoredVak1,
          vak1Aanvallend: restoredVak1Aanvallend,
          halfMinuten: Number(settings.half_duur_minuten) || prev.halfMinuten,
          autoVakWisselNa2:
            settings.auto_vakwissel_na_2 === true || String(settings.auto_vakwissel_na_2).toLowerCase() === "ja",
          aanvalLinks:
            settings.aanval_links === false || String(settings.aanval_links).toLowerCase() === "nee" ? false : true,
          season: String(settings.actief_seizoen ?? info.actief_seizoen ?? prev.season),
          seasonOptions: Array.from(new Set([
            ...prev.seasonOptions,
            ...seasonOptionsFromFile,
            String(settings.actief_seizoen ?? info.actief_seizoen ?? prev.season),
          ].filter(Boolean))),
          matchType: (["Competitie", "Oefenwedstrijd", "Toernooi"].includes(String(settings.standaard_wedstrijdtype))
            ? String(settings.standaard_wedstrijdtype)
            : prev.matchType) as MatchType,
          // Een import herstelt de database/configuratie, niet een half gespeelde wedstrijd.
          scoreThuis: 0,
          scoreUit: 0,
          tijdSeconden: 0,
          klokLoopt: false,
          log: [],
          possessionOwner: null,
          possessionThuisSeconden: 0,
          possessionUitSeconden: 0,
          speelSeconden: {},
          goalsSinceLastSwitch: 0,
          currentHalf: 1,
          activeVak: "aanvallend",
          attacks: [],
          currentAttackId: null,
          fieldEvents: [],
          markerGroup: 0,
          opponentName: "",
          matchEnded: false,
        }));
      }

      const count = imported.matches.length;
      alert(
        hasFullBackup
          ? `Volledige back-up hersteld ✅\n${count} wedstrijd${count === 1 ? "" : "en"}, spelers, vakindeling en instellingen zijn geladen.`
          : `Excel database geladen ✅\n${count} wedstrijd${count === 1 ? "" : "en"}. Dit is een oudere database zonder teamconfiguratie.`
      );
    } catch (err) {
      console.error(err);
      alert("Kon dit Excel-bestand niet inlezen 😅");
    } finally {
      e.target.value = "";
    }
  };

  reader.readAsArrayBuffer(file);
};






const exportToExcel = () => {
  // Stabiel wedstrijd-ID: opnieuw exporteren vervangt dezelfde wedstrijd i.p.v. dupliceren.
  const exportDate = new Date().toLocaleDateString("sv-SE");
  const opponentSlug = (state.opponentName || "tegenstander")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "tegenstander";
  const wedstrijdId = `WED-${exportDate}-${state.homeAway}-${opponentSlug}`;

  const alreadyExists = (dbSheets?.matches ?? []).some(
    (m: any) => String(m.wedstrijd_id ?? "") === wedstrijdId
  );
  if (alreadyExists && !confirm("Deze wedstrijd staat al in de database. Bestaande versie vervangen?")) {
    return;
  }

  // 🔹 Gemeenschappelijke velden voor naamgeving
  const thuisTeamNaam = "Korbis";
  const uitTeamNaam = state.opponentName || "Tegenstander";
  const locatieLabel = state.homeAway === "thuis" ? "Thuis" : state.homeAway === "uit" ? "Uit" : "";

  const wedstrijdNaam =
    state.homeAway === "thuis"
      ? `${thuisTeamNaam} - ${uitTeamNaam}`
      : `${uitTeamNaam} - ${thuisTeamNaam}`;

  // ---------- 0) TUSSENSTAND PER EVENT OPBOUWEN ----------
  const sortedForScore = state.log.slice().reverse();
  let scoreThuis = 0;
  let scoreUit = 0;
  const scoreAtEvent = new Map<string, { thuis: number; uit: number }>();

  for (const e of sortedForScore) {
    const isThuisGoal =
      e.soort === "Kans" &&
      e.vak === "aanvallend" &&
      (e.reden === "Gescoord" || e.reden === "Doelpunt");

    const isUitGoal =
      e.soort === "Gemis" &&
      e.vak === "verdedigend" &&
      (e.reden === "Doorgelaten" || e.reden === "Doelpunt");

    if (isThuisGoal) scoreThuis++;
    if (isUitGoal) scoreUit++;

    scoreAtEvent.set(e.id, { thuis: scoreThuis, uit: scoreUit });
  }

  // ---------- 1) EVENTS SHEET (zonder wissels) ----------
  const eventsForSheet = state.log
    .slice()
    .reverse()
    .filter((e) => e.soort !== "Wissel");

  const eventRows = eventsForSheet.map((e) => {
    const attackMeta = e.attackId
      ? state.attacks.find((a) => a.id === e.attackId)
      : undefined;

    const aanvalDuurSeconden =
      attackMeta && attackMeta.endSeconden != null
        ? attackMeta.endSeconden - attackMeta.startSeconden
        : undefined;

    const findFieldEventForLog = (logEv: LogEvent): FieldEvent | undefined => {
      if (!logEv.attackId || !logEv.vak) return undefined;

      const candidates = state.fieldEvents.filter(
        (fe) => fe.attackId === logEv.attackId && fe.vak === logEv.vak
      );
      if (candidates.length === 0) return undefined;

      let best = candidates[0];
      let bestDelta = Math.abs(best.tijdSeconden - logEv.tijdSeconden);

      for (const fe of candidates) {
        const delta = Math.abs(fe.tijdSeconden - logEv.tijdSeconden);
        if (delta <= bestDelta) {
          best = fe;
          bestDelta = delta;
        }
      }
      return best;
    };

    const fieldEv = findFieldEventForLog(e);

    const halfMinuten2 = Number.isFinite(state.halfMinuten)
      ? state.halfMinuten
      : DEFAULT_STATE.halfMinuten;
    const totalSeconds2 = halfMinuten2 * 60;

    const resterend =
      e.resterendSeconden ?? Math.max(totalSeconds2 - e.tijdSeconden, 0);

    const score = scoreAtEvent.get(e.id);

    const actieLabel =
      e.actie ??
      (e.soort === "Schot" || e.soort === "Rebound" ? e.soort : "");

    const uitkomstLabel = e.resultaat ?? "";

    const rawTeam: "thuis" | "uit" | undefined =
      e.team ??
      (e.vak === "aanvallend"
        ? "thuis"
        : e.vak === "verdedigend"
        ? "uit"
        : undefined);

    const teamLabel = rawTeam
      ? rawTeam === "thuis"
        ? thuisTeamNaam
        : uitTeamNaam
      : "";

    return {
      wedstrijd_id: wedstrijdId,
      wedstrijd_naam: wedstrijdNaam,        // 👈 nieuw
      locatie: locatieLabel,
      seizoen: state.season,
      wedstrijdtype: state.matchType,
      id: e.id,
      tijd_verstreken: formatTime(e.tijdSeconden),
      klok_resterend: formatTime(resterend),
      wedstrijd_minuut:
        e.wedstrijdMinuut ?? Math.max(1, Math.ceil(e.tijdSeconden / 60)),
      vak: e.vak ?? "",
      vak_id: e.vakId ?? attackMeta?.vakId ?? "",
      team: teamLabel,
      actie: actieLabel,
      uitkomst: uitkomstLabel,
      reden: e.reden,
      spelerId: e.spelerId || "",
      spelerNaam:
        e.spelerId === TEGENSTANDER_ID
          ? "Tegenstander"
          : e.spelerId
          ? spelersMap.get(e.spelerId)?.naam || ""
          : "",
      score_korbis: score?.thuis ?? "",
      score_tegenstander: score?.uit ?? "",
      x_pct: fieldEv ? Number(fieldEv.x.toFixed(1)) : "",
      y_pct: fieldEv ? Number(fieldEv.y.toFixed(1)) : "",
      aanval_nr: e.attackIndex ?? "",
      aanval_start: attackMeta ? formatTime(attackMeta.startSeconden) : "",
      aanval_einde:
        attackMeta?.endSeconden != null
          ? formatTime(attackMeta.endSeconden)
          : "",
      aanval_duur:
        aanvalDuurSeconden != null ? formatTime(aanvalDuurSeconden) : "",
    };
  });

  // ---------- 2) ATTACKS SHEET ----------
  const attackRows = state.attacks.map((a) => {
    const eventsInAttack = state.log.filter((e) => e.attackId === a.id);
    const schoten = eventsInAttack.filter((e) => e.actie === "Schot").length;
    const doorloop = eventsInAttack.filter((e) => e.actie === "Doorloop").length;
    const vrije = eventsInAttack.filter((e) => e.actie === "Vrijebal").length;
    const straf = eventsInAttack.filter((e) => e.actie === "Strafworp").length;
    const duurSeconden =
      a.endSeconden != null ? a.endSeconden - a.startSeconden : undefined;

    const teamLabel =
      a.team === "thuis" ? thuisTeamNaam : uitTeamNaam;

    return {
      wedstrijd_id: wedstrijdId,
      wedstrijd_naam: wedstrijdNaam,        // 👈 nieuw
      locatie: locatieLabel,
      seizoen: state.season,
      wedstrijdtype: state.matchType,
      aanval_nr: a.index,
      team: teamLabel,
      vak: a.vak === "aanvallend" ? "Aanvallend" : "Verdedigend",
      vak_id: a.vakId ?? "",
      start: formatTime(a.startSeconden),
      einde: a.endSeconden != null ? formatTime(a.endSeconden) : "",
      duur: duurSeconden != null ? formatTime(duurSeconden) : "",
      schoten,
      doorloop,
      vrije_ballen: vrije,
      strafworpen: straf,
    };
  });

  // ---------- 3) WISSELS SHEET ----------
  const wisselEvents = state.log
    .slice()
    .reverse()
    .filter((e) => e.soort === "Wissel");

  const wisselRows = wisselEvents.map((e) => {
    const score = scoreAtEvent.get(e.id);

    const rawTeam: "thuis" | "uit" | undefined =
      e.team ??
      (e.vak === "aanvallend"
        ? "thuis"
        : e.vak === "verdedigend"
        ? "uit"
        : undefined);

    const teamLabel = rawTeam
      ? rawTeam === "thuis"
        ? thuisTeamNaam
        : uitTeamNaam
      : "";

    return {
      wedstrijd_id: wedstrijdId,
      wedstrijd_naam: wedstrijdNaam,        // 👈 nieuw
      locatie: locatieLabel,
      seizoen: state.season,
      wedstrijdtype: state.matchType,
      id: e.id,
      tijd_verstreken: formatTime(e.tijdSeconden),
      wedstrijd_minuut:
        e.wedstrijdMinuut ?? Math.max(1, Math.ceil(e.tijdSeconden / 60)),
      vak: e.vak ?? "",
      vak_id: e.vakId ?? "",
      team: teamLabel,
      positie: e.pos ?? "",
      wissel: e.reden,
      spelerId: e.spelerId || "",
      spelerNaam: e.spelerId ? spelersMap.get(e.spelerId)?.naam || "" : "",
      score_korbis: score?.thuis ?? "",
      score_tegenstander: score?.uit ?? "",
    };
  });

  // ---------- 4) MATCH SUMMARY SHEET ----------
  const nowTime = state.tijdSeconden;
  const totalPoss =
  state.possessionThuisSeconden + state.possessionUitSeconden;

  const possThuisPct =
    totalPoss > 0 ? (state.possessionThuisSeconden / totalPoss) * 100 : 0;

  const possUitPct =
    totalPoss > 0 ? (state.possessionUitSeconden / totalPoss) * 100 : 0;
  const computeAttackSecondsPerTeam = () => {
    let thuis = 0;
    let uit = 0;

    for (const a of state.attacks) {
      const end = a.endSeconden != null ? a.endSeconden : nowTime;
      if (end <= a.startSeconden) continue;

      const duur = end - a.startSeconden;

      if (a.team === "thuis" && a.vak === "aanvallend") {
        thuis += duur;
      }
      if (a.team === "uit" && a.vak === "verdedigend") {
        uit += duur;
      }
    }

    return { thuis, uit };
  };

  const { thuis: attackThuisSec, uit: attackUitSec } =
    computeAttackSecondsPerTeam();
  const totalAttackSec = attackThuisSec + attackUitSec;
  const attackThuisPct =
    totalAttackSec > 0 ? (attackThuisSec / totalAttackSec) * 100 : 0;
  const attackUitPct =
    totalAttackSec > 0 ? (attackUitSec / totalAttackSec) * 100 : 0;

  const matchSummaryRows = [
    {
      wedstrijd_id: wedstrijdId,
      wedstrijd_naam: wedstrijdNaam,        // 👈 nieuw
      locatie: locatieLabel,
      seizoen: state.season,
      wedstrijdtype: state.matchType,
      datum: exportDate,
      tegenstander: uitTeamNaam,
      half_duur_minuten: Number.isFinite(state.halfMinuten)
        ? state.halfMinuten
        : DEFAULT_STATE.halfMinuten,
      score_korbis: state.scoreThuis,
      score_tegenstander: state.scoreUit,
      bezit_thuis_seconden: state.possessionThuisSeconden,
      bezit_uit_seconden: state.possessionUitSeconden,
      bezit_thuis_pct: totalPoss > 0 ? possThuisPct.toFixed(1) : "",
      bezit_uit_pct: totalPoss > 0 ? possUitPct.toFixed(1) : "",
      aanval_thuis_seconden: attackThuisSec,
      aanval_uit_seconden: attackUitSec,
      aanval_thuis_pct:
        totalAttackSec > 0 ? attackThuisPct.toFixed(1) : "",
      aanval_uit_pct:
        totalAttackSec > 0 ? attackUitPct.toFixed(1) : "",
      speeltijd_spelers_json: JSON.stringify(
        state.spelers.map((p) => ({
          spelerId: p.id,
          spelerNaam: p.naam,
          status: p.status,
          seconden: state.speelSeconden[p.id] ?? 0,
        }))
      ),
      wedstrijd_afgesloten: state.matchEnded ? "ja" : "nee",
    },
  ];

  // ---------- 5) MERGE MET BESTAANDE DATABASE (dbSheets) ----------
  // Zelfde wedstrijd-ID wordt eerst verwijderd; zo blijft iedere wedstrijd exact één keer bestaan.
  const keepOtherMatch = (row: any) => String(row.wedstrijd_id ?? "") !== wedstrijdId;
  const allEvents = [...(dbSheets?.events ?? []).filter(keepOtherMatch), ...eventRows];
  const allAttacks = [...(dbSheets?.attacks ?? []).filter(keepOtherMatch), ...attackRows];
  const allWissels = [...(dbSheets?.wissels ?? []).filter(keepOtherMatch), ...wisselRows];
  const normalizeMatchRow = (m: any) => ({
    wedstrijd_id: m.wedstrijd_id ?? "", wedstrijd_naam: m.wedstrijd_naam ?? "", locatie: m.locatie ?? "",
    seizoen: m.seizoen ?? "", wedstrijdtype: m.wedstrijdtype ?? "",
    datum: m.datum ?? "", tegenstander: m.tegenstander ?? "", half_duur_minuten: m.half_duur_minuten ?? "",
    score_korbis: m.score_korbis ?? "", score_tegenstander: m.score_tegenstander ?? "",
    bezit_thuis_seconden: m.bezit_thuis_seconden ?? "", bezit_uit_seconden: m.bezit_uit_seconden ?? "",
    bezit_thuis_pct: m.bezit_thuis_pct ?? "", bezit_uit_pct: m.bezit_uit_pct ?? "",
    aanval_thuis_seconden: m.aanval_thuis_seconden ?? "", aanval_uit_seconden: m.aanval_uit_seconden ?? "",
    aanval_thuis_pct: m.aanval_thuis_pct ?? "", aanval_uit_pct: m.aanval_uit_pct ?? "",
    speeltijd_spelers_json: m.speeltijd_spelers_json ?? "",
    wedstrijd_afgesloten: m.wedstrijd_afgesloten ?? "",
  });
  const allMatches = [
    ...(dbSheets?.matches ?? []).filter(keepOtherMatch).map(normalizeMatchRow),
    ...matchSummaryRows.map(normalizeMatchRow),
  ];

  // ---------- 6) VOLLEDIGE APP-BACK-UP ----------
  const spelerRows = state.spelers.map((p) => ({
    speler_id: p.id,
    naam: p.naam,
    geslacht: p.geslacht,
    status: p.status,
    actief: p.actief ? "ja" : "nee",
    foto: p.foto ?? "",
  }));

  const vak1Ids = state.vak1Aanvallend ? state.aanval : state.verdediging;
  const vak2Ids = state.vak1Aanvallend ? state.verdediging : state.aanval;
  const vakRows = [
    ...vak1Ids.map((id, index) => ({
      vak_id: 1,
      positie: index + 1,
      speler_id: id ?? "",
      speler_naam: id ? spelersMap.get(id)?.naam ?? "" : "",
    })),
    ...vak2Ids.map((id, index) => ({
      vak_id: 2,
      positie: index + 1,
      speler_id: id ?? "",
      speler_naam: id ? spelersMap.get(id)?.naam ?? "" : "",
    })),
  ];

  const teamRows = [{
    team_naam: "Korbis",
    actief_seizoen: state.season,
    aantal_spelers: state.spelers.length,
  }];

  const instellingenRows = [{
    half_duur_minuten: state.halfMinuten,
    auto_vakwissel_na_2: state.autoVakWisselNa2 ? "ja" : "nee",
    aanval_links: state.aanvalLinks ? "ja" : "nee",
    vak1_aanvallend: state.vak1Aanvallend ? "ja" : "nee",
    actief_seizoen: state.season,
    seizoen_opties_json: JSON.stringify(state.seasonOptions),
    standaard_wedstrijdtype: state.matchType,
  }];

  const sortedMatchesForInfo = allMatches.slice().sort((a: any, b: any) =>
    String(a.datum ?? "").localeCompare(String(b.datum ?? ""))
  );
  const databaseInfoRows = [{
    database_versie: DATABASE_VERSION,
    app_versie: APP_DATABASE_LABEL,
    export_datum: new Date().toISOString(),
    actief_seizoen: state.season,
    aantal_wedstrijden: allMatches.length,
    laatste_wedstrijd_datum: sortedMatchesForInfo.at(-1)?.datum ?? "",
  }];

  const nextDatabase: DatabaseSheetsData = {
    events: allEvents, attacks: allAttacks, wissels: allWissels, matches: allMatches,
    spelers: spelerRows, team: teamRows, vakindeling: vakRows,
    instellingen: instellingenRows, databaseInfo: databaseInfoRows,
  };
  setDbSheets(nextDatabase);

  const eventsSheet = XLSX.utils.json_to_sheet(allEvents);
  const attacksSheet = XLSX.utils.json_to_sheet(allAttacks);
  const wisselSheet = XLSX.utils.json_to_sheet(allWissels);
  const matchSheet = XLSX.utils.json_to_sheet(allMatches);
  const spelersSheet = XLSX.utils.json_to_sheet(spelerRows);
  const teamSheet = XLSX.utils.json_to_sheet(teamRows);
  const vakSheet = XLSX.utils.json_to_sheet(vakRows);
  const instellingenSheet = XLSX.utils.json_to_sheet(instellingenRows);
  const infoSheet = XLSX.utils.json_to_sheet(databaseInfoRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, eventsSheet, "Events");
  XLSX.utils.book_append_sheet(wb, attacksSheet, "Attacks");
  XLSX.utils.book_append_sheet(wb, wisselSheet, "Wissels");
  XLSX.utils.book_append_sheet(wb, matchSheet, "Wedstrijden");
  XLSX.utils.book_append_sheet(wb, spelersSheet, "Spelers");
  XLSX.utils.book_append_sheet(wb, teamSheet, "Team");
  XLSX.utils.book_append_sheet(wb, vakSheet, "Vakindeling");
  XLSX.utils.book_append_sheet(wb, instellingenSheet, "Instellingen");
  XLSX.utils.book_append_sheet(wb, infoSheet, "DatabaseInfo");

  const filename = `korfbal-database-${state.season.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${exportDate}.xlsx`;

  XLSX.writeFile(wb, filename);
};


const wisSeizoensdatabase = () => {
  const aantal = dbSheets?.matches?.length ?? 0;
  const ok = confirm(
    `Seizoensdatabase wissen?\n\nAlle ${aantal} opgeslagen wedstrijd${aantal === 1 ? "" : "en"} en bijbehorende historische gegevens worden definitief verwijderd. Je spelers, vakindeling en instellingen blijven behouden.\n\nDeze actie kan niet ongedaan worden gemaakt.`
  );
  if (!ok) return;

  const vak1Ids = state.vak1Aanvallend ? state.aanval : state.verdediging;
  const vak2Ids = state.vak1Aanvallend ? state.verdediging : state.aanval;
  const spelerById = new Map(state.spelers.map((p) => [p.id, p]));
  const emptyDatabase: DatabaseSheetsData = {
    events: [],
    attacks: [],
    wissels: [],
    matches: [],
    spelers: state.spelers.map((p) => ({
      speler_id: p.id, naam: p.naam, geslacht: p.geslacht, status: p.status,
      actief: p.actief ? "ja" : "nee", foto: p.foto ?? "",
    })),
    team: [{ team_naam: "Korbis", actief_seizoen: state.season, aantal_spelers: state.spelers.length }],
    vakindeling: [
      ...vak1Ids.map((id, index) => ({
        vak_id: 1, positie: index + 1, speler_id: id ?? "",
        speler_naam: id ? spelerById.get(id)?.naam ?? "" : "",
      })),
      ...vak2Ids.map((id, index) => ({
        vak_id: 2, positie: index + 1, speler_id: id ?? "",
        speler_naam: id ? spelerById.get(id)?.naam ?? "" : "",
      })),
    ],
    instellingen: [{
      half_duur_minuten: state.halfMinuten,
      auto_vakwissel_na_2: state.autoVakWisselNa2 ? "ja" : "nee",
      aanval_links: state.aanvalLinks ? "ja" : "nee",
      vak1_aanvallend: state.vak1Aanvallend ? "ja" : "nee",
      actief_seizoen: state.season,
      seizoen_opties_json: JSON.stringify(state.seasonOptions),
      standaard_wedstrijdtype: state.matchType,
    }],
    databaseInfo: [{
      database_versie: DATABASE_VERSION,
      app_versie: APP_DATABASE_LABEL,
      export_datum: new Date().toISOString(),
      actief_seizoen: state.season,
      aantal_wedstrijden: 0,
      laatste_wedstrijd_datum: "",
    }],
  };

  setDbSheets(emptyDatabase);
  setDatabaseSetupOpen(false);
  saveDatabaseToBrowser(emptyDatabase).catch((err) =>
    console.warn("Kon lege browserdatabase niet opslaan", err)
  );
};

const resetAlles = () => {
  if (!confirm("Weet je zeker dat je alles wilt wissen?")) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  setDbSheets(null);
  setDatabaseSetupOpen(true);
  clearDatabaseFromBrowser().catch((err) => console.warn("Kon browserdatabase niet wissen", err));
  setState({ 
    ...DEFAULT_STATE,
    attacks: [],
    currentAttackId: null,
  });
};

const eindeWedstrijd = () => {
  const ok = confirm(
    "Weet je zeker dat je de wedstrijd wilt beëindigen? Hierna kunnen geen nieuwe acties meer worden geregistreerd."
  );

  if (!ok) return;

  setState((prev) => {
    const now = prev.tijdSeconden;
    const attacks = [...prev.attacks];

    if (prev.currentAttackId) {
      const idx = attacks.findIndex(
        (a) => a.id === prev.currentAttackId
      );

      if (idx >= 0 && attacks[idx].endSeconden == null) {
        attacks[idx] = {
          ...attacks[idx],
          endSeconden: now,
        };
      }
    }

    return {
      ...prev,
      klokLoopt: false,
      matchEnded: true,
      attacks,
      currentAttackId: null,
    };
  });
  setTab("verslag");
};

const startNieuweDatabase = () => {
  if (!confirm(
    "Nieuwe seizoensdatabase starten? Er wordt een lege wedstrijdhistorie aangemaakt. Je huidige spelers, vakindeling en instellingen blijven in de app staan."
  )) return;

  const vak1Ids = state.vak1Aanvallend ? state.aanval : state.verdediging;
  const vak2Ids = state.vak1Aanvallend ? state.verdediging : state.aanval;
  const spelerById = new Map(state.spelers.map((p) => [p.id, p]));
  const emptyDatabase: DatabaseSheetsData = {
    events: [],
    attacks: [],
    wissels: [],
    matches: [],
    spelers: state.spelers.map((p) => ({
      speler_id: p.id, naam: p.naam, geslacht: p.geslacht, status: p.status,
      actief: p.actief ? "ja" : "nee", foto: p.foto ?? "",
    })),
    team: [{ team_naam: "Korbis", actief_seizoen: state.season, aantal_spelers: state.spelers.length }],
    vakindeling: [
      ...vak1Ids.map((id, index) => ({
        vak_id: 1, positie: index + 1, speler_id: id ?? "",
        speler_naam: id ? spelerById.get(id)?.naam ?? "" : "",
      })),
      ...vak2Ids.map((id, index) => ({
        vak_id: 2, positie: index + 1, speler_id: id ?? "",
        speler_naam: id ? spelerById.get(id)?.naam ?? "" : "",
      })),
    ],
    instellingen: [{
      half_duur_minuten: state.halfMinuten,
      auto_vakwissel_na_2: state.autoVakWisselNa2 ? "ja" : "nee",
      aanval_links: state.aanvalLinks ? "ja" : "nee",
      vak1_aanvallend: state.vak1Aanvallend ? "ja" : "nee",
      actief_seizoen: state.season,
      seizoen_opties_json: JSON.stringify(state.seasonOptions),
      standaard_wedstrijdtype: state.matchType,
    }],
    databaseInfo: [{
      database_versie: DATABASE_VERSION,
      app_versie: APP_DATABASE_LABEL,
      export_datum: new Date().toISOString(),
      actief_seizoen: state.season,
      aantal_wedstrijden: 0,
      laatste_wedstrijd_datum: "",
    }],
  };

  setDbSheets(emptyDatabase);
  setDatabaseSetupOpen(false);
};

const requestNieuweWedstrijd = () => {
  if (!databaseReady || !dbSheets) {
    setDatabaseSetupOpen(true);
    return;
  }
  clearWedstrijd();
};

const clearWedstrijd = (warningText = "Nieuwe wedstrijd starten? De huidige wedstrijdgegevens worden uit de app verwijderd. Exporteer deze eerst naar Excel als je ze wilt bewaren.") => {
  if (!confirm(warningText)) {
    return;
  }

  setState((s) => ({
    ...s,

    scoreThuis: 0,
    scoreUit: 0,

    tijdSeconden: 0,
    klokLoopt: false,
    currentHalf: 1,

    possessionOwner: null,
    possessionThuisSeconden: 0,
    possessionUitSeconden: 0,
    speelSeconden: {},

    log: [],
    attacks: [],
    currentAttackId: null,
    goalsSinceLastSwitch: 0,

    fieldEvents: [],
    markerGroup: 0,

    aanvalLinks: DEFAULT_STATE.aanvalLinks,
    activeVak: "aanvallend",
    vak1Aanvallend: true,

    opponentName: "",
    homeAway: "",
    matchEnded: false,
  }));
};

// Afgeleide arrays voor modal
const spelersAanval = state.aanval.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));
const spelersVerdediging = state.verdediging.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));
const databaseMatches = dbSheets?.matches ?? [];
const latestDatabaseMatch = databaseMatches.slice().sort((a:any,b:any)=>{ const av = typeof a.datum === "number" ? a.datum : Date.parse(String(a.datum ?? "")); const bv = typeof b.datum === "number" ? b.datum : Date.parse(String(b.datum ?? "")); return av - bv; }).at(-1);


  //////////////////////////////////////////////////////////////////////////////
  // UI ------------------------------------------------------------------------
  //////////////////////////////////////////////////////////////////////////////
  const sectionTitle: Record<typeof tab, string> = {
    spelers: "Spelers",
    vakken: "Wedstrijdinstellingen",
    wedstrijd: "Wedstrijdregistratie",
    verslag: "Wedstrijdverslag",
    insights: "Insights & analyse",
    seizoen: "Seizoensdashboard",
  };

  const shareMatch = () => {
    try {
      const encoded = encodeStateForShare(state);
      const url = `${window.location.origin}${window.location.pathname}?s=${encoded}`;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url);
        alert("Deel-link gekopieerd naar je klembord ✅");
      } else {
        prompt("Kopieer deze link:", url);
      }
    } catch (e) {
      console.error(e);
      alert("Het lukt niet om een deel-link te maken 😅");
    }
  };

  const SideNavButton = ({ id, label, icon }: { id: typeof tab; label: string; icon: "match" | "insights" | "season" | "players" | "settings" }) => (
    <button
      onClick={() => setTab(id)}
      className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition ${
        tab === id
          ? "bg-blue-50 text-blue-700 shadow-sm ring-1 ring-blue-100"
          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
      }`}
    >
      <NavGlyph type={icon} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="korbiq-app min-h-screen bg-[#f6f8fc] text-slate-900">
      <style>{`
        html, body, #root { min-height: 100%; margin: 0; background: #f6f8fc; }
        body { align-items: flex-start !important; justify-content: flex-start !important; place-items: start !important; }
        #root { width: 100%; max-width: none !important; margin: 0 !important; padding: 0 !important; }
        .korbiq-main .border.rounded-2xl, .korbiq-main .border.rounded-xl { border-color: #e4eaf2; box-shadow: 0 1px 2px rgba(15,23,42,.025), 0 8px 24px rgba(15,23,42,.035); }
        .korbiq-main table thead { color: #64748b; }
        .korbiq-main input, .korbiq-main select, .korbiq-main textarea { border-color: #dbe3ee; }
        .korbiq-main h2, .korbiq-main h3 { letter-spacing: -.01em; }
        @media (max-width: 1023px) { .korbiq-desktop-sidebar { display:none; } }
      `}</style>

      <div className="flex min-h-screen w-full items-start">
        <aside className="korbiq-desktop-sidebar sticky top-0 h-screen w-[250px] shrink-0 border-r border-slate-200/90 bg-white px-4 py-5 shadow-[2px_0_16px_rgba(15,23,42,0.025)]">
          <div className="px-2 pb-6"><KorbIQLogo /></div>

          <nav className="space-y-5">
            <section>
              <div className="mb-2 px-3 text-[11px] font-extrabold uppercase tracking-[0.12em] text-blue-700">Wedstrijd</div>
              <div className="space-y-1">
                <button onClick={requestNieuweWedstrijd} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"><span className="text-xl leading-none font-light">＋</span><span>Nieuwe wedstrijd</span></button>
                <SideNavButton id="wedstrijd" label="Huidige / live wedstrijd" icon="match" />
                <SideNavButton id="verslag" label="Wedstrijdverslag" icon="insights" />
              </div>
            </section>

            <section className="border-t border-slate-200 pt-5">
              <div className="mb-2 px-3 text-[11px] font-extrabold uppercase tracking-[0.12em] text-blue-700">Team</div>
              <div className="space-y-1">
                <SideNavButton id="insights" label="Insights & analyse" icon="insights" />
                <SideNavButton id="seizoen" label="Seizoensdashboard" icon="season" />
              </div>
            </section>

            <section className="border-t border-slate-200 pt-5">
              <div className="mb-2 px-3 text-[11px] font-extrabold uppercase tracking-[0.12em] text-blue-700">Beheer</div>
              <div className="space-y-1">
                <SideNavButton id="spelers" label="Spelers" icon="players" />
                <SideNavButton id="vakken" label="Wedstrijdinstellingen" icon="settings" />
                <button onClick={exportToExcel} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"><NavGlyph type="export"/><span>Exporteren</span></button>
                <button onClick={() => dbFileInputRef.current?.click()} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"><NavGlyph type="backup"/><span>Backup laden</span></button>
                <button onClick={shareMatch} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"><NavGlyph type="share"/><span>Deel wedstrijd</span></button>
                <button onClick={wisSeizoensdatabase} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-orange-700 transition hover:bg-orange-50"><NavGlyph type="reset"/><span>Database wissen</span></button>
                <button onClick={resetAlles} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-red-600 transition hover:bg-red-50"><NavGlyph type="reset"/><span>Reset alles</span></button>
              </div>
            </section>
          </nav>

          <div className="absolute bottom-5 left-4 right-4 rounded-2xl bg-slate-50 p-3 text-xs text-slate-500 ring-1 ring-slate-200">
            <div className="font-bold text-slate-700">{state.season}</div>
            <div className="mt-1">{databaseMatches.length} wedstrijd{databaseMatches.length === 1 ? "" : "en"} opgeslagen</div>
            <div className={`mt-2 font-semibold ${databaseReady && dbSheets ? "text-emerald-700" : "text-amber-700"}`}>
              {!databaseReady ? "● Database laden…" : dbSheets ? "● Browserdatabase actief" : "● Geen database geladen"}
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/95 backdrop-blur">
            <div className="flex min-h-[70px] items-center justify-between gap-4 px-4 md:px-6 xl:px-8">
              <div className="flex min-w-0 items-center gap-4">
                <div className="lg:hidden"><KorbIQLogo compact /></div>
                <div className="hidden h-8 w-px bg-slate-200 lg:block" />
                <div className="min-w-0">
                  <div className="truncate text-lg font-bold text-slate-900">{sectionTitle[tab]}</div>
                  <div className="mt-0.5 hidden truncate text-xs text-slate-500 md:block">
                    {state.opponentName ? `Korbis · ${state.opponentName}` : "KorbIQ · wedstrijddata en coaching"}
                  </div>
                </div>
              </div>
              <div className="hidden items-center gap-3 text-xs md:flex">
                {latestDatabaseMatch && <span className="text-slate-500">Laatste: {formatImportedDate(latestDatabaseMatch.datum)}{latestDatabaseMatch.tegenstander ? ` · ${latestDatabaseMatch.tegenstander}` : ""}</span>}
                <span className={`rounded-full px-3 py-1.5 font-semibold ${databaseReady && dbSheets ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                  {!databaseReady ? "● Database laden…" : dbSheets ? "● Browserdatabase actief" : "● Geen database geladen"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen((open) => !open)}
                className="lg:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm"
                aria-label={mobileMenuOpen ? "Menu sluiten" : "Menu openen"}
                aria-expanded={mobileMenuOpen}
              >
                <span className="text-2xl leading-none">{mobileMenuOpen ? "×" : "☰"}</span>
              </button>
            </div>

            {mobileMenuOpen && (
              <div className="lg:hidden border-t border-slate-200 bg-white px-4 py-4 shadow-lg">
                <div className="mx-auto max-w-xl space-y-4">
                  <section>
                    <div className="mb-2 px-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-blue-700">Wedstrijd</div>
                    <div className="space-y-1">
                      <button onClick={() => { setMobileMenuOpen(false); requestNieuweWedstrijd(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><span className="text-xl leading-none font-light">＋</span><span>Nieuwe wedstrijd</span></button>
                      <SideNavButton id="wedstrijd" label="Huidige / live wedstrijd" icon="match" />
                      <SideNavButton id="verslag" label="Wedstrijdverslag" icon="insights" />
                    </div>
                  </section>
                  <section className="border-t border-slate-200 pt-4">
                    <div className="mb-2 px-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-blue-700">Team</div>
                    <div className="space-y-1">
                      <SideNavButton id="insights" label="Insights & analyse" icon="insights" />
                      <SideNavButton id="seizoen" label="Seizoensdashboard" icon="season" />
                    </div>
                  </section>
                  <section className="border-t border-slate-200 pt-4">
                    <div className="mb-2 px-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-blue-700">Beheer</div>
                    <div className="space-y-1">
                      <SideNavButton id="spelers" label="Spelers" icon="players" />
                      <SideNavButton id="vakken" label="Wedstrijdinstellingen" icon="settings" />
                      <button onClick={() => { setMobileMenuOpen(false); exportToExcel(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><NavGlyph type="export"/><span>Exporteren</span></button>
                      <button onClick={() => { setMobileMenuOpen(false); dbFileInputRef.current?.click(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><NavGlyph type="backup"/><span>Backup laden</span></button>
                      <button onClick={() => { setMobileMenuOpen(false); shareMatch(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><NavGlyph type="share"/><span>Deel wedstrijd</span></button>
                      <button onClick={() => { setMobileMenuOpen(false); wisSeizoensdatabase(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-orange-700 hover:bg-orange-50"><NavGlyph type="reset"/><span>Database wissen</span></button>
                      <button onClick={() => { setMobileMenuOpen(false); resetAlles(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-red-600 hover:bg-red-50"><NavGlyph type="reset"/><span>Reset alles</span></button>
                    </div>
                  </section>
                  <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500 ring-1 ring-slate-200">
                    <div className="font-bold text-slate-700">{state.season}</div>
                    <div className="mt-1">{databaseMatches.length} wedstrijd{databaseMatches.length === 1 ? "" : "en"} opgeslagen</div>
                    <div className={`mt-2 font-semibold ${databaseReady && dbSheets ? "text-emerald-700" : "text-amber-700"}`}>
                      {!databaseReady ? "● Database laden…" : dbSheets ? "● Browserdatabase actief" : "● Geen database geladen"}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="overflow-x-auto border-t border-slate-100 lg:hidden">
              <div className="grid min-w-[650px] grid-cols-5 bg-white px-3">
                {([
                  { id: "spelers", label: "Spelers" },
                  { id: "vakken", label: "Instellingen" },
                  { id: "wedstrijd", label: "Wedstrijd" },
                  { id: "insights", label: "Insights" },
                  { id: "seizoen", label: "Seizoen" },
                ] as const).map((t) => <button key={t.id} onClick={() => setTab(t.id)} className={`border-b-2 px-3 py-3 text-sm font-semibold ${tab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500"}`}>{t.label}</button>)}
              </div>
            </div>
          </header>

          <main className="korbiq-main mx-auto w-full max-w-[1500px] px-4 py-5 md:px-6 md:py-7 xl:px-8">
      {tab === "spelers" && (
        <SpelersTab
          spelers={state.spelers}
          speelSeconden={state.speelSeconden}
          addSpeler={addSpeler}
          delSpeler={delSpeler}
          updateSpelerStatus={updateSpelerStatus}
          updateSpelerActief={updateSpelerActief}
          exportTeam={exportTeam}
          triggerImportTeam={triggerImportTeam}
        />
      )}

      {tab === "vakken" && (
        <VakindelingTab
          spelers={state.spelers}
          toegewezen={toegewezenIds}
          aanval={state.aanval}
          verdediging={state.verdediging}
          vak1Aanvallend={state.vak1Aanvallend}
          setVakPos={setVakPos}
          wisselVakken={wisselVakken}
          autoVakWisselNa2={state.autoVakWisselNa2}
          setAutoVakWisselNa2={(value) =>
            setState((s) => ({ ...s, autoVakWisselNa2: value }))
          }
          opponentName={state.opponentName}
          setOpponentName={(value) =>
            setState((s) => ({ ...s, opponentName: value }))
          }
          halfMinuten={state.halfMinuten}                       
          setHalfMinuten={(value) =>
            setState((s) => ({ ...s, halfMinuten: value }))
          }
          aanvalLinks={state.aanvalLinks}                        
          setAanvalLinks={(value) =>
            setState((s) => ({ ...s, aanvalLinks: value }))
          }
          homeAway={state.homeAway}
          setHomeAway={(value) =>
          setState((s) => ({ ...s, homeAway: value }))
          }
          season={state.season}
          seasonOptions={state.seasonOptions}
          setSeason={(value) =>
            setState((s) => ({ ...s, season: value }))
          }
          addSeason={(value) =>
            setState((s) => {
              const clean = value.trim();
              if (!clean) return s;
              return {
                ...s,
                season: clean,
                seasonOptions: Array.from(new Set([...s.seasonOptions, clean])),
              };
            })
          }
          matchType={state.matchType}
          setMatchType={(value) =>
            setState((s) => ({ ...s, matchType: value }))
          }
        />
      )}

      {tab === "wedstrijd" && (
        <WedstrijdTab
          state={state}
          setState={setState}
          spelersMap={spelersMap}
          wisselVakken={wisselVakken}
          bank={bank}
          setVakPos={setVakPos}
          toggleKlok={toggleKlok}
          openVakActionModal={(vak) => setVakActionPopup({ vak })}
          openStealModal={() => setStealPopup({})}
          opponentName={state.opponentName}
          onEndMatch={eindeWedstrijd}
          onCancelMatch={() => clearWedstrijd("Wedstrijd annuleren? Alle gegevens van de huidige wedstrijd worden verwijderd en NIET aan de seizoensdatabase toegevoegd. Deze actie kan niet ongedaan worden gemaakt.")}
        />
      )}

      {tab === "verslag" && (
        <MatchReport
          state={state}
          spelersMap={spelersMap}
          onBackToMatch={() => setTab("wedstrijd")}
        />
      )}

      {tab === "insights" && (
        <InsightsTab
          state={state}
          spelersMap={spelersMap}
          opponentName={state.opponentName}
          dbSheets={dbSheets}
        />
      )}

      {tab === "seizoen" && (
        <SeasonDashboard
          state={state}
          dbSheets={dbSheets}
        />
      )}


      {/* Pop-Ups */}
      {possPopup && (
        <PossessionModal
          team={possPopup.team}
          spelers={veldSpelers}
          opponentName={state.opponentName}
          onClose={() => setPossPopup(null)}
          onSave={(reden, spelerId) => {
            // 1) Event loggen
            logBalbezit(possPopup.team, reden, spelerId);

            // 2) Balbezit voor de timer goed zetten
            setState((s) => ({
              ...s,
              possessionOwner: possPopup.team,   
            }));

            // 3) Popup sluiten
            setPossPopup(null);
          }}
        />
      )}

      {shotPopup && (
        <ShotReboundModal
          type={shotPopup.type}
          spelers={spelersAanval}
          onClose={() => setShotPopup(null)}
          onSave={(resultaat, spelerId) => {
            logSchotOfRebound(shotPopup.type, resultaat, spelerId);
            setShotPopup(null);
          }}
        />
      )}

      {vakActionPopup && (
        <VakActionModal
          vak={vakActionPopup.vak}
          vakLabel={
            vakActionPopup.vak === "aanvallend"
              ? (state.vak1Aanvallend ? "Vak 1" : "Vak 2")
              : (state.vak1Aanvallend ? "Vak 2" : "Vak 1")
          }
          spelers={
            vakActionPopup.vak === "aanvallend" ? spelersAanval : spelersVerdediging
          }
          onClose={() => setVakActionPopup(null)}
          onComplete={(actie, uitkomst, spelerId) => {
            const vak = vakActionPopup.vak;

            handleVakActieLog(vak, actie, uitkomst, spelerId);
            setVakActionPopup(null);

            // Alleen na Mis of Korf in het aanvallende vak
            if (
              vak === "aanvallend" &&
              (uitkomst === "Mis" || uitkomst === "Korf")
            ) {
              setReboundPopup({});
            }
          }}
          onSteal={(spelerId) => {
            if (vakActionPopup.vak === "verdedigend") {
              // Steal door Korbis in verdedigend vak → bestaande logica
              logSteal(spelerId);
            } else {
              // Steal tegen Korbis in aanvallend vak
              logStealAgainstUs(spelerId);
            }
            setVakActionPopup(null);
          }}
        />
      )}
      {reboundPopup && (
        <ReboundModal
          spelers={spelersAanval}
          onClose={() => setReboundPopup(null)}
          onSave={(spelerId) => {
            logRebound(spelerId);
            setReboundPopup(null);
          }}
        />
      )}
      {stealPopup && (
        <StealModal
          spelers={spelersVerdediging}
          onClose={() => setStealPopup(null)}
          onSave={(spelerId) => {
            logSteal(spelerId);
            setStealPopup(null);
          }}
        />
      )}

      {databaseSetupOpen && databaseReady && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-gray-200 p-6">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 shrink-0 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold">!</div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Geen lokale seizoensdatabase gevonden</h2>
                <p className="mt-2 text-sm text-gray-600 leading-6">
                  De browser heeft op dit moment geen opgeslagen wedstrijdendatabase. Laad je laatste Excel-back-up om verder te gaan met een bestaand seizoen, of start bewust een nieuwe database voor de eerste wedstrijd van een nieuw seizoen.
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl bg-gray-50 border border-gray-200 p-4 text-sm text-gray-600">
              <div className="font-semibold text-gray-800">Huidige app-instellingen</div>
              <div className="mt-1">Seizoen: {state.season} · {state.spelers.length} spelers in de spelerslijst</div>
              <div className="mt-1 text-xs text-gray-500">Een nieuwe database wist je spelers of vakindeling niet; alleen de wedstrijdhistorie begint leeg.</div>
            </div>

            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => dbFileInputRef.current?.click()}
              >
                Backup laden
              </Button>
              <Button
                className="w-full"
                onClick={startNieuweDatabase}
              >
                Nieuwe database starten
              </Button>
            </div>
            <p className="mt-4 text-xs text-gray-500 text-center">
              Deze melding verdwijnt pas nadat een back-up is geladen of bewust een nieuwe database is gestart.
            </p>
          </div>
        </div>
      )}

      {/* 👇 Verborgen file input voor team-import */}
      <input
        type="file"
        accept="application/json"
        ref={teamFileInputRef}
        className="hidden"
        onChange={handleImportTeamFile}
      />
      {/* Verborgen file input voor Excel database */}
      <input
        type="file"
        accept=".xlsx"
        ref={dbFileInputRef}
        className="hidden"
        onChange={handleImportDatabaseFile}
      />
          </main>
        </div>
      </div>
    </div>
  );
}
//////////////////////////////////////////////////////////////////////////////
// --- Spelers Tab -----------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function SpelersTab({
  spelers,
  speelSeconden,
  addSpeler,
  delSpeler,
  updateSpelerStatus,
  updateSpelerActief,
  exportTeam,
  triggerImportTeam,
}: {
  spelers: Player[];
  speelSeconden: Record<string, number>;
  addSpeler: (naam: string, geslacht: Geslacht, status: PlayerStatus, foto?: string) => void;
  delSpeler: (id: string) => void;
  updateSpelerStatus: (id: string, status: PlayerStatus) => void;
  updateSpelerActief: (id: string, actief: boolean) => void;
  exportTeam: () => void;
  triggerImportTeam: () => void;
}) {
  const [naam, setNaam] = useState("");
  const [geslacht, setGeslacht] = useState<Geslacht>("Dame");
  const [status, setStatus] = useState<PlayerStatus>("Basisspeler");
  const [foto, setFoto] = useState("");

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Linker kolom: nieuwe speler + team export/import */}
      <div className="border rounded-2xl p-4 space-y-3">
        <h2 className="font-semibold mb-2">Nieuwe speler</h2>

        <input
          className="w-full border rounded-lg p-2"
          placeholder="Naam"
          value={naam}
          onChange={(e) => setNaam(e.target.value)}
        />

        <select
          className="w-full border rounded-lg p-2"
          value={geslacht}
          onChange={(e) => setGeslacht(e.target.value as Geslacht)}
        >
          {GESLACHTEN.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>

        <select
          className="w-full border rounded-lg p-2"
          value={status}
          onChange={(e) => setStatus(e.target.value as PlayerStatus)}
        >
          <option value="Basisspeler">Basisspeler</option>
          <option value="Gast">Invaller / Gast</option>
        </select>

        <input
          className="w-full border rounded-lg p-2"
          placeholder="Foto URL (optioneel)"
          value={foto}
          onChange={(e) => setFoto(e.target.value)}
        />

        <Button
          variant="primary"
          className="w-full"
          onClick={() => {
            if (!naam.trim()) return alert("Vul een naam in");
            addSpeler(naam.trim(), geslacht, status, foto.trim() || undefined);
            setNaam("");
            setFoto("");
          }}
        >
          Toevoegen
        </Button>

        {/* Team export/import knoppen */}
        <div className="flex flex-col gap-2 pt-4 border-t mt-4">
          <Button
            variant="secondary"
            className="w-full"
            onClick={exportTeam}
          >
            Exporteer team
          </Button>

          <Button
            variant="secondary"
            className="w-full"
            onClick={triggerImportTeam}
          >
            Importeer team
          </Button>
        </div>
      </div>

      {/* Rechter kolom: spelerslijst */}
      <div className="border rounded-2xl p-4">
        <h2 className="font-semibold mb-2">Spelerslijst</h2>
        <div className="flex flex-col gap-2">
          {spelers.length === 0 && (
            <div className="text-gray-500">Nog geen spelers toegevoegd.</div>
          )}
          {spelers.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-3 border rounded-xl p-2 ${p.actief ? "bg-white" : "bg-gray-100 opacity-70"}`}
            >
              <div className="flex items-center gap-3">
                <Avatar url={p.foto} naam={p.naam} />
                <div>
                  <div className="font-medium">{p.naam}</div>
                  <div className="text-xs text-gray-500">{p.geslacht} · {Math.floor((speelSeconden[p.id] ?? 0) / 60)} min gespeeld deze wedstrijd</div>
                  <select
                    value={p.status}
                    onChange={(e) => updateSpelerStatus(p.id, e.target.value as PlayerStatus)}
                    className="mt-1 border rounded-lg px-2 py-1 text-xs bg-white"
                  >
                    <option value="Basisspeler">Basisspeler</option>
                    <option value="Gast">Invaller / Gast</option>
                  </select>
                  <label className="mt-2 flex items-center gap-2 text-xs font-medium">
                    <input
                      type="checkbox"
                      checked={p.actief}
                      onChange={(e) => updateSpelerActief(p.id, e.target.checked)}
                    />
                    Actief en beschikbaar voor wedstrijden
                  </label>
                </div>
              </div>
              <button
                className="text-red-600 text-sm"
                onClick={() => delSpeler(p.id)}
              >
                Verwijder
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

//////////////////////////////////////////////////////////////////////////////
// --- Vakindeling Tab -------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function VakindelingTab({
  spelers,
  toegewezen,
  aanval,
  verdediging,
  vak1Aanvallend,
  setVakPos,
  wisselVakken,
  autoVakWisselNa2,
  setAutoVakWisselNa2,
  opponentName,
  setOpponentName,
  halfMinuten,
  setHalfMinuten,
  aanvalLinks,
  setAanvalLinks,
  homeAway,
  setHomeAway,
  season,
  seasonOptions,
  setSeason,
  addSeason,
  matchType,
  setMatchType,
}: {
  spelers: Player[];
  toegewezen: Set<string>;
  aanval: (string | null)[];
  verdediging: (string | null)[];
  vak1Aanvallend: boolean;
  setVakPos: (
    vak: VakSide,
    pos: number,
    spelerId: string | null,
    logWissel?: boolean
  ) => void;
  wisselVakken: () => void;
  autoVakWisselNa2: boolean;
  setAutoVakWisselNa2: (value: boolean) => void;
  opponentName: string;
  setOpponentName: (value: string) => void;
  halfMinuten: number;
  setHalfMinuten: (value: number) => void;
  aanvalLinks: boolean;
  setAanvalLinks: (value: boolean) => void;
  homeAway: "" | "thuis" | "uit";
  setHomeAway: (value: "" | "thuis" | "uit") => void;
  season: string;
  seasonOptions: string[];
  setSeason: (value: string) => void;
  addSeason: (value: string) => void;
  matchType: MatchType;
  setMatchType: (value: MatchType) => void;
}) {
  const [newSeason, setNewSeason] = useState("");
  const beschikbare = spelers.filter((s) => s.actief && !toegewezen.has(s.id));

  // JSX VakindelingTab
  const opstellingCompleet = [...aanval, ...verdediging].every(Boolean);
  const wedstrijdgegevensCompleet = Boolean(opponentName.trim()) && Boolean(homeAway);

  return (
    <div className="space-y-4">
      {/* Gegevens die voor iedere wedstrijd opnieuw gecontroleerd moeten worden */}
      <div className={`border-2 rounded-2xl p-4 ${wedstrijdgegevensCompleet ? "border-blue-200 bg-blue-50" : "border-amber-400 bg-amber-50"}`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-bold">Huidige wedstrijd</h2>
            <p className="text-sm text-gray-600">
              Vul deze gegevens voor iedere wedstrijd in voordat je start.
            </p>
          </div>
          <div className={`text-xs font-bold px-2 py-1 rounded-full ${wedstrijdgegevensCompleet ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
            {wedstrijdgegevensCompleet ? "Compleet" : "Nog invullen"}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold mb-1">
              Naam tegenstander <span className="text-red-600">*</span>
            </label>
            <input
              className={`border rounded-lg px-3 py-2 text-sm w-full ${opponentName.trim() ? "" : "border-amber-400 bg-white"}`}
              placeholder="Bijv. TOP, PKC..."
              value={opponentName}
              onChange={(e) => setOpponentName(e.target.value)}
            />
          </div>

          <div>
            <div className="text-sm font-semibold mb-2">
              Locatie wedstrijd <span className="text-red-600">*</span>
            </div>
            <div className="flex gap-4">
              <label className={`flex items-center gap-2 text-sm border rounded-xl px-3 py-2 bg-white ${homeAway === "thuis" ? "border-blue-500 ring-1 ring-blue-200" : ""}`}>
                <input
                  type="radio"
                  className="h-4 w-4"
                  checked={homeAway === "thuis"}
                  onChange={() => setHomeAway("thuis")}
                />
                Thuis
              </label>
              <label className={`flex items-center gap-2 text-sm border rounded-xl px-3 py-2 bg-white ${homeAway === "uit" ? "border-blue-500 ring-1 ring-blue-200" : ""}`}>
                <input
                  type="radio"
                  className="h-4 w-4"
                  checked={homeAway === "uit"}
                  onChange={() => setHomeAway("uit")}
                />
                Uit
              </label>
            </div>
            {!homeAway && <div className="text-xs text-amber-700 mt-1">Kies Thuis of Uit.</div>}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div>
            <h2 className="text-lg font-bold">Vakindeling</h2>
            <p className="text-sm text-gray-600">Alle acht posities moeten bezet zijn om de wedstrijd te kunnen starten.</p>
          </div>
          <div className={`text-xs font-bold px-2 py-1 rounded-full ${opstellingCompleet ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
            {opstellingCompleet ? "Compleet" : "Nog spelers kiezen"}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <VakBox
            titel={`${vak1Aanvallend ? "Vak 1" : "Vak 2"} (aanvallend)`}
            vak="aanvallend"
            posities={aanval}
            setVakPos={setVakPos}
            spelers={spelers}
            toegewezen={toegewezen}
          />
          <VakBox
            titel={`${vak1Aanvallend ? "Vak 2" : "Vak 1"} (verdedigend)`}
            vak="verdedigend"
            posities={verdediging}
            setVakPos={setVakPos}
            spelers={spelers}
            toegewezen={toegewezen}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="text-sm text-gray-600">
            Bank: {beschikbare.map((s) => s.naam).join(", ") || "—"}
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={autoVakWisselNa2}
                onChange={(e) => setAutoVakWisselNa2(e.target.checked)}
              />
              <span>Automatisch wisselen na 2 doelpunten</span>
            </label>

            <button
              className="px-3 py-2 border rounded-xl text-sm"
              onClick={wisselVakken}
            >
              Vakken wisselen
            </button>
          </div>
        </div>

        {/* Wedstrijdduur + aanval links/rechts */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Wedstrijdduur per helft:</span>
            <Button
              size="sm"
              onClick={() =>
                setHalfMinuten(
                  Math.max(
                    1,
                    (Number.isFinite(halfMinuten)
                      ? halfMinuten
                      : DEFAULT_STATE.halfMinuten) - 1
                  )
                )
              }
            >
              −
            </Button>
            <span className="w-10 text-center text-sm">
              {Number.isFinite(halfMinuten)
                ? halfMinuten
                : DEFAULT_STATE.halfMinuten}
            </span>
            <Button
              size="sm"
              onClick={() =>
                setHalfMinuten(
                  Math.min(
                    60,
                    (Number.isFinite(halfMinuten)
                      ? halfMinuten
                      : DEFAULT_STATE.halfMinuten) + 1
                  )
                )
              }
            >
              +
            </Button>
            <span className="text-sm">minuten</span>
          </div>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAanvalLinks(!aanvalLinks)}
          >
            Aanval {aanvalLinks ? "links" : "rechts"} starten
          </Button>
        </div>

        {/* Minder vaak te wijzigen instellingen */}
        <div className="border rounded-2xl p-4 bg-gray-50">
          <div className="mb-3">
            <h3 className="font-bold">Seizoeninstellingen</h3>
            <p className="text-xs text-gray-500">
              Deze instellingen wijzigen meestal niet iedere wedstrijd en worden onthouden.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Seizoen:</label>
              <select
                className="border rounded-lg px-2 py-2 text-sm w-full"
                value={season}
                onChange={(e) => setSeason(e.target.value)}
              >
                {seasonOptions.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
              <div className="flex gap-2 mt-2">
                <input
                  className="border rounded-lg px-2 py-1.5 text-sm flex-1 min-w-0"
                  placeholder="Bijv. Zaal 2027/2028"
                  value={newSeason}
                  onChange={(e) => setNewSeason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newSeason.trim()) {
                      e.preventDefault();
                      addSeason(newSeason);
                      setNewSeason("");
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!newSeason.trim()}
                  onClick={() => {
                    addSeason(newSeason);
                    setNewSeason("");
                  }}
                >
                  Nieuw seizoen
                </Button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Wedstrijdtype:</label>
              <select
                className="border rounded-lg px-2 py-2 text-sm w-full"
                value={matchType}
                onChange={(e) => setMatchType(e.target.value as MatchType)}
              >
                <option value="Competitie">Competitie</option>
                <option value="Oefenwedstrijd">Oefenwedstrijd</option>
                <option value="Toernooi">Toernooi</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function VakBox({
  titel,
  vak,
  posities,
  setVakPos,
  spelers,
  toegewezen,
}: {
  titel: string;
  vak: VakSide;
  posities: (string | null)[];
  setVakPos: (
    vak: VakSide,
    pos: number,
    spelerId: string | null,
    logWissel?: boolean
  ) => void;
  spelers: Player[];
  toegewezen: Set<string>;
}) {
  // bepaal welke spelers in dit vak staan
  const spelersInVak = posities
    .map((id) => spelers.find((s) => s.id === id))
    .filter((x): x is Player => Boolean(x));

  const dames = spelersInVak.filter((p) => p.geslacht === "Dame").length;
  const heren = spelersInVak.filter((p) => p.geslacht === "Heer").length;

  const isValid = dames === 2 && heren === 2;
  const boxBorder = isValid ? "border-gray-200" : "border-red-500";
  const titleColor = isValid ? "text-gray-900" : "text-red-600";

  return (
    <div className={`border rounded-2xl p-4 ${boxBorder}`}>
      <div className={`font-semibold mb-1 ${titleColor}`}>{titel}</div>
      {!isValid && (
        <div className="text-xs text-red-600 mb-2">
          Let op: dit vak heeft geen 2 dames en 2 heren (nu {dames} dames, {heren} heren).
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {posities.map((spelerId, i) => {
          const currentId = spelerId || undefined;
          const opties = spelers.filter(
            (s) => s.actief && (!toegewezen.has(s.id) || s.id === currentId)
          );
          return (
            <div key={i} className="flex items-center gap-2">
              <div className="w-8 text-sm text-gray-500">{i + 1}.</div>
              <select
                className={`w-full border rounded-lg p-2 ${
                  isValid ? "" : "border-red-400"
                }`}
                value={spelerId || ""}
                onChange={(e) =>
                  setVakPos(vak, i, e.target.value || null, false) // 👈 geen logging
                }
              >
                <option value="">— Kies speler —</option>
                {opties.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.naam} ({s.geslacht})
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
//////////////////////////////////////////////////////////////////////////////
// --- Wedstrijd Tab ---------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function WedstrijdTab({
  state,
  setState,
  spelersMap,
  wisselVakken,
  bank,
  setVakPos,
  toggleKlok,
  openVakActionModal,
  opponentName,
  onEndMatch,
  onCancelMatch,
}: {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  spelersMap: Map<string, Player>;
  wisselVakken: () => void;
  bank: Player[];
  setVakPos: (
    vak: VakSide,
    pos: number,
    spelerId: string | null,
    logWissel?: boolean
  ) => void;
  toggleKlok: (aan: boolean) => void;
  openVakActionModal: (vak: VakSide) => void;
  openStealModal: () => void;
  opponentName: string;
  onEndMatch: () => void;
  onCancelMatch: () => void;
}) {
  const handleVakClick = (vak: VakSide) => {
    // Klik op NIET-actief vak:
    // alleen dit vak actief maken / nieuwe aanval starten
    if (state.activeVak !== vak) {
      setState((s) => startAttackForVak(s, vak));
      return;
    }
  
    // Klik op ACTIEF vak:
    // zorg dat er een aanval bestaat
    if (!state.currentAttackId) {
      setState((s) => startAttackForVak(s, vak));
    }
  
    // Alleen bij het actieve vak de actie-popup openen
    openVakActionModal(vak);
  };


  // 🔹 helper om een veld-event (heatmap puntje) toe te voegen
  const addFieldEvent = (vak: VakSide, xPct: number, yPct: number) => {
    setState((s) => {
      const { attackId } = getCurrentAttackInfo(s);
      const newEvent: FieldEvent = {
        id: uid("fe"),
        vak,
        x: xPct,
        y: yPct,
        tijdSeconden: s.tijdSeconden,
        attackId,
        markerGroup: s.markerGroup,
        // actie/resultaat komen na de popup
      };
      return { ...s, fieldEvents: [...s.fieldEvents, newEvent] };
    });
  };

  const fixtureLabel =
  state.homeAway === "thuis"
    ? `Korbis - ${opponentName || "Tegenstander"}`
    : state.homeAway === "uit"
    ? `${opponentName || "Tegenstander"} - Korbis`
    : `Korbis - ${opponentName || "Tegenstander"}`;


  const [scoreEditorOpen, setScoreEditorOpen] = useState(false);
  const [draftScoreThuis, setDraftScoreThuis] = useState(state.scoreThuis);
  const [draftScoreUit, setDraftScoreUit] = useState(state.scoreUit);

  const openScoreEditor = () => {
    setDraftScoreThuis(state.scoreThuis);
    setDraftScoreUit(state.scoreUit);
    setScoreEditorOpen(true);
  };

  const scoreAtEvent = useMemo(() => {
    const map = new Map<string, { thuis: number; uit: number }>();
    let thuis = 0;
    let uit = 0;
    for (const e of state.log.slice().reverse()) {
      const isThuisGoal = e.soort === "Kans" && e.vak === "aanvallend" && (e.reden === "Gescoord" || e.reden === "Doelpunt");
      const isUitGoal = e.soort === "Gemis" && e.vak === "verdedigend" && (e.reden === "Doorgelaten" || e.reden === "Doelpunt");
      if (isThuisGoal) thuis += 1;
      if (isUitGoal) uit += 1;
      map.set(e.id, { thuis, uit });
    }
    return map;
  }, [state.log]);

  const latestActions = state.log.filter((e) => e.soort !== "Wissel").slice(0, 5);
  const matchDateLabel = new Date().toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" });

  // Fase 5: compacte live coachinformatie. We kijken bewust vooral naar
  // recente aanvallen, zodat een signaal tijdens de wedstrijd bruikbaar is.
  const liveAttemptEvents = state.log.filter((e) =>
    ["Schot", "Doorloop", "Vrijebal", "Strafworp"].includes(String(e.actie ?? "")) &&
    ["Raak", "Mis", "Korf", "Verdedigd"].includes(String(e.resultaat ?? ""))
  );

  const attackTeamForEvent = (e: LogEvent): AttackTeam | undefined => {
    if (e.team === "thuis" || e.team === "uit") return e.team;
    if (e.vak === "aanvallend") return "thuis";
    if (e.vak === "verdedigend") return "uit";
    return undefined;
  };

  const finishedHomeAttacks = state.attacks
    .filter((a) => a.team === "thuis")
    .slice(-5);
  const finishedAwayAttacks = state.attacks
    .filter((a) => a.team === "uit")
    .slice(-5);

  const eventsForAttacks = (attacks: AttackMeta[]) => {
    const ids = new Set(attacks.map((a) => a.id));
    return state.log.filter((e) => e.attackId && ids.has(e.attackId));
  };

  const recentHomeEvents = eventsForAttacks(finishedHomeAttacks);
  const recentAwayEvents = eventsForAttacks(finishedAwayAttacks);
  const recentHomeAttempts = recentHomeEvents.filter((e) =>
    liveAttemptEvents.some((x) => x.id === e.id) && attackTeamForEvent(e) === "thuis"
  );
  const recentAwayAttempts = recentAwayEvents.filter((e) =>
    liveAttemptEvents.some((x) => x.id === e.id) && attackTeamForEvent(e) === "uit"
  );
  const recentHomeGoals = recentHomeAttempts.filter((e) => e.resultaat === "Raak").length;
  const recentAwayGoals = recentAwayAttempts.filter((e) => e.resultaat === "Raak").length;
  const recentNoChanceAttacks = finishedHomeAttacks.filter((a) =>
    !recentHomeAttempts.some((e) => e.attackId === a.id)
  ).length;
  const recentRebounds = recentHomeEvents.filter(
    (e) => e.soort === "Rebound" && e.vak === "aanvallend"
  );
  const recentWonRebounds = recentRebounds.filter((e) => e.reden === "Rebound").length;
  const recentReboundPct = recentRebounds.length
    ? (recentWonRebounds / recentRebounds.length) * 100
    : null;

  type LiveCoachSignal = { priority: 1 | 2 | 3; tone: "goed" | "letop" | "info"; text: string };
  const liveCoachSignals: LiveCoachSignal[] = [];
  const addLiveSignal = (signal: LiveCoachSignal) => liveCoachSignals.push(signal);

  const recentAttemptsPerAttack = finishedHomeAttacks.length
    ? recentHomeAttempts.length / finishedHomeAttacks.length
    : 0;
  const allFinishedHomeAttacks = state.attacks.filter((a) => a.team === "thuis");
  const allHomeEvents = eventsForAttacks(allFinishedHomeAttacks);
  const allHomeAttempts = allHomeEvents.filter((e) =>
    liveAttemptEvents.some((x) => x.id === e.id) && attackTeamForEvent(e) === "thuis"
  );
  const matchAttemptsPerAttack = allFinishedHomeAttacks.length
    ? allHomeAttempts.length / allFinishedHomeAttacks.length
    : 0;

  const recentKorfgericht = recentHomeAttempts.filter(
    (e) => e.resultaat === "Raak" || e.resultaat === "Korf"
  ).length;
  const recentKorfgerichtPct = recentHomeAttempts.length
    ? (recentKorfgericht / recentHomeAttempts.length) * 100
    : null;

  const recentAttackIds = new Set(finishedHomeAttacks.map((a) => a.id));
  const recentFieldShots = state.fieldEvents.filter(
    (fe) => fe.attackId && recentAttackIds.has(fe.attackId) && !!fe.actie && !!fe.resultaat
  );
  const recentFarShots = recentFieldShots.filter((fe) => getShotZone(fe) === "Ver afstandsschot");
  const recentFarKorfgericht = recentFarShots.filter(
    (fe) => fe.resultaat === "raak" || fe.resultaat === "korf"
  ).length;

  const recentWonReboundEvents = recentRebounds.filter((e) => e.reden === "Rebound");
  const recentSecondChanceGoals = recentWonReboundEvents.filter((rebound) =>
    recentHomeAttempts.some(
      (e) =>
        e.attackId &&
        e.attackId === rebound.attackId &&
        e.tijdSeconden >= rebound.tijdSeconden &&
        e.resultaat === "Raak"
    )
  ).length;

  const recentAwayNoChanceAttacks = finishedAwayAttacks.filter((a) =>
    !recentAwayAttempts.some((e) => e.attackId === a.id)
  ).length;
  const recentAwayAttemptsPerAttack = finishedAwayAttacks.length
    ? recentAwayAttempts.length / finishedAwayAttacks.length
    : 0;

  const recentHomeByVak = (vakId: VakId) => {
    const attacks = state.attacks.filter((a) => a.team === "thuis" && a.vakId === vakId).slice(-5);
    const ev = eventsForAttacks(attacks);
    const attempts = ev.filter((e) => liveAttemptEvents.some((x) => x.id === e.id) && attackTeamForEvent(e) === "thuis");
    return { attacks, attempts, goals: attempts.filter((e) => e.resultaat === "Raak").length };
  };
  const recentAwayByVak = (vakId: VakId) => {
    const attacks = state.attacks.filter((a) => a.team === "uit" && a.vakId === vakId).slice(-5);
    const ev = eventsForAttacks(attacks);
    const attempts = ev.filter((e) => liveAttemptEvents.some((x) => x.id === e.id) && attackTeamForEvent(e) === "uit");
    return { attacks, attempts, goals: attempts.filter((e) => e.resultaat === "Raak").length };
  };

  if (finishedAwayAttacks.length >= 5 && recentAwayGoals >= 3) {
    addLiveSignal({ priority: 1, tone: "letop", text: `Verdedigend direct aandacht: tegenstander scoorde ${recentAwayGoals} keer uit de laatste 5 aanvallen.` });
  }
  ([1, 2] as VakId[]).forEach((vakId) => {
    const v = recentAwayByVak(vakId);
    if (v.attacks.length >= 5 && v.goals >= 3) {
      addLiveSignal({ priority: 1, tone: "letop", text: `Vak ${vakId} onder druk: tegenstander scoorde ${v.goals} keer uit de laatste 5 aanvallen tegen dit vak.` });
    }
  });

  if (finishedHomeAttacks.length >= 5) {
    if (recentHomeGoals === 0) {
      addLiveSignal({ priority: 1, tone: "letop", text: "Aanvallend direct aandacht: laatste 5 aanvallen zonder goal." });
    } else if (recentHomeGoals >= 3) {
      addLiveSignal({ priority: 3, tone: "goed", text: `Sterke aanvallende fase: ${recentHomeGoals} goals uit de laatste 5 aanvallen.` });
    }
    if (recentNoChanceAttacks >= 2) {
      addLiveSignal({ priority: 2, tone: "letop", text: `${recentNoChanceAttacks} van de laatste 5 aanvallen eindigden zonder doelpoging.` });
    }
    if (matchAttemptsPerAttack >= 1.15 && recentAttemptsPerAttack <= matchAttemptsPerAttack - 0.35) {
      addLiveSignal({ priority: 2, tone: "letop", text: `Kanscreatie valt terug: recent ${recentAttemptsPerAttack.toFixed(2)} kansen per aanval, wedstrijdgemiddelde ${matchAttemptsPerAttack.toFixed(2)}.` });
    }
  }

  if (recentHomeAttempts.length >= 7 && recentKorfgerichtPct != null) {
    if (recentKorfgerichtPct < 50) {
      addLiveSignal({ priority: 2, tone: "letop", text: `Korfgerichtheid laag: slechts ${recentKorfgerichtPct.toFixed(0)}% van de laatste ${recentHomeAttempts.length} kansen was raak of raakte de korf.` });
    } else if (recentKorfgerichtPct >= 75) {
      addLiveSignal({ priority: 3, tone: "goed", text: `Goede korfgerichtheid: ${recentKorfgerichtPct.toFixed(0)}% van de recente kansen was raak of raakte de korf.` });
    }
  }

  if (recentFieldShots.length >= 7 && recentFarShots.length >= 4) {
    const farShare = (recentFarShots.length / recentFieldShots.length) * 100;
    const farQuality = recentFarShots.length ? (recentFarKorfgericht / recentFarShots.length) * 100 : 0;
    if (farShare >= 55 && farQuality < 50) {
      addLiveSignal({ priority: 2, tone: "letop", text: `Veel verre pogingen: ${recentFarShots.length} van de laatste ${recentFieldShots.length}; slechts ${farQuality.toFixed(0)}% was raak of korfgericht.` });
    }
  }

  if (recentReboundPct != null && recentRebounds.length >= 4) {
    if (recentReboundPct < 40) {
      addLiveSignal({ priority: 2, tone: "letop", text: `Aanvallende rebound recent laag: ${recentReboundPct.toFixed(0)}%.` });
    } else if (recentReboundPct >= 65) {
      addLiveSignal({ priority: 3, tone: "goed", text: `Aanvallende rebound sterk: ${recentReboundPct.toFixed(0)}% in de recente fase.` });
    }
  }

  if (recentWonReboundEvents.length >= 4) {
    const secondChancePct = (recentSecondChanceGoals / recentWonReboundEvents.length) * 100;
    if (recentSecondChanceGoals === 0) {
      addLiveSignal({ priority: 2, tone: "letop", text: `${recentWonReboundEvents.length} recente aanvallende rebounds gewonnen, maar nog geen goal uit die tweede kansen.` });
    } else if (secondChancePct >= 50) {
      addLiveSignal({ priority: 3, tone: "goed", text: `Tweede kansen leveren op: ${recentSecondChanceGoals} van ${recentWonReboundEvents.length} gewonnen rebounds leidden tot een goal.` });
    }
  }

  if (finishedAwayAttacks.length >= 5) {
    if (recentAwayNoChanceAttacks >= 3) {
      addLiveSignal({ priority: 3, tone: "goed", text: `Sterke verdedigende fase: tegenstander kwam in ${recentAwayNoChanceAttacks} van de laatste 5 aanvallen niet tot een doelpoging.` });
    } else if (recentAwayAttemptsPerAttack >= 1.8) {
      addLiveSignal({ priority: 2, tone: "letop", text: `Tegenstander creëert veel: ${recentAwayAttemptsPerAttack.toFixed(1)} kansen per aanval in de laatste 5 aanvallen.` });
    }
  }

  ([1, 2] as VakId[]).forEach((vakId) => {
    const v = recentHomeByVak(vakId);
    if (v.attacks.length >= 5) {
      const kpa = v.attempts.length / v.attacks.length;
      if (kpa < 0.8) addLiveSignal({ priority: 2, tone: "letop", text: `Vak ${vakId} komt moeilijk tot kansen: ${kpa.toFixed(1)} kans per aanval in de laatste 5 aanvallen.` });
      if (v.goals >= 3) addLiveSignal({ priority: 3, tone: "goed", text: `Vak ${vakId} sterk aanvallend: ${v.goals} goals uit de laatste 5 aanvallen.` });
    }
  });

  liveCoachSignals.sort((a, b) => a.priority - b.priority || (a.tone === "letop" ? -1 : b.tone === "letop" ? 1 : 0));
  const visibleLiveCoachSignals = liveCoachSignals.slice(0, 3);

  if (
    visibleLiveCoachSignals.length === 0 &&
    !state.matchEnded &&
    (state.tijdSeconden > 0 || state.currentHalf === 2 || state.log.length > 0 || state.attacks.length > 0)
  ) {
    visibleLiveCoachSignals.push({ priority: 3, tone: "info", text: "Geen opvallend live signaal op dit moment." });
  }


    const zichtbareFieldEvents = state.fieldEvents.filter(
      (e) => e.markerGroup === state.markerGroup
    );
    
    const aanvalMarkers = zichtbareFieldEvents.filter(
      (e) => e.vak === "aanvallend"
    );
    
    const verdedigMarkers = zichtbareFieldEvents.filter(
      (e) => e.vak === "verdedigend"
    );

  const countGeslachtInVak = (ids: (string | null)[]) => {
    let dames = 0;
    let heren = 0;
    ids.forEach((id) => {
      if (!id) return;
      const p = spelersMap.get(id);
      if (!p) return;
      if (p.geslacht === "Dame") dames++;
      if (p.geslacht === "Heer") heren++;
    });
    return { dames, heren };
  };

  const aanvCounts = countGeslachtInVak(state.aanval);
  const verdCounts = countGeslachtInVak(state.verdediging);
  const aanvValid = aanvCounts.dames === 2 && aanvCounts.heren === 2;
  const verdValid = verdCounts.dames === 2 && verdCounts.heren === 2;
  const nowTime = state.tijdSeconden;
  const halfMinuten = Number.isFinite(state.halfMinuten)
    ? state.halfMinuten
    : DEFAULT_STATE.halfMinuten;
  const halfTotal = halfMinuten * 60;

  const halfStart = state.currentHalf === 1 ? 0 : halfTotal;
  const halfElapsed = Math.max(
    0,
    Math.min(halfTotal, state.tijdSeconden - halfStart)
  );
  const resterend = Math.max(halfTotal - halfElapsed, 0);

      const computeAttackSeconds = (team: AttackTeam) => {
        let total = 0;
        for (const a of state.attacks) {
          const shouldCount =
            team === "thuis"
              ? a.team === "thuis" && a.vak === "aanvallend"
              : a.team === "uit" && a.vak === "verdedigend";
      
          if (!shouldCount) continue;
      
          const end = a.endSeconden != null ? a.endSeconden : nowTime;
          if (end > a.startSeconden) total += end - a.startSeconden;
        }
        return total;
      };

  const attackThuisSec = computeAttackSeconds("thuis");
  const attackUitSec = computeAttackSeconds("uit");
  const totalAttackSec = attackThuisSec + attackUitSec;
  const attackThuisPct =
  totalAttackSec > 0 ? (attackThuisSec / totalAttackSec) * 100 : 0;

const attackUitPct =
  totalAttackSec > 0 ? (attackUitSec / totalAttackSec) * 100 : 0;


  // 🔹 Wanneer is de wedstrijd "niet gestart"?
  //   → tijd = 0, 1e helft, geen log/aanvallen
  const wedstrijdGestart =
    state.tijdSeconden > 0 ||
    state.currentHalf === 2 ||
    state.log.length > 0 ||
    state.attacks.length > 0;

    const wedstrijdNietGestart =
    !wedstrijdGestart && !state.matchEnded;
  
  const wedstrijdAfgelopen = state.matchEnded;
  
  const eersteHelftAfgelopen =
    state.currentHalf === 1 &&
    resterend === 0 &&
    !state.klokLoopt &&
    !wedstrijdAfgelopen;

  const showOverlay =
    wedstrijdNietGestart ||
    eersteHelftAfgelopen ||
    wedstrijdAfgelopen;

  const overlayTitle = wedstrijdAfgelopen
    ? "Wedstrijd afgelopen"
    : eersteHelftAfgelopen
    ? "Rust"
    : wedstrijdNietGestart
    ? "Wedstrijd is nog niet gestart"
    : "Wedstrijd staat op pauze";

  const overlayText = wedstrijdAfgelopen
    ? `Eindstand: Korbis ${state.scoreThuis} - ${state.scoreUit} ${
        opponentName || "Tegenstander"
      }`
    : eersteHelftAfgelopen
    ? "De eerste helft is afgelopen. Start de tweede helft wanneer beide teams klaarstaan."
    : wedstrijdNietGestart
    ? "Druk op start om de timer te laten lopen en events te registreren."
    : "Druk op hervatten om verder te gaan met de wedstrijd.";

  const overlayButtonLabel = eersteHelftAfgelopen
    ? "Start 2e helft"
    : wedstrijdNietGestart
    ? "Start wedstrijd"
    : "Hervat wedstrijd";

  const startValidationErrors = (() => {
    const errors: string[] = [];
    if (!state.opponentName.trim()) errors.push("Vul de naam van de tegenstander in.");
    if (!state.homeAway) errors.push("Kies de locatie: Thuis of Uit.");
    const legePosities = [...state.aanval, ...state.verdediging].filter((id) => !id).length;
    if (legePosities > 0) {
      errors.push(`De vakindeling is nog niet compleet: ${legePosities} positie${legePosities === 1 ? "" : "s"} staat nog op Kies speler.`);
    }
    return errors;
  })();

  const startWedstrijdMetControle = () => {
    if (startValidationErrors.length > 0) {
      alert(`Wedstrijd kan nog niet starten:\n\n${startValidationErrors.map((x) => `• ${x}`).join("\n")}\n\nVul dit aan bij Wedstrijdinstellingen.`);
      return;
    }
    toggleKlok(true);
  };

  const startTweedeHelft = () => {
    setState((s) => {
      const halfMinuten = Number.isFinite(s.halfMinuten)
        ? s.halfMinuten
        : DEFAULT_STATE.halfMinuten;
      const halfTotal = halfMinuten * 60;

      return {
        ...s,
        currentHalf: 2,
        tijdSeconden: Math.max(s.tijdSeconden, halfTotal),
        klokLoopt: true,
        aanvalLinks: !s.aanvalLinks,
        markerGroup: s.markerGroup + 1,
      };
    });
  };

    return (
      <div className="relative space-y-4">
    
        {showOverlay && (
          <div className="absolute inset-0 z-40 flex items-start justify-center pt-20 rounded-2xl overflow-hidden">
    
            {/* dim layer */}
            <div className="absolute inset-0 bg-black/60" />
    
            {/* card */}
            <div className="relative z-10 w-full max-w-xl mx-4 rounded-2xl bg-white p-6 shadow-2xl text-center">
    
              <div className="text-3xl font-extrabold mb-2">
                {overlayTitle}
              </div>
    
              <div className="text-sm text-gray-600 mb-6">
                {overlayText}
              </div>

              {wedstrijdNietGestart && startValidationErrors.length > 0 && (
                <div className="mb-4 text-left rounded-xl border border-amber-300 bg-amber-50 p-3">
                  <div className="font-bold text-amber-900 mb-1">Nog invullen voor de start:</div>
                  <ul className="list-disc pl-5 text-sm text-amber-900">
                    {startValidationErrors.map((error) => <li key={error}>{error}</li>)}
                  </ul>
                </div>
              )}

              {!wedstrijdAfgelopen && (
                <Button
                  variant="primary"
                  className="w-full text-3xl font-extrabold py-7 min-h-[88px] rounded-2xl"
                  onClick={() =>
                    eersteHelftAfgelopen
                      ? startTweedeHelft()
                      : wedstrijdNietGestart
                      ? startWedstrijdMetControle()
                      : toggleKlok(true)
                  }
                >
                  {overlayButtonLabel}
                </Button>
              )}

              {wedstrijdAfgelopen && (
                <div className="space-y-3">
                  <div className="text-lg font-semibold text-green-700">
                    Wedstrijd is definitief afgesloten
                  </div>

                  <div className="text-sm text-gray-500">
                    Je kunt nu de wedstrijdgegevens bekijken in Insights
                    of exporteren naar Excel.
                  </div>
                </div>
              )}
    
            </div>
          </div>
        )}
      {/* Wedstrijdheader in KorbIQ-stijl */}
      <div className="space-y-3" data-no-pause>
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="grid grid-cols-2 lg:grid-cols-5 divide-x divide-y lg:divide-y-0 divide-slate-100">
            <div className="flex items-center gap-3 p-4 min-w-0">
              <MatchInfoGlyph type="shirt" />
              <div className="min-w-0"><div className="text-xs text-slate-500">Wedstrijd</div><div className="font-bold truncate">{fixtureLabel}</div></div>
            </div>
            <div className="flex items-center gap-3 p-4 min-w-0">
              <MatchInfoGlyph type="trophy" />
              <div className="min-w-0"><div className="text-xs text-slate-500">Competitie</div><div className="font-bold truncate">{state.matchType}</div><div className="text-[11px] text-slate-400 truncate">{state.season}</div></div>
            </div>
            <div className="flex items-center gap-3 p-4 min-w-0">
              <MatchInfoGlyph type="calendar" />
              <div><div className="text-xs text-slate-500">Datum</div><div className="font-bold">{matchDateLabel}</div></div>
            </div>
            <div className="flex items-center gap-3 p-4 min-w-0">
              <MatchInfoGlyph type="clock" />
              <div><div className="text-xs text-slate-500">Resterend</div><div className="font-bold tabular-nums">{formatTime(resterend)}</div><div className="text-[11px] text-slate-400">{state.currentHalf}e helft</div></div>
            </div>
            <button type="button" onClick={openScoreEditor} className="group flex items-center justify-between gap-3 p-4 text-left hover:bg-blue-50/60 transition" title="Klik om de stand aan te passen">
              <div className="flex items-center gap-3"><MatchInfoGlyph type="score" /><div><div className="text-xs text-slate-500">Stand</div><div className="text-[11px] text-blue-600 group-hover:underline">Klik om aan te passen</div></div></div>
              <div className="rounded-xl bg-[#124a98] px-4 py-2 text-xl font-extrabold text-white tabular-nums shadow-sm whitespace-nowrap">{state.scoreThuis} - {state.scoreUit}</div>
            </button>
          </div>
        </div>

        {!wedstrijdNietGestart && !wedstrijdAfgelopen && !eersteHelftAfgelopen && (
          <button
            type="button"
            onClick={() => toggleKlok(!state.klokLoopt)}
            className={`w-full rounded-xl border px-4 py-3 text-center font-extrabold tracking-wide transition ${
              state.klokLoopt
                ? "border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100"
                : "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100"
            }`}
          >
            {state.klokLoopt ? "Ⅱ  PAUZEER WEDSTRIJD" : "▶  HERVAT WEDSTRIJD"}
            <span className="ml-3 font-semibold text-sm opacity-70">{formatTime(resterend)} resterend</span>
          </button>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid grid-cols-2 gap-2 text-sm flex-1 min-w-[320px]">
            <div className="rounded-xl border border-green-100 bg-green-50/70 px-3 py-2"><span className="font-semibold text-green-800">Korbis aanvalstijd</span><span className="float-right font-bold">{totalAttackSec > 0 ? attackThuisPct.toFixed(1) : "0.0"}% · {formatTime(attackThuisSec)}</span></div>
            <div className="rounded-xl border border-red-100 bg-red-50/70 px-3 py-2"><span className="font-semibold text-red-800">Tegenstander aanvalstijd</span><span className="float-right font-bold">{totalAttackSec > 0 ? attackUitPct.toFixed(1) : "0.0"}% · {formatTime(attackUitSec)}</span></div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              size="md"
              variant="secondary"
              disabled={state.currentHalf === 2}
              onClick={() =>
                setState((s) => {
                  const halfMinuten = Number.isFinite(s.halfMinuten) ? s.halfMinuten : DEFAULT_STATE.halfMinuten;
                  const halfTotal = halfMinuten * 60;
                  return { ...s, currentHalf: 2, tijdSeconden: Math.max(s.tijdSeconden, halfTotal), klokLoopt: false, aanvalLinks: !s.aanvalLinks, markerGroup: s.markerGroup + 1 };
                })
              }
            >
              2e helft
            </Button>
            <Button size="md" variant="danger" onClick={onEndMatch}>Einde wedstrijd</Button>
            <Button size="md" variant="secondary" onClick={onCancelMatch}>Wedstrijd annuleren</Button>
          </div>
        </div>
      </div>

      {scoreEditorOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4" data-no-pause onMouseDown={(e) => { if (e.target === e.currentTarget) setScoreEditorOpen(false); }}>
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4 mb-5"><div><div className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">Stand aanpassen</div><div className="mt-1 text-xl font-extrabold">{fixtureLabel}</div></div><button className="h-9 w-9 rounded-full bg-slate-100 text-xl" onClick={() => setScoreEditorOpen(false)}>×</button></div>
            <div className="grid grid-cols-2 gap-4">
              {[{label:"Korbis",value:draftScoreThuis,set:setDraftScoreThuis,tone:"blue"},{label:opponentName || "Tegenstander",value:draftScoreUit,set:setDraftScoreUit,tone:"slate"}].map((team) => (
                <div key={team.label} className={`rounded-2xl border p-4 text-center ${team.tone === "blue" ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50"}`}>
                  <div className="font-bold truncate mb-3">{team.label}</div>
                  <div className="flex items-center justify-center gap-3"><button className="h-10 w-10 rounded-xl border bg-white text-xl font-bold" onClick={() => team.set(Math.max(0, team.value - 1))}>−</button><div className="w-14 text-4xl font-extrabold tabular-nums">{team.value}</div><button className="h-10 w-10 rounded-xl border bg-white text-xl font-bold" onClick={() => team.set(team.value + 1)}>+</button></div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex gap-3"><Button className="flex-1" onClick={() => setScoreEditorOpen(false)}>Annuleren</Button><Button variant="primary" className="flex-1" onClick={() => { setState((s) => ({ ...s, scoreThuis: draftScoreThuis, scoreUit: draftScoreUit })); setScoreEditorOpen(false); }}>Stand opslaan</Button></div>
          </div>
        </div>
      )}

          {/* Fase 5: live coachsignalen, compact en altijd op dezelfde plek */}
          {wedstrijdGestart && !wedstrijdAfgelopen && (
            <div className="rounded-2xl border bg-white p-4" data-no-pause>
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div>
                  <div className="font-bold">Live coachsignalen</div>
                  <div className="text-xs text-gray-500">Gebaseerd op de meest recente aanvallen; bedoeld als snelle aanwijzing, niet als eindconclusie.</div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs min-w-0 lg:min-w-[520px]">
                  <div className="rounded-xl bg-gray-50 border px-2 py-2"><div className="text-gray-500">Laatste aanvallen</div><div className="font-bold text-base">{finishedHomeAttacks.length}/5</div></div>
                  <div className="rounded-xl bg-gray-50 border px-2 py-2"><div className="text-gray-500">Goals Korbis</div><div className="font-bold text-base">{recentHomeGoals}</div></div>
                  <div className="rounded-xl bg-gray-50 border px-2 py-2"><div className="text-gray-500">Kansen</div><div className="font-bold text-base">{recentHomeAttempts.length}</div></div>
                  <div className="rounded-xl bg-gray-50 border px-2 py-2"><div className="text-gray-500">Aanv. rebound</div><div className="font-bold text-base">{recentReboundPct == null ? "–" : `${recentReboundPct.toFixed(0)}%`}</div></div>
                </div>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-3">
                {visibleLiveCoachSignals.map((signal, i) => (
                  <div
                    key={`${signal.text}-${i}`}
                    className={`flex gap-2 rounded-xl border px-3 py-2 text-sm font-medium ${
                      signal.tone === "goed"
                        ? "bg-green-50 border-green-200 text-green-800"
                        : signal.tone === "letop" && signal.priority === 1
                        ? "bg-red-50 border-red-200 text-red-900"
                        : signal.tone === "letop"
                        ? "bg-orange-50 border-orange-200 text-orange-900"
                        : "bg-blue-50 border-blue-200 text-blue-800"
                    }`}
                  >
                    <SignalDot tone={signal.tone === "goed" ? "green" : signal.tone === "letop" && signal.priority === 1 ? "red" : signal.tone === "letop" ? "orange" : "blue"} />
                    <span>{signal.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Alles hieronder wordt grijs + niet klikbaar zolang wedstrijdNietGestart */}
          <div
            className={
              wedstrijdNietGestart
                ? "opacity-40 pointer-events-none transition"
                : "transition"
            }
          >
            {/* Vakken met daarnaast maximaal vijf laatste acties */}
            <div className="relative mt-4" data-no-pause>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,0.82fr)] mb-4 items-stretch">
                {/* BOVEN: twee veld-afbeeldingen, altijd horizontaal */}
                <div className="relative flex gap-4 min-w-0">
                {state.aanvalLinks ? (
                  <>
                    {/* LINKS: Aanvallend veld */}
                    <FieldImageCard
                      title={`${state.vak1Aanvallend ? "Vak 1" : "Vak 2"} (aanvallend)`}
                      imgSrc="/VeldLinks.jpg"
                      active={state.activeVak === "aanvallend"}
                      onClick={() => handleVakClick("aanvallend")}
                      markers={aanvalMarkers}
                      onFieldClick={
                        state.activeVak === "aanvallend"
                          ? (xPct, yPct) =>
                              addFieldEvent("aanvallend", xPct, yPct)
                          : undefined
                      }
                    />

                    {/* RECHTS: Verdedigend veld + STEAL-knop */}
                    <FieldImageCard
                      title={`${state.vak1Aanvallend ? "Vak 2" : "Vak 1"} (verdedigend)`}
                      imgSrc="/VeldRechts.jpg"
                      active={state.activeVak === "verdedigend"}
                      onClick={() => handleVakClick("verdedigend")}
                      markers={verdedigMarkers}
                      onFieldClick={
                        state.activeVak === "verdedigend"
                          ? (xPct, yPct) =>
                              addFieldEvent("verdedigend", xPct, yPct)
                          : undefined
                      }
                    >
                    </FieldImageCard>
                  </>
                ) : (
                  <>
                    {/* LINKS: Verdedigend veld + STEAL-knop */}
                    <FieldImageCard
                      title={`${state.vak1Aanvallend ? "Vak 2" : "Vak 1"} (verdedigend)`}
                      imgSrc="/VeldLinks.jpg"
                      active={state.activeVak === "verdedigend"}
                      onClick={() => handleVakClick("verdedigend")}
                      markers={verdedigMarkers}
                      onFieldClick={
                        state.activeVak === "verdedigend"
                          ? (xPct, yPct) =>
                              addFieldEvent("verdedigend", xPct, yPct)
                          : undefined
                      }
                    >
                    </FieldImageCard>

                    {/* RECHTS: Aanvallend veld */}
                    <FieldImageCard
                      title={`${state.vak1Aanvallend ? "Vak 1" : "Vak 2"} (aanvallend)`}
                      imgSrc="/VeldRechts.jpg"
                      active={state.activeVak === "aanvallend"}
                      onClick={() => handleVakClick("aanvallend")}
                      markers={aanvalMarkers}
                      onFieldClick={
                        state.activeVak === "aanvallend"
                          ? (xPct, yPct) =>
                              addFieldEvent("aanvallend", xPct, yPct)
                          : undefined
                      }
                    />
                  </>
                )}
                  {/* Wissel aanval/verdediging: bewust tussen de twee veldafbeeldingen */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); wisselVakken(); }}
                    aria-label="Aanval en verdediging wisselen"
                    title="Aanval en verdediging wisselen"
                    className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 h-16 w-16 items-center justify-center rounded-full border-2 border-blue-200 bg-white text-3xl font-black text-blue-700 shadow-xl transition hover:bg-blue-50 active:scale-95"
                  >
                    ⇄
                  </button>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm min-h-full" data-no-pause>
                  <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
                    <div>
                      <div className="font-extrabold">Laatste acties</div>
                      <div className="text-xs text-slate-500">Maximaal 5 · inclusief stand</div>
                    </div>
                    <div className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">{latestActions.length}/5</div>
                  </div>
                  {latestActions.length > 0 ? (
                    <div className="divide-y divide-slate-100">
                      {latestActions.map((e) => {
                        const score = scoreAtEvent.get(e.id);
                        const playerName = e.spelerId ? spelersMap.get(e.spelerId)?.naam : undefined;
                        const isGoal = (e.soort === "Kans" && (e.reden === "Gescoord" || e.reden === "Doelpunt")) || (e.soort === "Gemis" && (e.reden === "Doorgelaten" || e.reden === "Doelpunt"));
                        const label = e.actie || e.soort || "Actie";
                        const tone = isGoal
                          ? e.team === "uit"
                            ? "bg-red-50 text-red-700 border-red-200"
                            : "bg-green-50 text-green-700 border-green-200"
                          : e.resultaat === "Verdedigd" || e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept" || e.reden === "Bal onderschept"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : e.soort === "Rebound"
                          ? "bg-orange-50 text-orange-700 border-orange-200"
                          : "bg-slate-50 text-slate-700 border-slate-200";
                        return (
                          <div key={e.id} className="px-4 py-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="w-[44px] shrink-0 text-xs font-semibold tabular-nums text-slate-400">{formatTime(e.tijdSeconden)}</span>
                                <span className={`inline-flex max-w-[150px] truncate rounded-lg border px-2 py-1 text-[10px] font-extrabold uppercase ${tone}`}>{label}</span>
                              </div>
                              <div className="rounded-lg bg-slate-900 px-2.5 py-1 font-extrabold text-white tabular-nums whitespace-nowrap">{score ? `${score.thuis} - ${score.uit}` : `${state.scoreThuis} - ${state.scoreUit}`}</div>
                            </div>
                            <div className="mt-2 min-w-0 pl-[52px]">
                              <div className="font-semibold truncate">{playerName || (e.team === "uit" ? opponentName || "Tegenstander" : "Teamactie")}</div>
                              <div className="text-xs text-slate-500 truncate">{e.vakId ? `Vak ${e.vakId}` : ""}{e.vak ? ` · ${e.vak === "aanvallend" ? "Aanval" : "Verdediging"}` : ""}{e.reden ? ` · ${e.reden}` : ""}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex min-h-[180px] items-center justify-center p-6 text-center text-sm text-slate-400">De laatste acties verschijnen hier zodra je begint met registreren.</div>
                  )}
                </div>
              </div>

              {/* ONDER: vakken met spelers en wisselknoppen */}
              <div className="grid md:grid-cols-2 gap-4">
                {state.aanvalLinks ? (
                  <>
                    {/* LINKS: Aanvallend vak */}
                    <div
                      className={`rounded-2xl p-4 border ${
                        aanvValid ? "border-gray-200" : "border-red-500"
                      } ${
                        state.activeVak === "aanvallend"
                          ? "bg-white"
                          : "bg-gray-100"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div
                          className={`font-semibold ${
                            aanvValid ? "" : "text-red-600"
                          }`}
                        >
                          {state.vak1Aanvallend ? "Vak 1" : "Vak 2"} (aanvallend)
                        </div>
                      </div>

                      {!aanvValid && (
                        <div className="text-xs text-red-600 mb-2">
                          Let op: dit vak heeft geen 2 dames en 2 heren (nu{" "}
                          {aanvCounts.dames} dames, {aanvCounts.heren} heren).
                        </div>
                      )}

                      <div className="space-y-3">
                        {state.aanval.map((id, i) => (
                          <SpelerCircleRow
                            key={`aanval-${i}`}
                            id={id}
                            vak="aanvallend"
                            index={i}
                            spelersMap={spelersMap}
                            bank={bank}
                            setVakPos={setVakPos}
                          />
                        ))}
                      </div>
                    </div>

                    {/* RECHTS: Verdedigend vak */}
                    <div
                      className={`rounded-2xl p-4 border ${
                        verdValid ? "border-gray-200" : "border-red-500"
                      } ${
                        state.activeVak === "verdedigend"
                          ? "bg-white"
                          : "bg-gray-100"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div
                          className={`font-semibold ${
                            verdValid ? "" : "text-red-600"
                          }`}
                        >
                          {state.vak1Aanvallend ? "Vak 2" : "Vak 1"} (verdedigend)
                        </div>
                      </div>

                      {!verdValid && (
                        <div className="text-xs text-red-600 mb-2">
                          Let op: dit vak heeft geen 2 dames en 2 heren (nu{" "}
                          {verdCounts.dames} dames, {verdCounts.heren} heren).
                        </div>
                      )}

                      <div className="space-y-3">
                        {state.verdediging.map((id, i) => (
                          <SpelerCircleRow
                            key={`verdediging-${i}`}
                            id={id}
                            vak="verdedigend"
                            index={i}
                            spelersMap={spelersMap}
                            bank={bank}
                            setVakPos={setVakPos}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* LINKS: Verdedigend vak */}
                    <div
                      className={`rounded-2xl p-4 border ${
                        verdValid ? "border-gray-200" : "border-red-500"
                      } ${
                        state.activeVak === "verdedigend"
                          ? "bg-white"
                          : "bg-gray-100"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div
                          className={`font-semibold ${
                            verdValid ? "" : "text-red-600"
                          }`}
                        >
                          {state.vak1Aanvallend ? "Vak 2" : "Vak 1"} (verdedigend)
                        </div>
                      </div>

                      {!verdValid && (
                        <div className="text-xs text-red-600 mb-2">
                          Let op: dit vak heeft geen 2 dames en 2 heren (nu{" "}
                          {verdCounts.dames} dames, {verdCounts.heren} heren).
                        </div>
                      )}

                      <div className="space-y-3">
                        {state.verdediging.map((id, i) => (
                          <SpelerCircleRow
                            key={`verdediging-${i}`}
                            id={id}
                            vak="verdedigend"
                            index={i}
                            spelersMap={spelersMap}
                            bank={bank}
                            setVakPos={setVakPos}
                          />
                        ))}
                      </div>
                    </div>

                    {/* RECHTS: Aanvallend vak */}
                    <div
                      className={`rounded-2xl p-4 border ${
                        aanvValid ? "border-gray-200" : "border-red-500"
                      } ${
                        state.activeVak === "aanvallend"
                          ? "bg-white"
                          : "bg-gray-100"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div
                          className={`font-semibold ${
                            aanvValid ? "" : "text-red-600"
                          }`}
                        >
                          {state.vak1Aanvallend ? "Vak 1" : "Vak 2"} (aanvallend)
                        </div>
                      </div>

                      {!aanvValid && (
                        <div className="text-xs text-red-600 mb-2">
                          Let op: dit vak heeft geen 2 dames en 2 heren (nu{" "}
                          {aanvCounts.dames} dames, {aanvCounts.heren} heren).
                        </div>
                      )}

                      <div className="space-y-3">
                        {state.aanval.map((id, i) => (
                          <SpelerCircleRow
                            key={`aanval-${i}`}
                            id={id}
                            vak="aanvallend"
                            index={i}
                            spelersMap={spelersMap}
                            bank={bank}
                            setVakPos={setVakPos}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

            </div>
          </div>

          {/* Optioneel: klein hintje als de wedstrijd nog niet gestart is */}
          {wedstrijdNietGestart && (
            <div className="text-xs text-gray-500 mt-1">
              Start de wedstrijd om score, veld en wissels te gebruiken.
            </div>
          )}
        </div>
  );
}


function MatchReport({
  state,
  spelersMap,
  onBackToMatch,
}: {
  state: AppState;
  spelersMap: Map<string, Player>;
  onBackToMatch: () => void;
}) {
  const opponent = state.opponentName || "Tegenstander";
  const totalAttempts = state.fieldEvents.filter((e) => Boolean(e.actie)).length;
  const onTarget = state.fieldEvents.filter((e) => e.resultaat === "raak" || e.resultaat === "korf").length;
  const quality = totalAttempts ? (onTarget / totalAttempts) * 100 : 0;
  const reboundsWon = state.log.filter((e) => e.reden === "Rebound" && e.team !== "uit").length;
  const reboundsLost = state.log.filter((e) => e.reden === "Geen Rebound" || (e.reden === "Rebound" && e.team === "uit")).length;
  const reboundTotal = reboundsWon + reboundsLost;
  const reboundPct = reboundTotal ? (reboundsWon / reboundTotal) * 100 : 0;

  const korbisAttacks = state.attacks.filter((a) => a.team === "thuis");
  const oppAttacks = state.attacks.filter((a) => a.team === "uit");
  const avgAttack = (items: AttackMeta[]) => items.length ? items.reduce((sum, a) => sum + Math.max(0, (a.endSeconden ?? state.tijdSeconden) - a.startSeconden), 0) / items.length : 0;

  const vakStats = ([1, 2] as VakId[]).map((vakId) => {
    const attacks = korbisAttacks.filter((a) => a.vakId === vakId);
    const attackIds = new Set(attacks.map((a) => a.id));
    const attempts = state.fieldEvents.filter((e) => e.attackId && attackIds.has(e.attackId) && Boolean(e.actie));
    const goals = attempts.filter((e) => e.resultaat === "raak").length;
    const directed = attempts.filter((e) => e.resultaat === "raak" || e.resultaat === "korf").length;
    return { vakId, attacks: attacks.length, attempts: attempts.length, goals, quality: attempts.length ? directed / attempts.length * 100 : 0 };
  });

  const playerRows = Array.from(spelersMap.values()).map((p) => {
    const logs = state.log.filter((e) => e.spelerId === p.id);
    const goals = logs.filter((e) => e.reden === "Doelpunt" || e.reden === "Gescoord").length;
    const rebounds = logs.filter((e) => e.reden === "Rebound").length;
    const defense = logs.filter((e) => e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept" || e.reden === "Bal onderschept" || e.reden === "Verdedigd").length;
    const impact = goals * 3 + rebounds * 1.5 + defense * 2;
    return { p, goals, rebounds, defense, impact };
  }).filter((x) => x.goals + x.rebounds + x.defense > 0).sort((a,b) => b.impact-a.impact).slice(0,3);

  const strengths: string[] = [];
  const attention: { tone: "orange" | "red"; text: string }[] = [];
  if (state.scoreThuis > state.scoreUit) strengths.push(`Wedstrijd gewonnen met ${state.scoreThuis - state.scoreUit} doelpunt${state.scoreThuis - state.scoreUit === 1 ? "" : "en"} verschil.`);
  if (quality >= 60 && totalAttempts >= 5) strengths.push(`Korfgerichtheid was sterk: ${quality.toFixed(0)}% van de kansen was raak of raakte de korf.`);
  if (reboundPct >= 55 && reboundTotal >= 4) strengths.push(`Aanvallende rebound was positief met ${reboundPct.toFixed(0)}% gewonnen rebounds.`);
  const bestVak = vakStats.slice().sort((a,b) => (b.attacks ? b.goals/b.attacks : 0) - (a.attacks ? a.goals/a.attacks : 0))[0];
  if (bestVak && bestVak.attacks >= 2 && bestVak.goals > 0) strengths.push(`Vak ${bestVak.vakId} was aanvallend het productiefst met ${bestVak.goals} doelpunt${bestVak.goals === 1 ? "" : "en"} uit ${bestVak.attacks} aanvallen.`);
  if (state.scoreUit > state.scoreThuis) attention.push({ tone:"red", text:`${opponent} scoorde ${state.scoreUit} keer; Korbis eindigde op ${state.scoreThuis}.` });
  if (quality < 45 && totalAttempts >= 5) attention.push({ tone:"orange", text:`Korfgerichtheid bleef op ${quality.toFixed(0)}%; relatief veel kansen waren niet korfgericht.` });
  if (reboundPct < 45 && reboundTotal >= 4) attention.push({ tone:"orange", text:`Slechts ${reboundPct.toFixed(0)}% van de geregistreerde aanvallende rebounds werd gewonnen.` });
  if (oppAttacks.length > korbisAttacks.length + 3) attention.push({ tone:"orange", text:`De tegenstander had meer aanvalsmomenten (${oppAttacks.length} tegenover ${korbisAttacks.length}).` });
  if (!strengths.length) strengths.push("Nog onvoldoende uitgesproken positieve signalen om betrouwbaar uit te lichten.");
  if (!attention.length) attention.push({ tone:"orange", text:"Geen groot aandachtspunt springt op basis van de geregistreerde wedstrijddata direct naar voren." });

  const scoreEvents = state.log.filter((e) => e.reden === "Doelpunt" || e.reden === "Gescoord" || e.reden === "Doorgelaten").slice().sort((a,b) => a.tijdSeconden-b.tijdSeconden);
  let home=0, away=0;
  const progression = scoreEvents.map((e) => {
    const isOpp = e.team === "uit" || e.reden === "Doorgelaten";
    if (isOpp) away += 1; else home += 1;
    return { ...e, home, away, isOpp };
  });

  const fixture = state.homeAway === "uit" ? `${opponent} - Korbis` : `Korbis - ${opponent}`;
  return (
    <div className="space-y-5">
      <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Match Report</div><h2 className="mt-1 text-2xl font-bold">Wedstrijdverslag</h2><p className="mt-1 text-sm text-slate-500">Automatische samenvatting op basis van de geregistreerde wedstrijdacties.</p></div>
          <div className="flex items-center gap-4 rounded-2xl border border-blue-100 bg-white px-5 py-3 shadow-sm"><div><div className="text-xs text-slate-500">{fixture}</div><div className="text-3xl font-extrabold text-slate-900">{state.scoreThuis} - {state.scoreUit}</div></div><span className={`rounded-full px-3 py-1 text-xs font-extrabold ${state.scoreThuis>state.scoreUit?"bg-green-100 text-green-800":state.scoreThuis<state.scoreUit?"bg-red-100 text-red-800":"bg-slate-100 text-slate-700"}`}>{state.scoreThuis>state.scoreUit?"Winst":state.scoreThuis<state.scoreUit?"Verlies":"Gelijk"}</span></div>
        </div>
      </div>

      {!state.matchEnded && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><b>Voorlopig verslag.</b> De wedstrijd is nog niet afgesloten; de cijfers veranderen mee met nieuwe registraties.</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[['Doelpunten',state.scoreThuis,'bg-green-50 border-green-100 text-green-800'],['Kansen',totalAttempts,'bg-blue-50 border-blue-100 text-blue-800'],['Korfgericht',`${quality.toFixed(0)}%`,'bg-cyan-50 border-cyan-100 text-cyan-800'],['Rebound',`${reboundPct.toFixed(0)}%`,'bg-orange-50 border-orange-100 text-orange-800'],['Gem. aanval',`${avgAttack(korbisAttacks).toFixed(0)} sec`,'bg-violet-50 border-violet-100 text-violet-800']].map(([label,value,cls])=><div key={String(label)} className={`rounded-2xl border p-4 ${cls}`}><div className="text-xs font-bold uppercase tracking-wide opacity-70">{label}</div><div className="mt-1 text-3xl font-extrabold">{value}</div></div>)}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Sterke punten</h3><div className="mt-4 space-y-3">{strengths.slice(0,3).map((text,i)=><div key={i} className="flex gap-3 rounded-xl bg-green-50 p-3 text-sm text-green-950"><span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-green-500"/><span>{text}</span></div>)}</div></div>
        <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Aandachtspunten</h3><div className="mt-4 space-y-3">{attention.slice(0,3).map((item,i)=><div key={i} className={`flex gap-3 rounded-xl p-3 text-sm ${item.tone==='red'?'bg-red-50 text-red-950':'bg-orange-50 text-orange-950'}`}><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${item.tone==='red'?'bg-red-500':'bg-orange-500'}`}/><span>{item.text}</span></div>)}</div></div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <div className="rounded-2xl border bg-white p-5"><div className="flex items-end justify-between gap-3"><div><h3 className="text-lg font-bold">Scoreverloop</h3><p className="text-sm text-slate-500">Doelpunten in chronologische volgorde.</p></div><div className="text-xs text-slate-400">{progression.length} scoremomenten</div></div><div className="mt-5 flex min-h-24 items-center gap-2 overflow-x-auto pb-2">{progression.length?progression.map((e,i)=><div key={e.id+i} className="min-w-[74px] text-center"><div className={`mx-auto flex h-11 w-11 items-center justify-center rounded-xl text-sm font-extrabold text-white ${e.isOpp?'bg-red-500':'bg-green-500'}`}>{e.home}-{e.away}</div><div className="mt-1 text-[10px] text-slate-400">{Math.floor(e.tijdSeconden/60)}'</div></div>):<div className="text-sm text-slate-400">Geen doelpunten geregistreerd.</div>}</div></div>
        <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Opvallende spelers</h3><div className="mt-4 space-y-3">{playerRows.length?playerRows.map((x,i)=><div key={x.p.id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3"><div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 font-extrabold text-blue-700">{i+1}</div><div className="min-w-0 flex-1"><div className="truncate font-bold">{x.p.naam}</div><div className="text-xs text-slate-500">{x.goals} goals · {x.rebounds} rebounds · {x.defense} verdedigend</div></div></div>):<div className="text-sm text-slate-400">Nog onvoldoende individuele acties geregistreerd.</div>}</div></div>
      </div>

      <div className="rounded-2xl border bg-white p-5"><div className="mb-4"><h3 className="text-lg font-bold">Vak 1 versus Vak 2</h3><p className="text-sm text-slate-500">Vergelijking op basis van de vaste vakidentiteit.</p></div><div className="grid gap-4 md:grid-cols-2">{vakStats.map(v=><div key={v.vakId} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"><div className="mb-3 text-lg font-extrabold text-blue-800">Vak {v.vakId}</div><div className="grid grid-cols-4 gap-2 text-center"><div><div className="text-xl font-extrabold">{v.attacks}</div><div className="text-[11px] text-slate-500">Aanvallen</div></div><div><div className="text-xl font-extrabold">{v.attempts}</div><div className="text-[11px] text-slate-500">Kansen</div></div><div><div className="text-xl font-extrabold">{v.goals}</div><div className="text-[11px] text-slate-500">Goals</div></div><div><div className="text-xl font-extrabold">{v.quality.toFixed(0)}%</div><div className="text-[11px] text-slate-500">Korfgericht</div></div></div></div>)}</div></div>

      <div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={onBackToMatch}>Terug naar wedstrijd</Button></div>
    </div>
  );
}

function SeasonDashboard({
  state,
  dbSheets,
}: {
  state: AppState;
  dbSheets: { events: any[]; attacks: any[]; wissels: any[]; matches: any[] } | null;
}) {
  const matches = dbSheets?.matches ?? [];
  const seasons = Array.from(new Set([
    ...state.seasonOptions,
    ...matches.map((m:any) => String(m.seizoen ?? "").trim()).filter(Boolean),
  ])).filter(Boolean);
  const [season, setSeason] = useState<string>(() => state.season || seasons[0] || "");
  const [includeNonCompetition, setIncludeNonCompetition] = useState(false);

  useEffect(() => {
    if (!season && state.season) setSeason(state.season);
  }, [season, state.season]);

  const seasonMatches = matches
    .filter((m:any) => String(m.seizoen ?? "") === season)
    .filter((m:any) => includeNonCompetition || !m.wedstrijdtype || String(m.wedstrijdtype) === "Competitie")
    .sort((a:any,b:any) => Date.parse(String(a.datum ?? "")) - Date.parse(String(b.datum ?? "")));
  const ids = new Set(seasonMatches.map((m:any) => String(m.wedstrijd_id)));
  const events = (dbSheets?.events ?? []).filter((e:any) => ids.has(String(e.wedstrijd_id)));
  const attacks = (dbSheets?.attacks ?? []).filter((a:any) => ids.has(String(a.wedstrijd_id)));
  const isKorbis = (e:any) => String(e.team ?? "").trim().toLowerCase() === "korbis";
  const isAttempt = (e:any) => ["Schot","Doorloop","Vrijebal","Strafworp"].includes(String(e.actie ?? "")) && ["Raak","Mis","Korf","Verdedigd"].includes(String(e.uitkomst ?? ""));
  const pct = (a:number,b:number) => b ? a / b * 100 : 0;
  const own = events.filter((e:any)=>isKorbis(e)&&isAttempt(e));
  const opp = events.filter((e:any)=>!isKorbis(e)&&isAttempt(e));
  const goals = own.filter((e:any)=>e.uitkomst==="Raak").length;
  const korf = own.filter((e:any)=>e.uitkomst==="Korf").length;
  const oppGoals = opp.filter((e:any)=>e.uitkomst==="Raak").length;
  const defended = opp.filter((e:any)=>e.uitkomst==="Verdedigd").length;
  const wonRebounds = events.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Rebound").length;
  const lostRebounds = events.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Geen Rebound").length;
  const ownAttacks = attacks.filter((a:any)=>String(a.team??"").trim().toLowerCase()==="korbis");
  const wins=seasonMatches.filter((m:any)=>Number(m.score_korbis)>Number(m.score_tegenstander)).length;
  const draws=seasonMatches.filter((m:any)=>Number(m.score_korbis)===Number(m.score_tegenstander)).length;
  const losses=seasonMatches.filter((m:any)=>Number(m.score_korbis)<Number(m.score_tegenstander)).length;
  const goalsFor=seasonMatches.reduce((n:number,m:any)=>n+Number(m.score_korbis||0),0);
  const goalsAgainst=seasonMatches.reduce((n:number,m:any)=>n+Number(m.score_tegenstander||0),0);

  const perMatch = seasonMatches.map((m:any, i:number)=>{
    const id=String(m.wedstrijd_id);
    const me=events.filter((e:any)=>String(e.wedstrijd_id)===id);
    const ma=me.filter((e:any)=>isKorbis(e)&&isAttempt(e));
    const mg=ma.filter((e:any)=>e.uitkomst==="Raak").length;
    const mk=ma.filter((e:any)=>e.uitkomst==="Korf").length;
    const oa=me.filter((e:any)=>!isKorbis(e)&&isAttempt(e));
    const og=oa.filter((e:any)=>e.uitkomst==="Raak").length;
    const mr=me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Rebound").length;
    const ml=me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Geen Rebound").length;
    const date=String(m.datum??"").slice(0,10);
    return {id,date,label:date?date.slice(5):`W${i+1}`,score:pct(mg,ma.length),quality:pct(mg+mk,ma.length),rebound:pct(mr,mr+ml),oppScore:pct(og,oa.length),gf:Number(m.score_korbis||0),ga:Number(m.score_tegenstander||0)};
  });
  const recent=perMatch.slice(-3), previous=perMatch.length>=6?perMatch.slice(-6,-3):[];
  const avg=(rows:any[], key:string)=>rows.length?rows.reduce((n:number,r:any)=>n+Number(r[key]||0),0)/rows.length:0;
  const insights:string[]=[];
  if(previous.length){
    const ds=avg(recent,"score")-avg(previous,"score");
    const dr=avg(recent,"rebound")-avg(previous,"rebound");
    const dop=avg(recent,"oppScore")-avg(previous,"oppScore");
    if(ds>=5) insights.push(`Afronding verbetert: laatste 3 wedstrijden ${ds.toFixed(1)} procentpunt hoger.`);
    if(ds<=-5) insights.push(`Afronding vraagt aandacht: laatste 3 wedstrijden ${Math.abs(ds).toFixed(1)} procentpunt lager.`);
    if(dr>=8) insights.push(`Aanvallende rebound ontwikkelt positief: +${dr.toFixed(1)} procentpunt.`);
    if(dr<=-8) insights.push(`Aanvallende rebound loopt terug: ${Math.abs(dr).toFixed(1)} procentpunt lager.`);
    if(dop<=-5) insights.push(`Verdedigend positieve trend: tegenstanders scoren ${Math.abs(dop).toFixed(1)} procentpunt minder van hun kansen.`);
    if(dop>=5) insights.push(`Verdedigend aandachtspunt: tegenstanders scoren ${dop.toFixed(1)} procentpunt meer van hun kansen.`);
  }
  if(!insights.length) insights.push(perMatch.length<6?"Vanaf zes wedstrijden worden duidelijke 3-tegen-3 seizoenstrends zichtbaar.":"De belangrijkste kengetallen zijn de laatste zes wedstrijden relatief stabiel.");

  const vakSummary=(vakId:number)=>{
    const ve=events.filter((e:any)=>String(e.vak_id??"")===String(vakId));
    const va=ve.filter((e:any)=>isKorbis(e)&&isAttempt(e));
    const vg=va.filter((e:any)=>e.uitkomst==="Raak").length;
    const vo=ve.filter((e:any)=>!isKorbis(e)&&isAttempt(e));
    const vog=vo.filter((e:any)=>e.uitkomst==="Raak").length;
    return {attempts:va.length,goals:vg,score:pct(vg,va.length),oppScore:pct(vog,vo.length)};
  };
  const v1=vakSummary(1), v2=vakSummary(2);
  const playerRows=Array.from(new Set(events.filter(isKorbis).map((e:any)=>String(e.spelerNaam??"")).filter(Boolean))).map(name=>{
    const pe=events.filter((e:any)=>isKorbis(e)&&String(e.spelerNaam??"")===name);
    const pa=pe.filter(isAttempt); const pg=pa.filter((e:any)=>e.uitkomst==="Raak").length;
    return {name,attempts:pa.length,goals:pg,score:pct(pg,pa.length),rebounds:pe.filter((e:any)=>e.actie==="Rebound"&&e.reden==="Rebound").length};
  }).sort((a,b)=>b.goals-a.goals || b.score-a.score);

  const MiniTrend=({title,keyName,suffix="%"}:{title:string;keyName:"score"|"quality"|"rebound"|"oppScore";suffix?:string})=>{
    const vals=perMatch.map((m:any)=>Number(m[keyName]||0)); const w=520,h=165,l=52,r=16,t=15,b=35;
    const isPercent=suffix==="%"; const rawMax=Math.max(...vals,0); const axisMax=isPercent?100:Math.max(1,Math.ceil(rawMax/5)*5); const axisMin=0; const span=Math.max(1,axisMax-axisMin);
    const x=(i:number)=>vals.length<=1?(l+w-r)/2:l+i/(Math.max(vals.length-1,1))*(w-l-r); const y=(v:number)=>h-b-(v-axisMin)/span*(h-t-b); const pts=vals.map((v,i)=>`${x(i)},${y(v)}`).join(" ");
    const ticks=Array.from({length:6},(_,i)=>axisMin+(axisMax-axisMin)*(i/5));
    return <div className="border rounded-2xl p-4 bg-white"><div className="font-bold">{title}</div><div className="text-xs text-gray-500 mb-2">{vals.length?`Laatste: ${vals[vals.length-1].toFixed(1)}${suffix}`:"Geen wedstrijden"}</div><svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[165px]">{ticks.map((tick,i)=><g key={`yt-${i}`}><line x1={l} y1={y(tick)} x2={w-r} y2={y(tick)} stroke="#e5e7eb"/><text x={l-8} y={y(tick)+4} textAnchor="end" fontSize="10" fill="#6b7280">{isPercent?`${tick.toFixed(0)}%`:tick.toFixed(tick%1===0?0:1)}</text></g>)}<line x1={l} y1={t} x2={l} y2={h-b} stroke="#d1d5db"/><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="3"/>{vals.map((v,i)=><g key={i}><circle cx={x(i)} cy={y(v)} r="4" fill="currentColor"/><text x={x(i)} y={h-13} textAnchor="middle" fontSize="10" fill="#6b7280">{perMatch[i].label}</text></g>)}</svg></div>;
  };

  return <div className="space-y-5">
    <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm"><div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4"><div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Season</div><h2 className="mt-1 text-2xl font-bold">Seizoensdashboard</h2><p className="text-sm text-gray-500">Compact coach-overzicht van resultaten, ontwikkeling, vakken en spelers.</p></div><div className="flex flex-wrap gap-3 items-end"><label className="flex flex-col gap-1"><span className="text-xs font-semibold text-gray-500">Seizoen</span><select value={season} onChange={e=>setSeason(e.target.value)} className="border rounded-xl px-3 py-2 bg-white min-w-[210px]">{seasons.map(s=><option key={s} value={s}>{s}</option>)}</select></label><label className="flex items-center gap-2 border border-blue-100 rounded-xl px-3 py-2 bg-white/90 text-sm"><input type="checkbox" checked={includeNonCompetition} onChange={e=>setIncludeNonCompetition(e.target.checked)}/> Oefen/toernooi meenemen</label></div></div></div>
    {!dbSheets ? <div className="border rounded-2xl p-6 bg-white text-sm text-gray-600">Laad eerst de Excel-database. Het seizoensdashboard gebruikt de opgeslagen wedstrijden uit die database.</div> : seasonMatches.length===0 ? <div className="border rounded-2xl p-6 bg-white text-sm text-gray-600">Voor <b>{season||"dit seizoen"}</b> zijn binnen dit filter nog geen wedstrijden gevonden.</div> : <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">{[["Wedstrijden",seasonMatches.length,"blue"],["Winst / gelijk / verlies",`${wins} / ${draws} / ${losses}`,wins>=losses?"green":"orange"],["Doelpunten",`${goalsFor} - ${goalsAgainst}`,goalsFor>=goalsAgainst?"green":"red"],["Kansen raak",`${pct(goals,own.length).toFixed(1)}%`,"blue"],["Aanv. rebound gewonnen",`${pct(wonRebounds,wonRebounds+lostRebounds).toFixed(1)}%`,"orange"]].map(([l,v,tone])=>{const cls=tone==="green"?"border-emerald-200 bg-emerald-50/70 text-emerald-900":tone==="red"?"border-red-200 bg-red-50/70 text-red-900":tone==="orange"?"border-orange-200 bg-orange-50/70 text-orange-900":"border-blue-200 bg-blue-50/70 text-blue-900";return <div key={String(l)} className={`border rounded-2xl p-4 ${cls}`}><div className="text-xs font-semibold opacity-70">{l}</div><div className="text-2xl font-bold mt-1">{v}</div></div>})}</div>
      <div className="grid gap-4 lg:grid-cols-2"><div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Coachsignalen</div><div className="space-y-2">{insights.map((x,i)=>{const lower=x.toLowerCase();const negative=lower.includes("aandacht")||lower.includes("loopt terug")||lower.includes("lager")||lower.includes("meer van hun kansen");const positive=lower.includes("verbetert")||lower.includes("positief")||lower.includes("minder van hun kansen");const tone=negative?"orange":positive?"green":"blue";const cls=tone==="green"?"bg-emerald-50 border-emerald-100 text-emerald-900":tone==="orange"?"bg-orange-50 border-orange-100 text-orange-900":"bg-blue-50 border-blue-100 text-blue-900";return <div key={i} className={`flex gap-2 rounded-xl border px-3 py-2 text-sm ${cls}`}><SignalDot tone={tone}/><span>{x}</span></div>})}</div></div><div className="border rounded-2xl p-5 bg-gradient-to-br from-white to-blue-50/60"><div className="text-lg font-bold mb-3">Seizoensprofiel</div><div className="grid grid-cols-2 gap-2 text-sm"><div className="rounded-xl bg-blue-50 border border-blue-100 p-3"><span className="block text-xs text-blue-700">Korfgerichtheid</span><b className="text-lg text-blue-950">{pct(goals+korf,own.length).toFixed(1)}%</b></div><div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3"><span className="block text-xs text-emerald-700">Kansen per aanval</span><b className="text-lg text-emerald-950">{ownAttacks.length?(own.length/ownAttacks.length).toFixed(2):"0.00"}</b></div><div className="rounded-xl bg-red-50 border border-red-100 p-3"><span className="block text-xs text-red-700">Tegenstander raak</span><b className="text-lg text-red-950">{pct(oppGoals,opp.length).toFixed(1)}%</b></div><div className="rounded-xl bg-orange-50 border border-orange-100 p-3"><span className="block text-xs text-orange-700">Pogingen verdedigd</span><b className="text-lg text-orange-950">{pct(defended,opp.length).toFixed(1)}%</b></div></div></div></div>
      <div><h3 className="text-xl font-bold">Ontwikkeling door het seizoen</h3><p className="text-sm text-gray-500">Per wedstrijd; gebruik Insights voor de uitgebreidere 3-tegen-3 analyse.</p></div><div className="grid gap-4 lg:grid-cols-2"><MiniTrend title="Kansen raak" keyName="score"/><MiniTrend title="Korfgerichtheid" keyName="quality"/><MiniTrend title="Aanvallende rebounds gewonnen" keyName="rebound"/><MiniTrend title="Kansen tegenstander raak" keyName="oppScore"/></div>
      <div className="grid gap-4 lg:grid-cols-2"><div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Vak 1 vs Vak 2 – seizoen</div><div className="overflow-auto"><table className="w-full text-sm"><thead><tr className="text-gray-500"><th className="text-left py-2">Kengetal</th><th className="text-right">Vak 1</th><th className="text-right">Vak 2</th></tr></thead><tbody>{[["Kansen",v1.attempts,v2.attempts],["Goals",v1.goals,v2.goals],["Kansen raak",`${v1.score.toFixed(1)}%`,`${v2.score.toFixed(1)}%`],["Tegenstander kansen raak",`${v1.oppScore.toFixed(1)}%`,`${v2.oppScore.toFixed(1)}%`]].map(([l,a,b])=><tr key={String(l)} className="border-t"><td className="py-2 font-semibold">{l}</td><td className="text-right">{a}</td><td className="text-right">{b}</td></tr>)}</tbody></table></div></div><div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Spelers – seizoen</div><div className="overflow-auto max-h-[260px]"><table className="w-full text-sm"><thead className="sticky top-0 bg-white"><tr className="text-gray-500"><th className="text-left py-2">Speler</th><th className="text-right">Goals</th><th className="text-right">Kansen</th><th className="text-right">% raak</th><th className="text-right">Reb.</th></tr></thead><tbody>{playerRows.map(p=><tr key={p.name} className="border-t"><td className="py-2 font-semibold">{p.name}</td><td className="text-right">{p.goals}</td><td className="text-right">{p.attempts}</td><td className="text-right">{p.score.toFixed(1)}%</td><td className="text-right">{p.rebounds}</td></tr>)}</tbody></table></div></div></div>
      <div className="border rounded-2xl overflow-hidden bg-white"><div className="p-4 border-b font-bold">Wedstrijden – {season}</div><div className="overflow-auto"><table className="w-full text-sm min-w-[720px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Datum</th><th className="text-left p-3">Tegenstander</th><th className="text-left p-3">Type</th><th className="text-right p-3">Uitslag</th><th className="text-right p-3">Kansen raak</th></tr></thead><tbody>{seasonMatches.map((m:any)=>{const pm=perMatch.find(x=>x.id===String(m.wedstrijd_id));return <tr key={String(m.wedstrijd_id)} className="border-t"><td className="p-3">{String(m.datum??"").slice(0,10)}</td><td className="p-3 font-semibold">{m.tegenstander||m.wedstrijd_naam||"-"}</td><td className="p-3">{m.wedstrijdtype||"Competitie"}</td><td className="p-3 text-right font-bold">{m.score_korbis}-{m.score_tegenstander}</td><td className="p-3 text-right">{pm?`${pm.score.toFixed(1)}%`:"-"}</td></tr>})}</tbody></table></div></div>
    </>}
  </div>;
}

function InsightsTab({
  state,
  spelersMap,
  opponentName,
  dbSheets,
}: {
  state: AppState;
  spelersMap: Map<string, Player>;
  opponentName: string;
  dbSheets: { events: any[]; attacks: any[]; wissels: any[]; matches: any[] } | null;
}) {
  const ACTIONS = ["Schot", "Doorloop", "Vrijebal", "Strafworp"] as const;
  type ActionKind = (typeof ACTIONS)[number];

  const [analysisMode, setAnalysisMode] = useState<"speler" | "team">("speler");
  const [insightMatchId, setInsightMatchId] = useState<string>("__live__");
  const [historyPlayerName, setHistoryPlayerName] = useState<string>("");
  const [historySeason, setHistorySeason] = useState<string>("__all__");
  const [historyMatchType, setHistoryMatchType] = useState<string>("__all__");
  const [historyPlayerPeriod, setHistoryPlayerPeriod] = useState<"all" | "3" | "5" | "10">("all");

  const [selectedPlayerId, setSelectedPlayerId] = useState<string>(
    () => state.spelers[0]?.id ?? ""
  );

  useEffect(() => {
    if (state.spelers.length === 0) {
      if (selectedPlayerId) setSelectedPlayerId("");
      return;
    }

    if (!state.spelers.some((p) => p.id === selectedPlayerId)) {
      setSelectedPlayerId(state.spelers[0].id);
    }
  }, [state.spelers, selectedPlayerId]);

  const databaseMatches = dbSheets?.matches ?? [];
  const insightModeButtons = (
    <div className="inline-flex w-full rounded-xl border bg-white p-1 gap-1">
      <button
        type="button"
        onClick={() => setAnalysisMode("speler")}
        className={`flex-1 px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${
          analysisMode === "speler"
            ? "bg-blue-600 text-white"
            : "text-gray-600 hover:bg-gray-50"
        }`}
      >
        Speleranalyse
      </button>
      <button
        type="button"
        onClick={() => setAnalysisMode("team")}
        className={`flex-1 px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${
          analysisMode === "team"
            ? "bg-blue-600 text-white"
            : "text-gray-600 hover:bg-gray-50"
        }`}
      >
        Teamanalyse
      </button>
    </div>
  );

  const matchSelector = (
    <label className="flex flex-col gap-1 min-w-[260px]">
      <span className="text-xs font-semibold text-gray-500">Wedstrijd</span>
      <select value={insightMatchId} onChange={(e) => setInsightMatchId(e.target.value)} className="border rounded-xl px-3 py-2 bg-white text-sm">
        <option value="__live__">Huidige / live wedstrijd</option>
        {databaseMatches.length > 0 && <option value="__all__">Alle geïmporteerde wedstrijden</option>}
        {databaseMatches.map((m: any, i: number) => <option key={String(m.wedstrijd_id ?? i)} value={String(m.wedstrijd_id ?? i)}>{formatImportedDate(m.datum)} · {m.seizoen ? `${m.seizoen} · ` : ""}{m.wedstrijd_naam || m.tegenstander || `Wedstrijd ${i+1}`} · {m.score_korbis ?? "?"}-{m.score_tegenstander ?? "?"}</option>)}
      </select>
    </label>
  );

  if (insightMatchId !== "__live__") {
    const all = insightMatchId === "__all__";
    const historySeasons = Array.from(
      new Set(databaseMatches.map((m:any) => String(m.seizoen ?? "").trim()).filter(Boolean))
    ).sort((a,b) => a.localeCompare(b));
    const historyMatchTypes = Array.from(
      new Set(databaseMatches.map((m:any) => String(m.wedstrijdtype ?? "").trim()).filter(Boolean))
    ).sort((a,b) => a.localeCompare(b));
    const selectedMatches = all
      ? databaseMatches.filter((m:any) =>
          (historySeason === "__all__" || String(m.seizoen ?? "") === historySeason) &&
          (historyMatchType === "__all__" || String(m.wedstrijdtype ?? "") === historyMatchType)
        )
      : databaseMatches.filter((m:any) => String(m.wedstrijd_id) === insightMatchId);
    const ids = new Set(selectedMatches.map((m:any) => String(m.wedstrijd_id)));
    const events = (dbSheets?.events ?? []).filter((e:any) => ids.has(String(e.wedstrijd_id)));
    const num = (v:any) => Number.isFinite(Number(v)) ? Number(v) : 0;
    const isKorbis = (e:any) => String(e.team ?? "").trim().toLowerCase() === "korbis";
    const isAttempt = (e:any) => ["Schot","Doorloop","Vrijebal","Strafworp"].includes(String(e.actie ?? "")) && ["Raak","Mis","Korf","Verdedigd"].includes(String(e.uitkomst ?? ""));
    const own = events.filter((e:any) => isKorbis(e) && isAttempt(e));
    const opp = events.filter((e:any) => !isKorbis(e) && isAttempt(e));
    const goals = own.filter((e:any) => e.uitkomst === "Raak").length;
    const korf = own.filter((e:any) => e.uitkomst === "Korf").length;
    const oppGoals = opp.filter((e:any) => e.uitkomst === "Raak").length;
    const rebounds = events.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Rebound").length;
    const noRebounds = events.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Geen Rebound").length;
    const scorePct = own.length ? goals / own.length * 100 : 0;
    const qualityPct = own.length ? (goals + korf) / own.length * 100 : 0;
    const reboundPct = rebounds + noRebounds ? rebounds / (rebounds + noRebounds) * 100 : 0;
    const oppPct = opp.length ? oppGoals / opp.length * 100 : 0;
    const names = Array.from(new Set(events.filter((e:any) => isKorbis(e) && e.spelerNaam).map((e:any) => String(e.spelerNaam)))).sort((a,b)=>a.localeCompare(b));
    const players = names.map(name => { const pe=events.filter((e:any)=>isKorbis(e)&&String(e.spelerNaam)===name); const pa=pe.filter(isAttempt); const pg=pa.filter((e:any)=>e.uitkomst==="Raak").length; const pk=pa.filter((e:any)=>e.uitkomst==="Korf").length; return {name, attempts:pa.length, goals:pg, score:pa.length?pg/pa.length*100:0, quality:pa.length?(pg+pk)/pa.length*100:0, rebounds:pe.filter((e:any)=>e.actie==="Rebound"&&e.reden==="Rebound").length}; });
    const sortedDatabaseMatches = [...selectedMatches].sort((a:any,b:any) => {
      const dateSortValue = (value:any) => {
        if (typeof value === "number" && Number.isFinite(value)) return (value - 25569) * 86400 * 1000;
        const parsed = Date.parse(String(value ?? ""));
        return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
      };
      const ad = dateSortValue(a.datum);
      const bd = dateSortValue(b.datum);
      if (Number.isFinite(ad) && Number.isFinite(bd)) return ad - bd;
      return String(a.wedstrijd_id ?? "").localeCompare(String(b.wedstrijd_id ?? ""));
    });
    const toSeconds = (value:any) => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const parts = String(value ?? "").split(":").map(Number);
      if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
      if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      return num(value);
    };
    const formatDatabaseDate = (value:any) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        // Excel bewaart datums vaak als serienummer: dag 1 = 01-01-1900.
        // De correctie van 25569 houdt rekening met Excel's 1900-datumsysteem.
        const d = new Date(Math.round((value - 25569) * 86400 * 1000));
        if (!Number.isNaN(d.getTime())) {
          return `${String(d.getUTCDate()).padStart(2,"0")}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${d.getUTCFullYear()}`;
        }
      }
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
      const nl = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (nl) return `${nl[1].padStart(2,"0")}-${nl[2].padStart(2,"0")}-${nl[3]}`;
      return raw.slice(0,10);
    };
    const databaseDateForSort = (value:any) => {
      if (typeof value === "number" && Number.isFinite(value)) return (value - 25569) * 86400 * 1000;
      const raw = String(value ?? "").trim();
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return Date.UTC(Number(iso[1]), Number(iso[2])-1, Number(iso[3]));
      const nl = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (nl) return Date.UTC(Number(nl[3]), Number(nl[2])-1, Number(nl[1]));
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    };
    const formatAxisDate = (value:any, index:number) => {
      const time = databaseDateForSort(value);
      if (!Number.isFinite(time)) return `W${index + 1}`;
      const d = new Date(time);
      const temp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = temp.getUTCDay() || 7;
      temp.setUTCDate(temp.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(temp.getUTCFullYear(),0,1));
      const week = Math.ceil((((temp.getTime()-yearStart.getTime())/86400000)+1)/7);
      return `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")} · wk ${week}`;
    };
    const trend = sortedDatabaseMatches.map((m:any, matchIndex:number) => {
      const me=(dbSheets?.events??[]).filter((e:any)=>String(e.wedstrijd_id)===String(m.wedstrijd_id));
      const ma=me.filter((e:any)=>isKorbis(e)&&isAttempt(e));
      const oa=me.filter((e:any)=>!isKorbis(e)&&isAttempt(e));
      const mg=ma.filter((e:any)=>e.uitkomst==="Raak").length;
      const mk=ma.filter((e:any)=>e.uitkomst==="Korf").length;
      const og=oa.filter((e:any)=>e.uitkomst==="Raak").length;
      const od=oa.filter((e:any)=>e.uitkomst==="Verdedigd").length;
      const mr=me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Rebound").length;
      const mn=me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Geen Rebound").length;
      const matchAttacks=(dbSheets?.attacks??[]).filter((a:any)=>String(a.wedstrijd_id)===String(m.wedstrijd_id) && String(a.team??"").trim().toLowerCase()==="korbis");
      const avgAttackDuration=matchAttacks.length ? matchAttacks.reduce((sum:number,a:any)=>sum+toSeconds(a.duur),0)/matchAttacks.length : 0;
      return {
        id:String(m.wedstrijd_id),
        label:formatDatabaseDate(m.datum)||String(m.wedstrijd_naam??""),
        opponent:String(m.tegenstander ?? ""),
        axisLabel:formatAxisDate(m.datum, matchIndex),
        score:ma.length?mg/ma.length*100:0,
        quality:ma.length?(mg+mk)/ma.length*100:0,
        rebounds:mr,
        reboundPct:mr+mn?mr/(mr+mn)*100:0,
        attack:num(m.aanval_thuis_pct),
        possession:num(m.bezit_thuis_pct),
        goals:num(m.score_korbis),
        against:num(m.score_tegenstander),
        oppScore:oa.length?og/oa.length*100:0,
        defendedPct:oa.length?od/oa.length*100:0,
        attemptsPerAttack:matchAttacks.length?ma.length/matchAttacks.length:0,
        avgAttackDuration,
        attempts: ma.length,
        goalsCount: mg,
        korfCount: mk,
        oppAttempts: oa.length,
        oppGoalsCount: og,
        defendedCount: od,
        wonRebounds: mr,
        lostRebounds: mn,
        attackCount: matchAttacks.length,
      };
    });
    const Trend = ({title, values, labels, suffix="", comparisonValues, comparisonLabel="Teamgemiddelde", inverseComparison=false}:{title:string;values:number[];labels?:string[];suffix?:string;comparisonValues?:number[];comparisonLabel?:string;inverseComparison?:boolean}) => {
      const w=560,h=190,left=54,right=18,top=16,bottom=44;
      const isPercent=suffix==="%";
      const allValues=[...values,...(comparisonValues ?? [])];
      const rawMax=Math.max(...allValues,0);
      const axisMax=isPercent ? 100 : Math.max(1, Math.ceil(rawMax / 5) * 5);
      const axisMin=0;
      const span=Math.max(axisMax-axisMin,1);
      const x=(i:number)=>values.length===1?(left+w-right)/2:left+i/(Math.max(values.length-1,1))*(w-left-right);
      const y=(v:number)=>h-bottom-(v-axisMin)/span*(h-top-bottom);
      const pts=values.map((v,i)=>`${x(i)},${y(v)}`).join(" ");
      const comparisonPts=(comparisonValues ?? []).map((v,i)=>`${x(i)},${y(v)}`).join(" ");
      const ticks=Array.from({length:6},(_,i)=>axisMin+(axisMax-axisMin)*(i/5));
      const avg=values.length ? values.reduce((sum,v)=>sum+v,0)/values.length : 0;
      const latestComparison=comparisonValues?.length ? comparisonValues[comparisonValues.length-1] : null;
      const pointIsGood=(v:number,i:number)=>{
        const benchmark=comparisonValues?.[i];
        if (benchmark == null || !Number.isFinite(benchmark)) return v>=avg;
        return inverseComparison ? v<=benchmark : v>=benchmark;
      };
      return <div className="border rounded-2xl p-4 bg-white"><div className="font-bold">{title}</div><div className="text-xs text-gray-500 mb-2">{values.length?`Laatste: ${values[values.length-1].toFixed(isPercent?1:values[values.length-1] % 1 === 0 ? 0 : 1)}${suffix}${latestComparison!=null?` · ${comparisonLabel}: ${latestComparison.toFixed(isPercent?1:latestComparison % 1 === 0 ? 0 : 1)}${suffix}`:` · Gemiddeld: ${avg.toFixed(isPercent?1:avg % 1 === 0 ? 0 : 1)}${suffix}`}`:"Geen data"}</div><svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[190px]">{ticks.map((tick,i)=><g key={`yt-${i}`}><line x1={left} y1={y(tick)} x2={w-right} y2={y(tick)} stroke="#e5e7eb"/><text x={left-8} y={y(tick)+4} textAnchor="end" fontSize="10" fill="#6b7280">{isPercent?`${tick.toFixed(0)}%`:tick.toFixed(tick%1===0?0:1)}</text></g>)}{comparisonValues&&comparisonValues.length===values.length&&<polyline points={comparisonPts} fill="none" stroke="#2563eb" strokeWidth="2" strokeDasharray="6 5" strokeLinejoin="round" strokeLinecap="round"/>}{!comparisonValues&&values.length>0&&<line x1={left} y1={y(avg)} x2={w-right} y2={y(avg)} stroke="#94a3b8" strokeDasharray="5 5"/>}<line x1={left} y1={top} x2={left} y2={h-bottom} stroke="#d1d5db"/><polyline points={pts} fill="none" stroke="#64748b" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>{values.map((v,i)=><g key={i}><circle cx={x(i)} cy={y(v)} r="5" fill={pointIsGood(v,i)?"#16a34a":"#dc2626"} stroke="white" strokeWidth="1.5"/><text x={x(i)} y={h-20} textAnchor="middle" fontSize="10" fill="#6b7280">{labels?.[i] ?? `W${i+1}`}</text></g>)}</svg>{comparisonValues&&<div className="mt-1 flex items-center gap-2 text-xs text-gray-500"><span className="inline-block w-6 border-t-2 border-dashed border-blue-600"></span><span>{comparisonLabel}</span></div>}</div>
    };
    const average = (values:number[]) => values.length ? values.reduce((sum,v)=>sum+v,0)/values.length : 0;
    const metricTone = (value:number, avg:number, inverse=false) => {
      if (!Number.isFinite(value) || !Number.isFinite(avg) || Math.abs(value-avg) < 0.05) return "bg-gray-50 text-gray-700";
      const better = inverse ? value < avg : value > avg;
      return better
        ? "bg-emerald-50 text-emerald-800 font-semibold"
        : "bg-red-50 text-red-800 font-semibold";
    };
    const pct = (part:number,total:number) => total > 0 ? (part / total) * 100 : 0;
    const summarizeTrendWindow = (rows: typeof trend) => {
      const attempts = rows.reduce((sum,m)=>sum+m.attempts,0);
      const goalsCount = rows.reduce((sum,m)=>sum+m.goalsCount,0);
      const korfCount = rows.reduce((sum,m)=>sum+m.korfCount,0);
      const wonRebounds = rows.reduce((sum,m)=>sum+m.wonRebounds,0);
      const lostRebounds = rows.reduce((sum,m)=>sum+m.lostRebounds,0);
      const oppAttempts = rows.reduce((sum,m)=>sum+m.oppAttempts,0);
      const oppGoalsCount = rows.reduce((sum,m)=>sum+m.oppGoalsCount,0);
      const defendedCount = rows.reduce((sum,m)=>sum+m.defendedCount,0);
      const attackCount = rows.reduce((sum,m)=>sum+m.attackCount,0);
      return {
        attempts, attackCount, oppAttempts,
        score: pct(goalsCount, attempts),
        quality: pct(goalsCount + korfCount, attempts),
        reboundPct: pct(wonRebounds, wonRebounds + lostRebounds),
        attemptsPerAttack: attackCount ? attempts / attackCount : 0,
        oppScore: pct(oppGoalsCount, oppAttempts),
        defendedPct: pct(defendedCount, oppAttempts),
      };
    };
    const recentWindow = trend.slice(-Math.min(3, trend.length));
    const previousWindow = trend.length >= 6 ? trend.slice(-6, -3) : [];
    const recentSummary = summarizeTrendWindow(recentWindow);
    const previousSummary = summarizeTrendWindow(previousWindow);
    const recentVsPrevious = (selector:(m:(typeof trend)[number])=>number) => previousWindow.length ? average(recentWindow.map(selector)) - average(previousWindow.map(selector)) : 0;
    const developmentStrengths:string[] = [];
    const developmentAttention:string[] = [];
    if (trend.length >= 6) {
      const scoreDelta = recentSummary.score - previousSummary.score;
      const qualityDelta = recentSummary.quality - previousSummary.quality;
      const reboundDelta = recentSummary.reboundPct - previousSummary.reboundPct;
      const attackDelta = recentVsPrevious(m=>m.attack);
      const oppDelta = recentSummary.oppScore - previousSummary.oppScore;
      if (scoreDelta >= 5) developmentStrengths.push(`Afronding groeit: schotpercentage ligt recent ${scoreDelta.toFixed(1)} procentpunt hoger.`);
      if (qualityDelta >= 6) developmentStrengths.push(`Korfgerichtheid ontwikkelt positief: +${qualityDelta.toFixed(1)} procentpunt in de laatste wedstrijden.`);
      if (reboundDelta >= 8) developmentStrengths.push(`Reboundkracht neemt toe: recent +${reboundDelta.toFixed(1)} procentpunt gewonnen rebounds.`);
      if (attackDelta >= 4) developmentStrengths.push(`Meer aanvalstijd: Korbis speelt recent ${attackDelta.toFixed(1)} procentpunt meer in de aanval.`);
      if (oppDelta <= -5) developmentStrengths.push(`Verdediging wordt effectiever: tegenstanders scoren recent ${Math.abs(oppDelta).toFixed(1)} procentpunt minder.`);
      if (scoreDelta <= -5) developmentAttention.push(`Afronding loopt terug: schotpercentage ligt recent ${Math.abs(scoreDelta).toFixed(1)} procentpunt lager.`);
      if (qualityDelta <= -6) developmentAttention.push(`Korfgerichtheid daalt: recent ${Math.abs(qualityDelta).toFixed(1)} procentpunt lager.`);
      if (reboundDelta <= -8) developmentAttention.push(`Reboundpercentage neemt af: recent ${Math.abs(reboundDelta).toFixed(1)} procentpunt lager.`);
      if (attackDelta <= -4) developmentAttention.push(`Minder aanvalstijd: Korbis heeft recent ${Math.abs(attackDelta).toFixed(1)} procentpunt minder aanvalstijd.`);
      if (oppDelta >= 5) developmentAttention.push(`Tegenstanders worden efficiënter: hun schotpercentage is recent ${oppDelta.toFixed(1)} procentpunt hoger.`);
    }
    if (developmentStrengths.length === 0) developmentStrengths.push(trend.length < 6 ? "Na zes wedstrijden kan de app de laatste 3 wedstrijden vergelijken met de 3 daarvoor." : "De belangrijkste teamcijfers zijn over de laatste twee blokken van drie wedstrijden redelijk stabiel.");
    if (developmentAttention.length === 0) developmentAttention.push(trend.length < 6 ? "Nog te weinig wedstrijden voor een volledige 3-tegen-3 vergelijking." : "Geen duidelijke negatieve ontwikkeling tussen de laatste 3 en de 3 wedstrijden daarvoor.");
    const allOwnAttacks=(dbSheets?.attacks??[]).filter((a:any)=>ids.has(String(a.wedstrijd_id)) && String(a.team??"").trim().toLowerCase()==="korbis");
    const aggregateAttemptsPerAttack=allOwnAttacks.length?own.length/allOwnAttacks.length:0;
    const aggregateAttackDuration=allOwnAttacks.length?allOwnAttacks.reduce((sum:number,a:any)=>sum+toSeconds(a.duur),0)/allOwnAttacks.length:0;
    const defendedOpponent=opp.filter((e:any)=>e.uitkomst==="Verdedigd").length;
    const defendedOpponentPct=opp.length?defendedOpponent/opp.length*100:0;
    const steals=events.filter((e:any)=>isKorbis(e)&&(e.reden==="Schot afgevangen"||e.reden==="Pass Onderschept")).length;
    const averagePossession=average(selectedMatches.map((m:any)=>num(m.bezit_thuis_pct)));
    const averageAttackShare=average(selectedMatches.map((m:any)=>num(m.aanval_thuis_pct)));

    const buildVakHistory = (vakId: 1 | 2) => sortedDatabaseMatches.map((m:any, matchIndex:number) => {
      const matchId = String(m.wedstrijd_id);
      const matchEvents = (dbSheets?.events ?? []).filter((e:any) => String(e.wedstrijd_id) === matchId);
      const vakEvents = matchEvents.filter((e:any) => String(e.vak_id ?? "") === String(vakId));
      const ownAttempts = vakEvents.filter((e:any) => isKorbis(e) && isAttempt(e));
      const oppAttempts = vakEvents.filter((e:any) => !isKorbis(e) && isAttempt(e));
      const goalsCount = ownAttempts.filter((e:any) => e.uitkomst === "Raak").length;
      const korfCount = ownAttempts.filter((e:any) => e.uitkomst === "Korf").length;
      const oppGoalsCount = oppAttempts.filter((e:any) => e.uitkomst === "Raak").length;
      const won = vakEvents.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Rebound").length;
      const lost = vakEvents.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Geen Rebound").length;
      const attacks = (dbSheets?.attacks ?? []).filter((a:any) => String(a.wedstrijd_id) === matchId && String(a.team ?? "").trim().toLowerCase() === "korbis" && String(a.vak_id ?? "") === String(vakId));
      return {
        id: matchId, axisLabel: formatAxisDate(m.datum, matchIndex), attempts: ownAttempts.length, goalsCount, korfCount,
        score: pct(goalsCount, ownAttempts.length), quality: pct(goalsCount + korfCount, ownAttempts.length),
        reboundPct: pct(won, won + lost), attemptsPerAttack: attacks.length ? ownAttempts.length / attacks.length : 0,
        oppAttempts: oppAttempts.length, oppGoalsCount, oppScore: pct(oppGoalsCount, oppAttempts.length),
      };
    });
    const vak1Trend = buildVakHistory(1);
    const vak2Trend = buildVakHistory(2);
    const summarizeVakWindow = (rows: ReturnType<typeof buildVakHistory>) => {
      const attempts = rows.reduce((sum,r)=>sum+r.attempts,0);
      const goalsCount = rows.reduce((sum,r)=>sum+r.goalsCount,0);
      const korfCount = rows.reduce((sum,r)=>sum+r.korfCount,0);
      const oppAttempts = rows.reduce((sum,r)=>sum+r.oppAttempts,0);
      const oppGoalsCount = rows.reduce((sum,r)=>sum+r.oppGoalsCount,0);
      return { attempts, score:pct(goalsCount,attempts), quality:pct(goalsCount+korfCount,attempts), reboundPct:average(rows.map(r=>r.reboundPct)), attemptsPerAttack:average(rows.map(r=>r.attemptsPerAttack)), oppScore:pct(oppGoalsCount,oppAttempts) };
    };
    const vakRecent = [summarizeVakWindow(vak1Trend.slice(-3)), summarizeVakWindow(vak2Trend.slice(-3))];
    const vakPrevious = [summarizeVakWindow(vak1Trend.slice(-6,-3)), summarizeVakWindow(vak2Trend.slice(-6,-3))];

    const parsePlaytime = (m:any) => {
      try {
        const parsed = typeof m.speeltijd_spelers_json === "string"
          ? JSON.parse(m.speeltijd_spelers_json || "[]")
          : m.speeltijd_spelers_json;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const playtimeByPlayer = new Map<string, { seconds:number; matches:number; status:PlayerStatus }>();
    selectedMatches.forEach((m:any) => {
      parsePlaytime(m).forEach((row:any) => {
        const name=String(row.spelerNaam ?? "").trim();
        if (!name) return;
        const current=playtimeByPlayer.get(name) ?? { seconds:0, matches:0, status:"Basisspeler" as PlayerStatus };
        current.seconds += num(row.seconden);
        current.matches += num(row.seconden) > 0 ? 1 : 0;
        current.status = row.status === "Gast" ? "Gast" : "Basisspeler";
        playtimeByPlayer.set(name,current);
      });
    });
    const starterMinutes = Array.from(playtimeByPlayer.values()).filter(v=>v.status==="Basisspeler").map(v=>v.seconds/60);
    const avgStarterMinutes = average(starterMinutes);

    const selectedHistoryPlayer =
      historyPlayerName && names.includes(historyPlayerName)
        ? historyPlayerName
        : names[0] ?? "";

    const playerTrend = sortedDatabaseMatches.map((m: any, matchIndex:number) => {
      const matchId = String(m.wedstrijd_id);
      const matchEvents = (dbSheets?.events ?? []).filter(
        (e: any) => String(e.wedstrijd_id) === matchId
      );
      const playerEvents = matchEvents.filter(
        (e: any) =>
          isKorbis(e) && String(e.spelerNaam ?? "") === selectedHistoryPlayer
      );
      const attempts = playerEvents.filter(isAttempt);
      const goals = attempts.filter((e: any) => e.uitkomst === "Raak").length;
      const korfCount = attempts.filter((e: any) => e.uitkomst === "Korf").length;
      const defended = attempts.filter((e: any) => e.uitkomst === "Verdedigd").length;
      const playerRebounds = playerEvents.filter(
        (e: any) => e.actie === "Rebound" && e.reden === "Rebound"
      ).length;
      const teamAttempts = matchEvents.filter((e:any) => isKorbis(e) && isAttempt(e));
      const teamGoals = teamAttempts.filter((e:any) => e.uitkomst === "Raak").length;
      const teamKorf = teamAttempts.filter((e:any) => e.uitkomst === "Korf").length;
      const teamDefended = teamAttempts.filter((e:any) => e.uitkomst === "Verdedigd").length;
      const teamRebounds = matchEvents.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Rebound").length;
      const playtimeRows = parsePlaytime(m).filter((r:any) => num(r.seconden) > 0);
      const activePlayerCount = Math.max(1, playtimeRows.length || new Set(matchEvents.filter((e:any)=>isKorbis(e)).map((e:any)=>String(e.spelerNaam ?? "")).filter(Boolean)).size);

      return {
        id: matchId,
        label: formatDatabaseDate(m.datum) || String(m.wedstrijd_naam ?? ""),
        opponent: String(m.tegenstander ?? ""),
        matchNumber: matchIndex + 1,
        axisLabel: formatAxisDate(m.datum, matchIndex),
        attempts: attempts.length,
        goals,
        korfCount,
        defendedCount: defended,
        scorePct: attempts.length > 0 ? (goals / attempts.length) * 100 : 0,
        qualityPct: attempts.length > 0 ? ((goals + korfCount) / attempts.length) * 100 : 0,
        rebounds: playerRebounds,
        playedSeconds: (() => {
          const row = parsePlaytime(m).find((r:any) => String(r.spelerNaam ?? "") === selectedHistoryPlayer);
          return row ? num(row.seconden) : 0;
        })(),
        defendedPct: attempts.length > 0 ? (defended / attempts.length) * 100 : 0,
        teamAttemptsAvg: teamAttempts.length / activePlayerCount,
        teamScorePct: pct(teamGoals, teamAttempts.length),
        teamQualityPct: pct(teamGoals + teamKorf, teamAttempts.length),
        teamReboundsAvg: teamRebounds / activePlayerCount,
        teamDefendedPct: pct(teamDefended, teamAttempts.length),
      };
    });

    const periodCount = historyPlayerPeriod === "all" ? playerTrend.length : Number(historyPlayerPeriod);
    const playerPeriodTrend = historyPlayerPeriod === "all" ? playerTrend : playerTrend.slice(-periodCount);
    const playerPeriodIds = new Set(playerPeriodTrend.map((row) => row.id));
    const playerPeriodEvents = (dbSheets?.events ?? []).filter((e:any) => playerPeriodIds.has(String(e.wedstrijd_id)));

    const selectedPlayerAllEvents = playerPeriodEvents.filter(
      (e: any) => isKorbis(e) && String(e.spelerNaam ?? "") === selectedHistoryPlayer
    );
    const selectedPlayerAllAttempts = selectedPlayerAllEvents.filter(isAttempt);
    const selectedPlayerAllGoals = selectedPlayerAllAttempts.filter((e: any) => e.uitkomst === "Raak").length;
    const selectedPlayerAllKorf = selectedPlayerAllAttempts.filter((e: any) => e.uitkomst === "Korf").length;
    const selectedPlayerAllDefended = selectedPlayerAllAttempts.filter((e: any) => e.uitkomst === "Verdedigd").length;
    const selectedPlayerAllRebounds = selectedPlayerAllEvents.filter(
      (e: any) => e.actie === "Rebound" && e.reden === "Rebound"
    ).length;

    const selectedPlayerOverallScore = selectedPlayerAllAttempts.length > 0 ? (selectedPlayerAllGoals / selectedPlayerAllAttempts.length) * 100 : 0;
    const selectedPlayerOverallQuality = selectedPlayerAllAttempts.length > 0 ? ((selectedPlayerAllGoals + selectedPlayerAllKorf) / selectedPlayerAllAttempts.length) * 100 : 0;
    const selectedPlayerOverallDefended = selectedPlayerAllAttempts.length > 0 ? (selectedPlayerAllDefended / selectedPlayerAllAttempts.length) * 100 : 0;
    const periodOwn = playerPeriodEvents.filter((e:any) => isKorbis(e) && isAttempt(e));
    const periodGoals = periodOwn.filter((e:any) => e.uitkomst === "Raak").length;
    const periodKorf = periodOwn.filter((e:any) => e.uitkomst === "Korf").length;
    const periodRebounds = playerPeriodEvents.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Rebound").length;
    const periodPlayerNames = new Set(playerPeriodEvents.filter((e:any)=>isKorbis(e) && e.spelerNaam).map((e:any)=>String(e.spelerNaam)));
    const teamPlayerCount = Math.max(1, periodPlayerNames.size);
    const teamAvgAttemptsPerPlayer = periodOwn.length / teamPlayerCount;
    const teamAvgReboundsPerPlayer = periodRebounds / teamPlayerCount;
    const teamPeriodScorePct = pct(periodGoals, periodOwn.length);
    const teamPeriodQualityPct = pct(periodGoals + periodKorf, periodOwn.length);
    const teamOwnDefended = periodOwn.filter((e:any) => e.uitkomst === "Verdedigd").length;
    const teamOwnDefendedPct = pct(teamOwnDefended, periodOwn.length);
    const compareTone = (value:number, benchmark:number, inverse=false) => metricTone(value, benchmark, inverse);
    const summarizePlayerWindow = (rows: typeof playerTrend) => {
      const attempts = rows.reduce((sum,r)=>sum+r.attempts,0);
      const goalsCount = rows.reduce((sum,r)=>sum+r.goals,0);
      const korfCount = rows.reduce((sum,r)=>sum+r.korfCount,0);
      const defendedCount = rows.reduce((sum,r)=>sum+r.defendedCount,0);
      return { attempts, score:pct(goalsCount,attempts), quality:pct(goalsCount+korfCount,attempts), defended:pct(defendedCount,attempts), rebounds:rows.reduce((sum,r)=>sum+r.rebounds,0) };
    };
    const playerRecent = summarizePlayerWindow(playerPeriodTrend.slice(-3));
    const playerPrevious = summarizePlayerWindow(playerPeriodTrend.slice(-6,-3));
    const playerComparisonReliable = playerPeriodTrend.length >= 6 && playerRecent.attempts >= 6 && playerPrevious.attempts >= 6;

    const isDefensiveContribution = (e:any) => {
      const vak = String(e.vak ?? "").toLowerCase();
      const defensiveVak = vak.includes("verdedig");
      const stop = String(e.uitkomst ?? "") === "Verdedigd";
      const steal = e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept";
      return defensiveVak && (stop || steal);
    };
    const selectedPlayerDefensiveActions = selectedPlayerAllEvents.filter(isDefensiveContribution).length;
    const periodTeamDefensiveActions = playerPeriodEvents.filter((e:any) => isKorbis(e) && isDefensiveContribution(e)).length;
    const teamAvgDefensiveActionsPerPlayer = periodTeamDefensiveActions / teamPlayerCount;
    const teamAvgGoalsPerPlayer = periodGoals / teamPlayerCount;

    const historyPlayerControl = (
      <label className="flex flex-col gap-1 min-w-0">
        <span className="text-xs font-semibold text-gray-500">Speler</span>
        <select
          value={analysisMode === "speler" ? selectedHistoryPlayer : ""}
          onChange={(e) => setHistoryPlayerName(e.target.value)}
          disabled={analysisMode !== "speler"}
          className="w-full border rounded-xl px-3 py-2 bg-white text-sm min-w-0 disabled:bg-gray-50 disabled:text-gray-400"
        >
          {analysisMode !== "speler" && <option value="">Niet van toepassing</option>}
          {names.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
    );
    const historyPeriodControl = (
      <label className="flex flex-col gap-1 min-w-0">
        <span className="text-xs font-semibold text-gray-500">Periode</span>
        <select
          value={all && analysisMode === "speler" ? historyPlayerPeriod : "wedstrijd"}
          onChange={(e) => setHistoryPlayerPeriod(e.target.value as "all" | "3" | "5" | "10")}
          disabled={!all || analysisMode !== "speler"}
          className="w-full border rounded-xl px-3 py-2 bg-white text-sm min-w-0 disabled:bg-gray-50 disabled:text-gray-400"
        >
          {!all && <option value="wedstrijd">Deze wedstrijd</option>}
          {all && <>
            <option value="all">Hele selectie</option>
            <option value="3">Laatste 3</option>
            <option value="5">Laatste 5</option>
            <option value="10">Laatste 10</option>
          </>}
        </select>
      </label>
    );
    const historyInsightsHeader = (
      <div className="space-y-4">
        <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm">
          <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Insights</div>
          <h2 className="mt-1 text-2xl font-bold">{analysisMode === "speler" ? "Insights per speler" : "Team Insights"}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {all
              ? "Analyse op basis van de geselecteerde wedstrijden uit de geladen database."
              : "Analyse van de geselecteerde wedstrijd uit de geladen database."}
          </p>
        </div>
        <div className="grid gap-3 grid-cols-1 md:grid-cols-[minmax(280px,1.8fr)_250px_minmax(190px,1fr)_165px] items-end">
          <div className="min-w-0">{matchSelector}</div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-gray-500 mb-1">Analyse</div>
            {insightModeButtons}
          </div>
          {historyPlayerControl}
          {historyPeriodControl}
        </div>
      </div>
    );

    return <div className="space-y-6">
      {historyInsightsHeader}
      <div className="flex flex-col gap-4">
        {all && <div className="flex flex-col sm:flex-row gap-3 border rounded-2xl p-4 bg-gray-50">
          <label className="flex flex-col gap-1 min-w-[230px]"><span className="text-xs font-semibold text-gray-500">Seizoen</span><select value={historySeason} onChange={(e)=>setHistorySeason(e.target.value)} className="border rounded-xl px-3 py-2 bg-white text-sm"><option value="__all__">Alle seizoenen</option>{historySeasons.map(season=><option key={season} value={season}>{season}</option>)}</select></label>
          <label className="flex flex-col gap-1 min-w-[210px]"><span className="text-xs font-semibold text-gray-500">Wedstrijdtype</span><select value={historyMatchType} onChange={(e)=>setHistoryMatchType(e.target.value)} className="border rounded-xl px-3 py-2 bg-white text-sm"><option value="__all__">Alle wedstrijdtypen</option>{historyMatchTypes.map(type=><option key={type} value={type}>{type}</option>)}</select></label>
          <div className="text-sm text-gray-600 sm:self-end sm:pb-2">{selectedMatches.length} wedstrijd{selectedMatches.length===1?"":"en"} in deze selectie</div>
        </div>}
      </div>
      {analysisMode === "speler" && names.length > 0 ? (
        <>
          <div className="border rounded-2xl p-4 bg-gradient-to-br from-blue-50 to-white">
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-full border bg-white flex items-center justify-center">
                <span className="text-xl font-bold text-gray-400">{selectedHistoryPlayer.slice(0,1).toUpperCase() || "?"}</span>
              </div>
              <div>
                <div className="text-xl font-bold">{selectedHistoryPlayer || "Speler"}</div>
                <div className="text-sm text-gray-500">{selectedMatches.length} wedstrijd{selectedMatches.length===1?"":"en"} in deze selectie</div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              { label:"Acties", value:selectedPlayerAllAttempts.length.toString(), benchmark:teamAvgAttemptsPerPlayer, metric:selectedPlayerAllAttempts.length, sub:`Teamgem.: ${teamAvgAttemptsPerPlayer.toFixed(1)}` },
              { label:"Doelpunten", value:selectedPlayerAllGoals.toString(), benchmark:teamAvgGoalsPerPlayer, metric:selectedPlayerAllGoals, sub:`Teamgem.: ${teamAvgGoalsPerPlayer.toFixed(1)} · ${selectedPlayerOverallScore.toFixed(0)}% raak` },
              { label:"Schotkwaliteit", value:selectedPlayerAllAttempts.length ? `${selectedPlayerOverallQuality.toFixed(0)}%` : "—", benchmark:teamPeriodQualityPct, metric:selectedPlayerOverallQuality, sub:`Teamgem.: ${teamPeriodQualityPct.toFixed(0)}% · raak + korf` },
              { label:"Rebounds", value:selectedPlayerAllRebounds.toString(), benchmark:teamAvgReboundsPerPlayer, metric:selectedPlayerAllRebounds, sub:`Teamgem.: ${teamAvgReboundsPerPlayer.toFixed(1)}` },
              { label:"Verdedigend", value:selectedPlayerDefensiveActions.toString(), benchmark:teamAvgDefensiveActionsPerPlayer, metric:selectedPlayerDefensiveActions, sub:`Teamgem.: ${teamAvgDefensiveActionsPerPlayer.toFixed(1)} acties` },
            ].map((card) => {
              const same=Math.abs(card.metric-card.benchmark)<0.05;
              const tone=same?"text-gray-900":card.metric>card.benchmark?"text-emerald-600":"text-red-600";
              return <div key={card.label} className="border rounded-2xl p-4 bg-white shadow-sm"><div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{card.label}</div><div className={`text-3xl font-extrabold mt-1 ${tone}`}>{card.value}</div><div className="text-xs text-gray-500 mt-1">{card.sub}</div></div>;
            })}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{[["Wedstrijden",selectedMatches.length],["Kansen raak",own.length?`${scorePct.toFixed(1)}%`:"—"],["Korfgerichtheid",own.length?`${qualityPct.toFixed(1)}%`:"—"],["Aanvallende rebounds gewonnen",rebounds+noRebounds?`${reboundPct.toFixed(0)}%`:"—"],["Kansen tegenstander raak",opp.length?`${oppPct.toFixed(1)}%`:"—"]].map(([l,v])=><div key={String(l)} className="border rounded-2xl p-4 bg-white"><div className="text-xs font-semibold text-gray-500">{l}</div><div className="text-3xl font-extrabold mt-1">{v}</div></div>)}</div>
      )}
      {all && analysisMode === "team" && <><div className="border rounded-2xl p-5 bg-white">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2 mb-4"><div><div className="text-lg font-bold">Laatste 3 vs. de 3 daarvoor</div><div className="text-sm text-gray-500">Percentages worden gewogen op het aantal kansen.</div></div><div className="text-xs font-semibold text-gray-500">{trend.length >= 6 ? "Volledige vergelijking" : `${trend.length}/6 wedstrijden beschikbaar`}</div></div>
        {trend.length >= 6 ? <div className="overflow-auto"><table className="w-full text-sm min-w-[760px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Kengetal</th><th className="text-right p-3">3 daarvoor</th><th className="text-right p-3">Laatste 3</th><th className="text-right p-3">Verschil</th></tr></thead><tbody>{[
          ["Kansen raak",previousSummary.score,recentSummary.score,"%"],["Korfgerichtheid",previousSummary.quality,recentSummary.quality,"%"],["Aanvallende rebounds gewonnen",previousSummary.reboundPct,recentSummary.reboundPct,"%"],["Kansen per aanval",previousSummary.attemptsPerAttack,recentSummary.attemptsPerAttack,""],["Kansen tegenstander raak",previousSummary.oppScore,recentSummary.oppScore,"%"],["Pogingen tegenstander verdedigd",previousSummary.defendedPct,recentSummary.defendedPct,"%"]
        ].map(([label,previous,recent,suffix])=>{const p=Number(previous),r=Number(recent),d=r-p;const inverse=String(label)==="Kansen tegenstander raak";const better=inverse?d<0:d>0;const tone=Math.abs(d)<0.05?"bg-gray-50 text-gray-700":better?"bg-emerald-50 text-emerald-800":"bg-red-50 text-red-800";return <tr key={String(label)} className="border-t"><td className="p-3 font-semibold">{label}</td><td className="p-3 text-right">{p.toFixed(suffix?1:2)}{suffix}</td><td className={`p-3 text-right ${tone}`}>{r.toFixed(suffix?1:2)}{suffix}</td><td className={`p-3 text-right font-bold ${tone}`}>{d>0?"+":""}{d.toFixed(suffix?1:2)}{suffix}</td></tr>})}</tbody></table></div> : <div className="text-sm text-gray-500">Voor deze vergelijking zijn zes wedstrijden binnen hetzelfde filter nodig.</div>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
          <div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Sterke punten in de ontwikkeling</div><div className="space-y-2">{developmentStrengths.slice(0,5).map((item,i)=><div key={i} className="flex gap-2 rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2 text-sm"><SignalDot tone="green"/><span>{item}</span></div>)}</div></div>
          <div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Aandachtspunten in de ontwikkeling</div><div className="space-y-2">{developmentAttention.slice(0,5).map((item,i)=><div key={i} className="flex gap-2 rounded-xl bg-orange-50 border border-orange-100 px-3 py-2 text-sm"><SignalDot tone="orange"/><span>{item}</span></div>)}</div></div>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Aanvalsprofiel</div><div className="space-y-2 text-sm"><div className="flex justify-between"><span>Pogingen per aanval</span><b>{aggregateAttemptsPerAttack.toFixed(2)}</b></div><div className="flex justify-between"><span>Gem. aanvalsduur</span><b>{formatTime(Math.round(aggregateAttackDuration))}</b></div><div className="flex justify-between"><span>Kansen raak</span><b>{scorePct.toFixed(1)}%</b></div><div className="flex justify-between"><span>Korfgerichtheid</span><b>{qualityPct.toFixed(1)}%</b></div><div className="flex justify-between"><span>Gem. aanvalstijd</span><b>{averageAttackShare.toFixed(1)}%</b></div></div></div>
          <div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Verdedigend profiel</div><div className="space-y-2 text-sm"><div className="flex justify-between"><span>Tegenstander schot %</span><b>{oppPct.toFixed(1)}%</b></div><div className="flex justify-between"><span>Verdedigde pogingen</span><b>{defendedOpponentPct.toFixed(1)}%</b></div><div className="flex justify-between"><span>Steals / onderscheppingen</span><b>{steals}</b></div><div className="flex justify-between"><span>Tegendoelpunten</span><b>{selectedMatches.reduce((sum:number,m:any)=>sum+num(m.score_tegenstander),0)}</b></div></div></div>
          <div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Balbezit & spelverdeling</div><div className="space-y-2 text-sm"><div className="flex justify-between"><span>Gem. balbezit Korbis</span><b>{averagePossession.toFixed(1)}%</b></div><div className="flex justify-between"><span>Gem. aanvalstijd Korbis</span><b>{averageAttackShare.toFixed(1)}%</b></div><div className="flex justify-between"><span>Gem. verdedigingstijd</span><b>{Math.max(0,100-averageAttackShare).toFixed(1)}%</b></div><div className="flex justify-between"><span>Wedstrijden</span><b>{selectedMatches.length}</b></div></div></div>
        </div>
        <div className="space-y-4">
          <div><h3 className="text-xl font-bold">Ontwikkeling Vak 1 vs Vak 2</h3><p className="text-sm text-gray-500">De vakidentiteit blijft gelijk, ook als een vak wisselt tussen aanval en verdediging.</p></div>
          <div className="border rounded-2xl overflow-hidden bg-white"><div className="overflow-auto"><table className="w-full text-sm min-w-[820px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Laatste 3 wedstrijden</th><th className="text-right p-3">Vak 1</th><th className="text-right p-3">Vak 2</th></tr></thead><tbody>{[["Kansen",vakRecent[0].attempts,vakRecent[1].attempts,"count"],["Kansen raak",vakRecent[0].score,vakRecent[1].score,"pct"],["Korfgerichtheid",vakRecent[0].quality,vakRecent[1].quality,"pct"],["Aanvallende rebound gewonnen",vakRecent[0].reboundPct,vakRecent[1].reboundPct,"pct"],["Kansen per aanval",vakRecent[0].attemptsPerAttack,vakRecent[1].attemptsPerAttack,"decimal"],["Kansen tegenstander raak",vakRecent[0].oppScore,vakRecent[1].oppScore,"pct"]].map(([label,v1,v2,kind])=><tr key={String(label)} className="border-t"><td className="p-3 font-semibold">{label}</td><td className="p-3 text-right">{kind==="pct"?`${Number(v1).toFixed(1)}%`:kind==="decimal"?Number(v1).toFixed(2):Number(v1).toFixed(0)}</td><td className="p-3 text-right">{kind==="pct"?`${Number(v2).toFixed(1)}%`:kind==="decimal"?Number(v2).toFixed(2):Number(v2).toFixed(0)}</td></tr>)}</tbody></table></div>{trend.length>=6 && <div className="p-3 border-t text-xs text-gray-500">3 wedstrijden daarvoor: kansen raak Vak 1 {vakPrevious[0].score.toFixed(1)}% · Vak 2 {vakPrevious[1].score.toFixed(1)}%.</div>}</div>
          <div className="grid gap-4 lg:grid-cols-2"><Trend title="Vak 1 – kansen raak" values={vak1Trend.map(m=>m.score)} labels={vak1Trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Vak 2 – kansen raak" values={vak2Trend.map(m=>m.score)} labels={vak2Trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Vak 1 – tegenstander kansen raak" values={vak1Trend.map(m=>m.oppScore)} labels={vak1Trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Vak 2 – tegenstander kansen raak" values={vak2Trend.map(m=>m.oppScore)} labels={vak2Trend.map(m=>m.axisLabel)} suffix="%"/></div>
        </div>
        <div><h3 className="text-xl font-bold">Ontwikkeling team</h3><p className="text-sm text-gray-500">De X-as gebruikt de wedstrijddatum met ISO-weeknummer, zodat je de ontwikkeling ook in de tijd kunt plaatsen.</p></div>
        <div className="grid gap-4 lg:grid-cols-2"><Trend title="Kansen raak" values={trend.map(m=>m.score)} labels={trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Korfgerichtheid" values={trend.map(m=>m.quality)} labels={trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Aanvallende rebounds gewonnen" values={trend.map(m=>m.reboundPct)} labels={trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Aanvalstijd Korbis" values={trend.map(m=>m.attack)} labels={trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Balbezit Korbis" values={trend.map(m=>m.possession)} labels={trend.map(m=>m.axisLabel)} suffix="%"/><Trend title="Kansen tegenstander raak" values={trend.map(m=>m.oppScore)} labels={trend.map(m=>m.axisLabel)} suffix="%"/></div>
        <div className="border rounded-2xl overflow-hidden bg-white"><div className="p-4 border-b font-bold">Wedstrijdontwikkeling</div><div className="overflow-auto"><table className="w-full text-sm min-w-[900px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Datum</th><th className="text-left p-3">Wedstrijd</th><th className="text-right p-3">Uitslag</th><th className="text-right p-3">% raak</th><th className="text-right p-3">% raak of korf</th><th className="text-right p-3">Aanv. rebound %</th><th className="text-right p-3">Aanvalstijd %</th><th className="text-right p-3">Balbezit %</th><th className="text-right p-3">Tegenstander % raak</th></tr></thead><tbody>{trend.map(m=><tr key={m.id} className="border-t"><td className="p-3">{m.label}</td><td className="p-3 font-semibold">Korbis{m.opponent ? ` - ${m.opponent}` : ""}</td><td className="p-3 text-right">{m.goals}-{m.against}</td><td className={`p-3 text-right ${metricTone(m.score,average(trend.map(x=>x.score)))}`}>{m.score.toFixed(1)}%</td><td className={`p-3 text-right ${metricTone(m.quality,average(trend.map(x=>x.quality)))}`}>{m.quality.toFixed(1)}%</td><td className={`p-3 text-right ${metricTone(m.reboundPct,average(trend.map(x=>x.reboundPct)))}`}>{m.reboundPct.toFixed(0)}%</td><td className={`p-3 text-right ${metricTone(m.attack,average(trend.map(x=>x.attack)))}`}>{m.attack.toFixed(1)}%</td><td className={`p-3 text-right ${metricTone(m.possession,average(trend.map(x=>x.possession)))}`}>{m.possession.toFixed(1)}%</td><td className={`p-3 text-right ${metricTone(m.oppScore,average(trend.map(x=>x.oppScore)),true)}`}>{m.oppScore.toFixed(1)}%</td></tr>)}</tbody></table></div></div>
      </>}
      {all && analysisMode === "speler" && names.length > 0 && (
        <div className="space-y-4">
          <div className="border-b pb-2"><h3 className="text-xl font-bold">Ontwikkeling per speler</h3><p className="text-sm text-gray-500">Volg per wedstrijd of een speler vooruitgaat, stabiel blijft of terugvalt.</p></div>

          <div className="border rounded-2xl p-4 bg-white">
            <div className="font-bold">Laatste 3 vs. de 3 daarvoor</div>
            {playerComparisonReliable ? <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3"><div className={playerRecent.score>=playerPrevious.score?"rounded-xl bg-emerald-50 p-3":"rounded-xl bg-red-50 p-3"}><div className="text-xs text-gray-500">Kansen raak</div><div className="font-bold">{playerPrevious.score.toFixed(1)}% → {playerRecent.score.toFixed(1)}%</div></div><div className={playerRecent.quality>=playerPrevious.quality?"rounded-xl bg-emerald-50 p-3":"rounded-xl bg-red-50 p-3"}><div className="text-xs text-gray-500">Korfgerichtheid</div><div className="font-bold">{playerPrevious.quality.toFixed(1)}% → {playerRecent.quality.toFixed(1)}%</div></div><div className={playerRecent.rebounds>=playerPrevious.rebounds?"rounded-xl bg-emerald-50 p-3":"rounded-xl bg-red-50 p-3"}><div className="text-xs text-gray-500">Rebounds</div><div className="font-bold">{playerPrevious.rebounds} → {playerRecent.rebounds}</div></div><div className={playerRecent.attempts>=playerPrevious.attempts?"rounded-xl bg-emerald-50 p-3":"rounded-xl bg-red-50 p-3"}><div className="text-xs text-gray-500">Kansen</div><div className="font-bold">{playerPrevious.attempts} → {playerRecent.attempts}</div></div></div> : <div className="text-sm text-gray-500 mt-2">Voor een spelersvergelijking zijn zes wedstrijden én minimaal 6 kansen in beide blokken nodig.</div>}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <div className={`border rounded-2xl p-4 ${compareTone(selectedPlayerAllAttempts.length,teamAvgAttemptsPerPlayer)}`}><div className="text-xs font-semibold opacity-70">Kansen</div><div className="text-3xl font-extrabold mt-1">{selectedPlayerAllAttempts.length}</div><div className="text-xs mt-1 opacity-80">Teamgem. per speler: {teamAvgAttemptsPerPlayer.toFixed(1)}</div></div>
            <div className={`border rounded-2xl p-4 ${compareTone(selectedPlayerOverallScore,teamPeriodScorePct)}`}><div className="text-xs font-semibold opacity-70">Kansen raak</div><div className="text-3xl font-extrabold mt-1">{selectedPlayerAllAttempts.length ? `${selectedPlayerOverallScore.toFixed(1)}%` : "—"}</div><div className="text-xs mt-1 opacity-80">Team: {teamPeriodScorePct.toFixed(1)}% · {selectedPlayerAllGoals} goals</div></div>
            <div className={`border rounded-2xl p-4 ${compareTone(selectedPlayerOverallQuality,teamPeriodQualityPct)}`}><div className="text-xs font-semibold opacity-70">Korfgerichtheid</div><div className="text-3xl font-extrabold mt-1">{selectedPlayerAllAttempts.length ? `${selectedPlayerOverallQuality.toFixed(1)}%` : "—"}</div><div className="text-xs mt-1 opacity-80">Team: {teamPeriodQualityPct.toFixed(1)}%</div></div>
            <div className={`border rounded-2xl p-4 ${compareTone(selectedPlayerAllRebounds,teamAvgReboundsPerPlayer)}`}><div className="text-xs font-semibold opacity-70">Rebounds</div><div className="text-3xl font-extrabold mt-1">{selectedPlayerAllRebounds}</div><div className="text-xs mt-1 opacity-80">Teamgem. per speler: {teamAvgReboundsPerPlayer.toFixed(1)}</div></div>
            <div className={`border rounded-2xl p-4 ${compareTone(selectedPlayerOverallDefended,teamOwnDefendedPct,true)}`}><div className="text-xs font-semibold opacity-70">Eigen pogingen verdedigd</div><div className="text-3xl font-extrabold mt-1">{selectedPlayerAllAttempts.length ? `${selectedPlayerOverallDefended.toFixed(1)}%` : "—"}</div><div className="text-xs mt-1 opacity-80">Team: {teamOwnDefendedPct.toFixed(1)}% · lager is beter</div></div>
            <div className="border rounded-2xl p-4 bg-white"><div className="text-xs font-semibold text-gray-500">Speelminuten</div><div className="text-3xl font-extrabold mt-1">{Math.round(playerPeriodTrend.reduce((sum,row)=>sum+row.playedSeconds,0)/60)}</div><div className="text-xs text-gray-500 mt-1">{playtimeByPlayer.get(selectedHistoryPlayer)?.status ?? "Basisspeler"}</div></div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Trend title={`${selectedHistoryPlayer} – kansen raak`} values={playerPeriodTrend.map((m) => m.scorePct)} comparisonValues={playerPeriodTrend.map((m)=>m.teamScorePct)} comparisonLabel="Team" labels={playerPeriodTrend.map((m) => m.axisLabel)} suffix="%"/>
            <Trend title={`${selectedHistoryPlayer} – korfgerichtheid`} values={playerPeriodTrend.map((m) => m.qualityPct)} comparisonValues={playerPeriodTrend.map((m)=>m.teamQualityPct)} comparisonLabel="Team" labels={playerPeriodTrend.map((m) => m.axisLabel)} suffix="%"/>
            <Trend title={`${selectedHistoryPlayer} – kansen`} values={playerPeriodTrend.map((m) => m.attempts)} comparisonValues={playerPeriodTrend.map((m)=>m.teamAttemptsAvg)} comparisonLabel="Teamgem. per speler" labels={playerPeriodTrend.map((m) => m.axisLabel)}/>
            <Trend title={`${selectedHistoryPlayer} – gewonnen rebounds`} values={playerPeriodTrend.map((m) => m.rebounds)} comparisonValues={playerPeriodTrend.map((m)=>m.teamReboundsAvg)} comparisonLabel="Teamgem. per speler" labels={playerPeriodTrend.map((m) => m.axisLabel)}/>
            <Trend title={`${selectedHistoryPlayer} – eigen pogingen verdedigd`} values={playerPeriodTrend.map((m) => m.defendedPct)} comparisonValues={playerPeriodTrend.map((m)=>m.teamDefendedPct)} comparisonLabel="Team" inverseComparison labels={playerPeriodTrend.map((m) => m.axisLabel)} suffix="%"/>
            <Trend title={`${selectedHistoryPlayer} – speelminuten`} values={playerPeriodTrend.map((m) => m.playedSeconds/60)} labels={playerPeriodTrend.map((m) => m.axisLabel)}/>
          </div>

          <div className="border rounded-2xl overflow-hidden bg-white">
            <div className="p-4 border-b"><div className="text-lg font-bold">Wedstrijdontwikkeling {selectedHistoryPlayer}</div><div className="text-sm text-gray-500">Percentages met weinig pogingen kunnen sterk schommelen; daarom tonen we het aantal pogingen er altijd naast.</div></div>
            <div className="overflow-auto"><table className="w-full text-sm min-w-[820px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Datum · wedstrijd</th><th className="text-right p-3">Kansen</th><th className="text-right p-3">Teamgem.</th><th className="text-right p-3">Goals</th><th className="text-right p-3">% raak</th><th className="text-right p-3">Team %</th><th className="text-right p-3">% raak of korf</th><th className="text-right p-3">Team %</th><th className="text-right p-3">Rebounds</th><th className="text-right p-3">Teamgem.</th><th className="text-right p-3">Verdedigd %</th><th className="text-right p-3">Team %</th><th className="text-right p-3">Minuten</th></tr></thead><tbody>{playerPeriodTrend.map((row) => <tr key={row.id} className="border-t"><td className="p-3"><div className="font-semibold">{row.label}</div><div className="text-sm font-semibold text-gray-700">Korbis{row.opponent ? ` - ${row.opponent}` : ""}</div><div className="text-xs text-gray-400">Wedstrijd {row.matchNumber}</div></td><td className={`p-3 text-right ${metricTone(row.attempts,row.teamAttemptsAvg)}`}>{row.attempts}</td><td className="p-3 text-right text-gray-500">{row.teamAttemptsAvg.toFixed(1)}</td><td className="p-3 text-right">{row.goals}</td><td className={`p-3 text-right ${metricTone(row.scorePct,row.teamScorePct)}`}>{row.attempts ? `${row.scorePct.toFixed(1)}%` : "—"}</td><td className="p-3 text-right text-gray-500">{row.teamScorePct.toFixed(1)}%</td><td className={`p-3 text-right ${metricTone(row.qualityPct,row.teamQualityPct)}`}>{row.attempts ? `${row.qualityPct.toFixed(1)}%` : "—"}</td><td className="p-3 text-right text-gray-500">{row.teamQualityPct.toFixed(1)}%</td><td className={`p-3 text-right ${metricTone(row.rebounds,row.teamReboundsAvg)}`}>{row.rebounds}</td><td className="p-3 text-right text-gray-500">{row.teamReboundsAvg.toFixed(1)}</td><td className={`p-3 text-right ${metricTone(row.defendedPct,row.teamDefendedPct,true)}`}>{row.attempts ? `${row.defendedPct.toFixed(1)}%` : "—"}</td><td className="p-3 text-right text-gray-500">{row.teamDefendedPct.toFixed(1)}%</td><td className="p-3 text-right font-semibold">{Math.round(row.playedSeconds/60)}</td></tr>)}</tbody></table></div>
          </div>
        </div>
      )}

      {all && analysisMode === "speler" && playtimeByPlayer.size > 0 && <div className="border-2 border-blue-100 rounded-2xl overflow-hidden bg-white"><div className="p-4 border-b bg-blue-50"><div className="text-lg font-bold text-blue-950">Speelminuten basisspelers</div><div className="text-sm text-blue-700">Groen = boven het gemiddelde van de basisspelers in deze selectie, rood = eronder. Gasten staan apart vermeld.</div></div><div className="overflow-auto"><table className="w-full text-sm min-w-[620px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Speler</th><th className="text-left p-3">Status</th><th className="text-right p-3">Wedstrijden gespeeld</th><th className="text-right p-3">Minuten</th><th className="text-right p-3">Verschil t.o.v. basisgem.</th></tr></thead><tbody>{Array.from(playtimeByPlayer.entries()).sort((a,b)=>a[1].status.localeCompare(b[1].status)||a[0].localeCompare(b[0])).map(([name,v])=>{const minutes=v.seconds/60;const delta=minutes-avgStarterMinutes;return <tr key={name} className="border-t"><td className="p-3 font-semibold">{name}</td><td className="p-3">{v.status}</td><td className="p-3 text-right">{v.matches}</td><td className={`p-3 text-right ${v.status==="Basisspeler"?metricTone(minutes,avgStarterMinutes):"bg-gray-50 text-gray-700"}`}>{Math.round(minutes)}</td><td className="p-3 text-right">{v.status==="Basisspeler"?`${delta>=0?"+":""}${Math.round(delta)} min`:"—"}</td></tr>})}</tbody></table></div></div>}

      {analysisMode === "team" && <div className="border rounded-2xl overflow-hidden bg-white"><div className="p-4 border-b"><div className="text-lg font-bold">Spelers</div><div className="text-sm text-gray-500">{all?"Totaal over alle gekozen wedstrijden.":"Prestatie in deze wedstrijd."}</div></div><div className="overflow-auto"><table className="w-full text-sm min-w-[700px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Speler</th><th className="text-right p-3">Kansen</th><th className="text-right p-3">Goals</th><th className="text-right p-3">% raak</th><th className="text-right p-3">% raak of korf</th><th className="text-right p-3">Rebounds</th></tr></thead><tbody>{players.map(p=><tr key={p.name} className="border-t"><td className="p-3 font-semibold">{p.name}</td><td className="p-3 text-right">{p.attempts}</td><td className="p-3 text-right">{p.goals}</td><td className="p-3 text-right">{p.attempts?`${p.score.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{p.attempts?`${p.quality.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{p.rebounds}</td></tr>)}</tbody></table></div></div>}
    </div>;
  }

  const selectedPlayer = selectedPlayerId
    ? spelersMap.get(selectedPlayerId)
    : undefined;

  const playerEvents = selectedPlayerId
    ? state.log.filter((e) => e.spelerId === selectedPlayerId)
    : [];

  const attackingEvents = playerEvents.filter(
    (e) =>
      e.vak === "aanvallend" &&
      !!e.actie &&
      ACTIONS.includes(e.actie as ActionKind) &&
      !!e.resultaat
  );

  const reboundEvents = playerEvents.filter(
    (e) => e.soort === "Rebound" && e.reden === "Rebound"
  );

  const allReboundMoments = state.log.filter(
    (e) => e.soort === "Rebound" && e.vak === "aanvallend"
  );

  const defensiveStops = playerEvents.filter(
    (e) => e.vak === "verdedigend" && e.resultaat === "Verdedigd"
  ).length;

  const steals = playerEvents.filter(
    (e) =>
      e.vak === "verdedigend" &&
      (e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept")
  ).length;

  const againstGoals = playerEvents.filter(
    (e) => e.vak === "verdedigend" && e.reden === "Doorgelaten"
  ).length;

  const goals = attackingEvents.filter((e) => e.resultaat === "Raak").length;
  const korf = attackingEvents.filter((e) => e.resultaat === "Korf").length;
  const defended = attackingEvents.filter(
    (e) => e.resultaat === "Verdedigd"
  ).length;
  const attempts = attackingEvents.length;

  const scorePct = attempts > 0 ? (goals / attempts) * 100 : 0;
  const qualityPct = attempts > 0 ? ((goals + korf) / attempts) * 100 : 0;
  const reboundSharePct =
    allReboundMoments.length > 0
      ? (reboundEvents.length / allReboundMoments.length) * 100
      : 0;

  const actionStats = ACTIONS.map((actie) => {
    const events = attackingEvents.filter((e) => e.actie === actie);
    const raak = events.filter((e) => e.resultaat === "Raak").length;
    const korfCount = events.filter((e) => e.resultaat === "Korf").length;
    const mis = events.filter((e) => e.resultaat === "Mis").length;
    const verdedigd = events.filter((e) => e.resultaat === "Verdedigd").length;
    const totaal = events.length;

    return {
      actie,
      totaal,
      raak,
      korf: korfCount,
      mis,
      verdedigd,
      scorePct: totaal > 0 ? (raak / totaal) * 100 : 0,
      qualityPct: totaal > 0 ? ((raak + korfCount) / totaal) * 100 : 0,
    };
  });

  const strengths: string[] = [];
  const attentionPoints: string[] = [];

  if (attempts >= 5 && scorePct >= 40) {
    strengths.push(
      `Sterke afwerking: ${scorePct.toFixed(0)}% van ${attempts} pogingen is raak.`
    );
  }

  if (attempts >= 5 && qualityPct >= 70) {
    strengths.push(
      `Hoge schotkwaliteit: ${qualityPct.toFixed(0)}% is raak of raakt de korf.`
    );
  }

  actionStats.forEach((s) => {
    if (s.totaal >= 3 && s.scorePct >= 50) {
      strengths.push(
        `${s.actie} is sterk: ${s.raak} uit ${s.totaal} raak (${s.scorePct.toFixed(0)}%).`
      );
    }
  });

  if (reboundEvents.length >= 3 && reboundSharePct >= 25) {
    strengths.push(
      `Veel reboundbijdrage: ${reboundEvents.length} rebounds (${reboundSharePct.toFixed(0)}% van de geregistreerde reboundmomenten).`
    );
  }

  if (steals >= 2) {
    strengths.push(`Verdedigend actief: ${steals} steals/onderscheppingen geregistreerd.`);
  }

  if (attempts >= 5 && scorePct < 20) {
    attentionPoints.push(
      `Afwerking: ${goals} uit ${attempts} pogingen raak (${scorePct.toFixed(0)}%).`
    );
  }

  if (attempts >= 5 && defended / attempts >= 0.25) {
    attentionPoints.push(
      `${defended} van ${attempts} aanvallende acties werden als verdedigd geregistreerd.`
    );
  }

  actionStats.forEach((s) => {
    if (s.totaal >= 3 && s.scorePct < 20) {
      attentionPoints.push(
        `${s.actie}: ${s.raak} uit ${s.totaal} raak. Dit kan een gericht trainingspunt zijn.`
      );
    }
  });

  if (againstGoals >= 2) {
    attentionPoints.push(
      `Verdedigend terugkijken: ${againstGoals} keer is 'Doorgelaten' bij deze speler geregistreerd.`
    );
  }

  // Persoonlijke veldmarkers koppelen aan de actie-events van de geselecteerde speler.
  // FieldEvent bevat geen spelerId, dus we koppelen op aanval, vak, actie, resultaat en tijd.
  const fieldMarkerIds = new Set<string>();
  const playerFieldMarkers: FieldEvent[] = [];

  const actionToField = (actie?: LogEvent["actie"]): FieldEvent["actie"] => {
    if (actie === "Schot") return "schot";
    if (actie === "Doorloop") return "doorloop";
    if (actie === "Strafworp") return "strafworp";
    return "vrije";
  };

  attackingEvents.forEach((e) => {
    const candidates = state.fieldEvents.filter((fe) => {
      if (fe.vak !== "aanvallend") return false;
      if (e.attackId && fe.attackId !== e.attackId) return false;
      if (e.actie && fe.actie && fe.actie !== actionToField(e.actie)) return false;
      if (
        e.resultaat &&
        fe.resultaat &&
        fe.resultaat !== e.resultaat.toLowerCase()
      ) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) return;

    let best = candidates[0];
    let bestDelta = Math.abs(best.tijdSeconden - e.tijdSeconden);

    for (const candidate of candidates) {
      const delta = Math.abs(candidate.tijdSeconden - e.tijdSeconden);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }

    if (!fieldMarkerIds.has(best.id)) {
      fieldMarkerIds.add(best.id);
      playerFieldMarkers.push(best);
    }
  });

  const markerFill = (ev: FieldEvent) => {
    if (ev.actie === "schot") return "#2563eb";
    if (ev.actie === "doorloop") return "#db2777";
    if (ev.actie === "strafworp") return "#7c3aed";
    if (ev.actie === "vrije") return "#92400e";
    return "#6b7280";
  };

  const markerBorder = (ev: FieldEvent) => {
    if (ev.resultaat === "raak") return "#16a34a";
    if (ev.resultaat === "mis") return "#dc2626";
    if (ev.resultaat === "korf") return "#f97316";
    if (ev.resultaat === "verdedigd") return "#0f172a";
    return "#111827";
  };

  const SHOT_ZONES: ShotZone[] = [
    "Korte kans",
    "Afstandsschot",
    "Ver afstandsschot",
  ];

  const shotZoneStats = SHOT_ZONES.map((zone) => {
    const events = playerFieldMarkers.filter(
      (ev) => ev.actie === "schot" && getShotZone(ev) === zone
    );

    const raak = events.filter((ev) => ev.resultaat === "raak").length;
    const korfCount = events.filter((ev) => ev.resultaat === "korf").length;
    const mis = events.filter((ev) => ev.resultaat === "mis").length;
    const verdedigd = events.filter((ev) => ev.resultaat === "verdedigd").length;
    const totaal = events.length;

    return {
      zone,
      totaal,
      raak,
      korf: korfCount,
      mis,
      verdedigd,
      scorePct: totaal > 0 ? (raak / totaal) * 100 : 0,
      qualityPct: totaal > 0 ? ((raak + korfCount) / totaal) * 100 : 0,
      defendedPct: totaal > 0 ? (verdedigd / totaal) * 100 : 0,
    };
  });

  const positionedShotCount = shotZoneStats.reduce(
    (sum, zone) => sum + zone.totaal,
    0
  );

  const zoneStrengths: string[] = [];
  const zoneAttentionPoints: string[] = [];

  shotZoneStats.forEach((zone) => {
    // Vanaf vier geregistreerde schoten in een zone doen we een uitspraak.
    if (zone.totaal < 4) return;

    const strongThreshold =
      zone.zone === "Korte kans"
        ? 50
        : zone.zone === "Afstandsschot"
        ? 35
        : 25;

    const weakThreshold =
      zone.zone === "Korte kans"
        ? 30
        : zone.zone === "Afstandsschot"
        ? 20
        : 15;

    if (zone.scorePct >= strongThreshold) {
      zoneStrengths.push(
        `Sterk in ${zone.zone.toLowerCase()}: ${zone.raak} uit ${zone.totaal} raak (${zone.scorePct.toFixed(0)}%).`
      );
    }

    if (zone.scorePct < weakThreshold) {
      if (zone.qualityPct >= 65) {
        zoneAttentionPoints.push(
          `${zone.zone}: ${zone.raak} uit ${zone.totaal} raak, maar ${zone.raak + zone.korf} van de ${zone.totaal} waren raak of korf (${zone.qualityPct.toFixed(0)}%). De richting is behoorlijk; de afwerking kan scherper.`
        );
      } else if (zone.defendedPct >= 30) {
        zoneAttentionPoints.push(
          `${zone.zone}: ${zone.verdedigd} van de ${zone.totaal} schoten werden verdedigd. Kijk naar kansselectie en het moment van schieten.`
        );
      } else {
        zoneAttentionPoints.push(
          `Aandachtspunt ${zone.zone.toLowerCase()}: ${zone.raak} uit ${zone.totaal} raak (${zone.scorePct.toFixed(0)}%) en ${zone.qualityPct.toFixed(0)}% raak of korf.`
        );
      }
    } else if (zone.defendedPct >= 35) {
      zoneAttentionPoints.push(
        `${zone.zone}: ${zone.verdedigd} van de ${zone.totaal} pogingen werden verdedigd. Mogelijk worden deze kansen te vroeg of onder te veel druk genomen.`
      );
    }
  });

  if (positionedShotCount >= 6) {
    const farZone = shotZoneStats.find(
      (zone) => zone.zone === "Ver afstandsschot"
    );
    const farShare = farZone
      ? (farZone.totaal / positionedShotCount) * 100
      : 0;

    if (
      farZone &&
      farZone.totaal >= 3 &&
      farShare >= 40 &&
      farZone.qualityPct < 50
    ) {
      zoneAttentionPoints.push(
        `Kansselectie: ${farShare.toFixed(0)}% van de schoten met locatie kwam uit de verre zone, terwijl daar ${farZone.qualityPct.toFixed(0)}% raak of korf was. Overweeg vaker door te spelen naar een betere schotpositie.`
      );
    }

    if (farShare <= 20 && scorePct >= 30) {
      zoneStrengths.push(
        `Gedoseerde kansselectie: slechts ${farShare.toFixed(0)}% van de schoten met locatie kwam uit de verre zone.`
      );
    }
  }

  // Zone-inzichten krijgen voorrang op de algemenere conclusies.
  if (zoneStrengths.length > 0) {
    strengths.unshift(...zoneStrengths);
  }
  if (zoneAttentionPoints.length > 0) {
    attentionPoints.unshift(...zoneAttentionPoints);
  }

  // Compact teamoverzicht blijft beschikbaar onderaan.
  const getTeamForEvent = (e: LogEvent): AttackTeam | undefined => {
    if (e.team === "thuis" || e.team === "uit") return e.team;
    if (e.attackId) {
      const attack = state.attacks.find((a) => a.id === e.attackId);
      if (attack) return attack.team;
    }
    if (e.vak === "aanvallend") return "thuis";
    if (e.vak === "verdedigend") return "uit";
    return undefined;
  };

  const hitMissCounts: Record<
    AttackTeam,
    Record<ActionKind, { raak: number; mis: number }>
  > = {
    thuis: {
      Schot: { raak: 0, mis: 0 },
      Doorloop: { raak: 0, mis: 0 },
      Vrijebal: { raak: 0, mis: 0 },
      Strafworp: { raak: 0, mis: 0 },
    },
    uit: {
      Schot: { raak: 0, mis: 0 },
      Doorloop: { raak: 0, mis: 0 },
      Vrijebal: { raak: 0, mis: 0 },
      Strafworp: { raak: 0, mis: 0 },
    },
  };

  state.log.forEach((e) => {
    if (!e.actie || !ACTIONS.includes(e.actie as ActionKind) || !e.resultaat) return;
    const team = getTeamForEvent(e);
    if (!team) return;
    const action = e.actie as ActionKind;

    if (e.resultaat === "Raak") {
      hitMissCounts[team][action].raak += 1;
    } else if (
      e.resultaat === "Mis" ||
      e.resultaat === "Korf" ||
      e.resultaat === "Verdedigd"
    ) {
      hitMissCounts[team][action].mis += 1;
    }
  });

  const goalsPerSpeler = new Map<string, number>();
  state.log.forEach((e) => {
    if (
      e.vak === "aanvallend" &&
      e.spelerId &&
      e.spelerId !== TEGENSTANDER_ID &&
      e.resultaat === "Raak"
    ) {
      goalsPerSpeler.set(
        e.spelerId,
        (goalsPerSpeler.get(e.spelerId) ?? 0) + 1
      );
    }
  });

  const goalsSlices: PieSlice[] = Array.from(goalsPerSpeler.entries()).map(
    ([spelerId, value], index) => ({
      label: spelersMap.get(spelerId)?.naam ?? spelerId,
      value,
      color: [
        "#1d4ed8",
        "#ec4899",
        "#8b5cf6",
        "#f97316",
        "#22c55e",
        "#06b6d4",
        "#eab308",
        "#ef4444",
      ][index % 8],
    })
  );

  const tegenPerSpeler = new Map<string, number>();
  state.log.forEach((e) => {
    if (e.reden === "Doorgelaten" && e.spelerId && e.spelerId !== TEGENSTANDER_ID) {
      tegenPerSpeler.set(
        e.spelerId,
        (tegenPerSpeler.get(e.spelerId) ?? 0) + 1
      );
    }
  });

  const tegenSlices: PieSlice[] = Array.from(tegenPerSpeler.entries()).map(
    ([spelerId, value], index) => ({
      label: spelersMap.get(spelerId)?.naam ?? spelerId,
      value,
      color: [
        "#f97316",
        "#ef4444",
        "#8b5cf6",
        "#ec4899",
        "#06b6d4",
        "#22c55e",
        "#eab308",
        "#1d4ed8",
      ][index % 8],
    })
  );

  // ------------------------------------------------------------
  // TEAMANALYSE
  // ------------------------------------------------------------
  const teamActionEvents = state.log.filter(
    (e) => !!e.actie && ACTIONS.includes(e.actie as ActionKind) && !!e.resultaat
  );

  const homeActionEvents = teamActionEvents.filter(
    (e) => getTeamForEvent(e) === "thuis"
  );
  const awayActionEvents = teamActionEvents.filter(
    (e) => getTeamForEvent(e) === "uit"
  );

  const resultCount = (events: LogEvent[], result: NonNullable<LogEvent["resultaat"]>) =>
    events.filter((e) => e.resultaat === result).length;

  const homeAttempts = homeActionEvents.length;
  const awayAttempts = awayActionEvents.length;
  const homeGoals = resultCount(homeActionEvents, "Raak");
  const awayGoals =
    resultCount(awayActionEvents, "Raak") +
    awayActionEvents.filter(
      (e) => e.reden === "Doorgelaten" && e.resultaat !== "Raak"
    ).length;
  const homeKorf = resultCount(homeActionEvents, "Korf");
  const awayDefended = resultCount(awayActionEvents, "Verdedigd");

  const homeScorePct = homeAttempts > 0 ? (homeGoals / homeAttempts) * 100 : 0;
  const awayScorePct = awayAttempts > 0 ? (awayGoals / awayAttempts) * 100 : 0;
  const homeQualityPct =
    homeAttempts > 0 ? ((homeGoals + homeKorf) / homeAttempts) * 100 : 0;

  const homeAttacks = state.attacks.filter((a) => a.team === "thuis");

  const goalsPerAttack =
    homeAttacks.length > 0 ? homeGoals / homeAttacks.length : 0;
  const attemptsPerAttack =
    homeAttacks.length > 0 ? homeAttempts / homeAttacks.length : 0;

  const currentMatchSecond = state.tijdSeconden;
  const attackDuration = (a: AttackMeta) =>
    Math.max(
      0,
      (a.endSeconden != null ? a.endSeconden : currentMatchSecond) - a.startSeconden
    );

  const averageAttackDuration =
    homeAttacks.length > 0
      ? homeAttacks.reduce((sum, a) => sum + attackDuration(a), 0) /
        homeAttacks.length
      : 0;

  const ownReboundEvents = state.log.filter(
    (e) => e.soort === "Rebound" && e.vak === "aanvallend"
  );
  const wonRebounds = ownReboundEvents.filter((e) => e.reden === "Rebound");
  const lostRebounds = ownReboundEvents.filter((e) => e.reden === "Geen Rebound");
  const reboundPct =
    ownReboundEvents.length > 0
      ? (wonRebounds.length / ownReboundEvents.length) * 100
      : 0;

  // Tweede kans = na een geregistreerde aanvallende rebound wordt binnen
  // dezelfde aanval later nog gescoord.
  const secondChanceScores = wonRebounds.filter((rebound) =>
    state.log.some(
      (e) =>
        e.attackId &&
        e.attackId === rebound.attackId &&
        e.tijdSeconden >= rebound.tijdSeconden &&
        e.resultaat === "Raak" &&
        getTeamForEvent(e) === "thuis"
    )
  ).length;
  const secondChancePct =
    wonRebounds.length > 0
      ? (secondChanceScores / wonRebounds.length) * 100
      : 0;

  const teamSteals = state.log.filter(
    (e) =>
      e.vak === "verdedigend" &&
      (e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept")
  ).length;

  const opponentDefendedPct =
    awayAttempts > 0 ? (awayDefended / awayAttempts) * 100 : 0;

  const halfTotal = Math.max(1, state.halfMinuten * 60);
  const halfForEvent = (e: LogEvent) =>
    e.tijdSeconden < halfTotal ? 1 : 2;

  const halfStats = ([1, 2] as const).map((half) => {
    const home = homeActionEvents.filter((e) => halfForEvent(e) === half);
    const away = awayActionEvents.filter((e) => halfForEvent(e) === half);
    const goalsHome = resultCount(home, "Raak");
    const goalsAway =
      resultCount(away, "Raak") +
      away.filter((e) => e.reden === "Doorgelaten" && e.resultaat !== "Raak").length;
    const korfHome = resultCount(home, "Korf");

    return {
      half,
      homeAttempts: home.length,
      homeGoals: goalsHome,
      homeScorePct: home.length > 0 ? (goalsHome / home.length) * 100 : 0,
      homeQualityPct:
        home.length > 0 ? ((goalsHome + korfHome) / home.length) * 100 : 0,
      awayAttempts: away.length,
      awayGoals: goalsAway,
      awayScorePct: away.length > 0 ? (goalsAway / away.length) * 100 : 0,
    };
  });

  // Team-schotlocaties. We gebruiken het attackId om het team te bepalen.
  const teamFieldShots = state.fieldEvents.filter((fe) => {
    if (fe.actie !== "schot") return false;
    if (fe.attackId) {
      return state.attacks.find((a) => a.id === fe.attackId)?.team === "thuis";
    }
    return fe.vak === "aanvallend";
  });

  const teamZoneStats = SHOT_ZONES.map((zone) => {
    const events = teamFieldShots.filter((fe) => getShotZone(fe) === zone);
    const raak = events.filter((fe) => fe.resultaat === "raak").length;
    const korfCount = events.filter((fe) => fe.resultaat === "korf").length;
    const mis = events.filter((fe) => fe.resultaat === "mis").length;
    const verdedigd = events.filter((fe) => fe.resultaat === "verdedigd").length;
    return {
      zone,
      totaal: events.length,
      raak,
      korf: korfCount,
      mis,
      verdedigd,
      scorePct: events.length > 0 ? (raak / events.length) * 100 : 0,
      qualityPct:
        events.length > 0 ? ((raak + korfCount) / events.length) * 100 : 0,
    };
  });

  const totalPositionedTeamShots = teamZoneStats.reduce(
    (sum, z) => sum + z.totaal,
    0
  );
  const farTeamZone = teamZoneStats.find(
    (z) => z.zone === "Ver afstandsschot"
  );
  const farShotShare =
    farTeamZone && totalPositionedTeamShots > 0
      ? (farTeamZone.totaal / totalPositionedTeamShots) * 100
      : 0;

  const teamStrengths: string[] = [];
  const teamAttention: string[] = [];

  if (homeAttempts >= 10 && homeScorePct >= 30) {
    teamStrengths.push(
      `Efficiënte aanval: ${homeGoals} uit ${homeAttempts} pogingen raak (${homeScorePct.toFixed(0)}%).`
    );
  }

  if (homeAttempts >= 10 && homeQualityPct >= 65) {
    teamStrengths.push(
      `Goede schotkwaliteit: ${homeQualityPct.toFixed(0)}% van de pogingen was raak of korf.`
    );
  }

  if (ownReboundEvents.length >= 6 && reboundPct >= 55) {
    teamStrengths.push(
      `Sterke aanvallende rebound: ${wonRebounds.length} van ${ownReboundEvents.length} reboundmomenten gewonnen (${reboundPct.toFixed(0)}%).`
    );
  }

  if (wonRebounds.length >= 4 && secondChancePct >= 40) {
    teamStrengths.push(
      `Tweede kansen worden benut: na ${secondChanceScores} van ${wonRebounds.length} gewonnen rebounds volgde later in dezelfde aanval een doelpunt.`
    );
  }

  if (awayAttempts >= 8 && opponentDefendedPct >= 25) {
    teamStrengths.push(
      `Verdedigende druk: ${awayDefended} van ${awayAttempts} pogingen van de tegenstander werden verdedigd (${opponentDefendedPct.toFixed(0)}%).`
    );
  }

  if (teamSteals >= 4) {
    teamStrengths.push(
      `Actief verdedigd: ${teamSteals} onderscheppingen/afgevangen ballen geregistreerd.`
    );
  }

  if (
    halfStats[0].homeAttempts >= 5 &&
    halfStats[1].homeAttempts >= 5 &&
    halfStats[1].homeScorePct >= halfStats[0].homeScorePct + 10
  ) {
    teamStrengths.push(
      `Sterkere tweede helft: scoringspercentage steeg van ${halfStats[0].homeScorePct.toFixed(0)}% naar ${halfStats[1].homeScorePct.toFixed(0)}%.`
    );
  }

  if (homeAttempts >= 10 && homeScorePct < 20) {
    if (homeQualityPct >= 60) {
      teamAttention.push(
        `Afwerking blijft achter: slechts ${homeScorePct.toFixed(0)}% raak, terwijl ${homeQualityPct.toFixed(0)}% raak of korf was. De richting is redelijk; de afronding kan scherper.`
      );
    } else {
      teamAttention.push(
        `Aanvallende efficiëntie: ${homeGoals} uit ${homeAttempts} pogingen raak (${homeScorePct.toFixed(0)}%).`
      );
    }
  }

  if (ownReboundEvents.length >= 6 && reboundPct < 35) {
    teamAttention.push(
      `Rebound onder druk: slechts ${wonRebounds.length} van ${ownReboundEvents.length} reboundmomenten gewonnen (${reboundPct.toFixed(0)}%). Aanvallen eindigen daardoor sneller.`
    );
  }

  if (homeAttacks.length >= 6 && attemptsPerAttack < 1.4) {
    teamAttention.push(
      `Weinig vervolgkansen: gemiddeld ${attemptsPerAttack.toFixed(1)} poging per aanval. Kijk of langer balbezit en betere reboundpositie mogelijk zijn.`
    );
  }

  if (
    farTeamZone &&
    totalPositionedTeamShots >= 8 &&
    farTeamZone.totaal >= 3 &&
    farShotShare >= 35 &&
    farTeamZone.qualityPct < 50
  ) {
    teamAttention.push(
      `Veel verre schoten: ${farShotShare.toFixed(0)}% van de schotten met locatie kwam uit de verre zone, met ${farTeamZone.qualityPct.toFixed(0)}% raak of korf. Overweeg vaker door te spelen naar een betere positie.`
    );
  }

  if (awayAttempts >= 8 && opponentDefendedPct < 10 && awayScorePct >= 25) {
    teamAttention.push(
      `Weinig verdedigende druk: slechts ${awayDefended} van ${awayAttempts} pogingen van de tegenstander werden als verdedigd geregistreerd.`
    );
  }

  if (
    halfStats[0].homeAttempts >= 5 &&
    halfStats[1].homeAttempts >= 5 &&
    halfStats[1].homeScorePct + 10 <= halfStats[0].homeScorePct
  ) {
    teamAttention.push(
      `Terugval in de tweede helft: scoringspercentage daalde van ${halfStats[0].homeScorePct.toFixed(0)}% naar ${halfStats[1].homeScorePct.toFixed(0)}%.`
    );
  }


  const getVakIdForAttack = (attack: AttackMeta): VakId => {
    if (attack.vakId === 1 || attack.vakId === 2) return attack.vakId;
    return attack.vak === "aanvallend"
      ? state.vak1Aanvallend
        ? 1
        : 2
      : state.vak1Aanvallend
      ? 2
      : 1;
  };

  const getVakIdForEvent = (event: LogEvent): VakId | undefined => {
    if (event.vakId === 1 || event.vakId === 2) return event.vakId;
    if (event.attackId) {
      const attack = state.attacks.find((a) => a.id === event.attackId);
      if (attack) return getVakIdForAttack(attack);
    }
    if (!event.vak) return undefined;
    return event.vak === "aanvallend"
      ? state.vak1Aanvallend
        ? 1
        : 2
      : state.vak1Aanvallend
      ? 2
      : 1;
  };

  const vakPlayers = (vakId: VakId) => {
    const ids =
      vakId === 1
        ? state.vak1Aanvallend
          ? state.aanval
          : state.verdediging
        : state.vak1Aanvallend
        ? state.verdediging
        : state.aanval;
    return ids
      .filter((id): id is string => Boolean(id))
      .map((id) => spelersMap.get(id)?.naam ?? id);
  };

  const buildVakStats = (vakId: VakId) => {
    const ownAttacks = state.attacks.filter(
      (a) => a.team === "thuis" && getVakIdForAttack(a) === vakId
    );
    const opponentAttacks = state.attacks.filter(
      (a) => a.team === "uit" && getVakIdForAttack(a) === vakId
    );
    const ownAttempts = homeActionEvents.filter(
      (e) => getVakIdForEvent(e) === vakId
    );
    const opponentAttempts = awayActionEvents.filter(
      (e) => getVakIdForEvent(e) === vakId
    );
    const goals = resultCount(ownAttempts, "Raak");
    const opponentGoalsForVak =
      resultCount(opponentAttempts, "Raak") +
      opponentAttempts.filter(
        (e) => e.reden === "Doorgelaten" && e.resultaat !== "Raak"
      ).length;
    const defended = resultCount(opponentAttempts, "Verdedigd");
    const rebounds = state.log.filter(
      (e) =>
        e.soort === "Rebound" &&
        getVakIdForEvent(e) === vakId &&
        getTeamForEvent(e) === "thuis"
    );
    const won = rebounds.filter((e) => e.reden === "Rebound").length;
    const attackSeconds = ownAttacks.reduce(
      (sum, a) => sum + attackDuration(a),
      0
    );
    const opponentAttacksWithoutAttempt = opponentAttacks.filter(
      (a) =>
        !opponentAttempts.some((e) => e.attackId && e.attackId === a.id)
    ).length;

    return {
      vakId,
      players: vakPlayers(vakId),
      attacks: ownAttacks.length,
      attempts: ownAttempts.length,
      goals,
      scorePct:
        ownAttempts.length > 0 ? (goals / ownAttempts.length) * 100 : 0,
      attemptsPerAttack:
        ownAttacks.length > 0 ? ownAttempts.length / ownAttacks.length : 0,
      avgAttackDuration:
        ownAttacks.length > 0 ? attackSeconds / ownAttacks.length : 0,
      rebounds: rebounds.length,
      wonRebounds: won,
      reboundPct: rebounds.length > 0 ? (won / rebounds.length) * 100 : 0,
      opponentAttacks: opponentAttacks.length,
      opponentAttempts: opponentAttempts.length,
      opponentGoals: opponentGoalsForVak,
      opponentScorePct:
        opponentAttempts.length > 0
          ? (opponentGoalsForVak / opponentAttempts.length) * 100
          : 0,
      defendedPct:
        opponentAttempts.length > 0
          ? (defended / opponentAttempts.length) * 100
          : 0,
      opponentAttacksWithoutAttempt,
    };
  };

  const vakStats = ([1, 2] as const).map(buildVakStats);

  const attacksWithAttempt = homeAttacks.filter((a) =>
    homeActionEvents.some((e) => e.attackId && e.attackId === a.id)
  ).length;
  const attacksWithoutAttempt = Math.max(
    0,
    homeAttacks.length - attacksWithAttempt
  );
  const firstAttemptGoals = homeAttacks.filter((a) => {
    const attempts = homeActionEvents
      .filter((e) => e.attackId === a.id)
      .slice()
      .sort((x, y) => x.tijdSeconden - y.tijdSeconden);
    return attempts[0]?.resultaat === "Raak";
  }).length;
  const continuationAttempts = Math.max(0, homeAttempts - attacksWithAttempt);
  const opponentAttacks = state.attacks.filter((a) => a.team === "uit");
  const opponentAttacksWithoutAttempt = opponentAttacks.filter(
    (a) => !awayActionEvents.some((e) => e.attackId === a.id)
  ).length;

  const vak1 = vakStats[0];
  const vak2 = vakStats[1];
  if (
    vak1.attempts >= 5 &&
    vak2.attempts >= 5 &&
    Math.abs(vak1.scorePct - vak2.scorePct) >= 12
  ) {
    const better = vak1.scorePct > vak2.scorePct ? vak1 : vak2;
    const other = better.vakId === 1 ? vak2 : vak1;
    teamStrengths.push(
      `Vak ${better.vakId} rondt duidelijk efficiënter af: ${better.scorePct.toFixed(0)}% van de kansen raak tegenover ${other.scorePct.toFixed(0)}% bij Vak ${other.vakId}.`
    );
  }
  if (
    vak1.rebounds >= 4 &&
    vak2.rebounds >= 4 &&
    Math.abs(vak1.reboundPct - vak2.reboundPct) >= 20
  ) {
    const weaker = vak1.reboundPct < vak2.reboundPct ? vak1 : vak2;
    teamAttention.push(
      `Vak ${weaker.vakId} wint relatief weinig aanvallende rebounds (${weaker.reboundPct.toFixed(0)}%). Kijk naar reboundpositie en bezetting rond de korf.`
    );
  }
  if (
    vak1.opponentAttempts >= 5 &&
    vak2.opponentAttempts >= 5 &&
    Math.abs(vak1.opponentScorePct - vak2.opponentScorePct) >= 12
  ) {
    const weaker =
      vak1.opponentScorePct > vak2.opponentScorePct ? vak1 : vak2;
    teamAttention.push(
      `Tegen Vak ${weaker.vakId} scoort de tegenstander relatief vaak: ${weaker.opponentScorePct.toFixed(0)}% van de kansen raak.`
    );
  }
  if (homeAttacks.length >= 8 && attacksWithoutAttempt / homeAttacks.length >= 0.25) {
    teamAttention.push(
      `${attacksWithoutAttempt} van de ${homeAttacks.length} aanvallen eindigden zonder geregistreerde doelpoging. Kijk naar balverlies vóór de eerste kans.`
    );
  }
  if (
    opponentAttacks.length >= 8 &&
    opponentAttacksWithoutAttempt / opponentAttacks.length >= 0.25
  ) {
    teamStrengths.push(
      `Verdediging voorkomt kansen: ${opponentAttacksWithoutAttempt} van de ${opponentAttacks.length} aanvallen van de tegenstander eindigden zonder geregistreerde doelpoging.`
    );
  }

  const actionMix = ACTIONS.map((actie) => {
    const events = homeActionEvents.filter((e) => e.actie === actie);
    const raak = events.filter((e) => e.resultaat === "Raak").length;
    return {
      actie,
      totaal: events.length,
      raak,
      pctVanActies:
        homeAttempts > 0 ? (events.length / homeAttempts) * 100 : 0,
      scorePct: events.length > 0 ? (raak / events.length) * 100 : 0,
    };
  });

  const liveActivePlayerIds = new Set<string>();
  Object.entries(state.speelSeconden).forEach(([id, seconds]) => {
    if (Number(seconds) > 0) liveActivePlayerIds.add(id);
  });
  [...state.aanval, ...state.verdediging].forEach((id) => {
    if (id) liveActivePlayerIds.add(id);
  });
  state.log.forEach((e) => {
    if (e.spelerId && e.spelerId !== TEGENSTANDER_ID) liveActivePlayerIds.add(e.spelerId);
  });
  const livePlayerCount = Math.max(1, liveActivePlayerIds.size);
  const liveTeamAvgAttempts = homeAttempts / livePlayerCount;
  const liveTeamAvgGoals = homeGoals / livePlayerCount;
  const liveTeamAvgRebounds = wonRebounds.length / livePlayerCount;
  const liveTeamDefensiveActions = state.log.filter((e) =>
    e.spelerId &&
    e.spelerId !== TEGENSTANDER_ID &&
    e.vak === "verdedigend" &&
    (e.resultaat === "Verdedigd" || e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept")
  ).length;
  const liveTeamAvgDefensiveActions = liveTeamDefensiveActions / livePlayerCount;
  const liveMetricTextTone = (value:number, benchmark:number) => {
    if (!Number.isFinite(value) || !Number.isFinite(benchmark) || Math.abs(value-benchmark) < 0.05) return "text-gray-900";
    return value > benchmark ? "text-emerald-600" : "text-red-600";
  };

  const modeButtons = insightModeButtons;

  const livePlayerControl = (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-semibold text-gray-500">Speler</span>
      <select
        className="w-full border rounded-xl px-3 py-2 bg-white min-w-0 disabled:bg-gray-50 disabled:text-gray-400"
        value={analysisMode === "speler" ? selectedPlayerId : ""}
        onChange={(e) => setSelectedPlayerId(e.target.value)}
        disabled={analysisMode !== "speler"}
      >
        {analysisMode !== "speler" && <option value="">Niet van toepassing</option>}
        {state.spelers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.naam}
          </option>
        ))}
      </select>
    </label>
  );

  const livePeriodControl = (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-semibold text-gray-500">Periode</span>
      <select
        className="w-full border rounded-xl px-3 py-2 bg-gray-50 text-gray-700"
        value="wedstrijd"
        disabled
      >
        <option value="wedstrijd">Deze wedstrijd</option>
      </select>
    </label>
  );

  const liveInsightsHeader = (
    <div className="space-y-4">
      <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm">
        <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Insights</div>
        <h2 className="mt-1 text-2xl font-bold">
          {analysisMode === "speler" ? "Insights per speler" : "Team Insights"}
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          {analysisMode === "speler"
            ? "Persoonlijke analyse op basis van de geregistreerde acties in deze wedstrijd."
            : `Coachingsgerichte analyse van Korbis tegen ${opponentName || "de tegenstander"}.`}
        </p>
      </div>
      <div className="grid gap-3 grid-cols-1 md:grid-cols-[minmax(280px,1.8fr)_250px_minmax(190px,1fr)_165px] items-end">
        <div className="min-w-0">{matchSelector}</div>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-gray-500 mb-1">Analyse</div>
          {modeButtons}
        </div>
        {livePlayerControl}
        {livePeriodControl}
      </div>
    </div>
  );

  if (analysisMode === "team") {
    return (
      <div className="space-y-6">
        {liveInsightsHeader}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Doelpunten per aanval</div>
            <div className="text-3xl font-extrabold mt-1">
              {homeAttacks.length > 0 ? goalsPerAttack.toFixed(2) : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-1">doelpunten per aanval</div>
          </div>
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Kansen raak</div>
            <div className="text-3xl font-extrabold mt-1">
              {homeAttempts > 0 ? `${homeScorePct.toFixed(0)}%` : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {homeGoals} goals uit {homeAttempts} kansen
            </div>
          </div>
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Korfgerichtheid</div>
            <div className="text-3xl font-extrabold mt-1">
              {homeAttempts > 0 ? `${homeQualityPct.toFixed(0)}%` : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-1">raak of korf geraakt</div>
          </div>
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Aanvallende rebounds gewonnen</div>
            <div className="text-3xl font-extrabold mt-1">
              {ownReboundEvents.length > 0 ? `${reboundPct.toFixed(0)}%` : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {wonRebounds.length} gewonnen · {lostRebounds.length} niet
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="border rounded-2xl p-4 bg-green-50 border-green-200">
            <div className="text-lg font-bold text-green-900 mb-3">Sterke punten</div>
            {teamStrengths.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {teamStrengths.slice(0, 6).map((item, index) => (
                  <li key={index} className="flex gap-2">
                    <SignalDot tone="green" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-green-900/70">
                Nog te weinig duidelijke signalen voor een sterk teaminzicht.
              </div>
            )}
          </div>

          <div className="border rounded-2xl p-4 bg-amber-50 border-amber-200">
            <div className="text-lg font-bold text-amber-900 mb-3">Aandachtspunten</div>
            {teamAttention.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {teamAttention.slice(0, 6).map((item, index) => (
                  <li key={index} className="flex gap-2">
                    <SignalDot tone="orange" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-amber-900/70">
                Nog geen duidelijk aandachtspunt op basis van de geregistreerde data.
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-lg font-bold">Aanvalsprofiel</div>
            <div className="text-sm text-gray-500 mb-4">
              Hoeveel kansen ontstaan per aanval en hoe lang duurt een aanval gemiddeld?
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {homeAttacks.length > 0 ? attemptsPerAttack.toFixed(1) : "—"}
                </div>
                <div className="text-xs text-gray-500">kansen per aanval</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {homeAttacks.length > 0
                    ? `${averageAttackDuration.toFixed(0)}s`
                    : "—"}
                </div>
                <div className="text-xs text-gray-500">gemiddelde duur aanval</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">{homeAttacks.length}</div>
                <div className="text-xs text-gray-500">aantal aanvallen</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {wonRebounds.length > 0 ? `${secondChancePct.toFixed(0)}%` : "—"}
                </div>
                <div className="text-xs text-gray-500">goal na gewonnen rebound</div>
              </div>
            </div>
          </div>

          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-lg font-bold">Verdedigend profiel</div>
            <div className="text-sm text-gray-500 mb-4">
              Druk op de pogingen van {opponentName || "de tegenstander"}.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {awayAttempts > 0 ? `${opponentDefendedPct.toFixed(0)}%` : "—"}
                </div>
                <div className="text-xs text-gray-500">pogingen tegenstander verdedigd</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">{teamSteals}</div>
                <div className="text-xs text-gray-500">balonderscheppingen</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">{awayGoals}</div>
                <div className="text-xs text-gray-500">tegendoelpunten</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {awayAttempts > 0 ? `${awayScorePct.toFixed(0)}%` : "—"}
                </div>
                <div className="text-xs text-gray-500">kansen tegenstander raak</div>
              </div>
            </div>
          </div>

          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-lg font-bold">Balbezit</div>
            <div className="text-sm text-gray-500 mb-4">
              Verdeling van de geregistreerde balbezittijd tussen Korbis en de tegenstander.
            </div>
            <div className="space-y-4">
              {[
                {
                  label: "Korbis",
                  seconds: state.possessionThuisSeconden,
                  total:
                    state.possessionThuisSeconden + state.possessionUitSeconden,
                },
                {
                  label: opponentName || "Tegenstander",
                  seconds: state.possessionUitSeconden,
                  total:
                    state.possessionThuisSeconden + state.possessionUitSeconden,
                },
              ].map((item) => {
                const pct =
                  item.total > 0 ? (item.seconds / item.total) * 100 : 0;
                return (
                  <div key={item.label}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-semibold">{item.label}</span>
                      <span>
                        {formatTime(item.seconds)} · {item.total > 0 ? `${pct.toFixed(0)}%` : "—"}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full bg-blue-600"
                        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="border rounded-2xl overflow-hidden bg-white">
          <div className="p-4 border-b">
            <div className="text-lg font-bold">Vak 1 vs Vak 2</div>
            <div className="text-sm text-gray-500">
              Vergelijking van de twee vaste vakken. De vakidentiteit blijft gelijk wanneer aanval en verdediging wisselen; wissels worden vanaf het wisselmoment aan het juiste vak gekoppeld.
            </div>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm min-w-[880px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-3">Kenmerk</th>
                  {vakStats.map((v) => (
                    <th key={v.vakId} className="text-right p-3">
                      Vak {v.vakId}
                      <div className="font-normal text-xs text-gray-500 max-w-[300px] ml-auto">
                        {v.players.join(", ") || "Nog geen spelers"}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["Aanvallen", (v: typeof vakStats[number]) => String(v.attacks)],
                  ["Kansen", (v: typeof vakStats[number]) => String(v.attempts)],
                  ["Goals", (v: typeof vakStats[number]) => String(v.goals)],
                  ["Kansen raak", (v: typeof vakStats[number]) => v.attempts ? `${v.scorePct.toFixed(0)}%` : "—"],
                  ["Kansen per aanval", (v: typeof vakStats[number]) => v.attacks ? v.attemptsPerAttack.toFixed(2) : "—"],
                  ["Gem. duur aanval", (v: typeof vakStats[number]) => v.attacks ? `${v.avgAttackDuration.toFixed(0)}s` : "—"],
                  ["Aanvallende rebounds gewonnen", (v: typeof vakStats[number]) => v.rebounds ? `${v.reboundPct.toFixed(0)}% (${v.wonRebounds}/${v.rebounds})` : "—"],
                  ["Tegengoals", (v: typeof vakStats[number]) => String(v.opponentGoals)],
                  ["Kansen tegenstander raak", (v: typeof vakStats[number]) => v.opponentAttempts ? `${v.opponentScorePct.toFixed(0)}%` : "—"],
                  ["Pogingen tegenstander verdedigd", (v: typeof vakStats[number]) => v.opponentAttempts ? `${v.defendedPct.toFixed(0)}%` : "—"],
                  ["Verdedigende aanvallen zonder kans tegen", (v: typeof vakStats[number]) => `${v.opponentAttacksWithoutAttempt}/${v.opponentAttacks}`],
                ].map(([label, getValue]) => (
                  <tr key={String(label)} className="border-t">
                    <td className="p-3 font-semibold">{String(label)}</td>
                    {vakStats.map((v) => (
                      <td key={v.vakId} className="p-3 text-right">
                        {(getValue as (v: typeof vakStats[number]) => string)(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-lg font-bold">Aanvalsopbouw</div>
            <div className="text-sm text-gray-500 mb-4">
              Niet alleen hoeveel er wordt geschoten, maar ook hoe vaak Korbis tot een eerste en vervolgpoging komt.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{attacksWithoutAttempt}</div><div className="text-xs text-gray-500">aanvallen zonder kans</div></div>
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{firstAttemptGoals}</div><div className="text-xs text-gray-500">eerste kans direct raak</div></div>
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{continuationAttempts}</div><div className="text-xs text-gray-500">vervolgkansen na eerste poging</div></div>
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{secondChanceScores}</div><div className="text-xs text-gray-500">goals na gewonnen rebound</div></div>
            </div>
          </div>

          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-lg font-bold">Verdedigende opbouw</div>
            <div className="text-sm text-gray-500 mb-4">
              Hoe vaak de tegenstander wordt afgeremd voordat er überhaupt een doelpoging ontstaat.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{opponentAttacks.length}</div><div className="text-xs text-gray-500">verdedigde aanvallen</div></div>
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{opponentAttacksWithoutAttempt}</div><div className="text-xs text-gray-500">zonder kans tegen</div></div>
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{awayAttempts}</div><div className="text-xs text-gray-500">kansen tegen</div></div>
              <div className="rounded-xl bg-gray-50 p-3 text-center"><div className="text-2xl font-extrabold">{teamSteals}</div><div className="text-xs text-gray-500">balonderscheppingen</div></div>
            </div>
          </div>
        </div>

        <div className="border rounded-2xl overflow-hidden bg-white">
          <div className="p-4 border-b">
            <div className="text-lg font-bold">Schotzones Korbis</div>
            <div className="text-sm text-gray-500">
              Verdeling en rendement van gewone schoten met een veldpositie.
            </div>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-3">Zone</th>
                  <th className="text-right p-3">Kansen</th>
                  <th className="text-right p-3">Goals</th>
                  <th className="text-right p-3">Korf geraakt</th>
                  <th className="text-right p-3">Mis</th>
                  <th className="text-right p-3">Verdedigd</th>
                  <th className="text-right p-3">% raak</th>
                  <th className="text-right p-3">% raak of korf</th>
                </tr>
              </thead>
              <tbody>
                {teamZoneStats.map((zone) => (
                  <tr key={zone.zone} className="border-t">
                    <td className="p-3 font-semibold">{zone.zone}</td>
                    <td className="p-3 text-right">{zone.totaal}</td>
                    <td className="p-3 text-right">{zone.raak}</td>
                    <td className="p-3 text-right">{zone.korf}</td>
                    <td className="p-3 text-right">{zone.mis}</td>
                    <td className="p-3 text-right">{zone.verdedigd}</td>
                    <td className="p-3 text-right">
                      {zone.totaal > 0 ? `${zone.scorePct.toFixed(0)}%` : "—"}
                    </td>
                    <td className="p-3 text-right">
                      {zone.totaal > 0 ? `${zone.qualityPct.toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="border rounded-2xl overflow-hidden bg-white">
          <div className="p-4 border-b">
            <div className="text-lg font-bold">1e helft versus 2e helft</div>
            <div className="text-sm text-gray-500">
              Hiermee zie je of rendement en wedstrijdbeeld veranderen na rust.
            </div>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-3">Periode</th>
                  <th className="text-right p-3">Kansen</th>
                  <th className="text-right p-3">Goals</th>
                  <th className="text-right p-3">% raak</th>
                  <th className="text-right p-3">% raak of korf</th>
                  <th className="text-right p-3">Pogingen tegen</th>
                  <th className="text-right p-3">Goals tegen</th>
                  <th className="text-right p-3">Score % tegen</th>
                </tr>
              </thead>
              <tbody>
                {halfStats.map((row) => (
                  <tr key={row.half} className="border-t">
                    <td className="p-3 font-semibold">{row.half}e helft</td>
                    <td className="p-3 text-right">{row.homeAttempts}</td>
                    <td className="p-3 text-right">{row.homeGoals}</td>
                    <td className="p-3 text-right">
                      {row.homeAttempts > 0 ? `${row.homeScorePct.toFixed(0)}%` : "—"}
                    </td>
                    <td className="p-3 text-right">
                      {row.homeAttempts > 0 ? `${row.homeQualityPct.toFixed(0)}%` : "—"}
                    </td>
                    <td className="p-3 text-right">{row.awayAttempts}</td>
                    <td className="p-3 text-right">{row.awayGoals}</td>
                    <td className="p-3 text-right">
                      {row.awayAttempts > 0 ? `${row.awayScorePct.toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="border rounded-2xl overflow-hidden bg-white">
          <div className="p-4 border-b">
            <div className="text-lg font-bold">Actiemix</div>
            <div className="text-sm text-gray-500">
              Hoe Korbis zijn aanvallende pogingen verdeelt.
            </div>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm min-w-[620px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-3">Actie</th>
                  <th className="text-right p-3">Aantal</th>
                  <th className="text-right p-3">Aandeel</th>
                  <th className="text-right p-3">Goals</th>
                  <th className="text-right p-3">% raak</th>
                </tr>
              </thead>
              <tbody>
                {actionMix.map((row) => (
                  <tr key={row.actie} className="border-t">
                    <td className="p-3 font-semibold">{row.actie}</td>
                    <td className="p-3 text-right">{row.totaal}</td>
                    <td className="p-3 text-right">
                      {homeAttempts > 0 ? `${row.pctVanActies.toFixed(0)}%` : "—"}
                    </td>
                    <td className="p-3 text-right">{row.raak}</td>
                    <td className="p-3 text-right">
                      {row.totaal > 0 ? `${row.scorePct.toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <details className="border rounded-2xl bg-white">
          <summary className="cursor-pointer p-4 font-semibold">
            Details en oude grafieken
          </summary>
          <div className="p-4 pt-0 space-y-6">
            <div className="grid gap-6 md:grid-cols-2">
              <PieChart title="Doelpunten per speler" slices={goalsSlices} />
              <PieChart title="Tegendoelpunten per speler" slices={tegenSlices} />
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <HitMissBarChart
                title="Korbis – Raak vs niet raak per actie"
                counts={hitMissCounts.thuis}
              />
              <HitMissBarChart
                title={`${opponentName || "Tegenstander"} – Raak vs niet raak per actie`}
                counts={hitMissCounts.uit}
              />
            </div>
          </div>
        </details>
      </div>
    );
  }

  if (state.spelers.length === 0) {
    return (
      <div className="space-y-4">
        {liveInsightsHeader}
        <div className="border rounded-2xl p-6 bg-white">
          <p className="text-sm text-gray-500">
            Voeg eerst spelers toe om persoonlijke inzichten te kunnen tonen.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {liveInsightsHeader}

      <div className="border rounded-2xl p-4 bg-gradient-to-br from-blue-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-full border bg-white overflow-hidden flex items-center justify-center">
            {selectedPlayer?.foto ? (
              <img
                src={selectedPlayer.foto}
                alt={selectedPlayer.naam}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-xl font-bold text-gray-400">
                {selectedPlayer?.naam?.slice(0, 1).toUpperCase() || "?"}
              </span>
            )}
          </div>
          <div>
            <div className="text-xl font-bold">{selectedPlayer?.naam ?? "Speler"}</div>
            <div className="text-sm text-gray-500">
              {selectedPlayer?.geslacht} · {attempts} aanvallende acties geregistreerd
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: "Acties", value: attempts.toString(), metric: attempts, benchmark: liveTeamAvgAttempts, sub: `Teamgem.: ${liveTeamAvgAttempts.toFixed(1)} · aanvallend` },
          { label: "Doelpunten", value: goals.toString(), metric: goals, benchmark: liveTeamAvgGoals, sub: `Teamgem.: ${liveTeamAvgGoals.toFixed(1)} · ${scorePct.toFixed(0)}% raak` },
          { label: "Schotkwaliteit", value: `${qualityPct.toFixed(0)}%`, metric: qualityPct, benchmark: homeQualityPct, sub: `Teamgem.: ${homeQualityPct.toFixed(0)}% · raak + korf` },
          { label: "Rebounds", value: reboundEvents.length.toString(), metric: reboundEvents.length, benchmark: liveTeamAvgRebounds, sub: `Teamgem.: ${liveTeamAvgRebounds.toFixed(1)}${allReboundMoments.length > 0 ? ` · ${reboundSharePct.toFixed(0)}% aandeel` : ""}` },
          { label: "Verdedigend", value: (defensiveStops + steals).toString(), metric: defensiveStops + steals, benchmark: liveTeamAvgDefensiveActions, sub: `Teamgem.: ${liveTeamAvgDefensiveActions.toFixed(1)} · ${defensiveStops} verdedigd · ${steals} steals` },
        ].map((card) => (
          <div key={card.label} className="border rounded-2xl p-4 bg-white shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {card.label}
            </div>
            <div className={`text-3xl font-extrabold mt-1 ${liveMetricTextTone(card.metric, card.benchmark)}`}>{card.value}</div>
            <div className="text-xs text-gray-500 mt-1">{card.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="border rounded-2xl p-4 bg-green-50/60 border-green-200">
          <div className="text-lg font-bold text-green-900 mb-3">Sterke punten</div>
          {strengths.length > 0 ? (
            <div className="space-y-2">
              {strengths.slice(0, 5).map((text, index) => (
                <div
                  key={`${text}-${index}`}
                  className="flex gap-2 rounded-xl bg-white/80 border border-green-100 p-3 text-sm"
                >
                  <SignalDot tone="green" />
                  <span>{text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-green-900/70 bg-white/70 rounded-xl p-3">
              Nog te weinig data om een betrouwbaar sterk punt aan te wijzen. Na een paar acties worden hier automatisch patronen zichtbaar.
            </div>
          )}
        </div>

        <div className="border rounded-2xl p-4 bg-orange-50/60 border-orange-200">
          <div className="text-lg font-bold text-orange-900 mb-3">Aandachtspunten</div>
          {attentionPoints.length > 0 ? (
            <div className="space-y-2">
              {attentionPoints.slice(0, 5).map((text, index) => (
                <div
                  key={`${text}-${index}`}
                  className="flex gap-2 rounded-xl bg-white/80 border border-orange-100 p-3 text-sm"
                >
                  <SignalDot tone="orange" />
                  <span>{text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-orange-900/70 bg-white/70 rounded-xl p-3">
              Op basis van de huidige registratie is nog geen duidelijk aandachtspunt zichtbaar.
            </div>
          )}
        </div>
      </div>

      <div className="border rounded-2xl overflow-hidden bg-white">
        <div className="p-4 border-b">
          <div className="text-lg font-bold">Aanvallend profiel</div>
          <div className="text-sm text-gray-500">
            Resultaat per type actie van {selectedPlayer?.naam ?? "de speler"}.
          </div>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-3">Actie</th>
                <th className="text-right p-3">Kansen</th>
                <th className="text-right p-3">Goals</th>
                <th className="text-right p-3">Korf geraakt</th>
                <th className="text-right p-3">Mis</th>
                <th className="text-right p-3">Verdedigd</th>
                <th className="text-right p-3">% raak</th>
                <th className="text-right p-3">% raak of korf</th>
              </tr>
            </thead>
            <tbody>
              {actionStats.map((s) => (
                <tr key={s.actie} className="border-t">
                  <td className="p-3 font-semibold">{s.actie}</td>
                  <td className="p-3 text-right">{s.totaal}</td>
                  <td className="p-3 text-right">{s.raak}</td>
                  <td className="p-3 text-right">{s.korf}</td>
                  <td className="p-3 text-right">{s.mis}</td>
                  <td className="p-3 text-right">{s.verdedigd}</td>
                  <td className="p-3 text-right">
                    {s.totaal > 0 ? `${s.scorePct.toFixed(0)}%` : "—"}
                  </td>
                  <td className="p-3 text-right">
                    {s.totaal > 0 ? `${s.qualityPct.toFixed(0)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>


      <div className="border rounded-2xl overflow-hidden bg-white">
        <div className="p-4 border-b">
          <div className="text-lg font-bold">Schotzones</div>
          <div className="text-sm text-gray-500">
            Alleen gewone schoten met een gekoppelde veldpositie tellen mee.
            Binnen het oranje vlak = korte kans, daarbuiten = afstandsschot,
            en duidelijk verder weg = ver afstandsschot.
          </div>
        </div>

        <div className="overflow-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-3">Zone</th>
                <th className="text-right p-3">Kansen</th>
                <th className="text-right p-3">Goals</th>
                <th className="text-right p-3">Korf geraakt</th>
                <th className="text-right p-3">Mis</th>
                <th className="text-right p-3">Verdedigd</th>
                <th className="text-right p-3">% raak</th>
                <th className="text-right p-3">% raak of korf</th>
              </tr>
            </thead>
            <tbody>
              {shotZoneStats.map((zone) => (
                <tr key={zone.zone} className="border-t">
                  <td className="p-3 font-semibold">{zone.zone}</td>
                  <td className="p-3 text-right">{zone.totaal}</td>
                  <td className="p-3 text-right">{zone.raak}</td>
                  <td className="p-3 text-right">{zone.korf}</td>
                  <td className="p-3 text-right">{zone.mis}</td>
                  <td className="p-3 text-right">{zone.verdedigd}</td>
                  <td className="p-3 text-right">
                    {zone.totaal > 0 ? `${zone.scorePct.toFixed(0)}%` : "—"}
                  </td>
                  <td className="p-3 text-right">
                    {zone.totaal > 0 ? `${zone.qualityPct.toFixed(0)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t bg-gray-50 text-xs text-gray-500">
          {positionedShotCount} schotlocaties gekoppeld. Vanaf 4 pogingen in een zone
          kan die zone automatisch als sterk punt of aandachtspunt worden benoemd.
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="border rounded-2xl p-4 bg-white">
          <div className="text-lg font-bold mb-1">Reboundanalyse</div>
          <div className="text-sm text-gray-500 mb-4">
            Rebounds uit de aanvallende rebound-popup.
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-gray-50 border p-3">
              <div className="text-xs text-gray-500">Rebounds speler</div>
              <div className="text-3xl font-extrabold">{reboundEvents.length}</div>
            </div>
            <div className="rounded-xl bg-gray-50 border p-3">
              <div className="text-xs text-gray-500">Aandeel momenten</div>
              <div className="text-3xl font-extrabold">
                {allReboundMoments.length > 0 ? `${reboundSharePct.toFixed(0)}%` : "—"}
              </div>
            </div>
          </div>

          <div className="mt-4 text-sm text-gray-600">
            Er zijn in totaal <strong>{allReboundMoments.length}</strong> reboundmomenten geregistreerd, waarvan <strong>{state.log.filter((e) => e.soort === "Rebound" && e.reden === "Geen Rebound").length}</strong> zonder gewonnen rebound.
          </div>
        </div>

        <div className="border rounded-2xl p-4 bg-white">
          <div className="text-lg font-bold mb-1">Verdedigend profiel</div>
          <div className="text-sm text-gray-500 mb-4">
            Alleen situaties waarin een speler expliciet is geselecteerd worden meegeteld.
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-green-50 border border-green-100 p-3 text-center">
              <div className="text-2xl font-extrabold">{defensiveStops}</div>
              <div className="text-xs text-gray-600">Verdedigd</div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-center">
              <div className="text-2xl font-extrabold">{steals}</div>
              <div className="text-xs text-gray-600">Steals</div>
            </div>
            <div className="rounded-xl bg-red-50 border border-red-100 p-3 text-center">
              <div className="text-2xl font-extrabold">{againstGoals}</div>
              <div className="text-xs text-gray-600">Doorgelaten</div>
            </div>
          </div>
        </div>
      </div>

      <div className="border rounded-2xl p-4 bg-white">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <div>
            <div className="text-lg font-bold">Persoonlijke actiekaart</div>
            <div className="text-sm text-gray-500">
              Alleen acties die aan een geregistreerde veldpositie konden worden gekoppeld.
            </div>
          </div>
          <div className="text-xs text-gray-500">
            {playerFieldMarkers.length} locaties gekoppeld
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px] items-start">
          <div className="relative overflow-hidden rounded-2xl border bg-gray-50">
            <img
              src="/VeldLinks.jpg"
              alt="Persoonlijke actiekaart"
              className="w-full h-auto block"
              draggable={false}
            />
            {playerFieldMarkers.map((m) => (
              <div
                key={m.id}
                title={`${m.actie ?? "actie"} · ${m.resultaat ?? ""}`}
                style={{
                  position: "absolute",
                  width: "18px",
                  height: "18px",
                  left: `${m.x}%`,
                  top: `${m.y}%`,
                  transform: "translate(-50%, -50%)",
                  backgroundColor: markerFill(m),
                  border: `3px solid ${markerBorder(m)}`,
                  borderRadius: "50%",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
                }}
              />
            ))}
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <div className="font-semibold mb-2">Actie</div>
              <div className="space-y-1 text-gray-600">
                <div><span className="inline-block w-3 h-3 rounded-full bg-blue-600 mr-2" />Schot</div>
                <div><span className="inline-block w-3 h-3 rounded-full bg-pink-600 mr-2" />Doorloop</div>
                <div><span className="inline-block w-3 h-3 rounded-full bg-purple-700 mr-2" />Strafworp</div>
                <div><span className="inline-block w-3 h-3 rounded-full bg-amber-800 mr-2" />Vrijebal</div>
              </div>
            </div>
            <div>
              <div className="font-semibold mb-2">Schotafstand</div>
              <div className="space-y-1 text-gray-600 text-xs">
                <div><strong>Korte kans:</strong> binnen het oranje vlak</div>
                <div><strong>Afstand:</strong> buiten het oranje vlak</div>
                <div><strong>Ver:</strong> duidelijk buiten de normale schotzone</div>
              </div>
            </div>
            <div>
              <div className="font-semibold mb-2">Rand = uitkomst</div>
              <div className="space-y-1 text-gray-600">
                <div>🟢 Raak</div>
                <div>🟠 Korf</div>
                <div>🔴 Mis</div>
                <div>⚫ Verdedigd</div>
              </div>
            </div>
            {playerFieldMarkers.length === 0 && (
              <div className="rounded-xl bg-gray-50 border p-3 text-xs text-gray-500">
                Voor deze speler zijn nog geen acties aan een veldpositie gekoppeld.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border rounded-2xl bg-white overflow-hidden">
        <div className="p-4 border-b">
          <div className="text-lg font-bold">Teamvergelijking</div>
          <div className="text-sm text-gray-500">
            Compact overzicht om de persoonlijke cijfers in context te plaatsen.
          </div>
        </div>

        <div className="overflow-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-3">Speler</th>
                <th className="text-right p-3">Acties</th>
                <th className="text-right p-3">Goals</th>
                <th className="text-right p-3">% raak</th>
                <th className="text-right p-3">Rebounds</th>
                <th className="text-right p-3">Steals</th>
                <th className="text-right p-3">Doorgelaten</th>
              </tr>
            </thead>
            <tbody>
              {state.spelers.map((p) => {
                const pe = state.log.filter((e) => e.spelerId === p.id);
                const pa = pe.filter(
                  (e) =>
                    e.vak === "aanvallend" &&
                    !!e.actie &&
                    ACTIONS.includes(e.actie as ActionKind) &&
                    !!e.resultaat
                );
                const pg = pa.filter((e) => e.resultaat === "Raak").length;
                const pr = pe.filter((e) => e.soort === "Rebound" && e.reden === "Rebound").length;
                const ps = pe.filter(
                  (e) =>
                    e.vak === "verdedigend" &&
                    (e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept")
                ).length;
                const pd = pe.filter(
                  (e) => e.vak === "verdedigend" && e.reden === "Doorgelaten"
                ).length;

                return (
                  <tr
                    key={p.id}
                    className={`border-t ${p.id === selectedPlayerId ? "bg-blue-50" : ""}`}
                  >
                    <td className="p-3 font-semibold">{p.naam}</td>
                    <td className="p-3 text-right">{pa.length}</td>
                    <td className="p-3 text-right">{pg}</td>
                    <td className="p-3 text-right">
                      {pa.length > 0 ? `${((pg / pa.length) * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="p-3 text-right">{pr}</td>
                    <td className="p-3 text-right">{ps}</td>
                    <td className="p-3 text-right">{pd}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <details className="border rounded-2xl bg-white">
        <summary className="cursor-pointer p-4 font-semibold">
          Extra wedstrijdanalyse tonen
        </summary>
        <div className="p-4 pt-0 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <PieChart title="Doelpunten per speler" slices={goalsSlices} />
            <PieChart title="Tegendoelpunten per speler" slices={tegenSlices} />
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <HitMissBarChart
              title="Korbis – Raak vs niet raak per actie"
              counts={hitMissCounts.thuis}
            />
            <HitMissBarChart
              title={`${opponentName || "Tegenstander"} – Raak vs niet raak per actie`}
              counts={hitMissCounts.uit}
            />
          </div>
        </div>
      </details>
    </div>
  );
}

type SpelerCircleRowProps = {
  id: string | null;
  vak: VakSide;
  index: number;
  spelersMap: Map<string, Player>;
  bank: Player[];
  setVakPos: (
    vak: VakSide,
    pos: number,
    spelerId: string | null,
    logWissel?: boolean
  ) => void;
};

function SpelerCircleRow({
  id,
  vak,
  index,
  spelersMap,
  bank,
  setVakPos,
}: SpelerCircleRowProps) {
  const p = id ? spelersMap.get(id) : undefined;
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-12 rounded-full border overflow-hidden flex items-center justify-center bg-gray-50">
        {p?.foto ? (
          <img src={p.foto} alt={p.naam} className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm p-2 text-center">
            {p?.naam?.slice(0, 2) || "?"}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{p?.naam || "Leeg"}</div>
        <div className="text-xs text-gray-500">Positie {index + 1}</div>
      </div>

      {/* Wisselknop */}
      <div className="relative">
        <details className="cursor-pointer" ref={detailsRef}>
          <summary className="list-none px-2 py-1 border rounded-lg text-sm">
            ⇄ Wissel
          </summary>
          <div className="absolute right-0 mt-1 z-10 bg-white border rounded-xl p-2 w-56 max-h-64 overflow-auto shadow">
            <button
              className="w-full text-left text-sm p-1 hover:bg-gray-50 rounded"
              onClick={() => {
                setVakPos(vak, index, null);
                detailsRef.current?.removeAttribute("open");
              }}
            >
              Leeg maken
            </button>

            {bank.map((b) => (
              <button
                key={b.id}
                className="w-full text-left text-sm p-1 hover:bg-gray-50 rounded"
                onClick={() => {
                  setVakPos(vak, index, b.id);
                  detailsRef.current?.removeAttribute("open");
                }}
              >
                {b.naam}
              </button>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

//////////////////////////////////////////////////////////////////////////////
// --- Modal -----------------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function VakActionModal({
  vak,
  vakLabel,
  spelers,
  onClose,
  onComplete,
  onSteal,
}: {
  vak: VakSide;
  vakLabel: string;
  spelers: Player[];
  onClose: () => void;
  onComplete: (
    actie: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp",
    uitkomst: "Raak" | "Mis" | "Korf" | "Verdedigd",
    spelerId?: string
  ) => void;
  onSteal: (spelerId?: string) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [actie, setActie] = useState<
    "Schot" | "Doorloop" | "Vrijebal" | "Strafworp" | null
  >(null);
  const [speler, setSpeler] = useState<string | undefined>(undefined);
  const [uitkomst, setUitkomst] = useState<
    "Raak" | "Mis" | "Korf" | "Verdedigd" | null
  >(null);
  const [stealFlow, setStealFlow] = useState(false);

  const titelVak = vak === "aanvallend" ? "Aanvallend vak" : "Verdedigend vak";

  const handleFinish = (u: "Raak" | "Mis" | "Korf" | "Verdedigd") => {
    setUitkomst(u);
    if (actie) {
      onComplete(actie, u, speler);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white w-full max-w-3xl md:rounded-2xl md:m-6 p-4 md:p-6 space-y-6 max-h-[90vh] overflow-auto">
        {/* Duidelijke vakstatus + stappenindicator */}
        <div className={`rounded-xl border-2 p-4 ${vak === "aanvallend" ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50"}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={`text-sm font-extrabold uppercase tracking-[0.18em] ${vak === "aanvallend" ? "text-green-700" : "text-red-700"}`}>
                {vak === "aanvallend" ? "Aanval" : "Verdediging"}
              </div>
              <div className="text-3xl font-extrabold text-gray-900 mt-1">{vakLabel}</div>
              <div className="text-sm font-semibold text-gray-600 mt-1">Actie registreren in het {titelVak.toLowerCase()}</div>
            </div>
            <button
              className="text-sm text-gray-500 hover:text-gray-800"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
          <div className="text-sm text-gray-600 mt-3">
            Stap {step} van 3 –{" "}
            {step === 1
              ? "Kies een actie"
              : step === 2
              ? "Kies speler (optioneel)"
              : "Kies een uitkomst"}
          </div>
        </div>

        {/* Stap 1: Actie */}
        {step === 1 && (
          <div className="space-y-6 w-full">
            <div className="text-2xl font-bold text-center">Kies een actie</div>

            <div className="flex flex-col gap-4 w-full h-[70vh]">
              <div className="grid grid-cols-2 grid-rows-2 gap-4 flex-1">
                {(["Schot", "Doorloop", "Vrijebal", "Strafworp"] as const).map(
                  (a) => {
                    const selected = actie === a;
                    const base =
                      "w-full h-full text-3xl md:text-5xl font-extrabold rounded-2xl border-4 active:scale-95 transition";

                    const colorClasses =
                      vak === "aanvallend"
                        ? selected
                          ? "bg-green-600 text-white border-green-700"
                          : "bg-gray-100 hover:bg-gray-200 border-green-500"
                        : selected
                        ? "bg-red-600 text-white border-red-700"
                        : "bg-gray-100 hover:bg-gray-200 border-red-500";

                    return (
                      <button
                        key={a}
                        className={`${base} ${colorClasses}`}
                        onClick={() => {
                          setStealFlow(false);
                          setActie(a);
                          setStep(2);
                        }}
                      >
                        {a}
                      </button>
                    );
                  }
                )}
              </div>

              <button
                className={`
                  w-full h-24
                  text-3xl md:text-4xl
                  font-extrabold
                  rounded-2xl
                  border-4
                  active:scale-95
                  transition
                  ${
                    vak === "aanvallend"
                      ? "border-red-500 bg-gray-100 hover:bg-red-50 text-red-700"
                      : "border-green-500 bg-gray-100 hover:bg-green-50 text-green-700"
                  }
                `}
                onClick={() => {
                  setStealFlow(true);
                  setActie(null);
                  setStep(2);
                }}
              >
                STEAL
              </button>
            </div>
          </div>
        )}

        {/* Stap 2: Speler */}
        {step === 2 && (
          <div className="w-full flex flex-col gap-4 h-[70vh]">
            <div className="text-2xl font-bold text-center">Kies speler</div>

            <div className="flex flex-col gap-4 flex-1 min-h-0">
              <div className="grid grid-cols-2 grid-rows-2 gap-4 flex-1 min-h-0">
                {spelers.slice(0, 4).map((p) => (
                  <button
                    key={p.id}
                    className="
                      w-full h-full
                      text-3xl md:text-5xl
                      font-extrabold
                      rounded-2xl
                      border-4
                      bg-blue-50 border-blue-300
                      hover:bg-blue-100
                      active:scale-95
                      transition
                      flex items-center justify-center text-center px-2
                    "
                    onClick={() => {
                      setSpeler(p.id);

                      if (stealFlow) {
                        onSteal(p.id);
                        onClose();
                      } else {
                        setStep(3);
                      }
                    }}
                  >
                    {p.naam}
                  </button>
                ))}
              </div>

              <button
                className="
                  w-full h-20 shrink-0
                  text-2xl
                  font-bold
                  rounded-2xl
                  border-2
                  bg-gray-800 text-white border-gray-900
                  active:scale-95 transition
                "
                onClick={() => {
                  setSpeler(undefined);

                  if (stealFlow) {
                    onSteal(undefined);
                    onClose();
                  } else {
                    setStep(3);
                  }
                }}
              >
                Geen keuze
              </button>
            </div>
          </div>
        )}

        {/* Stap 3: Uitkomst */}
        {step === 3 && (
          <div className="space-y-6 w-full">
            <div className="text-2xl font-bold text-center">Uitkomst</div>

            <div className="grid grid-cols-2 grid-rows-2 gap-4 w-full h-[70vh]">
              <button
                className="w-full h-full text-3xl md:text-5xl font-extrabold rounded-2xl border-4 bg-green-500 text-white border-green-600 active:scale-95 transition"
                onClick={() => handleFinish("Raak")}
              >
                Raak
              </button>

              <button
                className="w-full h-full text-3xl md:text-5xl font-extrabold rounded-2xl border-4 bg-red-500 text-white border-red-600 active:scale-95 transition"
                onClick={() => handleFinish("Mis")}
              >
                Mis
              </button>

              <button
                className="w-full h-full text-3xl md:text-5xl font-extrabold rounded-2xl border-4 bg-orange-400 text-white border-orange-500 active:scale-95 transition"
                onClick={() => handleFinish("Korf")}
              >
                Korf
              </button>

              <button
                className="w-full h-full text-3xl md:text-5xl font-extrabold rounded-2xl border-4 bg-slate-500 text-white border-slate-600 active:scale-95 transition"
                onClick={() => handleFinish("Verdedigd")}
              >
                Verdedigd
              </button>
            </div>
          </div>
        )}

        {/* Onderbalk */}
        <div className="flex justify-between text-xs text-gray-500">
          <div>
            {actie && <div>Actie: {actie}</div>}
            {speler && (
              <div>
                Speler: {spelers.find((p) => p.id === speler)?.naam || "?"}
              </div>
            )}
            {uitkomst && <div>Uitkomst: {uitkomst}</div>}
          </div>
          <button
            className="text-sm text-gray-500 hover:text-gray-800"
            onClick={onClose}
          >
            Sluiten
          </button>
        </div>
      </div>
    </div>
  );
}

function PossessionModal({
  team,
  spelers,
  onClose,
  onSave,
  opponentName,
}: {
  team: "thuis" | "uit";
  spelers: Player[];
  onClose: () => void;
  onSave: (reden: LogReden, spelerId?: string) => void;
  opponentName: string;
}) {
  const [speler, setSpeler] = useState<string | undefined>(undefined);

  const opties: LogReden[] =
    team === "thuis"
      ? ["Pass Onderschept", "Bal uit", "Vrijebal", "Strafworp"]
      : ["Pass Onderschept", "Bal uit", "Vrije bal tegen", "Strafworp tegen"];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-xl">
      <div className="text-2xl font-semibold mb-4">
        Nieuw balbezit –{" "}
        {getTeamDisplayName(team, opponentName)}
      </div>
        {/* Speler kiezen */}
        <div className="space-y-2 mb-4">
          <div className="text-sm">Kies speler (optioneel)</div>
          <div className="flex flex-wrap gap-2 max-h-48 overflow-auto">
            <button
              className={`px-4 py-2 border rounded-full text-base font-semibold ${
                !speler ? "bg-black text-white" : ""
              }`}
              onClick={() => setSpeler(undefined)}
            >
              Team-event
            </button>
            {spelers.map((p) => (
              <button
                key={p.id}
                className={`px-4 py-2 border rounded-full text-base font-semibold ${
                  speler === p.id ? "bg-black text-white" : ""
                }`}
                onClick={() => setSpeler(p.id)}
              >
                {p.naam}
              </button>
            ))}
          </div>
        </div>

        {/* Reden knoppen */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          {opties.map((o) => (
            <button
              key={o}
              className="border rounded-xl p-4 hover:shadow text-base font-semibold"
              onClick={() => onSave(o, speler)}
            >
              {o}
            </button>
          ))}
        </div>

        {/* Extra brede knop: Schot afgevangen */}
        <button
          className="w-full border rounded-xl p-4 hover:shadow text-base font-semibold mb-4"
          onClick={() => onSave("Schot afgevangen", speler)}
        >
          Schot afgevangen
        </button>

        <div className="flex justify-end">
          <button className="text-sm text-gray-600" onClick={onClose}>
            Sluiten
          </button>
        </div>
      </div>
    </div>
  );
}

function StealModal({
  spelers,
  onClose,
  onSave,
}: {
  spelers: Player[];
  onClose: () => void;
  onSave: (spelerId?: string) => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-3xl shadow-xl space-y-6">
        {/* Titel */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-2xl font-semibold mb-1">
              Steal – verdedigend vak
            </div>
            <div className="text-sm text-gray-500">
              Kies wie het schot afvangt. De keuze wordt direct gelogd.
            </div>
          </div>
          <button
            className="text-sm text-gray-500 hover:text-gray-800"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Grote knoppen, zelfde stijl als actie-spelerkeuze */}
        <div className="grid grid-cols-2 grid-rows-3 gap-4 w-full">
          {/* Team-event / geen specifieke speler */}
          <button
            className="
              col-span-2
              w-full h-full
              text-3xl md:text-4xl
              font-extrabold
              rounded-2xl
              border-2
              bg-gray-800 text-white border-gray-900
              active:scale-95 transition
            "
            onClick={() => {
              onSave(undefined); // team-event
              onClose();
            }}
          >
            Team-event
          </button>

          {/* Spelers uit het verdedigende vak */}
          {spelers.map((p) => (
            <button
              key={p.id}
              className="
                w-full h-full
                text-2xl md:text-3xl
                font-bold
                rounded-2xl
                border-2
                bg-blue-50 border-blue-300
                hover:bg-blue-100
                active:scale-95
                transition
                flex items-center justify-center text-center px-2
              "
              onClick={() => {
                onSave(p.id);
                onClose();
              }}
            >
              {p.naam}
            </button>
          ))}
        </div>

        {/* Optionele onderbalk */}
        <div className="flex justify-end">
          <button
            className="text-sm text-gray-500 hover:text-gray-800"
            onClick={onClose}
          >
            Sluiten
          </button>
        </div>
      </div>
    </div>
  );
}
function ReboundModal({
  spelers,
  onClose,
  onSave,
}: {
  spelers: Player[];
  onClose: () => void;
  onSave: (spelerId?: string) => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-3xl shadow-xl space-y-6">

        <div className="flex items-start justify-between">
          <div>
            <div className="text-2xl font-bold">
              Rebound
            </div>
            <div className="text-sm text-gray-500 mt-1">
              Wie pakte de rebound?
            </div>
          </div>

          <button
            className="text-sm text-gray-500 hover:text-gray-800"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 h-[70vh]">

          {/* Vier spelers */}
          <div className="grid grid-cols-2 grid-rows-2 gap-4 flex-1">
            {spelers.map((p) => (
              <button
                key={p.id}
                className="
                  w-full h-full
                  text-3xl md:text-5xl
                  font-extrabold
                  rounded-2xl
                  border-4
                  bg-green-50 border-green-500
                  hover:bg-green-100
                  active:scale-95
                  transition
                "
                onClick={() => onSave(p.id)}
              >
                {p.naam}
              </button>
            ))}
          </div>

          {/* Geen rebound */}
          <button
            className="
              w-full h-24
              text-3xl md:text-4xl
              font-extrabold
              rounded-2xl
              border-4
              bg-red-500 text-white border-red-600
              active:scale-95 transition
            "
            onClick={() => onSave(undefined)}
          >
            Geen rebound
          </button>

        </div>
      </div>
    </div>
  );
}
function ShotReboundModal({
  type,
  spelers,
  onClose,
  onSave,
}: {
  type: "Schot" | "Rebound";
  spelers: Player[];
  onClose: () => void;
  onSave: (resultaat: "Raak" | "Mis", spelerId?: string) => void;
}) {
  const [speler, setSpeler] = useState<string | undefined>(undefined);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-xl">
        <div className="text-2xl font-semibold mb-4">
          {type} – aanvallend vak
        </div>

        {/* Speler kiezen (alleen aanvalsvak) */}
        <div className="space-y-2 mb-4">
          <div className="text-sm">Kies speler (optioneel)</div>
          <div className="flex flex-wrap gap-2 max-h-48 overflow-auto">
            <button
              className={`px-4 py-2 border rounded-full text-base font-semibold ${
                !speler ? "bg-black text-white" : ""
              }`}
              onClick={() => setSpeler(undefined)}
            >
              Team-event
            </button>
            {spelers.map((p) => (
              <button
                key={p.id}
                className={`px-4 py-2 border rounded-full text-base font-semibold ${
                  speler === p.id ? "bg-black text-white" : ""
                }`}
                onClick={() => setSpeler(p.id)}
              >
                {p.naam}
              </button>
            ))}
          </div>
        </div>

        {/* Raak / Mis knoppen */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            className="border rounded-xl p-4 hover:shadow text-base font-semibold bg-green-50"
            onClick={() => onSave("Raak", speler)}
          >
            Raak
          </button>
          <button
            className="border rounded-xl p-4 hover:shadow text-base font-semibold bg-red-50"
            onClick={() => onSave("Mis", speler)}
          >
            Mis
          </button>
        </div>
        
        <div className="flex justify-end">
          <button className="text-sm text-gray-600" onClick={onClose}>
            Sluiten
          </button>
        </div>
      </div>
    </div>
  );
}

type FieldImageCardProps = {
  title: string;
  imgSrc: string;
  active: boolean;
  onClick: () => void;
  onFieldClick?: (xPct: number, yPct: number) => void;
  markers?: FieldEvent[];
  children?: React.ReactNode;
};

function FieldImageCard({
  title,
  imgSrc,
  active,
  onClick,
  onFieldClick,
  markers = [],
  children,
}: FieldImageCardProps) {
  const isAttack = title.toLowerCase().includes("aanvallend");
  const vakLabel = title.split(" (")[0];

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (onFieldClick && active) {
      const xPct = ((e.clientX - rect.left) / rect.width) * 100;
      const yPct = ((e.clientY - rect.top) / rect.height) * 100;
      onFieldClick(xPct, yPct);
    }
    onClick();
  };

  function getFillColor(ev: FieldEvent) {
    switch (ev.actie) {
      case "schot": return "blue";
      case "doorloop": return "pink";
      case "strafworp": return "purple";
      case "vrije": return "brown";
      default: return "gray";
    }
  }

  function getBorderColor(ev: FieldEvent) {
    switch (ev.resultaat) {
      case "raak": return "green";
      case "mis": return "red";
      case "korf": return "orange";
      default: return "black";
    }
  }

  return (
    <div className={`w-full overflow-hidden rounded-2xl border ${isAttack ? "border-green-200 bg-green-50/80" : "border-red-200 bg-red-50/80"}`}>
      <div className="px-4 pt-3 pb-2 text-center">
        <div className={`text-sm md:text-base font-extrabold uppercase tracking-[0.16em] ${isAttack ? "text-green-700" : "text-red-700"}`}>{isAttack ? "Aanval" : "Verdediging"}</div>
        <div className="mt-0.5 text-sm font-bold text-slate-700">{vakLabel}</div>
      </div>

      <div className="px-3">
        <button
          className="relative block w-full overflow-hidden rounded-xl border border-white/80 p-0 outline-none shadow-sm bg-white"
          onClick={handleClick}
        >
          <img src={imgSrc} alt={title} className={`w-full h-auto select-none pointer-events-none transition-opacity duration-200 ${active ? "opacity-100" : "opacity-35"}`} draggable={false} />
          {markers.map((m) => (
            <div
              key={m.id}
              style={{ position: "absolute", width: "15px", height: "15px", left: `${m.x}%`, top: `${m.y}%`, transform: "translate(-50%, -50%)", backgroundColor: getFillColor(m), border: `1px solid ${getBorderColor(m)}`, borderRadius: "50%", pointerEvents: "none" }}
            />
          ))}
          {children}
        </button>
      </div>

      <div className={`mt-3 w-full border-t px-4 py-2.5 text-center text-sm font-extrabold ${active ? (isAttack ? "border-green-200 bg-green-100 text-green-800" : "border-red-200 bg-red-100 text-red-800") : "border-slate-200 bg-white/70 text-slate-500"}`}>
        <span className={`mr-2 inline-block h-2 w-2 rounded-full ${active ? (isAttack ? "bg-green-600" : "bg-red-600") : "bg-slate-300"}`} />
        {active ? "Actief vak" : "Niet actief"}
      </div>
    </div>
  );
}

function PieChart({
  title,
  slices,
}: {
  title: string;
  slices: PieSlice[];
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-gray-500">Nog geen data</div>
      </div>
    );
  }

  let current = 0;
  const parts: string[] = [];
  slices.forEach((s) => {
    const start = (current / total) * 100;
    const end = ((current + s.value) / total) * 100;
    parts.push(`${s.color} ${start}% ${end}%`);
    current += s.value;
  });

  const bg = `conic-gradient(${parts.join(", ")})`;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="text-sm font-semibold">{title}</div>
      <div
        className="relative rounded-full"
        style={{
          width: 160,
          height: 160,
          backgroundImage: bg,
        }}
      >
        <div className="absolute inset-6 rounded-full bg-white" />
      </div>
      <div className="flex flex-wrap justify-center gap-2 text-xs mt-1">
        {slices.map((s) => (
          <div key={s.label} className="flex items-center gap-1">
            <span
              className="w-3 h-3 rounded-full inline-block"
              style={{ backgroundColor: s.color }}
            />
            <span>
              {s.label} (
              {((s.value / total) * 100).toFixed(0)}
              %)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


type ActionName = "Schot" | "Doorloop" | "Vrijebal" | "Strafworp";

function HitMissBarChart({
  title,
  counts,
}: {
  title: string;
  counts: Record<ActionName, { raak: number; mis: number }>;
}) {
  const ACTION_KEYS: ActionName[] = ["Schot", "Doorloop", "Vrijebal", "Strafworp"];

  const values = ACTION_KEYS.flatMap((key) => [
    counts[key].raak,
    counts[key].mis,
  ]);
  const max = Math.max(0, ...values);

  if (max === 0) {
    return (
      <div className="border rounded-2xl p-3 flex flex-col items-center gap-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-gray-500">Nog geen data</div>
      </div>
    );
  }

  return (
    <div className="border rounded-2xl p-3">
      <div className="text-sm font-semibold mb-3">{title}</div>

      <div className="space-y-4">
        {ACTION_KEYS.map((a) => {
          const { raak, mis } = counts[a];

          const raakPerc = max > 0 ? (raak / max) * 100 : 0;
          const misPerc = max > 0 ? (mis / max) * 100 : 0;

          const raakHeight = raak > 0 ? Math.max(15, raakPerc) : 0;
          const misHeight = mis > 0 ? Math.max(15, misPerc) : 0;

          return (
            <div key={a}>
              <div className="text-xs mb-1 font-medium">{a}</div>

              {/* container met vaste hoogte */}
              <div className="flex items-end gap-4 h-32 border rounded-xl px-3 py-2 bg-gray-50">
                {/* Raak */}
                <div className="flex-1 flex flex-col items-center justify-end h-full">
                  <div
                    className="w-8 rounded-t-md bg-green-500 shadow-sm"
                    style={{ height: `${raakHeight}%` }}
                  />
                  <div className="text-[10px] mt-1 text-center">
                    Raak<br />({raak})
                  </div>
                </div>

                {/* Mis (incl. korf) */}
                <div className="flex-1 flex flex-col items-center justify-end h-full">
                  <div
                    className="w-8 rounded-t-md bg-red-500 shadow-sm"
                    style={{ height: `${misHeight}%` }}
                  />
                  <div className="text-[10px] mt-1 text-center">
                    Mis<br />({mis})
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

//////////////////////////////////////////////////////////////////////////////
// --- UI bits ---------------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function Avatar({ url, naam }: { url?: string; naam: string }) {
  if (url) return <img src={url} alt={naam} className="w-10 h-10 rounded-full object-cover" />;
  const init = naam.split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-sm font-semibold">{init}</div>
  );
}

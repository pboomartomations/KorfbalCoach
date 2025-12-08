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
// Korfbal Coach – volledige TSX app (tabs + vakindeling + wedstrijd)
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

  actie?: "schot" | "doorloop" | "strafworp" | "vrije";
  resultaat?: "raak" | "mis" | "korf" | "verdedigd";
};

type Geslacht = (typeof GESLACHTEN)[number];

type Player = { id: string; naam: string; geslacht: Geslacht; foto?: string };

type VakSide = "aanvallend" | "verdedigend";

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
  | "Korf"
  | "Doelpunt"
  | "Verdedigd";


type AttackTeam = "thuis" | "uit";

type AttackMeta = {
  id: string;              // interne id
  index: number;           // 1,2,3,... (aanvalnummer)
  team: AttackTeam;        // thuis of uit
  vak: VakSide;            // aanvallend / verdedigend
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
};

type TeamFileV1 = {
  version: 1;
  createdAt: string;
  spelers: Player[];
};


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
  autoVakWisselNa2: boolean;
  goalsSinceLastSwitch: number;
  aanvalLinks: boolean;
  currentHalf: 1 | 2;
  activeVak: VakSide;                 // waar is nu de bal
  attacks: AttackMeta[];
  currentAttackId: string | null;
  fieldEvents: FieldEvent[];  
  opponentName: string;
  homeAway: "thuis" | "uit";
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
  autoVakWisselNa2: false,
  goalsSinceLastSwitch: 0,
  aanvalLinks: true,
  currentHalf: 1,
  activeVak: "aanvallend",
  attacks: [],
  currentAttackId: null,
  fieldEvents: [], 
  opponentName: "",   
  homeAway: "thuis", 
  matchEnded: false,    
};

const STORAGE_KEY = "korfbal_coach_state_v1";

function startAttackForVak(prev: AppState, vak: VakSide): AppState {
  const now = prev.tijdSeconden;

  const team: AttackTeam = vak === "aanvallend" ? "thuis" : "uit";

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
    startSeconden: now,
  };
  attacks.push(newAttack);

  return {
    ...prev,
    activeVak: vak,
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
    spelers: Array.isArray(s.spelers) ? (s.spelers as Player[]) : [],
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

    // 🔹 NIEUW: aanvallen + huidige aanval
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
          : DEFAULT_STATE.homeAway,
      matchEnded: bool(s.matchEnded, DEFAULT_STATE.matchEnded),
    };
  }

//////////////////////////////////////////////////////////////////////////////
// --- Main component --------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////

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
  useState<"spelers" | "vakken" | "wedstrijd" | "insights">("spelers");
  //const [popup, setPopup] = useState<null | { vak: VakSide; soort: "Gemis" | "Kans" }>(null);
  const [possPopup, setPossPopup] = useState<null | { team: "thuis" | "uit" }>(null);
  const [shotPopup, setShotPopup] = useState<null | { type: "Schot" | "Rebound" }>(null);
  const [vakActionPopup, setVakActionPopup] =
  useState<null | { vak: VakSide }>(null);
  const [stealPopup, setStealPopup] = useState<null | {}>(null);
  const teamFileInputRef = useRef<HTMLInputElement | null>(null);
  type DatabaseSheets = {
    events: any[];
    attacks: any[];
    wissels: any[];
    matches: any[];
  } | null;
  
  const [dbSheets, setDbSheets] = useState<DatabaseSheets>(null);
  
  const dbFileInputRef = useRef<HTMLInputElement | null>(null);

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

  const bank = state.spelers.filter((p) => !toegewezenIds.has(p.id));

  //////////////////////////////////////////////////////////////////////////////
  // Actions -------------------------------------------------------------------
  //////////////////////////////////////////////////////////////////////////////

  const addSpeler = (naam: string, geslacht: Geslacht, foto?: string) => {
    const p: Player = { id: uid("sp"), naam, geslacht, foto };
    setState((s) => ({ ...s, spelers: [...s.spelers, p] }));
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
    setState((s) => ({ ...s, aanval: s.verdediging, verdediging: s.aanval, goalsSinceLastSwitch:0 }));

  const toggleKlok = (aan: boolean) => setState((s) => ({ ...s, klokLoopt: aan }));

  const resetKlok = () =>
  setState((s) => ({
    ...s,
    tijdSeconden: 0,
    klokLoopt: false,
    possessionOwner: null,
    possessionThuisSeconden: 0,
    possessionUitSeconden: 0,
    currentHalf: 1,
    aanvalLinks: DEFAULT_STATE.aanvalLinks,
  }));


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
            goalsSinceLastSwitch: 0,
          };
        } else {
          next.goalsSinceLastSwitch = goalsTotaal;
        }
      }

      // ⚪ alleen bal-kant wisselen na goal:
      if (goalScored) {
        const nextVak =
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

      const spelers = raw.spelers as Player[];

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

      const eventsSheet = wb.Sheets["Events"];
      const attacksSheet = wb.Sheets["Attacks"];
      const wisselSheet = wb.Sheets["Wissels"];
      const matchSheet = wb.Sheets["Wedstrijden"];

      const events = eventsSheet
        ? XLSX.utils.sheet_to_json(eventsSheet)
        : [];
      const attacks = attacksSheet
        ? XLSX.utils.sheet_to_json(attacksSheet)
        : [];
      const wissels = wisselSheet
        ? XLSX.utils.sheet_to_json(wisselSheet)
        : [];
      const matches = matchSheet
        ? XLSX.utils.sheet_to_json(matchSheet)
        : [];

      setDbSheets({
        events,
        attacks,
        wissels,
        matches,
      });

      alert("Excel database geladen ✅");
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
  // Uniek ID voor deze export / wedstrijd
  const wedstrijdId = `WED-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}`;

  // 🔹 Gemeenschappelijke velden voor naamgeving
  const thuisTeamNaam = "Korbis";
  const uitTeamNaam = state.opponentName || "Tegenstander";
  const locatieLabel = state.homeAway === "thuis" ? "Thuis" : "Uit";

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
      id: e.id,
      tijd_verstreken: formatTime(e.tijdSeconden),
      klok_resterend: formatTime(resterend),
      wedstrijd_minuut:
        e.wedstrijdMinuut ?? Math.max(1, Math.ceil(e.tijdSeconden / 60)),
      vak: e.vak ?? "",
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
      score_thuis: score?.thuis ?? "",
      score_uit: score?.uit ?? "",
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
      aanval_nr: a.index,
      team: teamLabel,
      vak: a.vak === "aanvallend" ? "Aanvallend" : "Verdedigend",
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
      id: e.id,
      tijd_verstreken: formatTime(e.tijdSeconden),
      wedstrijd_minuut:
        e.wedstrijdMinuut ?? Math.max(1, Math.ceil(e.tijdSeconden / 60)),
      vak: e.vak ?? "",
      team: teamLabel,
      positie: e.pos ?? "",
      wissel: e.reden,
      spelerId: e.spelerId || "",
      spelerNaam: e.spelerId ? spelersMap.get(e.spelerId)?.naam || "" : "",
      score_thuis: score?.thuis ?? "",
      score_uit: score?.uit ?? "",
    };
  });

  // ---------- 4) MATCH SUMMARY SHEET ----------
  const totalPoss =
    state.possessionThuisSeconden + state.possessionUitSeconden;
  const possThuisPct =
    totalPoss > 0 ? (state.possessionThuisSeconden / totalPoss) * 100 : 0;
  const possUitPct =
    totalPoss > 0 ? (state.possessionUitSeconden / totalPoss) * 100 : 0;

  const nowTime = state.tijdSeconden;

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
      datum: new Date().toISOString(),
      tegenstander: uitTeamNaam,
      half_duur_minuten: Number.isFinite(state.halfMinuten)
        ? state.halfMinuten
        : DEFAULT_STATE.halfMinuten,
      score_thuis: state.scoreThuis,
      score_uit: state.scoreUit,
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
      wedstrijd_afgesloten: state.matchEnded ? "ja" : "nee",
    },
  ];

  // ---------- 5) MERGE MET BESTAANDE DATABASE (dbSheets) ----------
  const allEvents = [...(dbSheets?.events ?? []), ...eventRows];
  const allAttacks = [...(dbSheets?.attacks ?? []), ...attackRows];
  const allWissels = [...(dbSheets?.wissels ?? []), ...wisselRows];
  const allMatches = [...(dbSheets?.matches ?? []), ...matchSummaryRows];

  const eventsSheet = XLSX.utils.json_to_sheet(allEvents);
  const attacksSheet = XLSX.utils.json_to_sheet(allAttacks);
  const wisselSheet = XLSX.utils.json_to_sheet(allWissels);
  const matchSheet = XLSX.utils.json_to_sheet(allMatches);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, eventsSheet, "Events");
  XLSX.utils.book_append_sheet(wb, attacksSheet, "Attacks");
  XLSX.utils.book_append_sheet(wb, wisselSheet, "Wissels");
  XLSX.utils.book_append_sheet(wb, matchSheet, "Wedstrijden");

  const filename = `korfbal-database-${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;

  XLSX.writeFile(wb, filename);
};


const resetAlles = () => {
  if (!confirm("Weet je zeker dat je alles wilt wissen?")) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  setState({ 
    ...DEFAULT_STATE,
    attacks: [],
    currentAttackId: null,
  });
};

const eindeWedstrijd = () => {
  setState((prev) => {
    const now = prev.tijdSeconden;
    let attacks = [...prev.attacks];

    if (prev.currentAttackId) {
      const idx = attacks.findIndex((a) => a.id === prev.currentAttackId);
      if (idx >= 0 && attacks[idx].endSeconden == null) {
        attacks[idx] = { ...attacks[idx], endSeconden: now };
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
};

const clearWedstrijd = () =>
setState((s) => ({
  ...s,

  // 🔢 Scores terug op 0
  scoreThuis: 0,
  scoreUit: 0,

  // ⏱ Tijd resetten + klok uit
  tijdSeconden: 0,
  klokLoopt: false,
  currentHalf: 1,

  // 🏀 Balbezit resetten
  possessionOwner: null,
  possessionThuisSeconden: 0,
  possessionUitSeconden: 0,

  // 📜 Logs & overzichten leegmaken
  log: [],
  attacks: [],
  currentAttackId: null,
  goalsSinceLastSwitch: 0,

  // 🎯 Heatmap leegmaken
  fieldEvents: [],

  // 🔁 Veldoriëntatie & actief vak terug naar start
  aanvalLinks: DEFAULT_STATE.aanvalLinks,
  activeVak: "aanvallend",
}));

// Afgeleide arrays voor modal
const spelersAanval = state.aanval.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));
const spelersVerdediging = state.verdediging.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));


  //////////////////////////////////////////////////////////////////////////////
  // UI ------------------------------------------------------------------------
  //////////////////////////////////////////////////////////////////////////////
  return (
    <div className="p-3 md:p-6 max-w-5xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <img
        src="/korbis.png"
        alt="Korfbal Coach logo"
        className="h-10 w-10 rounded-xl object-contain"
        />
        <h1 className="text-2xl font-bold">Korfbal Coach</h1>
        <div className="flex flex-wrap gap-2">
        <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        onClick={() => {
          try {
            const encoded = encodeStateForShare(state);
            const url = `${window.location.origin}${window.location.pathname}?s=${encoded}`;
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(url);
              alert("Deel-link gekopieerd naar je klembord ✅");
            } else {
              // fallback: toon link in prompt
              prompt("Kopieer deze link:", url);
            }
          } catch (e) {
            console.error(e);
            alert("Het lukt niet om een deel-link te maken 😅");
          }
        }}
      >
        Deel wedstrijd
      </Button>
      <Button variant="secondary" onClick={exportToExcel}>
        Export naar Excel
      </Button>
      <Button
        variant="secondary"
        onClick={() => dbFileInputRef.current?.click()}
      >
        Laad Excel database
      </Button>
      <Button variant="danger" onClick={clearWedstrijd}>
        Clear wedstrijd
      </Button>
      <Button variant="danger" onClick={resetAlles}>
        Reset alles
      </Button>
      </div>
    </div>

      </header>

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
      {([
          { id: "spelers", label: "Spelers" },
          { id: "vakken", label: "Wedstrijdinstellingen" },
          { id: "wedstrijd", label: "Wedstrijd" },
          { id: "insights", label: "Insights" },
        ] as const).map((t) => (
          <button
            key={t.id}
            className={`px-3 py-2 rounded-xl border ${tab === t.id ? "bg-blue-100" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "spelers" && (
        <SpelersTab
          spelers={state.spelers}
          addSpeler={addSpeler}
          delSpeler={delSpeler}
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
          resetKlok={resetKlok}
          openVakActionModal={(vak) => setVakActionPopup({ vak })}
          openStealModal={() => setStealPopup({})}
          opponentName={state.opponentName}
          onEndMatch={eindeWedstrijd}  
        />
      )}

      {tab === "insights" && (
        <InsightsTab
          state={state}
          spelersMap={spelersMap}
          opponentName={state.opponentName}
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
      {possPopup && (
        <PossessionModal
        team={possPopup.team}
        spelers={veldSpelers}
        opponentName={state.opponentName}
        onClose={() => setPossPopup(null)}
        onSave={(reden, spelerId) => {
          logBalbezit(possPopup.team, reden, spelerId);
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
          spelers={
            vakActionPopup.vak === "aanvallend" ? spelersAanval : spelersVerdediging
          }
          onClose={() => setVakActionPopup(null)}
          onComplete={(actie, uitkomst, spelerId) => {
            handleVakActieLog(vakActionPopup.vak, actie, uitkomst, spelerId);
            setVakActionPopup(null);
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






    </div>




  );
}
//////////////////////////////////////////////////////////////////////////////
// --- Spelers Tab -----------------------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function SpelersTab({
  spelers,
  addSpeler,
  delSpeler,
  exportTeam,
  triggerImportTeam,
}: {
  spelers: Player[];
  addSpeler: (naam: string, geslacht: Geslacht, foto?: string) => void;
  delSpeler: (id: string) => void;
  exportTeam: () => void;
  triggerImportTeam: () => void;
}) {
  const [naam, setNaam] = useState("");
  const [geslacht, setGeslacht] = useState<Geslacht>("Dame");
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
            addSpeler(naam.trim(), geslacht, foto.trim() || undefined);
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
              className="flex items-center justify-between gap-3 border rounded-xl p-2"
            >
              <div className="flex items-center gap-3">
                <Avatar url={p.foto} naam={p.naam} />
                <div>
                  <div className="font-medium">{p.naam}</div>
                  <div className="text-xs text-gray-500">{p.geslacht}</div>
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
}: {
  spelers: Player[];
  toegewezen: Set<string>;
  aanval: (string | null)[];
  verdediging: (string | null)[];
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
  homeAway: "thuis" | "uit";
  setHomeAway: (value: "thuis" | "uit") => void;
}) {
  const beschikbare = spelers.filter((s) => !toegewezen.has(s.id));

  // JSX VakindelingTab
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <VakBox
        titel="Aanvallend vak"
        vak="aanvallend"
        posities={aanval}
        setVakPos={setVakPos}
        spelers={spelers}
        toegewezen={toegewezen}
      />
      <VakBox
        titel="Verdedigend vak"
        vak="verdedigend"
        posities={verdediging}
        setVakPos={setVakPos}
        spelers={spelers}
        toegewezen={toegewezen}
      />

      <div className="md:col-span-2 flex flex-col gap-4 mt-2">
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

          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAanvalLinks(!aanvalLinks)}
            >
              Aanval {aanvalLinks ? "links" : "rechts"} starten
            </Button>
          </div>
        </div>

        {/* Tegenstander naam */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <label className="text-sm font-medium">Naam tegenstander:</label>
          <input
            className="border rounded-lg px-2 py-1 text-sm w-full sm:max-w-xs"
            placeholder="Bijv. TOP, PKC..."
            value={opponentName}
            onChange={(e) => setOpponentName(e.target.value)}
          />
        </div>

        {/* Uit / Thuis */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-2">
          <span className="text-sm font-medium">Locatie wedstrijd:</span>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              className="h-4 w-4"
              checked={homeAway === "thuis"}
              onChange={() => setHomeAway("thuis")}
            />
            Thuis
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              className="h-4 w-4"
              checked={homeAway === "uit"}
              onChange={() => setHomeAway("uit")}
            />
            Uit
          </label>
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
            (s) => !toegewezen.has(s.id) || s.id === currentId
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
  resetKlok,
  openVakActionModal,
  opponentName,
  onEndMatch,   
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
  resetKlok: () => void;
  openVakActionModal: (vak: VakSide) => void;
  openStealModal: () => void;
  opponentName: string;
  onEndMatch: () => void; 
}) {
  const handleVakClick = (vak: VakSide) => {
    // Zorg dat er een aanval is in het vak waar je op klikt
    if (state.activeVak !== vak || !state.currentAttackId) {
      setState((s) => startAttackForVak(s, vak));
    }
  
    // Altijd meteen de actie-popup openen
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
        // actie/resultaat komen na de popup
      };
      return { ...s, fieldEvents: [...s.fieldEvents, newEvent] };
    });
  };

  const fixtureLabel =
  state.homeAway === "thuis"
    ? `Korbis - ${opponentName || "Tegenstander"}`
    : `${opponentName || "Tegenstander"} - Korbis`;


  const aanvalMarkers = state.fieldEvents.filter(
    (e) => e.vak === "aanvallend"
  );
  const verdedigMarkers = state.fieldEvents.filter(
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

  const totalPoss = state.possessionThuisSeconden + state.possessionUitSeconden;
  const possThuisPct =
    totalPoss > 0
      ? (state.possessionThuisSeconden / totalPoss) * 100
      : 0;
  const possUitPct =
    totalPoss > 0
      ? (state.possessionUitSeconden / totalPoss) * 100
      : 0;

  const nowTime = state.tijdSeconden;
  const computeAttackSeconds = (team: AttackTeam) => {
    let total = 0;
    for (const a of state.attacks) {
      if (a.team !== team || a.vak !== "aanvallend") continue;
      const end = a.endSeconden != null ? a.endSeconden : nowTime;
      if (end > a.startSeconden) {
        total += end - a.startSeconden;
      }
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

  const wedstrijdNietGestart = !wedstrijdGestart;

  return (
    <div className="space-y-4">
      {/* Score + tijd + controls */}
      <div className="border rounded-2xl p-4">
        <div className="flex flex-col gap-4">
          {/* Tijd + duur + start/pauze */}
          <div className="flex flex-wrap items-start gap-3 justify-between">
            {/* Tijd */}
            <div>
              <div className="text-2xl font-bold">
                {formatTime(resterend)}
              </div>
              <div className="text-xs text-gray-500">
                Verstreken: {formatTime(state.tijdSeconden)} –{" "}
                {state.currentHalf}e helft
              </div>
            </div>

            {/* Knoppen + duur */}
            <div className="flex gap-2 items-center flex-wrap">
              {/* Start / Pauze */}
              {!state.klokLoopt ? (
                <Button variant="primary" onClick={() => toggleKlok(true)}>
                  Start
                </Button>
              ) : (
                <Button variant="primary" onClick={() => toggleKlok(false)}>
                  Pauze
                </Button>
              )}

              {/* Reset klok (alleen timer) */}
              <Button variant="secondary" onClick={resetKlok}>
                Reset
              </Button>

              <Button
                size="md"
                variant="secondary"
                disabled={state.currentHalf === 2}
                onClick={() =>
                  setState((s) => {
                    const halfMinuten = Number.isFinite(s.halfMinuten)
                      ? s.halfMinuten
                      : DEFAULT_STATE.halfMinuten;
                    const halfTotal = halfMinuten * 60;

                    // als je 2e helft indrukt vóór de 1e helft "officieel klaar" is,
                    // springen we eerst naar het einde van de 1e helft
                    const nieuweTijd = Math.max(s.tijdSeconden, halfTotal);

                    return {
                      ...s,
                      currentHalf: 2,
                      tijdSeconden: nieuweTijd,
                      klokLoopt: false,      // jij drukt daarna zelf weer op Start
                      aanvalLinks: !s.aanvalLinks,
                    };
                  })
                }
              >
                2e helft
              </Button>

              <Button
                size="md"
                variant="danger"
                onClick={onEndMatch}
              >
                Einde wedstrijd
              </Button>
              </div>
            </div>
          </div>

          {/* Wedstrijdlabel */}
          <div className="text-sm font-semibold">
            Wedstrijd: {fixtureLabel}
          </div>

          {/* Alles hieronder wordt grijs + niet klikbaar zolang wedstrijdNietGestart */}
          <div
            className={
              wedstrijdNietGestart
                ? "opacity-40 pointer-events-none transition"
                : "transition"
            }
          >
            {/* Scoresectie */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
              {/* THUIS */}
              <div className="rounded-2xl border bg-blue-50 p-4">
                <div className="flex items-center gap-3 justify-between">
                  <div className="text-lg font-semibold text-blue-800">
                    Korbis
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="md"
                      onClick={() =>
                        setState((s) => ({
                          ...s,
                          scoreThuis: Math.max(0, s.scoreThuis - 1),
                        }))
                      }
                    >
                      -
                    </Button>
                    <div className="text-3xl font-extrabold w-12 text-center text-blue-900">
                      {state.scoreThuis}
                    </div>
                    <Button
                      size="md"
                      onClick={() =>
                        setState((s) => ({
                          ...s,
                          scoreThuis: s.scoreThuis + 1,
                        }))
                      }
                    >
                      +
                    </Button>
                  </div>
                  <div className="text-xs text-blue-900 mt-1">
                    Balbezit: {totalPoss > 0 ? possThuisPct.toFixed(1) : "0.0"}%
                  </div>
                  <div className="text-xs text-blue-900">
                    Aanvalstijd t.o.v. tegenstander:{" "}
                    {totalAttackSec > 0 ? attackThuisPct.toFixed(1) : "0.0"}%
                  </div>
                </div>
              </div>

              {/* UIT */}
              <div className="rounded-2xl border bg-amber-50 p-4">
                <div className="flex items-center gap-3 justify-between">
                  <div className="text-lg font-semibold text-amber-800">
                    {opponentName || "Tegenstander"}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="md"
                      onClick={() =>
                        setState((s) => ({
                          ...s,
                          scoreUit: Math.max(0, s.scoreUit - 1),
                        }))
                      }
                    >
                      -
                    </Button>
                    <div className="text-3xl font-extrabold w-12 text-center text-amber-900">
                      {state.scoreUit}
                    </div>
                    <Button
                      size="md"
                      onClick={() =>
                        setState((s) => ({
                          ...s,
                          scoreUit: s.scoreUit + 1,
                        }))
                      }
                    >
                      +
                    </Button>
                  </div>
                  <div className="text-xs text-amber-900 mt-1">
                    Balbezit: {totalPoss > 0 ? possUitPct.toFixed(1) : "0.0"}%
                  </div>
                  <div className="text-xs text-amber-900">
                    Aanvalstijd t.o.v. Korbis:{" "}
                    {totalAttackSec > 0 ? attackUitPct.toFixed(1) : "0.0"}%
                  </div>
                </div>
              </div>
            </div>

            {/* Vakken: boven afbeeldingen (heatmap), onder spelers+wissels */}
            <div className="relative mt-4">
              {/* BOVEN: twee veld-afbeeldingen, altijd horizontaal */}
              <div className="flex mb-4" style={{ gap: 0 }}>
                {state.aanvalLinks ? (
                  <>
                    {/* LINKS: Aanvallend veld */}
                    <FieldImageCard
                      title="Aanvallend vak"
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
                      title="Verdedigend vak"
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
                      title="Verdedigend vak"
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
                      title="Aanvallend vak"
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
                          Aanvallend vak
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
                          Verdedigend vak
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
                          Verdedigend vak
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
                          Aanvallend vak
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

              {/* Wisselknop tussen de vakken (blijft) */}
              <button
                type="button"
                onClick={wisselVakken}
                aria-label="Vakken wisselen"
                className="
                  flex
                  absolute top-1/2 left-1/2
                  -translate-x-1/2 -translate-y-1/2
                  w-10 h-10
                  rounded-full
                  bg-white
                  border border-gray-300
                  shadow-lg
                  items-center justify-center
                  text-lg
                  hover:bg-gray-50
                  active:scale-95
                "
              >
                ⇄
              </button>
            </div>
          </div>

          {/* Optioneel: klein hintje als de wedstrijd nog niet gestart is */}
          {wedstrijdNietGestart && (
            <div className="text-xs text-gray-500 mt-1">
              Start de wedstrijd om score, veld en wissels te gebruiken.
            </div>
          )}
        </div>
      </div>
  );
}

function InsightsTab({
  state,
  spelersMap,
  opponentName,
}: {
  state: AppState;
  spelersMap: Map<string, Player>;
  opponentName: string;
}) {

  // 👇 helper om het team bij een event te bepalen
  const getTeamForEvent = (e: LogEvent): AttackTeam | undefined => {
    // 1) Als het event zelf een team heeft, gebruik die
    if (e.team === "thuis" || e.team === "uit") return e.team;

    // 2) Als er een attackId is, haal het team van die aanval
    if (e.attackId) {
      const attack = state.attacks.find((a) => a.id === e.attackId);
      if (attack) return attack.team;
    }

    // 3) Fallback: op basis van vak
    if (e.vak === "aanvallend") return "thuis";
    if (e.vak === "verdedigend") return "uit";

    return undefined;
  };

  // -----------------------------------------
  // 1) Schot vs Doorloop per team
  // -----------------------------------------
  let thuisSchot = 0;
  let thuisDoorloop = 0;
  let uitSchot = 0;
  let uitDoorloop = 0;

  state.log.forEach((e) => {
    if (e.actie !== "Schot" && e.actie !== "Doorloop") return;

    const teamFromAttack = getTeamForEvent(e);
    const fallbackTeam: AttackTeam =
      e.vak === "aanvallend"
        ? "thuis"
        : e.vak === "verdedigend"
        ? "uit"
        : "thuis";
    const team = teamFromAttack ?? fallbackTeam;

    if (team === "thuis") {
      if (e.actie === "Schot") thuisSchot++;
      if (e.actie === "Doorloop") thuisDoorloop++;
    } else {
      if (e.actie === "Schot") uitSchot++;
      if (e.actie === "Doorloop") uitDoorloop++;
    }
  });

  const thuisSlices: PieSlice[] = [];
  if (thuisSchot > 0)
    thuisSlices.push({
      label: "Schot",
      value: thuisSchot,
      color: "#1d4ed8", // blauw
    });
  if (thuisDoorloop > 0)
    thuisSlices.push({
      label: "Doorloop",
      value: thuisDoorloop,
      color: "#ec4899", // roze
    });

  const uitSlices: PieSlice[] = [];
  if (uitSchot > 0)
    uitSlices.push({
      label: "Schot",
      value: uitSchot,
      color: "#1d4ed8",
    });
  if (uitDoorloop > 0)
    uitSlices.push({
      label: "Doorloop",
      value: uitDoorloop,
      color: "#ec4899",
    });

  // -----------------------------------------
  // 2) Doelpunten per speler (eigen ploeg)
  // -----------------------------------------
  const goalEvents = state.log.filter(
    (e) =>
      (e.reden === "Gescoord" ||
        e.reden === "Doelpunt") &&
      e.spelerId &&
      e.spelerId !== TEGENSTANDER_ID
  );

  const goalsPerSpeler = new Map<string, number>();
  goalEvents.forEach((e) => {
    if (!e.spelerId) return;
    goalsPerSpeler.set(
      e.spelerId,
      (goalsPerSpeler.get(e.spelerId) ?? 0) + 1
    );
  });

  // -----------------------------------------
  // 3) Tegendoelpunten per speler (Doorgelaten)
  // -----------------------------------------
  const tegenEvents = state.log.filter(
    (e) =>
      e.reden === "Doorgelaten" &&
      e.spelerId &&
      e.spelerId !== TEGENSTANDER_ID
  );

  const tegenPerSpeler = new Map<string, number>();
  tegenEvents.forEach((e) => {
    if (!e.spelerId) return;
    tegenPerSpeler.set(
      e.spelerId,
      (tegenPerSpeler.get(e.spelerId) ?? 0) + 1
    );
  });

  const colorPalette = [
    "#1d4ed8", // blauw
    "#ec4899", // roze
    "#8b5cf6", // paars
    "#f97316", // oranje
    "#22c55e", // groen
    "#06b6d4", // cyaan
    "#facc15", // geel
    "#ef4444", // rood
  ];

  const goalsSlices: PieSlice[] = Array.from(
    goalsPerSpeler.entries()
  ).map(([spelerId, count], idx) => ({
    label: spelersMap.get(spelerId)?.naam ?? spelerId,
    value: count,
    color: colorPalette[idx % colorPalette.length],
  }));

  const tegenSlices: PieSlice[] = Array.from(
    tegenPerSpeler.entries()
  ).map(([spelerId, count], idx) => ({
    label:
      (spelersMap.get(spelerId)?.naam ?? spelerId) + " (tegen)",
    value: count,
    color: colorPalette[(idx + 3) % colorPalette.length],
  }));

  // -----------------------------------------
  // 4) Overzicht acties per team (Schot / Doorloop / Vrijebal / Strafworp)
  // -----------------------------------------
  const ACTIONS: ("Schot" | "Doorloop" | "Vrijebal" | "Strafworp")[] = [
    "Schot",
    "Doorloop",
    "Vrijebal",
    "Strafworp",
  ];

  type ActionKind = (typeof ACTIONS)[number];

  const actionCounts: Record<AttackTeam, Record<ActionKind, number>> = {
    thuis: {
      Schot: 0,
      Doorloop: 0,
      Vrijebal: 0,
      Strafworp: 0,
    },
    uit: {
      Schot: 0,
      Doorloop: 0,
      Vrijebal: 0,
      Strafworp: 0,
    },
  };

  state.log.forEach((e) => {
    if (!e.actie) return;
    if (!ACTIONS.includes(e.actie)) return;

    const teamFromAttack = getTeamForEvent(e);
    const fallbackTeam: AttackTeam =
      e.vak === "aanvallend"
        ? "thuis"
        : e.vak === "verdedigend"
        ? "uit"
        : "thuis";
    const team = teamFromAttack ?? fallbackTeam;

    const action = e.actie as ActionKind;
    actionCounts[team][action]++;
  });

  // -----------------------------------------
  // 5) Pogingen & Raak per team
  //    poging = elke actie (Schot/Doorloop/Vrijebal/Strafworp)
  //    raak = doelpunt voor dat team
  // -----------------------------------------
  let attemptsThuis = 0;
  let attemptsUit = 0;
  let hitsThuis = 0;
  let hitsUit = 0;

  state.log.forEach((e) => {
    if (!e.actie) return;
    if (!ACTIONS.includes(e.actie)) return;

    const teamFromAttack = getTeamForEvent(e);
    const fallbackTeam: AttackTeam =
      e.vak === "aanvallend"
        ? "thuis"
        : e.vak === "verdedigend"
        ? "uit"
        : "thuis";
    const team = teamFromAttack ?? fallbackTeam;

    // elke actie is een poging
    if (team === "thuis") attemptsThuis++;
    else attemptsUit++;

    // bepalen of dit een "raak"-poging was
    const isScoreForThuis =
      team === "thuis" &&
      (e.reden === "Gescoord" ||
        e.reden === "Doelpunt");

    const isScoreForUit =
      team === "uit" &&
      (e.reden === "Gescoord" ||
        e.reden === "Doelpunt"||
        e.reden === "Doorgelaten");

    if (isScoreForThuis) hitsThuis++;
    if (isScoreForUit) hitsUit++;
  });

  const pct = (hits: number, attempts: number) =>
    attempts > 0 ? `${((hits / attempts) * 100).toFixed(1)} %` : "—";

  // -----------------------------------------
  // 6) Raak vs Mis per actie & per team
  //    - Raak = e.resultaat === "Raak"
  //    - Mis  = e.resultaat === "Mis" of "Korf"
  // -----------------------------------------
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
    if (!e.actie) return;
    if (!ACTIONS.includes(e.actie)) return;
    if (!e.resultaat) return;

    const teamFromAttack = getTeamForEvent(e);
    const fallbackTeam: AttackTeam =
      e.vak === "aanvallend"
        ? "thuis"
        : e.vak === "verdedigend"
        ? "uit"
        : "thuis";

    const team = teamFromAttack ?? fallbackTeam;
    const action = e.actie as ActionKind;

    const bucket = hitMissCounts[team][action];

    if (e.resultaat === "Raak") {
      bucket.raak += 1;
    } else if (e.resultaat === "Mis" || e.resultaat === "Korf") {
      bucket.mis += 1;
    }
  });



  // -----------------------------------------
  // 7) UI
  // -----------------------------------------
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Insights wedstrijd</h2>

      {/* Rij 1: Schot vs Doorloop per team */}
      <div className="grid gap-6 md:grid-cols-2">
      <PieChart
        title="Korbis: Schot vs Doorloop"
        slices={thuisSlices}
      />
      <PieChart
        title={`${opponentName || "Tegenstander"}: Schot vs Doorloop`}
        slices={uitSlices}
      />
      </div>

      {/* Rij 2: Doelpunten en tegendoelpunten per speler */}
      <div className="grid gap-6 md:grid-cols-2">
        <PieChart title="Doelpunten per speler" slices={goalsSlices} />
        <PieChart
          title="Tegendoelpunten per speler (Doorgelaten)"
          slices={tegenSlices}
        />
      </div>

      {/* Raak vs Mis per actie per team */}
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <HitMissBarChart
          title="Korbis – Raak vs Mis per actie"
          counts={hitMissCounts.thuis}
        />
        <HitMissBarChart
          title={`${opponentName || "Tegenstander"} – Raak vs Mis per actie`}
          counts={hitMissCounts.uit}
        />
      </div>

  

      {/* Overzicht acties per team */}
      <div className="mt-4 border rounded-2xl p-3">
        <div className="text-sm font-semibold mb-2">
          Overzicht acties per team
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-1">Actie</th>
                <th className="text-right p-1">Korbis</th>
                <th className="text-right p-1">{opponentName || "Tegenstander"}</th>
              </tr>
            </thead>
            <tbody>
              {ACTIONS.map((a) => (
                <tr key={a} className="border-t">
                  <td className="p-1">{a}</td>
                  <td className="p-1 text-right">
                    {actionCounts.thuis[a]}
                  </td>
                  <td className="p-1 text-right">
                    {actionCounts.uit[a]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pogingen & Raak per team */}
      <div className="mt-4 border rounded-2xl p-3">
        <div className="text-sm font-semibold mb-2">
          Pogingen &amp; raak per team
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-1">Team</th>
                <th className="text-right p-1">Pogingen</th>
                <th className="text-right p-1">Raak</th>
                <th className="text-right p-1">% Raak</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="p-1">Korbis</td>
                <td className="p-1 text-right">{attemptsThuis}</td>
                <td className="p-1 text-right">{hitsThuis}</td>
                <td className="p-1 text-right">
                  {pct(hitsThuis, attemptsThuis)}
                </td>
              </tr>
              <tr className="border-t">
                <td className="p-1">{opponentName || "Tegenstander"}</td>
                <td className="p-1 text-right">{attemptsUit}</td>
                <td className="p-1 text-right">{hitsUit}</td>
                <td className="p-1 text-right">
                  {pct(hitsUit, attemptsUit)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Overzicht aanvallen (oude tabel, nu op Insights-tab) */}
      <div className="mt-4 border rounded-2xl p-3">
        <div className="text-sm font-semibold mb-2">
          Overzicht aanvallen
        </div>
        <div className="mt-2 max-h-64 overflow-auto border rounded-xl">
          <table className="w-full text-[10px]">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="text-left p-1">Aanval</th>
                <th className="text-left p-1">Team</th>
                <th className="text-left p-1">Vak</th>
                <th className="text-left p-1">Start</th>
                <th className="text-left p-1">Einde</th>
                <th className="text-left p-1">Duur</th>
                <th className="text-left p-1">Schoten</th>
                <th className="text-left p-1">Doorloop</th>
                <th className="text-left p-1">Vrije ballen</th>
                <th className="text-left p-1">Strafworpen</th>
              </tr>
            </thead>
            <tbody>
              {state.attacks.map((a) => {
                const duurSeconden =
                  a.endSeconden != null
                    ? a.endSeconden - a.startSeconden
                    : undefined;

                const eventsInAttack = state.log.filter(
                  (e) => e.attackId === a.id
                );

                const schoten = eventsInAttack.filter(
                  (e) => e.actie === "Schot"
                ).length;
                const doorloop = eventsInAttack.filter(
                  (e) => e.actie === "Doorloop"
                ).length;
                const vrijeBallen = eventsInAttack.filter(
                  (e) => e.actie === "Vrijebal"
                ).length;
                const strafworpen = eventsInAttack.filter(
                  (e) => e.actie === "Strafworp"
                ).length;

                return (
                  <tr key={a.id} className="border-t">
                    <td className="p-1">{a.index}</td>
                    <td className="p-1">
                      {a.team === "thuis"
                        ? "Korbis"
                        : opponentName || "Tegenstander"}
                    </td>
                    <td className="p-1">
                      {a.vak === "aanvallend"
                        ? "Aanvallend"
                        : "Verdedigend"}
                    </td>
                    <td className="p-1">
                      {formatTime(a.startSeconden)}
                    </td>
                    <td className="p-1">
                      {a.endSeconden != null
                        ? formatTime(a.endSeconden)
                        : "—"}
                    </td>
                    <td className="p-1">
                      {duurSeconden != null
                        ? formatTime(duurSeconden)
                        : "—"}
                    </td>
                    <td className="p-1">{schoten}</td>
                    <td className="p-1">{doorloop}</td>
                    <td className="p-1">{vrijeBallen}</td>
                    <td className="p-1">{strafworpen}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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
  spelers,
  onClose,
  onComplete,
  onSteal,
}: {
  vak: VakSide;
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
        <div className="bg-white w-full max-w-3xl md:rounded-2xl md:m-6 p-4 md:p-6 space-y-6 max-h-[90vh] overflow-auto">
        {/* Titel + stappenindicator */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-2xl font-bold">
              Actie in {titelVak}
            </div>
            <div className="text-sm text-gray-500 mt-1">
              Stap {step} van 3 –{" "}
              {step === 1
                ? "Kies een actie"
                : step === 2
                ? "Kies speler (optioneel)"
                : "Kies een uitkomst"}
            </div>
          </div>
          <button
            className="text-sm text-gray-500 hover:text-gray-800"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Stap 1: Actie */}
        {step === 1 && (
          <div className="space-y-6 w-full">
            <div className="text-2xl font-bold text-center">Kies een actie</div>

            <div className="flex flex-col gap-4 w-full h-[70vh]">
              {/* Vier basis-acties in 2x2 grid */}
              <div className="grid grid-cols-2 grid-rows-2 gap-4 flex-1">
                {["Schot", "Doorloop", "Vrijebal", "Strafworp"].map((a) => {
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
                        setActie(a as any);
                        setStep(2);
                      }}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>

              {/* Steal-knop onder de andere knoppen, over de volle breedte */}
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
          <div className="w-full flex flex-col gap-6">
            <div className="text-2xl font-bold text-center">Kies speler</div>

            <div className="grid grid-cols-2 grid-rows-3 gap-4 w-full">
              {/* Bovenste rij: 'Geen keuze' over volledige breedte */}
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
                  setSpeler(undefined);
                  if (stealFlow) {
                    // Steal zonder specifieke speler
                    onSteal(undefined);
                    onClose();
                  } else {
                    setStep(3); // normaal: door naar uitkomst
                  }
                }}
              >
                Geen keuze
              </button>

              {/* Daaronder max. 4 spelers (2 breed, 2 hoog) */}
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
                    setSpeler(p.id);
                    if (stealFlow) {
                      // Steal mét speler → direct afhandelen
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
          </div>
        )}
        
        {/* Stap 3: Uitkomst */}
        {step === 3 && (
          <div className="space-y-6 w-full">
            <div className="text-2xl font-bold text-center">Uitkomst</div>

            <div className="grid grid-cols-2 grid-rows-2 gap-4 w-full">
              {/* RAAK (groen) */}
              <button
                className="
                  w-full h-full
                  text-3xl md:text-5xl
                  font-extrabold
                  rounded-2xl
                  border-2
                  bg-green-500 text-white border-green-600
                  active:scale-95 transition
                "
                onClick={() => handleFinish("Raak")}
              >
                Raak
              </button>

              {/* MIS (rood) */}
              <button
                className="
                  w-full h-full
                  text-3xl md:text-5xl
                  font-extrabold
                  rounded-2xl
                  border-2
                  bg-red-500 text-white border-red-600
                  active:scale-95 transition
                "
                onClick={() => handleFinish("Mis")}
              >
                Mis
              </button>

              {/* KORF (oranje) */}
              <button
                className="
                  w-full h-full
                  text-3xl md:text-5xl
                  font-extrabold
                  rounded-2xl
                  border-2
                  bg-orange-400 text-white border-orange-500
                  active:scale-95 transition
                "
                onClick={() => handleFinish("Korf")}
              >
                Korf
              </button>

              {/* VERDEDIGD (blauw/grijs) */}
              <button
                className="
                  w-full h-full
                  text-3xl md:text-5xl
                  font-extrabold
                  rounded-2xl
                  border-2
                  bg-slate-500 text-white border-slate-600
                  active:scale-95 transition
                "
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
                Speler:{" "}
                {spelers.find((p) => p.id === speler)?.naam || "?"}
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
      case "schot":
        return "blue";
      case "doorloop":
        return "pink";
      case "strafworp":
        return "purple";
      case "vrije":
        return "brown";
      default:
        return "gray";
    }
  }

  function getBorderColor(ev: FieldEvent) {
    switch (ev.resultaat) {
      case "raak":
        return "green";
      case "mis":
        return "red";
      case "korf":
        return "orange";
      default:
        return "black";
    }
  }

  return (
    <button
      className="relative block w-full p-0 border-none outline-none"
      onClick={handleClick}
      style={{ background: "transparent" }}
    >
      {/* veldafbeelding */}
      <img
        src={imgSrc}
        alt={title}
        className={`
          w-full
          h-auto
          select-none
          pointer-events-none
          transition-opacity
          duration-200
          ${active ? "opacity-100" : "opacity-20"}
        `}
        draggable={false}
      />

      {/* heatmap markers */}
      {markers.map((m) => (
        <div
          key={m.id}
          style={{
            position: "absolute",
            width: "15px",
            height: "15px",
            left: `${m.x}%`,
            top: `${m.y}%`,
            transform: "translate(-50%, -50%)",
            backgroundColor: getFillColor(m),
            border: `1px solid ${getBorderColor(m)}`,
            borderRadius: "50%",
            pointerEvents: "none",
            opacity: active ? 1 : 0.25, // minder fel als vak niet actief is
            zIndex: 10,
          }}
        />
      ))}

      {/* STEAL-knop overlay */}
      {children && (
        <div className="absolute bottom-2 left-0 right-0 flex justify-center pointer-events-none">
          <div className="pointer-events-auto w-full max-w-xs">
            {children}
          </div>
        </div>
      )}
    </button>
  );
}

type PieSlice = {
  label: string;
  value: number;
  color: string;
};

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

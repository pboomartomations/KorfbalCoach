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
  markerGroup: number;

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
  | "Geen Rebound"
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
  markerGroup: number;
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
  markerGroup: 0,
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

  const [reboundPopup, setReboundPopup] =
    useState<null | {}>(null);

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
  setState((s) => ({
    ...s,
    aanval: s.verdediging,
    verdediging: s.aanval,
    goalsSinceLastSwitch: 0,

    // nieuwe veldperiode -> oude markers niet meer tonen
    markerGroup: s.markerGroup + 1,
  }));

  const toggleKlok = (aan: boolean) =>
  setState((s) => ({
    ...s,
    klokLoopt: aan,
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
      datum: new Date().toISOString(),
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
};

const clearWedstrijd = () => {
  if (
    !confirm(
      "Nieuwe wedstrijd starten? De huidige wedstrijdgegevens worden uit de app verwijderd. Exporteer deze eerst naar Excel als je ze wilt bewaren."
    )
  ) {
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

    log: [],
    attacks: [],
    currentAttackId: null,
    goalsSinceLastSwitch: 0,

    fieldEvents: [],
    markerGroup: 0,

    aanvalLinks: DEFAULT_STATE.aanvalLinks,
    activeVak: "aanvallend",

    matchEnded: false,
  }));
};

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
        Nieuwe wedstrijd
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
  openVakActionModal: (vak: VakSide) => void;
  openStealModal: () => void;
  opponentName: string;
  onEndMatch: () => void; 
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
    : `${opponentName || "Tegenstander"} - Korbis`;


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

  const wedstrijdOpPauze =
    wedstrijdGestart &&
    !state.klokLoopt &&
    !wedstrijdAfgelopen &&
    !eersteHelftAfgelopen;

  const showOverlay =
    wedstrijdNietGestart ||
    eersteHelftAfgelopen ||
    wedstrijdOpPauze ||
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

              {!wedstrijdAfgelopen && (
                <Button
                  variant="primary"
                  className="w-full text-3xl font-extrabold py-7 min-h-[88px] rounded-2xl"
                  onClick={() =>
                    eersteHelftAfgelopen
                      ? startTweedeHelft()
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
      {/* Score + tijd + controls */}
      <div
        className={`relative border rounded-2xl p-4 ${
          state.klokLoopt ? "cursor-pointer hover:bg-gray-50" : ""
        }`}
        onClick={(e) => {
          const target = e.target as HTMLElement;
        
          // Niet pauzeren als de klik op een knop, input of ander interactief element was
          if (
            target.closest(
              "button, input, select, textarea, [role='dialog'], [data-no-pause]"
            )
          ) {
            return;
          }
        
          if (state.klokLoopt && !state.matchEnded) {
            toggleKlok(false);
          }
        }}
      >

        {/* Pauze-symbool midden in de balk */}
        <div className="flex flex-col gap-4">

          {/* Tijd + duur + start/pauze */}
          <div className="relative flex flex-wrap items-center gap-3 justify-between">
            {/* Pauze-symbool */}
            {state.klokLoopt && !state.matchEnded && (
              <div
                className="
                  absolute
                  left-1/2 top-1/2
                  -translate-x-1/2 -translate-y-1/2
                  flex gap-2
                  pointer-events-none
                "
                aria-hidden="true"
              >
                <span className="block w-2 h-8 bg-gray-900 rounded-sm" />
                <span className="block w-2 h-8 bg-gray-900 rounded-sm" />
              </div>
            )}
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

                      // nieuwe veldperiode voor de tweede helft
                      markerGroup: s.markerGroup + 1,
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
                  <div className="text-xs text-blue-900">
                    Aanvalstijd t.o.v. tegenstander:{" "}
                    {totalAttackSec > 0 ? attackThuisPct.toFixed(1) : "0.0"}%
                    {" · "}
                    {formatTime(attackThuisSec)}
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
                  <div className="text-xs text-amber-900">
                    Aanvalstijd t.o.v. Korbis:{" "}
                    {totalAttackSec > 0 ? attackUitPct.toFixed(1) : "0.0"}%
                    {" · "}
                    {formatTime(attackUitSec)}
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
  const ACTIONS = ["Schot", "Doorloop", "Vrijebal", "Strafworp"] as const;
  type ActionKind = (typeof ACTIONS)[number];

  const [analysisMode, setAnalysisMode] = useState<"speler" | "team">("speler");

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

  type ShotZone = "Korte kans" | "Afstandsschot" | "Ver afstandsschot";

  // De oranje zone in VeldLinks.jpg bestaat uit twee overlappende lobben.
  // We rekenen met percentages, zodat de indeling onafhankelijk is van de
  // schermgrootte waarop het veld wordt getoond.
  //
  // zoneDistance <= 1.0  -> binnen het oranje vlak
  // zoneDistance <= 2.0  -> normale afstand
  // zoneDistance > 2.0   -> verre afstand
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
  const awayKorf = resultCount(awayActionEvents, "Korf");
  const homeDefended = resultCount(homeActionEvents, "Verdedigd");
  const awayDefended = resultCount(awayActionEvents, "Verdedigd");

  const homeScorePct = homeAttempts > 0 ? (homeGoals / homeAttempts) * 100 : 0;
  const awayScorePct = awayAttempts > 0 ? (awayGoals / awayAttempts) * 100 : 0;
  const homeQualityPct =
    homeAttempts > 0 ? ((homeGoals + homeKorf) / homeAttempts) * 100 : 0;
  const awayQualityPct =
    awayAttempts > 0 ? ((awayGoals + awayKorf) / awayAttempts) * 100 : 0;

  const homeAttacks = state.attacks.filter((a) => a.team === "thuis");
  const awayAttacks = state.attacks.filter((a) => a.team === "uit");

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

  const modeButtons = (
    <div className="inline-flex rounded-xl border bg-white p-1 gap-1">
      <button
        type="button"
        onClick={() => setAnalysisMode("speler")}
        className={`px-4 py-2 rounded-lg text-sm font-semibold ${
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
        className={`px-4 py-2 rounded-lg text-sm font-semibold ${
          analysisMode === "team"
            ? "bg-blue-600 text-white"
            : "text-gray-600 hover:bg-gray-50"
        }`}
      >
        Teamanalyse
      </button>
    </div>
  );

  if (analysisMode === "team") {
    return (
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Team Insights</h2>
            <p className="text-sm text-gray-500 mt-1">
              Coachingsgerichte analyse van Korbis tegen {opponentName || "de tegenstander"}.
            </p>
          </div>
          {modeButtons}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Aanvalsrendering</div>
            <div className="text-3xl font-extrabold mt-1">
              {homeAttacks.length > 0 ? goalsPerAttack.toFixed(2) : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-1">doelpunten per aanval</div>
          </div>
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Scorepercentage</div>
            <div className="text-3xl font-extrabold mt-1">
              {homeAttempts > 0 ? `${homeScorePct.toFixed(0)}%` : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {homeGoals} uit {homeAttempts} pogingen
            </div>
          </div>
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Schotkwaliteit</div>
            <div className="text-3xl font-extrabold mt-1">
              {homeAttempts > 0 ? `${homeQualityPct.toFixed(0)}%` : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-1">raak + korf</div>
          </div>
          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-xs font-semibold text-gray-500">Rebound</div>
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
                    <span className="font-bold text-green-700">+</span>
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
                    <span className="font-bold text-amber-700">!</span>
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
                <div className="text-xs text-gray-500">pogingen / aanval</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {homeAttacks.length > 0
                    ? `${averageAttackDuration.toFixed(0)}s`
                    : "—"}
                </div>
                <div className="text-xs text-gray-500">gem. aanvalsduur</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">{homeAttacks.length}</div>
                <div className="text-xs text-gray-500">aanvallen</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {wonRebounds.length > 0 ? `${secondChancePct.toFixed(0)}%` : "—"}
                </div>
                <div className="text-xs text-gray-500">score na rebound</div>
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
                <div className="text-xs text-gray-500">verdedigd</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">{teamSteals}</div>
                <div className="text-xs text-gray-500">onderscheppingen</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">{awayGoals}</div>
                <div className="text-xs text-gray-500">tegendoelpunten</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="text-2xl font-extrabold">
                  {awayAttempts > 0 ? `${awayScorePct.toFixed(0)}%` : "—"}
                </div>
                <div className="text-xs text-gray-500">score% tegenstander</div>
              </div>
            </div>
          </div>

          <div className="border rounded-2xl p-4 bg-white">
            <div className="text-lg font-bold">Balbezit</div>
            <div className="text-sm text-gray-500 mb-4">
              Geregistreerde tijd in balbezit.
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
                  <th className="text-right p-3">Pogingen</th>
                  <th className="text-right p-3">Raak</th>
                  <th className="text-right p-3">Korf</th>
                  <th className="text-right p-3">Mis</th>
                  <th className="text-right p-3">Verdedigd</th>
                  <th className="text-right p-3">Score %</th>
                  <th className="text-right p-3">Kwaliteit %</th>
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
                  <th className="text-right p-3">Pogingen</th>
                  <th className="text-right p-3">Goals</th>
                  <th className="text-right p-3">Score %</th>
                  <th className="text-right p-3">Kwaliteit %</th>
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
                  <th className="text-right p-3">Raak</th>
                  <th className="text-right p-3">Score %</th>
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
        <div className="flex justify-end">{modeButtons}</div>
        <div className="border rounded-2xl p-6 bg-white">
          <h2 className="text-xl font-bold mb-2">Insights per speler</h2>
          <p className="text-sm text-gray-500">
            Voeg eerst spelers toe om persoonlijke inzichten te kunnen tonen.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Insights per speler</h2>
          <p className="text-sm text-gray-500 mt-1">
            Persoonlijke analyse op basis van de geregistreerde acties in deze wedstrijd.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          {modeButtons}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-gray-500">Speler</span>
            <select
              className="border rounded-xl px-3 py-2 bg-white min-w-52"
              value={selectedPlayerId}
              onChange={(e) => setSelectedPlayerId(e.target.value)}
            >
              {state.spelers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.naam}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-gray-500">Periode</span>
            <select
              className="border rounded-xl px-3 py-2 bg-gray-50 text-gray-700"
              value="wedstrijd"
              disabled
            >
              <option value="wedstrijd">Deze wedstrijd</option>
            </select>
          </label>
        </div>
      </div>

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
          { label: "Acties", value: attempts.toString(), sub: "aanvallend" },
          { label: "Doelpunten", value: goals.toString(), sub: `${scorePct.toFixed(0)}% raak` },
          { label: "Schotkwaliteit", value: `${qualityPct.toFixed(0)}%`, sub: "raak + korf" },
          { label: "Rebounds", value: reboundEvents.length.toString(), sub: allReboundMoments.length > 0 ? `${reboundSharePct.toFixed(0)}% aandeel` : "nog geen rebounddata" },
          { label: "Verdedigend", value: (defensiveStops + steals).toString(), sub: `${defensiveStops} verdedigd · ${steals} steals` },
        ].map((card) => (
          <div key={card.label} className="border rounded-2xl p-4 bg-white shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {card.label}
            </div>
            <div className="text-3xl font-extrabold mt-1">{card.value}</div>
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
                  <span aria-hidden="true">🟢</span>
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
                  <span aria-hidden="true">🟠</span>
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
                <th className="text-right p-3">Pogingen</th>
                <th className="text-right p-3">Raak</th>
                <th className="text-right p-3">Korf</th>
                <th className="text-right p-3">Mis</th>
                <th className="text-right p-3">Verdedigd</th>
                <th className="text-right p-3">Score %</th>
                <th className="text-right p-3">Kwaliteit %</th>
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
                <th className="text-right p-3">Pogingen</th>
                <th className="text-right p-3">Raak</th>
                <th className="text-right p-3">Korf</th>
                <th className="text-right p-3">Mis</th>
                <th className="text-right p-3">Verdedigd</th>
                <th className="text-right p-3">Score %</th>
                <th className="text-right p-3">Kwaliteit %</th>
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
                <th className="text-right p-3">Score %</th>
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
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white w-full max-w-3xl md:rounded-2xl md:m-6 p-4 md:p-6 space-y-6 max-h-[90vh] overflow-auto">
        {/* Titel + stappenindicator */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-2xl font-bold">Actie in {titelVak}</div>
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

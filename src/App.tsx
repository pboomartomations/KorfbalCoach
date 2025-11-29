import React, { useEffect, useMemo, useRef, useState } from "react";

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
  | "Doelpunt";


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
    tijdSeconden: number;            // totale verstreken tijd in de wedstrijd
    vak?: VakSide;
    soort: "Gemis" | "Kans" | "Wissel" | "Balbezit" | "Schot" | "Rebound";
    actie?: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp";
    reden: LogReden;
    spelerId?: string;
    resterendSeconden?: number;
    wedstrijdMinuut?: number;
    pos?: number;                    // 1..4 (alleen voor wissels)
    team?: "thuis" | "uit";          // vooral voor Balbezit
    possThuis?: number;              // 0–100
    possUit?: number;                // 0–100
    type?: "Schot" | "Rebound";
    resultaat?: "Raak" | "Mis";
    attackId?: string;
    attackIndex?: number;
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

// -- Hydration/migratie helper ----------------------------------------------
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
  };
}


// --- Main component --------------------------------------------------------

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

  const [tab, setTab] = useState<"spelers" | "vakken" | "wedstrijd">("spelers");
  const [popup, setPopup] = useState<null | { vak: VakSide; soort: "Gemis" | "Kans" }>(null);
  const [possPopup, setPossPopup] = useState<null | { team: "thuis" | "uit" }>(null);
  const [shotPopup, setShotPopup] = useState<null | { type: "Schot" | "Rebound" }>(null);
  const [vakActionPopup, setVakActionPopup] =
  useState<null | { vak: VakSide }>(null);
  const [stealPopup, setStealPopup] = useState<null | {}>(null);




  // Persist
  // Timer (intern: op-tellen; UI toont resterend) + balbezit
useEffect(() => {
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

  // Actions ---------------------------------------------------------------
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

  const setVakPos = (vak: VakSide, pos: number, spelerId: string | null) => {
    setState((s) => {
      const arr = vak === "aanvallend" ? [...s.aanval] : [...s.verdediging];
      const prevId = arr[pos] || null;
      arr[pos] = spelerId;
  
      const logs: LogEvent[] = [];
  
      // ✅ gebruik de halfMinuten uit de actuele state 's'
      const halfMinuten = Number.isFinite(s.halfMinuten)
        ? s.halfMinuten
        : DEFAULT_STATE.halfMinuten;
      const halfTotal = halfMinuten * 60;
  
      // ✅ geen halfElapsedSeconden meer → gewoon tijdSeconden
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
        });
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
    actie?: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp"
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
      actie,
      resterendSeconden: resterend,
      wedstrijdMinuut: minuut,
      attackId,
      attackIndex,
    };
  
    setState((s) => {
      let next: AppState = { ...s, log: [e, ...s.log] };
      let goalScored = false;
  
      // bestaande score-logica
      if (soort === "Kans" && vak === "aanvallend" && reden === "Gescoord") {
        next.scoreThuis = s.scoreThuis + 1;
        goalScored = true;
      }
      if (soort === "Gemis" && vak === "verdedigend" && reden === "Doorgelaten") {
        next.scoreUit = s.scoreUit + 1;
        goalScored = true;
      }
  
      // 🔁 automatisch vakkenwissel na 2 goals (als je die logica al hebt)
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
    const halfMinuten = Number.isFinite(state.halfMinuten)
      ? state.halfMinuten
      : DEFAULT_STATE.halfMinuten;
    const totalSeconds = halfMinuten * 60;
    const resterend = Math.max(totalSeconds - state.tijdSeconden, 0);
    const minuut = Math.max(1, Math.ceil(state.tijdSeconden / 60));
    const { attackId, attackIndex } = getCurrentAttackInfo(state);
  
    const e: LogEvent = {
      id: uid("ev"),
      tijdSeconden: state.tijdSeconden,
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
  
    setState((s) => ({ ...s, log: [e, ...s.log] }));
  };
  










  const handleVakActieLog = (
    vak: VakSide,
    actie: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp",
    uitkomst: "Korf" | "Mis" | "Raak",
    spelerId?: string
  ) => {
    let soort: "Kans" | "Gemis";
    let reden: LogReden;
  
    if (vak === "aanvallend") {
      soort = "Kans";
      if (uitkomst === "Raak") {
        reden = "Gescoord";
      } else {
        reden = "Gemist Schot";
      }
    } else {
      soort = "Gemis";
      if (uitkomst === "Raak") {
        reden = "Doorgelaten";
      } else {
        reden = "Gemist Schot";
      }
    }
  
    // ❗ Juist: actie met kleine letter
    logEvent(vak, soort, reden, spelerId, actie);
  
    // Warning weg + handig voor debugging
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
  
    // balbezit-snapshot op dit moment
    const totaalPoss =
      state.possessionThuisSeconden + state.possessionUitSeconden;
    const possThuis =
      totaalPoss > 0
        ? Math.round(
            (state.possessionThuisSeconden / totaalPoss) * 100
          )
        : 0;
    const possUit =
      totaalPoss > 0
        ? Math.round(
            (state.possessionUitSeconden / totaalPoss) * 100
          )
        : 0;
  
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
      resterendSeconden: resterend,
      wedstrijdMinuut: minuut,
      possThuis,
      possUit,
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

  // balbezit snapshot
  const totaalPoss =
    state.possessionThuisSeconden + state.possessionUitSeconden;
  const possThuis =
    totaalPoss > 0
      ? Math.round(
          (state.possessionThuisSeconden / totaalPoss) * 100
        )
      : 0;
  const possUit =
    totaalPoss > 0
      ? Math.round(
          (state.possessionUitSeconden / totaalPoss) * 100
        )
      : 0;

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
    possThuis,
    possUit,
    attackId,
    attackIndex,
  };

  setState((s) => ({ ...s, log: [e, ...s.log] }));
};
  
  const exportCSV = () => {
    // ✅ balbezit-percentages uitrekenen
    /*const totaalPoss =
      state.possessionThuisSeconden + state.possessionUitSeconden;
  
    const possThuis =
      totaalPoss > 0
        ? Math.round(
            (state.possessionThuisSeconden / totaalPoss) * 100
          )
        : 0;
  
    const possUit =
      totaalPoss > 0
        ? Math.round(
            (state.possessionUitSeconden / totaalPoss) * 100
          )
        : 0;*/
  
    const rows = [
      [
        "id",
        "aanval_nr",
        "aanval_team",
        "aanval_vak",
        "aanval_start",
        "aanval_einde",
        "aanval_einde",
        "tijd_verstreken",
        "klok_resterend",
        "wedstrijd_minuut",
        "vak",
        "soort",
        "reden",
        "team_event",
        "spelerId",
        "spelerNaam",
        "balbezit_thuis_pct",
        "balbezit_uit_pct",
      ],
      ...state.log
      .slice()
      .reverse()
      .map((e) => {
        const attackMeta = e.attackId
          ? state.attacks.find((a) => a.id === e.attackId)
          : undefined;
  

        const aanvalDuurSeconden =
          attackMeta && attackMeta.endSeconden != null
            ? attackMeta.endSeconden - attackMeta.startSeconden
            : undefined;
            
        return [
          e.id,
          e.attackIndex ?? "",
          attackMeta?.team ?? "",
          attackMeta?.vak ?? "",
          attackMeta ? formatTime(attackMeta.startSeconden) : "",
          attackMeta?.endSeconden != null
            ? formatTime(attackMeta.endSeconden)
            : "",
          aanvalDuurSeconden != null
            ? formatTime(aanvalDuurSeconden)
            : "",                    // 👈 duur in mm:ss
        formatTime(e.tijdSeconden),
          formatTime(e.tijdSeconden),
          formatTime(
            e.resterendSeconden ??
              Math.max(
                ((Number.isFinite(state.halfMinuten)
                  ? state.halfMinuten
                  : DEFAULT_STATE.halfMinuten) *
                  60) -
                  e.tijdSeconden,
                0
              )
          ),
          e.wedstrijdMinuut ??
            Math.max(1, Math.ceil(e.tijdSeconden / 60)),
          e.vak ?? "",
          e.soort,
          e.reden,
          e.team ?? "",
          e.spelerId || "",
          e.spelerId === TEGENSTANDER_ID
            ? "Tegenstander"
            : e.spelerId
            ? spelersMap.get(e.spelerId)?.naam || ""
            : "",
          e.possThuis ?? "",
          e.possUit ?? "",
        ];
      }),
  ];
  
    const escapeCSV = (v: any) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = rows.map((r) => r.map(escapeCSV).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `korfbal-log-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
  const leegLog = () =>
  setState((s) => ({
    ...s,
    log: [],
    attacks: [],         // 👈 alle aanvallen wissen
    currentAttackId: null, // 👈 geen lopende aanval meer
    goalsSinceLastSwitch: 0, // optioneel maar slim
    possessionThuisSeconden: 0, // optioneel reset balbezit
    possessionUitSeconden: 0,   // optioneel reset balbezit
  }));

  // Afgeleide arrays voor modal
  const spelersAanval = state.aanval.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));
  const spelersVerdediging = state.verdediging.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));

  // UI ----------------------------------------------------------------------
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
    
      <Button variant="secondary" onClick={exportCSV}>Export CSV</Button>
      <Button variant="danger" onClick={leegLog}>Log leegmaken</Button>
      <Button variant="danger" onClick={resetAlles}>Reset alles</Button>
    </div>
    </div>

      </header>
      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        {([
          { id: "spelers", label: "Spelers" },
          { id: "vakken", label: "Vakindeling" },
          { id: "wedstrijd", label: "Wedstrijd" },
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
        <SpelersTab spelers={state.spelers} addSpeler={addSpeler} delSpeler={delSpeler} />
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
          setAutoVakWisselNa2={(value) => setState((s) => ({ ...s, autoVakWisselNa2: value }))}   
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
        />
      )}

      {popup && (
        <ReasonModal
          vak={popup.vak}
          soort={popup.soort}
          spelersInVak={popup.vak === "aanvallend" ? spelersAanval : spelersVerdediging}
          onClose={() => setPopup(null)}
          onChoose={(reden, spelerId) => {
            logEvent(popup.vak, popup.soort, reden, spelerId);
            setPopup(null);
          }}
        />
      )}
      {possPopup && (
        <PossessionModal
          team={possPopup.team}
          spelers={veldSpelers}
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
    </div>
  );
}

// --- Spelers Tab -----------------------------------------------------------
function SpelersTab({ spelers, addSpeler, delSpeler }: {
  spelers: Player[];
  addSpeler: (naam: string, geslacht: Geslacht, foto?: string) => void;
  delSpeler: (id: string) => void;
}) {
  const [naam, setNaam] = useState("");
  const [geslacht, setGeslacht] = useState<Geslacht>("Dame");
  const [foto, setFoto] = useState("");

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="border rounded-2xl p-4">
        <h2 className="font-semibold mb-2">Nieuwe speler</h2>
        <div className="space-y-2">
          <input className="w-full border rounded-lg p-2" placeholder="Naam" value={naam} onChange={(e) => setNaam(e.target.value)} />
          <select className="w-full border rounded-lg p-2" value={geslacht} onChange={(e) => setGeslacht(e.target.value as Geslacht)}>
            {GESLACHTEN.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
          <input className="w-full border rounded-lg p-2" placeholder="Foto URL (optioneel)" value={foto} onChange={(e) => setFoto(e.target.value)} />
          <button className="px-3 py-2 border rounded-xl" onClick={() => {
            if (!naam.trim()) return alert("Vul een naam in");
            addSpeler(naam.trim(), geslacht, foto.trim() || undefined);
            setNaam(""); setFoto("");
          }}>Toevoegen</button>
        </div>
      </div>

      <div className="border rounded-2xl p-4">
        <h2 className="font-semibold mb-2">Spelerslijst</h2>
        <div className="flex flex-col gap-2">
          {spelers.length === 0 && <div className="text-gray-500">Nog geen spelers toegevoegd.</div>}
          {spelers.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 border rounded-xl p-2">
              <div className="flex items-center gap-3">
                <Avatar url={p.foto} naam={p.naam} />
                <div>
                  <div className="font-medium">{p.naam}</div>
                  <div className="text-xs text-gray-500">{p.geslacht}</div>
                </div>
              </div>
              <button className="text-red-600" onClick={() => delSpeler(p.id)}>Verwijder</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Vakindeling Tab -------------------------------------------------------
function VakindelingTab({
  spelers,
  toegewezen,
  aanval,
  verdediging,
  setVakPos,
  wisselVakken,
  autoVakWisselNa2,
  setAutoVakWisselNa2,
}: {
  spelers: Player[];
  toegewezen: Set<string>;
  aanval: (string | null)[];
  verdediging: (string | null)[];
  setVakPos: (vak: VakSide, pos: number, spelerId: string | null) => void;
  wisselVakken: () => void;
  autoVakWisselNa2: boolean;
  setAutoVakWisselNa2: (value: boolean) => void;
}) {

  const beschikbare = spelers.filter((s) => !toegewezen.has(s.id));

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <VakBox titel="Aanvallend vak" vak="aanvallend" posities={aanval} setVakPos={setVakPos} spelers={spelers} toegewezen={toegewezen} />
      <VakBox titel="Verdedigend vak" vak="verdedigend" posities={verdediging} setVakPos={setVakPos} spelers={spelers} toegewezen={toegewezen} />
      <div className="md:col-span-2 flex items-center justify-between mt-2">
        <div className="text-sm text-gray-600">Bank: {beschikbare.map((s) => s.naam).join(", ") || "—"}</div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={autoVakWisselNa2}
                onChange={(e) => setAutoVakWisselNa2(e.target.checked)}
              />
            <span>Automatisch wisselen na 2 doelpunten</span>
        </label>
      </div>
        <button className="px-3 py-2 border rounded-xl" onClick={wisselVakken}>Vakken wisselen</button>
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
  setVakPos: (vak: VakSide, pos: number, spelerId: string | null) => void;
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
                onChange={(e) => setVakPos(vak, i, e.target.value || null)}
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


// --- Wedstrijd Tab ---------------------------------------------------------
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
  openStealModal,
}: {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  spelersMap: Map<string, Player>;
  wisselVakken: () => void;
  bank: Player[];
  setVakPos: (vak: VakSide, pos: number, spelerId: string | null) => void;
  toggleKlok: (aan: boolean) => void;
  resetKlok: () => void;
  openVakActionModal: (vak: VakSide) => void;
  openStealModal: () => void;
}) {
    const handleVakClick = (vak: VakSide) => {
      // Klik je op een NIET-actief vak → maak 'm actief
      if (state.activeVak !== vak) {
        setState((s) => startAttackForVak(s, vak));
        return;
      }
      // Klik je op het AL actieve vak → popup tonen
      openVakActionModal(vak);
    };

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
  
  // hoeveel tijd is er in de huidige helft gespeeld?
  const halfStart = state.currentHalf === 1 ? 0 : halfTotal;
  const halfElapsed = Math.max(
    0,
    Math.min(halfTotal, state.tijdSeconden - halfStart)
  );
  const resterend = Math.max(halfTotal - halfElapsed, 0);
  
  const totaalPoss =
    state.possessionThuisSeconden + state.possessionUitSeconden;
  
  const possThuis =
    totaalPoss > 0
      ? Math.round((state.possessionThuisSeconden / totaalPoss) * 100)
      : 0;
  const possUit =
    totaalPoss > 0
      ? Math.round((state.possessionUitSeconden / totaalPoss) * 100)
      : 0;

      return (
        <div className="space-y-4">
          {/* Score + tijd + controls */}
          <div className="border rounded-2xl p-4">
            {/* Kolomlayout: tijd/duur boven, dan balbezit, dan score */}
            <div className="flex flex-col gap-4">
              {/* Tijd + duur + start/pauze */}
              <div className="flex flex-wrap items-start gap-3 justify-between">
                {/* Tijd */}
                <div>
                  <div className="text-2xl font-bold">{formatTime(resterend)}</div>
                  <div className="text-xs text-gray-500">
                    Verstreken: {formatTime(state.tijdSeconden)} – {state.currentHalf}e helft
                  </div>
                </div>
      
                {/* Knoppen + duur */}
                <div className="flex gap-2 items-center">
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
      
                  {/* Reset */}
                  <Button variant="secondary" onClick={resetKlok}>
                    Reset
                  </Button>
      
                  {/* 2e helft */}
                  <Button
                    size="md"
                    variant="secondary"
                    disabled={state.currentHalf === 2} // maar 2 helften
                    onClick={() =>
                      setState((s) => ({
                        ...s,
                        currentHalf: 2,
                        klokLoopt: true,
                        aanvalLinks: !s.aanvalLinks,
                      }))
                    }
                  >
                    2e helft
                  </Button>
          
                  <div className="flex gap-2 items-center">
                    {/* Start / Pauze / Reset / 2e helft enz... */}

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setState((s) => ({ ...s, aanvalLinks: !s.aanvalLinks }))
                      }
                    >
                      Aanval links/rechts
                    </Button>
                  </div>
      
                  {/* Duur instellen */}
                  <div className="flex items-center gap-2 ml-2">
                    <div className="text-lg">Duur</div>
                    <Button
                      size="md"
                      disabled={state.klokLoopt}
                      onClick={() =>
                        setState((s) => {
                          const hm = Number.isFinite(s.halfMinuten)
                            ? s.halfMinuten
                            : DEFAULT_STATE.halfMinuten;
                          return { ...s, halfMinuten: Math.max(1, hm - 1) };
                        })
                      }
                    >
                      −
                    </Button>
                    <div className="w-10 text-center">
                      {Number.isFinite(state.halfMinuten)
                        ? state.halfMinuten
                        : DEFAULT_STATE.halfMinuten}
                    </div>
                    <Button
                      size="md"
                      disabled={state.klokLoopt}
                      onClick={() =>
                        setState((s) => {
                          const hm = Number.isFinite(s.halfMinuten)
                            ? s.halfMinuten
                            : DEFAULT_STATE.halfMinuten;
                          return { ...s, halfMinuten: Math.min(60, hm + 1) };
                        })
                      }
                    >
                      +
                    </Button>
                    <div className="text-lg">Minuten</div>
                  </div>
                </div>
              </div>
      
              {/* ⬇️ hierna komen je balbezit-knoppen en de score-blokken */}

          {/* 🔵 Grote balbezit- en schot/rebound-knoppen */}
          <div className="w-full">
            <div className="text-xs text-gray-500 mb-1">
              Balbezit & schotregistratie
            </div>
      
      {/* 🟢 Vakken als 2 veldhelften */}
      <div className="relative mt-4">
        {/* BOVEN: twee veld-afbeeldingen, altijd horizontaal */}
        <div className="flex mb-4" style={{ gap: 0 }}>
          {state.aanvalLinks ? (
            <>
              <FieldImageCard
                vak="aanvallend"
                title="Aanvallend vak"
                imgSrc="/VeldLinks.png"        // <-- jouw afbeelding
                active={state.activeVak === "aanvallend"}
                onClick={() => handleVakClick("aanvallend")}
              />
              <FieldImageCard
                vak="verdedigend"
                title="Verdedigend vak"
                imgSrc="/VeldRechts.png"   // <-- jouw afbeelding
                active={state.activeVak === "verdedigend"}
                onClick={() => handleVakClick("verdedigend")}
              />
            </>
          ) : (
            <>
              {/* Als aanval rechts is, wissel de volgorde */}
              <FieldImageCard
                vak="verdedigend"
                title="Verdedigend vak"
                imgSrc="/VeldLinks.png"
                active={state.activeVak === "verdedigend"}
                onClick={() => handleVakClick("verdedigend")}
              />
              <FieldImageCard
                vak="aanvallend"
                title="Aanvallend vak"
                imgSrc="/VeldRechts.png"
                active={state.activeVak === "aanvallend"}
                onClick={() => handleVakClick("aanvallend")}
              />
            </>
          )}
        </div>

        {/* ONDER: de vakken met namen & wisselknoppen (oud gedrag) */}
        <div className="grid md:grid-cols-2 gap-4">
          {state.aanvalLinks ? (
            <>
              {/* LINKS: Aanvallend vak */}
              <div
                className={`rounded-2xl p-4 border ${
                  aanvValid ? "border-gray-200" : "border-red-500"
                } ${
                  state.activeVak === "aanvallend" ? "bg-white" : "bg-gray-100"
                } cursor-pointer`}
                onClick={() => handleVakClick("aanvallend")}
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
                  state.activeVak === "verdedigend" ? "bg-white" : "bg-gray-100"
                } cursor-pointer`}
                onClick={() => handleVakClick("verdedigend")}
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

                {/* STEAL-knop */}
                <div className="mt-4">
                  <Button
                    variant="primary"
                    className="w-full py-3"
                    onClick={(e) => {
                      e.stopPropagation();
                      openStealModal();
                    }}
                  >
                    STEAL
                  </Button>
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
                  state.activeVak === "verdedigend" ? "bg-white" : "bg-gray-100"
                } cursor-pointer`}
                onClick={() => handleVakClick("verdedigend")}
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

                <div className="mt-4">
                  <Button
                    variant="primary"
                    className="w-full py-3"
                    onClick={(e) => {
                      e.stopPropagation();
                      openStealModal();
                    }}
                  >
                    STEAL
                  </Button>
                </div>
              </div>

              {/* RECHTS: Aanvallend vak */}
              <div
                className={`rounded-2xl p-4 border ${
                  aanvValid ? "border-gray-200" : "border-red-500"
                } ${
                  state.activeVak === "aanvallend" ? "bg-white" : "bg-gray-100"
                } cursor-pointer`}
                onClick={() => handleVakClick("aanvallend")}
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
          {/* Scoresectie (gekleurde kaarten) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* THUIS */}
            <div className="rounded-2xl border bg-blue-50 p-4">
              <div className="flex items-center gap-3 justify-between">
                <div className="text-lg font-semibold text-blue-800">
                  Thuis
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
              </div>
              {/* Balbezit onder de stand */}
              <div className="mt-1 text-xs text-blue-800">
                Balbezit: {possThuis}%
              </div>
            </div>

            {/* UIT */}
            <div className="rounded-2xl border bg-amber-50 p-4">
              <div className="flex items-center gap-3 justify-between">
                <div className="text-lg font-semibold text-amber-800">
                  Uit
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
              </div>
              {/* Balbezit onder de stand */}
              <div className="mt-1 text-xs text-amber-800">
                Balbezit: {possUit}%
              </div>
            </div>
          </div>
        </div>
      </div>

      

      {/* Wissel + log */}
      
      <details className="ml-2 w-full md:w-full mt-2">
        <summary className="px-3 py-2 border rounded-xl cursor-pointer text-xs">
          Overzicht aanvallen
        </summary>

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

                // Alle events binnen deze aanval
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
                      {a.team === "thuis" ? "Thuis" : "Uit"}
                    </td>
                    <td className="p-1">
                      {a.vak === "aanvallend" ? "Aanvallend" : "Verdedigend"}
                    </td>
                    <td className="p-1">{formatTime(a.startSeconden)}</td>
                    <td className="p-1">
                      {a.endSeconden != null
                        ? formatTime(a.endSeconden)
                        : "—"}
                    </td>
                    <td className="p-1">
                      {duurSeconden != null ? formatTime(duurSeconden) : "—"}
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
  setVakPos: (vak: VakSide, pos: number, spelerId: string | null) => void;
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



// --- Modal ---------------------------------------------------------------
function VakActionModal({
  vak,
  spelers,
  onClose,
  onComplete,
}: {
  vak: VakSide;
  spelers: Player[];
  onClose: () => void;
  onComplete: (
    actie: "Schot" | "Doorloop" | "Vrijebal" | "Strafworp",
    uitkomst: "Raak" | "Mis" | "Korf",
    spelerId?: string
  ) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [actie, setActie] = useState<
    "Schot" | "Doorloop" | "Vrijebal" | "Strafworp" | null
  >(null);
  const [speler, setSpeler] = useState<string | undefined>(undefined);
  const [uitkomst, setUitkomst] = useState<
  "Raak" | "Mis" | "Korf" | null
  >(null);

  const titelVak = vak === "aanvallend" ? "Aanvallend vak" : "Verdedigend vak";

  const handleFinish = (u: "Raak" | "Mis" | "Korf") => {
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

            <div className="grid grid-cols-2 grid-rows-2 gap-4 w-full h-[70vh]">
              {["Schot", "Doorloop", "Vrijebal", "Strafworp"].map((a) => (
                <button
                  key={a}
                  className={`
                    w-full h-full
                    text-3xl md:text-5xl
                    font-extrabold
                    rounded-2xl
                    border-2
                    active:scale-95
                    transition
                    ${
                      actie === a
                        ? "bg-black text-white border-black"
                        : "bg-gray-100 hover:bg-gray-200 border-gray-300"
                    }
                  `}
                  onClick={() => {
                    setActie(a as any);
                    setStep(2);
                  }}
                >
                  {a}
                </button>
              ))}
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
                  setStep(3); // direct door naar uitkomst
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
                    setStep(3); // ook direct door
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

              {/* lege cel zodat de grid 2×2 blijft */}
              <div></div>
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

function ReasonModal({
  vak,
  soort,
  spelersInVak,
  onClose,
  onChoose,
}: {
  vak: VakSide;
  soort: "Gemis" | "Kans";
  spelersInVak: Player[];
  onClose: () => void;
  onChoose: (reden: LogReden, spelerId?: string) => void;
}) {
  const [speler, setSpeler] = useState<string | undefined>(undefined);

  const opties: LogReden[] =
    vak === "aanvallend" && soort === "Kans"
      ? ["Bal onderschept", "Bal uit", "overtreding", "Gescoord"]
      : ["Bal onderschept", "Bal uit", "overtreding", "Doorgelaten"];

  const titelKleur =
    vak === "aanvallend" ? "text-blue-700" : "text-amber-700";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl p-6 space-y-6">
        {/* Titel */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className={`text-2xl font-bold ${titelKleur}`}>
              {soort} – {vak === "aanvallend" ? "Aanvallend vak" : "Verdedigend vak"}
            </div>
            <div className="text-sm text-gray-500 mt-1">
              Kies eventueel een speler en daarna een reden.
            </div>
          </div>
          <button
            className="text-sm text-gray-500 hover:text-gray-800"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Spelersselectie */}
        <div className="space-y-2">
          <div className="text-sm font-semibold">Speler (optioneel)</div>
          <div className="flex flex-wrap gap-2 max-h-40 overflow-auto">
            <button
              className={`px-3 py-2 rounded-full border text-sm font-medium ${
                !speler
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-800 hover:bg-gray-50"
              }`}
              onClick={() => setSpeler(undefined)}
            >
              Team-event
            </button>
            {spelersInVak.map((p) => (
              <button
                key={p.id}
                className={`px-3 py-2 rounded-full border text-sm font-medium flex items-center gap-2 ${
                  speler === p.id
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-800 hover:bg-gray-50"
                }`}
                onClick={() => setSpeler(p.id)}
              >
                {p.foto ? (
                  <img
                    src={p.foto}
                    alt={p.naam}
                    className="w-6 h-6 rounded-full object-cover"
                  />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px]">
                    {p.naam.slice(0, 2)}
                  </span>
                )}
                <span className="truncate max-w-[160px]">{p.naam}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Reden-knoppen */}
        <div className="space-y-2">
          <div className="text-sm font-semibold">Reden</div>
          <div className="grid grid-cols-2 gap-3">
            {opties.map((o) => (
              <button
                key={o}
                className="w-full py-4 px-3 text-base font-semibold rounded-xl border bg-gray-50 hover:bg-gray-100 active:scale-[0.98] transition"
                onClick={() => onChoose(o, speler)}
              >
                {o}
              </button>
            ))}
          </div>
        </div>

        {/* Onderste balk */}
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

function PossessionModal({
  team,
  spelers,
  onClose,
  onSave,
}: {
  team: "thuis" | "uit";
  spelers: Player[];
  onClose: () => void;
  onSave: (reden: LogReden, spelerId?: string) => void;
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
          Nieuw balbezit – {team === "thuis" ? "Thuis" : "Uit"}
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
  const [speler, setSpeler] = useState<string | undefined>(undefined);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-xl">
        <div className="text-2xl font-semibold mb-4">
          Steal – verdedigend vak
        </div>

        <div className="space-y-2 mb-4">
          <div className="text-sm">Wie vangt het schot af?</div>
          <div className="flex flex-wrap gap-2 max-h-48 overflow-auto">
            {/* Team-event */}
            <button
              className={`px-4 py-2 border rounded-full text-base font-semibold ${
                !speler ? "bg-black text-white" : ""
              }`}
              onClick={() => setSpeler(undefined)}
            >
              Team-event
            </button>

            {/* Spelers uit het verdedigende vak */}
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

        <div className="flex justify-end gap-2">
          <button
            className="text-sm text-gray-600"
            onClick={onClose}
          >
            Annuleren
          </button>
          <Button
            variant="primary"
            onClick={() => onSave(speler)}
          >
            Log steal
          </Button>
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
  vak: VakSide;
  title: string;
  imgSrc: string;
  active: boolean;
  onClick: () => void;
};

function FieldImageCard({
  //vak,
  title,
  imgSrc,
  active,
  onClick,
}: FieldImageCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        p-0 m-0
        border-none
        focus:outline-none
        focus:ring-0
        outline-none
        flex-1
      "
      style={{ border: "none", background: "transparent" }}
    >
      <img
        src={imgSrc}
        alt={title}
        className={`
          w-full
          h-full
          object-cover
          transition-opacity
          duration-200
          select-none
          pointer-events-none
          ${active ? "opacity-100" : "opacity-40"}
        `}
        draggable={false}
      />
    </button>
  );
}

// --- UI bits ---------------------------------------------------------------
function Avatar({ url, naam }: { url?: string; naam: string }) {
  if (url) return <img src={url} alt={naam} className="w-10 h-10 rounded-full object-cover" />;
  const init = naam.split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-sm font-semibold">{init}</div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";

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
  | "Wissel uit";

type LogEvent = {
  id: string;
  tijdSeconden: number; // verstreken tijd
  vak: VakSide;
  soort: "Gemis" | "Kans" | "Wissel";
  reden: LogReden;
  spelerId?: string;
  resterendSeconden?: number;
  wedstrijdMinuut?: number; // ceil(verstreken_s / 60), min 1
  pos?: number; // 1..4
};

type AppState = {
  spelers: Player[];
  aanval: (string | null)[]; // 4 posities: id of null
  verdediging: (string | null)[];
  scoreThuis: number;
  scoreUit: number;
  tijdSeconden: number; // verstreken seconden in huidige helft
  klokLoopt: boolean;
  halfMinuten: number; // duur helft in minuten
  log: LogEvent[];
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
};

const STORAGE_KEY = "korfbal_coach_state_v1";

function formatTime(secs: number) {
  const clamped = Math.max(0, Math.floor(secs));
  const m = Math.floor(clamped / 60).toString().padStart(2, "0");
  const s = Math.floor(clamped % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// -- Hydration/migratie helper: maak opgeslagen state veilig en compleet
function sanitizeState(raw: any): AppState {
  const s: Partial<AppState> = typeof raw === "object" && raw ? raw : {};
  const toArr4 = (a: any): (string | null)[] =>
    Array.isArray(a)
      ? [a[0] ?? null, a[1] ?? null, a[2] ?? null, a[3] ?? null]
      : [null, null, null, null];
  const num = (v: any, d: number) => (Number.isFinite(v) ? Number(v) : d);
  const bool = (v: any, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    spelers: Array.isArray(s.spelers) ? (s.spelers as Player[]) : [],
    aanval: toArr4((s as any).aanval),
    verdediging: toArr4((s as any).verdediging),
    scoreThuis: num((s as any).scoreThuis, DEFAULT_STATE.scoreThuis),
    scoreUit: num((s as any).scoreUit, DEFAULT_STATE.scoreUit),
    tijdSeconden: num((s as any).tijdSeconden, DEFAULT_STATE.tijdSeconden),
    klokLoopt: bool((s as any).klokLoopt, DEFAULT_STATE.klokLoopt),
    halfMinuten: num((s as any).halfMinuten, DEFAULT_STATE.halfMinuten),
    log: Array.isArray((s as any).log) ? ((s as any).log as LogEvent[]) : [],
  };
}

// --- Main component --------------------------------------------------------
export default function App() {
  const [state, setState] = useState<AppState>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return sanitizeState(JSON.parse(raw));
    } catch {}
    return { ...DEFAULT_STATE };
  });

  const [tab, setTab] = useState<"spelers" | "vakken" | "wedstrijd">("spelers");
  const [popup, setPopup] = useState<null | { vak: VakSide; soort: "Gemis" | "Kans" }>(null);

  // Persist
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }, [state]);

  // Timer (intern: op-tellen; UI toont resterend)
  const intervalRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.klokLoopt && intervalRef.current === null) {
      intervalRef.current = window.setInterval(() => {
        setState((s) => {
          const total = (Number.isFinite(s.halfMinuten) ? s.halfMinuten : DEFAULT_STATE.halfMinuten) * 60;
          const next = s.tijdSeconden + 1;
          if (next >= total) {
            return { ...s, tijdSeconden: total, klokLoopt: false };
          }
          return { ...s, tijdSeconden: next };
        });
      }, 1000) as unknown as number;
    }
    if (!state.klokLoopt && intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, [state.klokLoopt, state.halfMinuten]);

  const spelersMap = useMemo(() => {
    const m = new Map<string, Player>();
    state.spelers.forEach((p) => m.set(p.id, p));
    return m;
  }, [state.spelers]);

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
      const resterend = Math.max(((Number.isFinite(s.halfMinuten) ? s.halfMinuten : DEFAULT_STATE.halfMinuten) * 60) - s.tijdSeconden, 0);
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

      const next = vak === "aanvallend" ? { ...s, aanval: arr } : { ...s, verdediging: arr };
      return logs.length ? { ...next, log: [...logs, ...s.log] } : next;
    });
  };

  const wisselVakken = () => setState((s) => ({ ...s, aanval: s.verdediging, verdediging: s.aanval }));

  const toggleKlok = (aan: boolean) => setState((s) => ({ ...s, klokLoopt: aan }));
  const resetKlok = () => setState((s) => ({ ...s, tijdSeconden: 0, klokLoopt: false }));

  const logEvent = (vak: VakSide, soort: "Gemis" | "Kans" | "Wissel", reden: LogReden, spelerId?: string) => {
    const resterend = Math.max(((Number.isFinite(state.halfMinuten) ? state.halfMinuten : DEFAULT_STATE.halfMinuten) * 60) - state.tijdSeconden, 0);
    const minuut = Math.max(1, Math.ceil(state.tijdSeconden / 60));
    const e: LogEvent = {
      id: uid("ev"),
      tijdSeconden: state.tijdSeconden,
      vak,
      soort,
      reden,
      spelerId,
      resterendSeconden: resterend,
      wedstrijdMinuut: minuut,
    };

    setState((s) => {
      const next: AppState = { ...s, log: [e, ...s.log] };
      if (soort === "Kans" && vak === "aanvallend" && reden === "Gescoord") next.scoreThuis = s.scoreThuis + 1;
      if (soort === "Gemis" && vak === "verdedigend" && reden === "Doorgelaten") next.scoreUit = s.scoreUit + 1;
      return next;
    });
  };

  const exportCSV = () => {
    const rows = [
      [
        "id",
        "tijd_verstreken",
        "klok_resterend",
        "wedstrijd_minuut",
        "vak",
        "soort",
        "reden",
        "positie",
        "spelerId",
        "spelerNaam",
      ],
      ...state.log
        .slice()
        .reverse()
        .map((e) => [
          e.id,
          formatTime(e.tijdSeconden),
          formatTime(e.resterendSeconden ?? Math.max(((Number.isFinite(state.halfMinuten) ? state.halfMinuten : DEFAULT_STATE.halfMinuten) * 60) - e.tijdSeconden, 0)),
          e.wedstrijdMinuut ?? Math.max(1, Math.ceil(e.tijdSeconden / 60)),
          e.vak,
          e.soort,
          e.reden,
          e.pos ?? "",
          e.spelerId || "",
          e.spelerId ? spelersMap.get(e.spelerId)?.naam || "" : "",
        ]),
    ];
    const escapeCSV = (v: any) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = rows.map((r) => r.map(escapeCSV).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `korfbal-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetAlles = () => {
    if (!confirm("Weet je zeker dat je alles wilt wissen?")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setState({ ...DEFAULT_STATE });
  };
  const leegLog = () => setState((s) => ({ ...s, log: [] }));

  // Afgeleide arrays voor modal
  const spelersAanval = state.aanval.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));
  const spelersVerdediging = state.verdediging.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));

  // UI ----------------------------------------------------------------------
  return (
    <div className="p-3 md:p-6 max-w-5xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <h1 className="text-2xl font-bold">Korfbal Coach</h1>
        <div className="flex flex-wrap gap-2">
          <button className="px-3 py-2 border rounded-xl" onClick={exportCSV}>Export CSV</button>
          <button className="px-3 py-2 border rounded-xl" onClick={leegLog}>Log leegmaken</button>
          <button className="px-3 py-2 border rounded-xl" onClick={resetAlles}>Reset alles</button>
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
            className={`px-3 py-2 rounded-xl border ${tab === t.id ? "bg-gray-100" : ""}`}
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
        />
      )}

      {tab === "wedstrijd" && (
        <WedstrijdTab
          state={state}
          setState={setState}
          spelersMap={spelersMap}
          setPopup={setPopup}
          wisselVakken={wisselVakken}
          bank={bank}
          setVakPos={setVakPos}
          toggleKlok={toggleKlok}
          resetKlok={resetKlok}
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
function VakindelingTab({ spelers, toegewezen, aanval, verdediging, setVakPos, wisselVakken }: {
  spelers: Player[];
  toegewezen: Set<string>;
  aanval: (string | null)[];
  verdediging: (string | null)[];
  setVakPos: (vak: VakSide, pos: number, spelerId: string | null) => void;
  wisselVakken: () => void;
}) {
  const beschikbare = spelers.filter((s) => !toegewezen.has(s.id));
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <VakBox titel="Aanvallend vak" vak="aanvallend" posities={aanval} setVakPos={setVakPos} spelers={spelers} />
      <VakBox titel="Verdedigend vak" vak="verdedigend" posities={verdediging} setVakPos={setVakPos} spelers={spelers} />
      <div className="md:col-span-2 flex items-center justify-between mt-2">
        <div className="text-sm text-gray-600">Bank: {beschikbare.map((s) => s.naam).join(", ") || "—"}</div>
        <button className="px-3 py-2 border rounded-xl" onClick={wisselVakken}>Vakken wisselen</button>
      </div>
    </div>
  );
}

function VakBox({ titel, vak, posities, setVakPos, spelers }: {
  titel: string;
  vak: VakSide;
  posities: (string | null)[];
  setVakPos: (vak: VakSide, pos: number, spelerId: string | null) => void;
  spelers: Player[];
}) {
  return (
    <div className="border rounded-2xl p-4">
      <div className="font-semibold mb-3">{titel}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {posities.map((spelerId, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-8 text-sm text-gray-500">{i + 1}.</div>
            <select className="w-full border rounded-lg p-2" value={spelerId || ""} onChange={(e) => setVakPos(vak, i, e.target.value || null)}>
              <option value="">— Kies speler —</option>
              {spelers.map((s) => (
                <option key={s.id} value={s.id}>{s.naam} ({s.geslacht})</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Wedstrijd Tab ---------------------------------------------------------
function WedstrijdTab({ state, setState, spelersMap, setPopup, wisselVakken, bank, setVakPos, toggleKlok, resetKlok }: {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  spelersMap: Map<string, Player>;
  setPopup: (p: { vak: VakSide; soort: "Gemis" | "Kans" } | null) => void;
  wisselVakken: () => void;
  bank: Player[];
  setVakPos: (vak: VakSide, pos: number, spelerId: string | null) => void;
  toggleKlok: (aan: boolean) => void;
  resetKlok: () => void;
}) {
  const circle = (id: string | null, vak: VakSide, i: number) => {
    const p = id ? spelersMap.get(id) : undefined;
    return (
      <div key={`${vak}-${i}`} className="flex items-center gap-2">
        <div className="w-12 h-12 rounded-full border overflow-hidden flex items-center justify-center bg-gray-50">
          {p?.foto ? (
            <img src={p.foto} alt={p.naam} className="w-full h-full object-cover" />
          ) : (
            <span className="text-sm p-2 text-center">{p?.naam?.slice(0, 2) || "?"}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{p?.naam || "Leeg"}</div>
          <div className="text-xs text-gray-500">Positie {i + 1}</div>
        </div>
        {/* Wisselknop */}
        <div className="relative">
          <details className="cursor-pointer">
            <summary className="list-none px-2 py-1 border rounded-lg text-sm">⇄ Wissel</summary>
            <div className="absolute right-0 mt-1 z-10 bg-white border rounded-xl p-2 w-56 max-h-64 overflow-auto shadow">
              <button className="w-full text-left text-sm p-1 hover:bg-gray-50 rounded" onClick={() => setVakPos(vak, i, null)}>Leeg maken</button>
              {bank.map((b) => (
                <button key={b.id} className="w-full text-left text-sm p-1 hover:bg-gray-50 rounded" onClick={() => setVakPos(vak, i, b.id)}>
                  {b.naam}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
    );
  };

  const resterend = Math.max(((Number.isFinite(state.halfMinuten) ? state.halfMinuten : DEFAULT_STATE.halfMinuten) * 60) - state.tijdSeconden, 0);

  return (
    <div className="space-y-4">
      {/* Score + tijd + controls */}
      <div className="border rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div>
            <div className="text-2xl font-bold">{formatTime(resterend)}</div>
            <div className="text-xs text-gray-500">Verstreken: {formatTime(state.tijdSeconden)}</div>
          </div>
          <div className="flex gap-2 items-center">
            {!state.klokLoopt ? (
              <button className="px-3 py-2 border rounded-xl" onClick={() => toggleKlok(true)}>Start</button>
            ) : (
              <button className="px-3 py-2 border rounded-xl" onClick={() => toggleKlok(false)}>Pauze</button>
            )}
            <button className="px-3 py-2 border rounded-xl" onClick={resetKlok}>Reset</button>
            <div className="flex items-center gap-1 ml-2">
              <span className="text-sm text-gray-600">Duur:</span>
              <button className="px-2 py-1 border rounded" disabled={state.klokLoopt} onClick={() => setState(s => { const hm = Number.isFinite(s.halfMinuten) ? s.halfMinuten : DEFAULT_STATE.halfMinuten; return {...s, halfMinuten: Math.max(1, hm - 1)}; })}>−</button>
              <div className="w-10 text-center">{Number.isFinite(state.halfMinuten) ? state.halfMinuten : DEFAULT_STATE.halfMinuten}</div>
              <button className="px-2 py-1 border rounded" disabled={state.klokLoopt} onClick={() => setState(s => { const hm = Number.isFinite(s.halfMinuten) ? s.halfMinuten : DEFAULT_STATE.halfMinuten; return {...s, halfMinuten: Math.min(60, hm + 1)}; })}>+</button>
              <span className="text-sm text-gray-600">min</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-lg">Thuis</div>
            <button className="px-2 py-1 border rounded-lg" onClick={() => setState((s) => ({ ...s, scoreThuis: Math.max(0, s.scoreThuis - 1) }))}>-</button>
            <div className="text-2xl font-bold w-10 text-center">{state.scoreThuis}</div>
            <button className="px-2 py-1 border rounded-lg" onClick={() => setState((s) => ({ ...s, scoreThuis: s.scoreThuis + 1 }))}>+</button>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-lg">Uit</div>
            <button className="px-2 py-1 border rounded-lg" onClick={() => setState((s) => ({ ...s, scoreUit: Math.max(0, s.scoreUit - 1) }))}>-</button>
            <div className="text-2xl font-bold w-10 text-center">{state.scoreUit}</div>
            <button className="px-2 py-1 border rounded-lg" onClick={() => setState((s) => ({ ...s, scoreUit: s.scoreUit + 1 }))}>+</button>
          </div>
        </div>
      </div>

      {/* Vakken */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="border rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold">Aanvallend vak</div>
            <div className="flex gap-2">
              <button className="px-3 py-1 border rounded-lg" onClick={() => setPopup({ vak: "aanvallend", soort: "Gemis" })}>Gemis</button>
              <button className="px-3 py-1 border rounded-lg" onClick={() => setPopup({ vak: "aanvallend", soort: "Kans" })}>Kans</button>
            </div>
          </div>
          <div className="space-y-3">
            {state.aanval.map((id, i) => circle(id, "aanvallend", i))}
          </div>
        </div>

        <div className="border rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold">Verdedigend vak</div>
            <div className="flex gap-2">
              <button className="px-3 py-1 border rounded-lg" onClick={() => setPopup({ vak: "verdedigend", soort: "Gemis" })}>Gemis</button>
              <button className="px-3 py-1 border rounded-lg" onClick={() => setPopup({ vak: "verdedigend", soort: "Kans" })}>Kans</button>
            </div>
          </div>
          <div className="space-y-3">
            {state.verdediging.map((id, i) => circle(id, "verdedigend", i))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button className="px-3 py-2 border rounded-xl" onClick={wisselVakken}>Vakken wisselen (↕)</button>
        <details>
          <summary className="px-3 py-2 border rounded-xl cursor-pointer">Log bekijken</summary>
          <div className="mt-2 max-h-64 overflow-auto border rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-left p-2">Tijd (verstreken)</th>
                  <th className="text-left p-2">Klok (resterend)</th>
                  <th className="text-left p-2">Wedstrijdminuut</th>
                  <th className="text-left p-2">Vak</th>
                  <th className="text-left p-2">Soort</th>
                  <th className="text-left p-2">Reden</th>
                  <th className="text-left p-2">Positie</th>
                  <th className="text-left p-2">Speler</th>
                </tr>
              </thead>
              <tbody>
                {state.log.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="p-2">{formatTime(e.tijdSeconden)}</td>
                    <td className="p-2">{formatTime(e.resterendSeconden ?? Math.max(((Number.isFinite(state.halfMinuten) ? state.halfMinuten : DEFAULT_STATE.halfMinuten) * 60) - e.tijdSeconden, 0))}</td>
                    <td className="p-2">{e.wedstrijdMinuut ?? Math.max(1, Math.ceil(e.tijdSeconden / 60))}</td>
                    <td className="p-2">{e.vak}</td>
                    <td className="p-2">{e.soort}</td>
                    <td className="p-2">{e.reden}</td>
                    <td className="p-2">{e.pos ?? "—"}</td>
                    <td className="p-2">{e.spelerId ? spelersMap.get(e.spelerId)?.naam : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}

// --- Modal ---------------------------------------------------------------
function ReasonModal({ vak, soort, spelersInVak, onClose, onChoose }: {
  vak: VakSide;
  soort: "Gemis" | "Kans";
  spelersInVak: Player[];
  onClose: () => void;
  onChoose: (reden: LogReden, spelerId?: string) => void;
}) {
  const [speler, setSpeler] = useState<string | undefined>(undefined);
  const opties: LogReden[] = vak === "aanvallend" && soort === "Kans"
    ? ["Bal onderschept", "Bal uit", "overtreding", "Gescoord"]
    : ["Bal onderschept", "Bal uit", "overtreding", "Doorgelaten"];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl p-4 w-full max-w-md shadow-xl">
        <div className="text-lg font-semibold mb-3">{soort} – {vak}</div>

        <div className="space-y-2 mb-3">
          <div className="text-sm">Kies speler (optioneel)</div>
          <div className="flex flex-wrap gap-2">
            <button className={`px-3 py-1 border rounded-full text-sm ${!speler ? "bg-black text-white" : ""}`} onClick={() => setSpeler(undefined)}>Team‑event</button>
            {spelersInVak.map((p) => (
              <button key={p.id} className={`px-3 py-1 border rounded-full text-sm flex items-center gap-2 ${speler === p.id ? "bg-black text-white" : ""}`} onClick={() => setSpeler(p.id)}>
                {p.foto ? (
                  <img src={p.foto} alt={p.naam} className="w-5 h-5 rounded-full object-cover" />
                ) : (
                  <span className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-[10px]">{p.naam.slice(0,2)}</span>
                )}
                {p.naam}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {opties.map((o) => (
            <button key={o} className="border rounded-xl p-3 hover:shadow" onClick={() => onChoose(o, speler)}>
              {o}
            </button>
          ))}
        </div>

        <div className="flex justify-end mt-3">
          <button className="text-sm text-gray-600" onClick={onClose}>Sluiten</button>
        </div>
      </div>
    </div>
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

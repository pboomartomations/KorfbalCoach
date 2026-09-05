import React, { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabaseClient";

const KORBIQ_PRODUCTION_ORIGIN = "https://korfbal-coach.vercel.app";
const KORBIQ_APP_ORIGIN = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? window.location.origin
  : KORBIQ_PRODUCTION_ORIGIN;

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

type VakPeriod = {
  id: string;
  vakId: VakId;
  startSeconden: number;
  endSeconden?: number;
  spelerIds: string[];
  combinatieKey: string;
};

type AttackMeta = {
  id: string;              // interne id
  index: number;           // 1,2,3,... (aanvalnummer)
  team: AttackTeam;        // thuis of uit
  vak: VakSide;            // aanvallend / verdedigend
  vakId?: VakId;           // vast teamvak: Vak 1 of Vak 2
  startSeconden: number;   // starttijd vd aanval (wedstrijdseconden)
  endSeconden?: number;    // optional: eindtijd
  spelerIds?: string[];    // Korbis-spelers die op dit moment samen in dit vaste vak staan
  combinatieKey?: string;  // volgorde-onafhankelijke identiteit van het viertal
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
  spelerIds?: string[];
  combinatieKey?: string;
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
  vakperiodes?: any[];
};

type DatabaseSheets = DatabaseSheetsData | null;

const emptyHistoryDatabase = (): DatabaseSheetsData => ({
  events: [], attacks: [], wissels: [], matches: [], vakperiodes: [],
});

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
  vakPeriods: VakPeriod[];
  fieldEvents: FieldEvent[];  
  markerGroup: number;
  opponentName: string;
  homeAway: "" | "thuis" | "uit";
  season: string;
  seasonOptions: string[];
  matchType: MatchType;
  matchEnded: boolean;
  // Fase 26.2: snapshot van het team/seizoen waarvoor de huidige wedstrijd wordt gespeeld.
  matchTeamSeasonId: string;
  matchTeamId: string;
  matchTeamName: string;
  matchSeasonId: string;
  matchSeasonName: string;
  // Fase 28: stabiele opslagidentiteit, zodat opnieuw opslaan dezelfde
  // wedstrijd vervangt, ook na herladen of op een volgende kalenderdag.
  matchDate?: string;
  matchLegacyId?: string;
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
  vakPeriods: [],
  fieldEvents: [], 
  markerGroup: 0,
  opponentName: "",   
  homeAway: "",
  season: "Veld najaar 2026",
  seasonOptions: ["Veld najaar 2026", "Zaal 2026/2027", "Veld voorjaar 2027"],
  matchType: "Competitie",
  matchEnded: false,
  matchTeamSeasonId: "",
  matchTeamId: "",
  matchTeamName: "",
  matchSeasonId: "",
  matchSeasonName: "",
  matchDate: "",
  matchLegacyId: "",
};

const STORAGE_KEY = "korfbal_coach_state_v1";

function combinationKey(ids: (string | null | undefined)[]) {
  return ids.filter((id): id is string => Boolean(id)).slice().sort().join("|");
}

function playerIdsForVak(state: AppState, vakId: VakId): string[] {
  const arr = vakId === 1
    ? (state.vak1Aanvallend ? state.aanval : state.verdediging)
    : (state.vak1Aanvallend ? state.verdediging : state.aanval);
  return arr.filter((id): id is string => Boolean(id));
}

function ensureInitialVakPeriods(state: AppState): AppState {
  if (state.vakPeriods.length > 0) return state;
  const periods: VakPeriod[] = ([1, 2] as VakId[]).map((vakId) => {
    const spelerIds = playerIdsForVak(state, vakId);
    return { id: uid("vp"), vakId, startSeconden: state.tijdSeconden, spelerIds, combinatieKey: combinationKey(spelerIds) };
  });
  return { ...state, vakPeriods: periods };
}

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

  const spelerIds = playerIdsForVak(prev, vakId);
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
    spelerIds,
    combinatieKey: combinationKey(spelerIds),
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

// Fase 29: vertaal de genormaliseerde PostgreSQL-tabellen terug naar het
// bestaande analyseformaat. Hierdoor blijven alle huidige dashboards en
// grafieken dezelfde velden gebruiken terwijl Supabase de primaire bron is.
function supabaseHistoryToDatabase(bundle: any): DatabaseSheetsData {
  const sourceMatches = Array.isArray(bundle?.matches) ? bundle.matches : [];
  const sourceEvents = Array.isArray(bundle?.events) ? bundle.events : [];
  const sourceAttacks = Array.isArray(bundle?.attacks) ? bundle.attacks : [];
  const sourceSubstitutions = Array.isArray(bundle?.substitutions) ? bundle.substitutions : [];
  const sourceVakPeriods = Array.isArray(bundle?.vak_periods) ? bundle.vak_periods : [];
  const matchById = new Map<string, any>(
    sourceMatches.map((match: any) => [String(match.id), match] as [string, any])
  );

  const matchContext = (databaseMatchId: unknown) => {
    const match: any = matchById.get(String(databaseMatchId)) ?? {};
    const legacyMatchId = String(match.legacy_match_id ?? "");
    const teamName = String(match.team_name_snapshot ?? "Korbis");
    const playerNames = new Map<string, string>();
    const snapshotPlayers = Array.isArray(match.payload?.state?.spelers)
      ? match.payload.state.spelers
      : [];
    snapshotPlayers.forEach((player: any) => {
      if (player?.id) playerNames.set(String(player.id), String(player.naam ?? player.id));
    });
    const playtimePlayers = Array.isArray(match.player_playtime) ? match.player_playtime : [];
    playtimePlayers.forEach((player: any) => {
      const id = player?.player_id ?? player?.spelerId;
      const name = player?.player_name ?? player?.spelerNaam;
      if (id && name) playerNames.set(String(id), String(name));
    });
    return {
      match,
      legacyMatchId,
      teamName,
      playerNames,
      common: {
        wedstrijd_id: legacyMatchId,
        wedstrijd_naam: match.match_name ?? "",
        locatie: match.location ?? "",
        seizoen: match.season_name_snapshot ?? match.payload?.state?.season ?? "",
        wedstrijdtype: match.match_type ?? "Competitie",
        team_season_id: match.team_season_id ?? "",
        team_id: match.team_id ?? "",
        team_naam: teamName,
        team_seizoen_id: match.season_id ?? "",
        team_seizoen_naam: match.season_name_snapshot ?? "",
      },
    };
  };

  const combinationIds = (value: unknown) => Array.isArray(value)
    ? value.map(String)
    : [];
  const combinationNames = (ids: string[], names: Map<string, string>) =>
    ids.map((id, index) => names.get(id) ?? (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? `Onbekende speler ${index + 1}` : id)).join(" · ");
  const analysisTeamLabel = (value: unknown, ownTeamName: string) =>
    String(value ?? "").trim().toLocaleLowerCase("nl-NL") === ownTeamName.trim().toLocaleLowerCase("nl-NL")
      ? "Korbis"
      : String(value ?? "");

  const matches = sourceMatches.map((match: any) => {
    const playtime = (Array.isArray(match.player_playtime) ? match.player_playtime : []).map((row: any) => ({
      spelerId: row.player_id ?? row.spelerId ?? "",
      spelerNaam: row.player_name ?? row.spelerNaam ?? "",
      status: row.status ?? "",
      seconden: Number(row.seconds ?? row.seconden ?? 0),
    }));
    return {
      wedstrijd_id: match.legacy_match_id ?? "",
      wedstrijd_naam: match.match_name ?? "",
      locatie: match.location ?? "",
      seizoen: match.season_name_snapshot ?? match.payload?.state?.season ?? "",
      wedstrijdtype: match.match_type ?? "Competitie",
      team_season_id: match.team_season_id ?? "",
      team_id: match.team_id ?? "",
      team_naam: match.team_name_snapshot ?? "",
      team_seizoen_id: match.season_id ?? "",
      team_seizoen_naam: match.season_name_snapshot ?? "",
      datum: match.match_date ?? "",
      tegenstander: match.opponent_name ?? "",
      half_duur_minuten: match.half_duration_minutes ?? "",
      score_korbis: match.score_for ?? 0,
      score_tegenstander: match.score_against ?? 0,
      bezit_thuis_seconden: match.possession_for_seconds ?? 0,
      bezit_uit_seconden: match.possession_against_seconds ?? 0,
      bezit_thuis_pct: match.possession_for_pct ?? "",
      bezit_uit_pct: match.possession_against_pct ?? "",
      aanval_thuis_seconden: match.attack_for_seconds ?? 0,
      aanval_uit_seconden: match.attack_against_seconds ?? 0,
      aanval_thuis_pct: match.attack_for_pct ?? "",
      aanval_uit_pct: match.attack_against_pct ?? "",
      speeltijd_spelers_json: JSON.stringify(playtime),
      wedstrijd_afgesloten: match.match_closed ? "ja" : "nee",
      supabase_match_id: match.id ?? "",
      gearchiveerd: Boolean(match.archived_at),
      gearchiveerd_op: match.archived_at ?? "",
      gearchiveerd_door: match.archived_by ?? "",
    };
  });

  const events = sourceEvents.map((event: any) => {
    const context = matchContext(event.match_id);
    const ids = combinationIds(event.combination_player_ids);
    return {
      ...context.common,
      id: event.source_event_id ?? event.id ?? "",
      tijd_verstreken: formatTime(Number(event.elapsed_seconds ?? 0)),
      klok_resterend: event.remaining_seconds == null ? "" : formatTime(Number(event.remaining_seconds)),
      wedstrijd_minuut: event.match_minute ?? "",
      vak: event.vak ?? "",
      vak_id: event.vak_id ?? "",
      combinatie_key: event.combination_key ?? "",
      combinatie_speler_ids: JSON.stringify(ids),
      combinatie_spelers: combinationNames(ids, context.playerNames),
      team: analysisTeamLabel(event.team_label, context.teamName),
      actie: event.action ?? "",
      uitkomst: event.result ?? "",
      reden: event.reason ?? "",
      spelerId: event.player_id ?? "",
      spelerNaam: event.player_name_snapshot ?? "",
      score_korbis: event.score_for ?? "",
      score_tegenstander: event.score_against ?? "",
      x_pct: event.x_pct ?? "",
      y_pct: event.y_pct ?? "",
      aanval_nr: event.attack_number ?? "",
      aanval_start: event.attack_start_seconds == null ? "" : formatTime(Number(event.attack_start_seconds)),
      aanval_einde: event.attack_end_seconds == null ? "" : formatTime(Number(event.attack_end_seconds)),
      aanval_duur: event.attack_duration_seconds == null ? "" : formatTime(Number(event.attack_duration_seconds)),
    };
  });

  const attacks = sourceAttacks.map((attack: any) => {
    const context = matchContext(attack.match_id);
    const ids = combinationIds(attack.combination_player_ids);
    return {
      ...context.common,
      aanval_nr: attack.attack_number ?? "",
      team: analysisTeamLabel(attack.team_label, context.teamName),
      vak: attack.vak === "aanvallend" ? "Aanvallend" : attack.vak === "verdedigend" ? "Verdedigend" : attack.vak ?? "",
      vak_id: attack.vak_id ?? "",
      combinatie_key: attack.combination_key ?? "",
      combinatie_speler_ids: JSON.stringify(ids),
      combinatie_spelers: combinationNames(ids, context.playerNames),
      start: formatTime(Number(attack.start_seconds ?? 0)),
      einde: attack.end_seconds == null ? "" : formatTime(Number(attack.end_seconds)),
      duur: attack.duration_seconds == null ? "" : formatTime(Number(attack.duration_seconds)),
      schoten: attack.shots ?? 0,
      doorloop: attack.run_throughs ?? 0,
      vrije_ballen: attack.free_balls ?? 0,
      strafworpen: attack.penalties ?? 0,
    };
  });

  const wissels = sourceSubstitutions.map((substitution: any) => {
    const context = matchContext(substitution.match_id);
    return {
      ...context.common,
      id: substitution.source_event_id ?? substitution.id ?? "",
      tijd_verstreken: formatTime(Number(substitution.elapsed_seconds ?? 0)),
      wedstrijd_minuut: substitution.match_minute ?? "",
      vak: substitution.vak ?? "",
      vak_id: substitution.vak_id ?? "",
      team: analysisTeamLabel(substitution.team_label, context.teamName),
      positie: substitution.position ?? "",
      wissel: substitution.substitution_type ?? "",
      spelerId: substitution.player_id ?? "",
      spelerNaam: substitution.player_name_snapshot ?? "",
      score_korbis: substitution.score_for ?? "",
      score_tegenstander: substitution.score_against ?? "",
    };
  });

  const vakperiodes = sourceVakPeriods.map((period: any) => {
    const context = matchContext(period.match_id);
    const ids = combinationIds(period.combination_player_ids);
    return {
      ...context.common,
      periode_id: period.source_period_id ?? period.id ?? "",
      vak_id: period.vak_id ?? "",
      start: formatTime(Number(period.start_seconds ?? 0)),
      einde: formatTime(Number(period.end_seconds ?? 0)),
      duur_seconden: period.duration_seconds ?? 0,
      combinatie_key: period.combination_key ?? "",
      combinatie_speler_ids: JSON.stringify(ids),
      combinatie_spelers: combinationNames(ids, context.playerNames),
    };
  });

  return { events, attacks, wissels, matches, vakperiodes };
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function getCurrentAttackInfo(state: AppState) {
  if (!state.currentAttackId) return { attackId: undefined, attackIndex: undefined as number | undefined };
  const a = state.attacks.find((x) => x.id === state.currentAttackId);
  if (!a) return { attackId: undefined, attackIndex: undefined as number | undefined };
  return { attackId: a.id, attackIndex: a.index };
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
      vakPeriods: Array.isArray(s.vakPeriods) ? s.vakPeriods : [],

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
      matchTeamSeasonId: typeof s.matchTeamSeasonId === "string" ? s.matchTeamSeasonId : "",
      matchTeamId: typeof s.matchTeamId === "string" ? s.matchTeamId : "",
      matchTeamName: typeof s.matchTeamName === "string" ? s.matchTeamName : "",
      matchSeasonId: typeof s.matchSeasonId === "string" ? s.matchSeasonId : "",
      matchSeasonName: typeof s.matchSeasonName === "string" ? s.matchSeasonName : "",
      matchDate: typeof s.matchDate === "string" ? s.matchDate : "",
      matchLegacyId: typeof s.matchLegacyId === "string" ? s.matchLegacyId : "",
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

const safeDisplayText = (value: unknown, fallback = "—") => {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
};

class InsightsErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Wedstrijdinzichten konden niet worden weergegeven", error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-900"><h2 className="text-lg font-black">Wedstrijdinzichten konden niet worden geopend</h2><p className="mt-2 text-sm">Een afwijkende waarde in de wedstrijdhistorie kon niet veilig worden weergegeven. De rest van KorbIQ blijft beschikbaar.</p><details className="mt-3 text-xs"><summary className="cursor-pointer font-bold">Technische melding</summary><div className="mt-2 break-words rounded-lg bg-white p-3">{this.state.error.message}</div></details><button type="button" onClick={()=>this.setState({error:null})} className="mt-4 rounded-xl bg-red-700 px-4 py-2 text-sm font-bold text-white">Opnieuw proberen</button></div>;
  }
}

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


type MetricDetailSeries = {
  labels: string[];
  detailLabels?: string[];
  values: number[];
  comparisonValues?: number[];
  comparisonLabel?: string;
  suffix?: string;
};

function MetricInsightCard({
  label,
  value,
  sub,
  metric,
  benchmark,
  inverse = false,
  series,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  metric?: number;
  benchmark?: number;
  inverse?: boolean;
  series?: MetricDetailSeries;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => () => clearTimers(), []);
  const scheduleOpen = () => {
    if (!series?.values.length) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), 500);
  };
  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  const keepOpen = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const values = (series?.values ?? []).map(Number).filter(Number.isFinite);
  const avg = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  const recent = values.slice(-Math.min(3, values.length));
  const previous = values.length >= 6 ? values.slice(-6, -3) : values.slice(0, Math.max(0, values.length - recent.length));
  const recentAvg = recent.length ? recent.reduce((sum, v) => sum + v, 0) / recent.length : 0;
  const previousAvg = previous.length ? previous.reduce((sum, v) => sum + v, 0) / previous.length : recentAvg;
  const delta = recentAvg - previousAvg;
  const trendGood = inverse ? delta < 0 : delta > 0;
  const trendLabel = Math.abs(delta) < 0.05 ? "→ stabiel" : `${trendGood ? "↑" : "↓"} ${Math.abs(delta).toFixed(1)}${series?.suffix ?? ""}`;
  const tone = metric == null || benchmark == null || !Number.isFinite(metric) || !Number.isFinite(benchmark)
    ? "text-gray-900"
    : Math.abs(metric - benchmark) < 0.05
      ? "text-gray-900"
      : (inverse ? metric < benchmark : metric > benchmark) ? "text-emerald-600" : "text-red-600";

  const w = 380, h = 210, left = 44, right = 14, top = 16, bottom = 68;
  const all = [...values, ...((series?.comparisonValues ?? []).filter(Number.isFinite))];
  const maxValue = Math.max(...all, 0);
  const minValue = Math.min(...all, 0);
  const yMin = Math.min(0, Math.floor(minValue));
  const yMax = Math.max(1, Math.ceil(maxValue * 1.15));
  const span = Math.max(1, yMax - yMin);
  const x = (i: number) => values.length <= 1 ? (left + w - right) / 2 : left + i / (values.length - 1) * (w - left - right);
  const y = (v: number) => h - bottom - (v - yMin) / span * (h - top - bottom);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const comparison = series?.comparisonValues?.length === values.length ? series.comparisonValues : undefined;
  const detailLabels = series?.detailLabels?.length === values.length ? series.detailLabels : series?.labels;
  const comparisonPoints = comparison?.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => yMin + (yMax - yMin) * i / 4);

  return <div
    className={`relative border rounded-2xl p-4 bg-white shadow-sm ${series?.values.length ? "cursor-help" : ""} ${className}`}
    onMouseEnter={scheduleOpen}
    onMouseLeave={scheduleClose}
    onClick={() => series?.values.length && setOpen((v) => !v)}
    tabIndex={series?.values.length ? 0 : undefined}
    onFocus={scheduleOpen}
    onBlur={scheduleClose}
  >
    <div className="flex items-start justify-between gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      {series?.values.length ? <span className="text-[11px] font-bold text-blue-500 opacity-70" aria-label="Meer informatie">ⓘ</span> : null}
    </div>
    <div className={`text-3xl font-extrabold mt-1 ${tone}`}>{value}</div>
    {sub ? <div className="text-xs text-gray-500 mt-1">{sub}</div> : null}
    {open && series?.values.length ? <div
      className="absolute left-0 top-[calc(100%+8px)] z-[80] w-[390px] max-w-[88vw] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
      onMouseEnter={keepOpen}
      onMouseLeave={scheduleClose}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3">
        <div><div className="font-black text-slate-900">{label} · per wedstrijd</div><div className="text-xs text-slate-500">Onderliggende data voor de geselecteerde periode</div></div>
        <button type="button" className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100" onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-slate-50 px-2 py-2"><div className="text-[10px] font-bold uppercase text-slate-400">Gem.</div><div className="font-black">{avg.toFixed(avg % 1 === 0 ? 0 : 1)}{series.suffix ?? ""}</div></div>
        <div className="rounded-xl bg-slate-50 px-2 py-2"><div className="text-[10px] font-bold uppercase text-slate-400">Laatste</div><div className="font-black">{values[values.length - 1].toFixed(values[values.length - 1] % 1 === 0 ? 0 : 1)}{series.suffix ?? ""}</div></div>
        <div className={`rounded-xl px-2 py-2 ${Math.abs(delta) < 0.05 ? "bg-slate-50 text-slate-700" : trendGood ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}><div className="text-[10px] font-bold uppercase opacity-60">Trend</div><div className="font-black">{trendLabel}</div></div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-[210px] w-full overflow-visible">
        {ticks.map((tick, i) => <g key={`tick-${i}`}><line x1={left} y1={y(tick)} x2={w-right} y2={y(tick)} stroke="#e5e7eb"/><text x={left-7} y={y(tick)+3} textAnchor="end" fontSize="9" fill="#94a3b8">{tick.toFixed(tick % 1 === 0 ? 0 : 1)}{series.suffix ?? ""}</text></g>)}
        {comparisonPoints ? <polyline points={comparisonPoints} fill="none" stroke="#2563eb" strokeWidth="1.8" strokeDasharray="5 4"/> : null}
        <polyline points={points} fill="none" stroke="#64748b" strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round"/>
        {values.map((v, i) => <g key={`p-${i}`}><circle cx={x(i)} cy={y(v)} r="4.5" fill="#fff" stroke="#475569" strokeWidth="2"><title>{`${detailLabels?.[i] ?? series.labels[i] ?? `W${i+1}`}: ${v.toFixed(v % 1 === 0 ? 0 : 1)}${series.suffix ?? ""}${comparison?.[i] != null ? ` · ${series.comparisonLabel ?? "Vergelijking"}: ${comparison[i].toFixed(comparison[i] % 1 === 0 ? 0 : 1)}${series.suffix ?? ""}` : ""}`}</title></circle><text x={x(i)} y={h-bottom+18} transform={`rotate(90 ${x(i)} ${h-bottom+18})`} textAnchor="start" fontSize="8.5" fill="#64748b">{series.labels[i] ?? `W${i+1}`}</text></g>)}
      </svg>
      {comparison ? <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500"><span className="inline-block w-5 border-t-2 border-dashed border-blue-600"/><span>{series.comparisonLabel ?? "Vergelijking"}</span></div> : null}
      <div className="mt-2 text-[11px] text-slate-400">Desktop: 0,5 sec hover · mobiel: tik op het kaartje · hover op een punt voor de exacte wedstrijdwaarde.</div>
    </div> : null}
  </div>;
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


type AuthProfile = {
  id: string;
  email: string | null;
  role: "coach" | "speler";
  speler_id: string | null;
  speler_naam: string | null;
  naam?: string | null;
  voornaam?: string | null;
  tussenvoegsel?: string | null;
  achternaam?: string | null;
  actief?: boolean;
  account_status?: "uitgenodigd" | "actief" | "gedeactiveerd" | null;
  invitation_status?: "uitgenodigd" | "actief" | null;
  invited_at?: string | null;
  person_id?: string | null;
};


type KorbIQRole = "admin" | "tc" | "coach" | "speler";

type UserRoleRow = {
  id: string;
  user_id: string;
  role: KorbIQRole;
  team_season_id: string | null;
  actief: boolean;
};

type TeamSeasonContext = {
  id: string;
  teamId: string;
  seasonId: string;
  teamName: string;
  teamIsTest: boolean;
  seasonName: string;
  seasonActive: boolean;
  period: "veld_najaar" | "zaal" | "veld_voorjaar" | null;
};

const roleLabel = (role: KorbIQRole) => role === "admin" ? "Admin" : role === "tc" ? "TC-lid" : role === "coach" ? "Coach" : "Speler";

const teamSortKey = (name: string) => {
  const normalized = String(name ?? "").trim().toUpperCase().replace(/\s+/g, "");

  const k = normalized.match(/^K(\d+)(?:[-._]?(\d+))?/);
  if (k) return { group: 0, primary: Number(k[1]), secondary: Number(k[2] ?? 0), label: normalized };

  const u = normalized.match(/^U(\d+)(?:[-._]?(\d+))?/);
  if (u) return { group: 1, primary: -Number(u[1]), secondary: Number(u[2] ?? 0), label: normalized };

  const j = normalized.match(/^J(\d+)(?:[-._]?(\d+))?/);
  if (j) return { group: 2, primary: Number(j[1]), secondary: Number(j[2] ?? 0), label: normalized };

  return { group: 3, primary: 0, secondary: 0, label: normalized };
};

const compareTeamNames = (a: string, b: string) => {
  const ka = teamSortKey(a);
  const kb = teamSortKey(b);
  return (
    ka.group - kb.group ||
    ka.primary - kb.primary ||
    ka.secondary - kb.secondary ||
    ka.label.localeCompare(kb.label, "nl-NL", { numeric: true })
  );
};

function KorbIQLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setMessage(error.message === "Invalid login credentials" ? "E-mailadres of wachtwoord is niet juist." : error.message);
    setBusy(false);
  };

  const resetPassword = async () => {
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setMessage("Vul eerst je e-mailadres in.");
      return;
    }
    setBusy(true);
    setMessage("");
    const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo: `${KORBIQ_APP_ORIGIN}/account-activate?mode=recovery` });
    setMessage(error ? error.message : "Er is een herstelmail verstuurd als dit e-mailadres bekend is.");
    setBusy(false);
  };

  return <div className="min-h-screen bg-[#f6f8fc] px-4 py-10 text-slate-900">
    <div className="mx-auto flex min-h-[75vh] max-w-md items-center">
      <div className="w-full rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/40">
        <KorbIQLogo />
        <div className="mt-7">
          <div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-700">Veilige toegang</div>
          <h1 className="mt-1 text-2xl font-black">Inloggen bij KorbIQ</h1>
          <p className="mt-2 text-sm text-slate-500">Log in met je coach- of spelersaccount.</p>
        </div>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-bold text-slate-700">E-mailadres
            <input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
          </label>
          <label className="block text-sm font-bold text-slate-700">Wachtwoord
            <input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
          </label>
          {message && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{message}</div>}
          <button disabled={busy} className="w-full rounded-xl bg-blue-600 px-4 py-3 font-extrabold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-60">{busy ? "Even wachten…" : "Inloggen"}</button>
          <button type="button" disabled={busy} onClick={resetPassword} className="w-full text-sm font-semibold text-blue-700 hover:underline">Wachtwoord vergeten?</button>
        </form>
      </div>
    </div>
  </div>;
}


function AccountActivationScreen() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sessionAvailable, setSessionAvailable] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const isRecovery = params.get("mode") === "recovery" || window.location.hash.includes("type=recovery");

  useEffect(() => {
    let active = true;

    const readSession = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error) setMessage(error.message);
      const session = data.session;
      setSessionAvailable(Boolean(session));
      setEmail(session?.user.email ?? "");
      setChecking(false);
    };

    void readSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setSessionAvailable(Boolean(session));
      setEmail(session?.user.email ?? "");
      setChecking(false);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const activate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    if (password.length < 8) {
      setMessage("Gebruik minimaal 8 tekens voor je wachtwoord.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("De twee wachtwoorden zijn niet gelijk.");
      return;
    }

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setMessage(error.message);
      setBusy(false);
      return;
    }

    const { error: activationError } = await supabase.rpc("complete_account_activation");
    if (activationError) {
      setMessage(`Wachtwoord is ingesteld, maar KorbIQ kon de accountstatus niet afronden: ${activationError.message}`);
      setBusy(false);
      return;
    }

    window.location.replace(window.location.origin);
  };

  const goToLogin = async () => {
    await supabase.auth.signOut();
    window.location.replace(window.location.origin);
  };

  return <div className="min-h-screen bg-[#f6f8fc] px-4 py-10 text-slate-900">
    <div className="mx-auto flex min-h-[75vh] max-w-md items-center">
      <div className="w-full rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/40">
        <KorbIQLogo />
        <div className="mt-7">
          <div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-700">{isRecovery ? "Account herstellen" : "Welkom bij KorbIQ"}</div>
          <h1 className="mt-1 text-2xl font-black">{isRecovery ? "Nieuw wachtwoord kiezen" : "Activeer je account"}</h1>
          <p className="mt-2 text-sm text-slate-500">{isRecovery ? "Kies een nieuw wachtwoord om weer toegang te krijgen tot KorbIQ." : "Je uitnodiging is bevestigd. Kies nu een wachtwoord voor je KorbIQ-account."}</p>
        </div>

        {checking ? <div className="mt-6 rounded-xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">Uitnodiging controleren…</div> : !sessionAvailable ? <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Deze uitnodigingssessie is niet beschikbaar of de link is verlopen. Vraag een nieuwe uitnodiging of wachtwoordherstelmail aan.</div>
          <button type="button" onClick={()=>void goToLogin()} className="w-full rounded-xl border px-4 py-3 font-bold">Naar inloggen</button>
        </div> : <form onSubmit={activate} className="mt-6 space-y-4">
          {email && <div className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900"><span className="font-bold">Account:</span> {email}</div>}
          <label className="block text-sm font-bold text-slate-700">Nieuw wachtwoord
            <input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e=>setPassword(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
          </label>
          <label className="block text-sm font-bold text-slate-700">Bevestig wachtwoord
            <input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
          </label>
          <div className="text-xs text-slate-500">Gebruik minimaal 8 tekens.</div>
          {message && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{message}</div>}
          <button disabled={busy} className="w-full rounded-xl bg-blue-600 px-4 py-3 font-extrabold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-60">{busy ? "Account activeren…" : isRecovery ? "Wachtwoord opslaan" : "Account activeren"}</button>
        </form>}
      </div>
    </div>
  </div>;
}

type PublicSharedMatchData = {
  available: boolean;
  match?: {
    team_name?: string;
    opponent_name?: string;
    match_name?: string;
    match_date?: string;
    location?: string;
    season?: string;
    match_type?: string;
    score_for?: number;
    score_against?: number;
  };
  stats?: {
    attempts_for?: number;
    goals_for?: number;
    attempts_against?: number;
    goals_against?: number;
    rebounds?: number;
    turnovers?: number;
    attacks_for?: number;
  };
  players?: Array<{ name: string; minutes: number; attempts: number; goals: number; rebounds: number }>;
  timeline?: Array<{ minute: number; team: string; scorer?: string | null; score_for?: number | null; score_against?: number | null }>;
};

function PublicSharedMatchPage({ token }: { token: string }) {
  const [data, setData] = useState<PublicSharedMatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      const { data: result, error: rpcError } = await supabase.rpc("load_shared_match", { p_token: token });
      if (!active) return;
      if (rpcError) {
        setError("Deze wedstrijdlink kon niet worden geladen.");
        setData(null);
      } else {
        setData((result ?? null) as PublicSharedMatchData | null);
        setError("");
      }
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [token]);

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-[#f6f8fc] text-sm font-semibold text-slate-500">Wedstrijdsamenvatting laden…</div>;
  if (error || !data?.available || !data.match) return <div className="min-h-screen bg-[#f6f8fc] p-5"><div className="mx-auto max-w-xl pt-12"><KorbIQLogo /><div className="mt-8 rounded-3xl border border-amber-200 bg-white p-6 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[.14em] text-amber-700">Link niet beschikbaar</div><h1 className="mt-2 text-2xl font-black">Deze wedstrijd kan niet worden bekeken</h1><p className="mt-2 text-sm leading-6 text-slate-600">De link is mogelijk ingetrokken, vervangen of hoort bij een gearchiveerde wedstrijd. Vraag de coach om een nieuwe link.</p></div></div></div>;

  const match = data.match;
  const stats = data.stats ?? {};
  const players = data.players ?? [];
  const timeline = data.timeline ?? [];
  const team = match.team_name || "Korbis";
  const opponent = match.opponent_name || "Tegenstander";
  const isAway = match.location === "Uit";
  const leftTeam = isAway ? opponent : team;
  const rightTeam = isAway ? team : opponent;
  const leftScore = isAway ? Number(match.score_against ?? 0) : Number(match.score_for ?? 0);
  const rightScore = isAway ? Number(match.score_for ?? 0) : Number(match.score_against ?? 0);
  const attempts = Number(stats.attempts_for ?? 0);
  const goals = Number(stats.goals_for ?? 0);
  const scorePct = attempts ? goals / attempts * 100 : 0;

  return <div className="min-h-screen bg-[#f6f8fc] text-slate-900">
    <header className="border-b bg-white"><div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4"><KorbIQLogo /><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-extrabold text-blue-700">Openbare wedstrijdsamenvatting</span></div></header>
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:py-9">
      <section className="overflow-hidden rounded-3xl border border-blue-100 bg-gradient-to-br from-blue-600 to-cyan-600 p-6 text-white shadow-lg sm:p-8">
        <div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-100">{formatImportedDate(match.match_date)} · {match.match_type || "Wedstrijd"}</div>
        <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center"><div className="text-lg font-black sm:text-2xl">{leftTeam}</div><div className="rounded-2xl bg-white/15 px-4 py-3 text-3xl font-black ring-1 ring-white/25 sm:text-4xl">{leftScore} – {rightScore}</div><div className="text-lg font-black sm:text-2xl">{rightTeam}</div></div>
        <div className="mt-5 text-center text-sm font-semibold text-blue-100">{match.season || ""}{match.location ? ` · ${match.location}` : ""}</div>
      </section>
      <section className="grid gap-3 grid-cols-2 lg:grid-cols-5"><MetricInsightCard label="Goals" value={goals}/><MetricInsightCard label="Kansen" value={attempts}/><MetricInsightCard label="Raak" value={attempts?`${scorePct.toFixed(1)}%`:"—"}/><MetricInsightCard label="Rebounds" value={Number(stats.rebounds??0)}/><MetricInsightCard label="Aanvallen" value={Number(stats.attacks_for??0)}/></section>
      <section className="rounded-2xl border bg-white p-5"><div className="flex items-end justify-between gap-3"><div><h2 className="text-lg font-black">Spelers</h2><p className="text-sm text-slate-500">Geregistreerde bijdrage in deze wedstrijd.</p></div><div className="text-xs font-bold text-slate-500">{players.length} spelers</div></div><div className="mt-4 overflow-auto"><table className="w-full min-w-[600px] text-sm"><thead><tr className="border-b text-slate-500"><th className="py-2 text-left">Speler</th><th className="text-right">Minuten</th><th className="text-right">Goals</th><th className="text-right">Kansen</th><th className="text-right">Raak</th><th className="text-right">Rebounds</th></tr></thead><tbody>{players.map(player=><tr key={player.name} className="border-b border-slate-100"><td className="py-2.5 font-bold">{player.name}</td><td className="text-right">{player.minutes}</td><td className="text-right font-black">{player.goals}</td><td className="text-right">{player.attempts}</td><td className="text-right">{player.attempts?`${(player.goals/player.attempts*100).toFixed(1)}%`:"—"}</td><td className="text-right">{player.rebounds}</td></tr>)}</tbody></table>{!players.length&&<div className="py-6 text-center text-sm text-slate-500">Geen individuele acties geregistreerd.</div>}</div></section>
      <section className="rounded-2xl border bg-white p-5"><h2 className="text-lg font-black">Scoreverloop</h2><p className="text-sm text-slate-500">Alle geregistreerde doelpunten op volgorde.</p><div className="mt-4 space-y-2">{timeline.map((event,index)=><div key={`${event.minute}-${index}`} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3"><div className="min-w-0"><div className="font-bold">{event.team}</div><div className="truncate text-xs text-slate-500">{event.scorer || "Doelpunt tegenstander"}</div></div><div className="shrink-0 text-right"><div className="font-black">{event.score_for ?? "–"} – {event.score_against ?? "–"}</div><div className="text-xs font-bold text-blue-700">{event.minute}'</div></div></div>)}{!timeline.length&&<div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Geen scoremomenten geregistreerd.</div>}</div></section>
      <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-xs leading-5 text-blue-800">Dit is een alleen-lezen samenvatting die door de coach is gedeeld. De pagina bevat geen account- of contactgegevens.</div>
    </main>
  </div>;
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authProfile, setAuthProfile] = useState<AuthProfile | null>(null);
  const [authError, setAuthError] = useState("");
  const [accessReady, setAccessReady] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [userRoles, setUserRoles] = useState<UserRoleRow[]>([]);
  const [teamContexts, setTeamContexts] = useState<TeamSeasonContext[]>([]);
  const [activeTeamSeasonId, setActiveTeamSeasonId] = useState("");

  useEffect(() => {
    let active = true;
    const loadUser = async (user: User | null) => {
      if (!active) return;
      setAuthUser(user);
      setAuthError("");
      if (!user) {
        setAuthProfile(null);
        setAuthReady(true);
        return;
      }
      setAuthReady(false);
      const { data, error } = await supabase
        .from("profiles")
        .select("id,email,role,speler_id,speler_naam,naam,voornaam,tussenvoegsel,achternaam,actief,account_status,invitation_status,invited_at")
        .eq("id", user.id)
        .single();
      if (!active) return;
      if (error || !data) {
        setAuthProfile(null);
        setAuthError(error?.message ?? "Accountprofiel kon niet worden geladen.");
      } else {
        setAuthProfile(data as AuthProfile);
      }
      setAuthReady(true);
    };

    supabase.auth.getSession().then(({ data }) => { void loadUser(data.session?.user ?? null); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      void loadUser(session?.user ?? null);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const refreshAccess = async () => {
    if (!authUser) {
      setUserRoles([]);
      setTeamContexts([]);
      setActiveTeamSeasonId("");
      setAccessError("");
      setAccessReady(true);
      return;
    }

    setAccessReady(false);
    setAccessError("");

    const { data: rolesData, error: rolesError } = await supabase
      .from("user_roles")
      .select("id,user_id,role,team_season_id,actief")
      .eq("user_id", authUser.id)
      .eq("actief", true);

    if (rolesError) {
      setUserRoles([]);
      setTeamContexts([]);
      setAccessError(rolesError.message);
      setAccessReady(true);
      return;
    }

    const roles = (rolesData ?? []) as UserRoleRow[];
    setUserRoles(roles);

    const globalAccess = roles.some((r) => r.role === "admin" || r.role === "tc");
    // Voor een gewone medewerker geven uitsluitend expliciete coachrollen
    // teamtoegang. Een speler- of andere rol met een team_season_id mag nooit
    // per ongeluk het coachdashboard of wedstrijdbeheer ontsluiten.
    const assignedIds = Array.from(new Set(
      roles
        .filter((r) => r.role === "coach" && r.actief)
        .map((r) => r.team_season_id)
        .filter((id): id is string => Boolean(id))
    ));

    let query = supabase
      .from("team_seasons")
      .select("id,team_id,season_id,actief,teams(id,naam,actief,is_test),seasons(id,naam,actief,periode)")
      .eq("actief", true);

    if (!globalAccess) {
      if (!assignedIds.length) {
        setTeamContexts([]);
        setActiveTeamSeasonId("");
        setAccessReady(true);
        return;
      }
      query = query.in("id", assignedIds);
    }

    const { data: contextsData, error: contextsError } = await query;
    if (contextsError) {
      setTeamContexts([]);
      setAccessError(contextsError.message);
      setAccessReady(true);
      return;
    }

    const relationOne = (value: any) => Array.isArray(value) ? value[0] : value;
    const contexts = (contextsData ?? []).map((row: any) => {
      const team = relationOne(row.teams);
      const season = relationOne(row.seasons);
      return {
        id: String(row.id),
        teamId: String(row.team_id),
        seasonId: String(row.season_id),
        teamName: String(team?.naam ?? "Onbekend team"),
        teamIsTest: team?.is_test === true,
        seasonName: String(season?.naam ?? "Onbekend seizoen"),
        seasonActive: season?.actief !== false,
        period: season?.periode === "veld_najaar" || season?.periode === "zaal" || season?.periode === "veld_voorjaar" ? season.periode : null,
      } as TeamSeasonContext;
    }).filter((c) => c.seasonActive)
      .sort((a, b) => compareTeamNames(a.teamName, b.teamName) || a.seasonName.localeCompare(b.seasonName, "nl-NL"));

    setTeamContexts(contexts);
    const storageKey = `korbiq-active-team-season-${authUser.id}`;
    const saved = localStorage.getItem(storageKey) ?? "";
    const nextId = contexts.some((c) => c.id === saved) ? saved : (contexts[0]?.id ?? "");
    setActiveTeamSeasonId(nextId);
    if (nextId) localStorage.setItem(storageKey, nextId);
    setAccessReady(true);
  };

  useEffect(() => {
    void refreshAccess();
  }, [authUser?.id]);

  const actualIsAdmin = userRoles.some((r) => r.role === "admin" && r.actief);
  const actualIsTc = userRoles.some((r) => r.role === "tc" && r.actief);
  const actualIsCoachRole = userRoles.some((r) => r.role === "coach" && r.actief);
  const actualHasStaffRole = actualIsAdmin || actualIsTc || actualIsCoachRole;
  const [showTestTeams, setShowTestTeams] = useState(() => localStorage.getItem("korbiq-show-test-teams") === "true");

  // Admin-testweergave is bewust alleen een UI-preview. De echte Supabase/RLS-rechten
  // blijven die van het ingelogde adminaccount. Gebruik echte testaccounts voor securitytests.
  const isAdmin = actualIsAdmin;
  const isTc = actualIsTc;
  const isCoachRole = actualIsCoachRole;
  const hasStaffRole = isAdmin || isTc || isCoachRole;
  const isTruePlayerAccount = authProfile?.role === "speler" && !actualHasStaffRole;
  const canManageOrganisation = isAdmin || isTc;
  const activeTeamContext = teamContexts.find((c) => c.id === activeTeamSeasonId) ?? null;
  const primaryRole: KorbIQRole = isAdmin ? "admin" : isTc ? "tc" : isCoachRole ? "coach" : "speler";

  const [accountProfiles, setAccountProfiles] = useState<AuthProfile[]>([]);
  const [accountProfilesLoading, setAccountProfilesLoading] = useState(false);

  const refreshAccountProfiles = async () => {
    if (!authProfile || !hasStaffRole) return;
    setAccountProfilesLoading(true);
    const { data, error } = await supabase
      .from("profiles")
      .select("id,email,role,speler_id,speler_naam,naam,voornaam,tussenvoegsel,achternaam,actief,account_status,invitation_status,invited_at")
      .eq("role", "speler");
    if (error) {
      console.error("KorbIQ accountprofielen laden mislukt:", error);
    } else {
      setAccountProfiles((data ?? []) as AuthProfile[]);
    }
    setAccountProfilesLoading(false);
  };

  const invitePlayerAccount = async (player: Player, email: string) => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) throw new Error("Vul een e-mailadres in.");
    const { data, error } = await supabase.functions.invoke("invite-player", {
      body: {
        email: cleanEmail,
        speler_id: player.id,
        speler_naam: player.naam,
      },
    });
    if (error) throw new Error(error.message || "Uitnodiging versturen is mislukt.");
    if (data?.error) throw new Error(String(data.error));
    await refreshAccountProfiles();
  };

  useEffect(() => {
    if (authProfile && hasStaffRole) void refreshAccountProfiles();
    else setAccountProfiles([]);
  }, [authProfile?.id, hasStaffRole]);

  const [state, setState] = useState<AppState>(() => {
    // Wedstrijdstatus wordt niet meer vanuit een openbare URL ingelezen.
    // De nieuwe deelfunctie krijgt later een beperkte, alleen-lezen dataset.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return sanitizeState(JSON.parse(raw));
    } catch {}

    return { ...DEFAULT_STATE };
  });

  type MatchSaveStatus = "idle" | "saving" | "saved" | "error";
  const [matchSaveStatus, setMatchSaveStatus] = useState<MatchSaveStatus>("idle");
  const [matchSaveMessage, setMatchSaveMessage] = useState("");

  const currentMatchHasDataForTeamLock =
    state.klokLoopt ||
    state.tijdSeconden > 0 ||
    state.scoreThuis > 0 ||
    state.scoreUit > 0 ||
    state.log.length > 0 ||
    state.fieldEvents.length > 0 ||
    state.attacks.length > 0 ||
    Boolean(state.opponentName.trim()) ||
    Boolean(state.homeAway);

  const teamOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    teamContexts.forEach((c) => {
      if ((actualIsAdmin || actualIsTc) && c.teamIsTest && !showTestTeams) return;
      if (!map.has(c.teamId)) map.set(c.teamId, { id: c.teamId, name: c.teamName });
    });
    return Array.from(map.values()).sort((a, b) => compareTeamNames(a.name, b.name));
  }, [teamContexts, actualIsAdmin, actualIsTc, showTestTeams]);

  useEffect(() => {
    localStorage.setItem("korbiq-show-test-teams", String(showTestTeams));
    if (!(actualIsAdmin || actualIsTc) || showTestTeams || !activeTeamContext?.teamIsTest) return;
    const next = teamContexts.find((context) => !context.teamIsTest);
    setActiveTeamSeasonId(next?.id ?? "");
    if (authUser?.id && next?.id) localStorage.setItem(`korbiq-active-team-season-${authUser.id}`, next.id);
  }, [showTestTeams, actualIsAdmin, actualIsTc, activeTeamContext?.teamIsTest, teamContexts, authUser?.id]);

  const activeTeamId = activeTeamContext?.teamId ?? "";

  const competitionPeriodOptions = useMemo(() => {
    if (!activeTeamId) return [];
    const periodOrder: Record<string, number> = {
      veld_najaar: 0,
      zaal: 1,
      veld_voorjaar: 2,
    };
    const unique = new Map<string, TeamSeasonContext>();
    teamContexts
      .filter((c) => c.teamId === activeTeamId)
      .forEach((c) => {
        if (!unique.has(c.seasonId)) unique.set(c.seasonId, c);
      });

    const yearFromName = (name: string) => {
      const match = name.match(/(20\d{2})\s*\/\s*(20\d{2})/);
      return match ? Number(match[1]) : 0;
    };

    return Array.from(unique.values()).sort((a, b) =>
      yearFromName(b.seasonName) - yearFromName(a.seasonName) ||
      (periodOrder[a.period ?? ""] ?? 99) - (periodOrder[b.period ?? ""] ?? 99) ||
      a.seasonName.localeCompare(b.seasonName, "nl-NL")
    );
  }, [teamContexts, activeTeamId]);

  const chooseContextForTeam = (teamId: string, preferredSeasonName = state.season) => {
    const options = teamContexts.filter((c) => c.teamId === teamId);
    return options.find((c) => c.seasonName === preferredSeasonName) ?? options[0] ?? null;
  };

  const selectTeam = (teamId: string) => {
    if (
      currentMatchHasDataForTeamLock &&
      !state.matchEnded &&
      state.matchTeamId &&
      teamId !== state.matchTeamId
    ) {
      alert(`Deze wedstrijd hoort bij ${state.matchTeamName || "het huidige team"}. Start eerst een nieuwe wedstrijd voordat je van team wisselt.`);
      return;
    }

    const context = chooseContextForTeam(teamId);
    if (!context) return;
    setActiveTeamSeasonId(context.id);
    if (authUser) localStorage.setItem(`korbiq-active-team-season-${authUser.id}`, context.id);
  };

  // Houd de lokale seizoenwaarde gelijk aan een geldige Supabase-competitieperiode.
  // Oude lokale/Excel-seizoensnamen blijven wel in historische data bestaan, maar zijn
  // niet langer handmatig aan te maken voor nieuwe wedstrijden.
  useEffect(() => {
    if (state.matchType !== "Competitie" || !competitionPeriodOptions.length) return;
    if (competitionPeriodOptions.some((c) => c.seasonName === state.season)) return;
    if (currentMatchHasDataForTeamLock && !state.matchEnded) return;
    setState((prev) => ({ ...prev, season: competitionPeriodOptions[0].seasonName }));
  }, [state.matchType, state.season, competitionPeriodOptions, currentMatchHasDataForTeamLock, state.matchEnded]);

  // De gebruiker kiest het team los van de competitieperiode.
  // De periode wordt pas relevant bij de wedstrijdinstellingen. Zolang er nog geen
  // wedstrijddata is, kiezen we achter de schermen de bijpassende team_season-context.
  useEffect(() => {
    if (!activeTeamId || state.matchType !== "Competitie") return;
    if (currentMatchHasDataForTeamLock && !state.matchEnded && state.matchTeamSeasonId) return;

    const matching = teamContexts.find((c) => c.teamId === activeTeamId && c.seasonName === state.season);
    if (!matching || matching.id === activeTeamSeasonId) return;

    setActiveTeamSeasonId(matching.id);
    if (authUser) localStorage.setItem(`korbiq-active-team-season-${authUser.id}`, matching.id);
  }, [state.season, state.matchType, activeTeamId, teamContexts, activeTeamSeasonId, currentMatchHasDataForTeamLock, state.matchEnded, state.matchTeamSeasonId, authUser?.id]);

  // Houd vóór de start van een wedstrijd de wedstrijdcontext gelijk aan het gekozen team.
  // Zodra er wedstrijddata bestaat, blijft dit een snapshot en verandert deze niet meer.
  useEffect(() => {
    if (!activeTeamContext) return;

    setState((prev) => {
      const hasMatchData =
        prev.klokLoopt ||
        prev.tijdSeconden > 0 ||
        prev.scoreThuis > 0 ||
        prev.scoreUit > 0 ||
        prev.log.length > 0 ||
        prev.fieldEvents.length > 0 ||
        prev.attacks.length > 0 ||
        Boolean(prev.opponentName.trim()) ||
        Boolean(prev.homeAway);

      if (hasMatchData && prev.matchTeamSeasonId) return prev;

      const next = {
        ...prev,
        matchTeamSeasonId: prev.matchType === "Competitie" ? activeTeamContext.id : "",
        matchTeamId: activeTeamContext.teamId,
        matchTeamName: activeTeamContext.teamName,
        matchSeasonId: prev.matchType === "Competitie" ? activeTeamContext.seasonId : "",
        matchSeasonName: prev.matchType === "Competitie" ? activeTeamContext.seasonName : "",
      };

      if (
        prev.matchTeamSeasonId === next.matchTeamSeasonId &&
        prev.matchTeamId === next.matchTeamId &&
        prev.matchTeamName === next.matchTeamName &&
        prev.matchSeasonId === next.matchSeasonId &&
        prev.matchSeasonName === next.matchSeasonName
      ) return prev;

      return next;
    });
  }, [activeTeamContext?.id, activeTeamContext?.teamId, activeTeamContext?.teamName, activeTeamContext?.seasonId, activeTeamContext?.seasonName]);

  // ---------------------------------------------------------------------------
  // Fase 26: actuele teamselectie komt uit Supabase.
  // De bestaande wedstrijd-/analysecode blijft voorlopig Player[] gebruiken,
  // maar de bron is nu players + people + player_team_memberships.
  // ---------------------------------------------------------------------------
  const [teamRosterLoading, setTeamRosterLoading] = useState(false);
  const [teamRosterError, setTeamRosterError] = useState("");
  const [teamRosterVersion, setTeamRosterVersion] = useState(0);
  const loadedRosterTeamIdRef = useRef("");

  type RememberedTeamLineup = {
    aanval: (string | null)[];
    verdediging: (string | null)[];
    vak1Aanvallend: boolean;
  };

  const teamLineupStorageKey = (teamId: string) =>
    `korbiq-team-lineup-${authUser?.id ?? "unknown"}-${teamId}`;

  useEffect(() => {
    let cancelled = false;

    const loadActiveTeamRoster = async () => {
      if (!authUser || !activeTeamId) return;

      // Een team wordt in KorbIQ één keer beheerd, maar heeft per competitiejaar
      // meerdere team_season-koppelingen (veld najaar, zaal en veld voorjaar).
      // Laad daarom het teamroster over alle perioden van het actieve team.
      const activeTeamSeasonIds = teamContexts
        .filter((context) => context.teamId === activeTeamId)
        .map((context) => context.id);

      if (!activeTeamSeasonIds.length) return;

      setTeamRosterLoading(true);
      setTeamRosterError("");

      const { data: membershipData, error: membershipError } = await supabase
        .from("player_team_memberships")
        .select("player_id,status,actief")
        .in("team_season_id", activeTeamSeasonIds)
        .eq("actief", true);

      if (membershipError) {
        if (!cancelled) {
          setTeamRosterError(membershipError.message);
          setTeamRosterLoading(false);
        }
        return;
      }

      const memberships = (membershipData ?? []) as Array<{
        player_id: string;
        status: PlayerStatus;
        actief: boolean;
      }>;

      // Dezelfde speler kan voor alle drie perioden een membership hebben. Toon
      // deze maar één keer; Basisspeler gaat voor Gast als de statussen afwijken.
      const membershipByPlayerId = new Map<string, {
        player_id: string;
        status: PlayerStatus;
        actief: boolean;
      }>();
      memberships.forEach((membership) => {
        const playerId = String(membership.player_id);
        const existing = membershipByPlayerId.get(playerId);
        if (!existing || membership.status === "Basisspeler") {
          membershipByPlayerId.set(playerId, { ...membership, player_id: playerId });
        }
      });
      const teamMemberships = Array.from(membershipByPlayerId.values());
      const playerIds = teamMemberships.map((membership) => membership.player_id);

      if (!playerIds.length) {
        if (!cancelled) {
          loadedRosterTeamIdRef.current = activeTeamId;
          setState((prev) => ({
            ...prev,
            spelers: [],
            aanval: [null, null, null, null],
            verdediging: [null, null, null, null],
            speelSeconden: {},
          }));
          setTeamRosterLoading(false);
        }
        return;
      }

      const { data: playerData, error: playerError } = await supabase
        .from("players")
        .select("id,person_id,naam,geslacht,actief")
        .in("id", playerIds);

      if (playerError) {
        if (!cancelled) {
          setTeamRosterError(playerError.message);
          setTeamRosterLoading(false);
        }
        return;
      }

      const managedPlayers = (playerData ?? []) as Array<{
        id: string;
        person_id: string | null;
        naam: string;
        geslacht: Geslacht;
        actief: boolean;
      }>;

      const personIds = Array.from(
        new Set(
          managedPlayers
            .map((p) => p.person_id)
            .filter((id): id is string => Boolean(id))
        )
      );

      let peopleById = new Map<string, {
        voornaam: string;
        tussenvoegsel: string | null;
        achternaam: string;
        actief: boolean;
      }>();

      if (personIds.length) {
        const { data: peopleData, error: peopleError } = await supabase
          .from("people")
          .select("id,voornaam,tussenvoegsel,achternaam,actief")
          .in("id", personIds);

        if (peopleError) {
          if (!cancelled) {
            setTeamRosterError(peopleError.message);
            setTeamRosterLoading(false);
          }
          return;
        }

        peopleById = new Map(
          (peopleData ?? []).map((p: any) => [
            String(p.id),
            {
              voornaam: String(p.voornaam ?? ""),
              tussenvoegsel: p.tussenvoegsel ? String(p.tussenvoegsel) : null,
              achternaam: String(p.achternaam ?? ""),
              actief: Boolean(p.actief),
            },
          ])
        );
      }

      const playerById = new Map(managedPlayers.map((p) => [p.id, p]));

      const roster: Player[] = teamMemberships
        .flatMap<Player>((membership) => {
          const player = playerById.get(String(membership.player_id));
          if (!player || !player.actief) return [];

          const person = player.person_id ? peopleById.get(player.person_id) : null;
          if (person && !person.actief) return [];

          const fullName = person
            ? [person.voornaam, person.tussenvoegsel, person.achternaam]
                .filter(Boolean)
                .join(" ")
            : String(player.naam ?? "").trim();

          return [{
            id: player.id,
            naam: fullName || String(player.naam ?? "Onbekende speler"),
            geslacht: player.geslacht,
            status: membership.status,
            actief: true,
          }];
        })
        .sort((a, b) =>
          a.status.localeCompare(b.status, "nl-NL") ||
          a.naam.localeCompare(b.naam, "nl-NL")
        );

      if (cancelled) return;

      const rosterIds = new Set(roster.map((p) => p.id));
      const firstRosterLoad = !loadedRosterTeamIdRef.current;
      let remembered: RememberedTeamLineup | null = null;
      try {
        const raw = localStorage.getItem(teamLineupStorageKey(activeTeamId));
        if (raw) remembered = JSON.parse(raw) as RememberedTeamLineup;
      } catch {
        remembered = null;
      }
      loadedRosterTeamIdRef.current = activeTeamId;

      setState((prev) => {
        const nextSpeelSeconden: Record<string, number> = {};
        roster.forEach((p) => {
          nextSpeelSeconden[p.id] = prev.speelSeconden[p.id] ?? 0;
        });

        const fallbackToCurrent = firstRosterLoad && prev.matchTeamId === activeTeamId;
        const sourceAanval = remembered?.aanval ?? (fallbackToCurrent ? prev.aanval : []);
        const sourceVerdediging = remembered?.verdediging ?? (fallbackToCurrent ? prev.verdediging : []);
        const used = new Set<string>();
        const restoreFour = (source: (string | null)[]) =>
          Array.from({ length: 4 }, (_, index) => {
            const id = source[index] ?? null;
            if (!id || !rosterIds.has(id) || used.has(id)) return null;
            used.add(id);
            return id;
          });
        const restoredAanval = restoreFour(sourceAanval);
        const restoredVerdediging = restoreFour(sourceVerdediging);

        return {
          ...prev,
          spelers: roster,
          aanval: restoredAanval,
          verdediging: restoredVerdediging,
          vak1Aanvallend: remembered?.vak1Aanvallend ?? (fallbackToCurrent ? prev.vak1Aanvallend : true),
          speelSeconden: nextSpeelSeconden,
        };
      });

      setTeamRosterLoading(false);
    };

    void loadActiveTeamRoster();

    return () => {
      cancelled = true;
    };
  }, [authUser?.id, activeTeamId, teamContexts, teamRosterVersion]);

  // Bewaar de laatst gekozen vakindeling apart per gebruiker en per echt team.
  // Tijdens het omschakelen wachten we tot het nieuwe teamroster geladen is,
  // zodat de opstelling van het vorige team nooit onder het nieuwe team belandt.
  useEffect(() => {
    if (!authUser || !activeTeamId || teamRosterLoading) return;
    if (loadedRosterTeamIdRef.current !== activeTeamId) return;
    const rosterIds = new Set(state.spelers.map((player) => player.id));
    const clean = (positions: (string | null)[]) =>
      positions.map((id) => id && rosterIds.has(id) ? id : null);
    const remembered: RememberedTeamLineup = {
      aanval: clean(state.aanval),
      verdediging: clean(state.verdediging),
      vak1Aanvallend: state.vak1Aanvallend,
    };
    try {
      localStorage.setItem(teamLineupStorageKey(activeTeamId), JSON.stringify(remembered));
    } catch {}
  }, [authUser?.id, activeTeamId, teamRosterLoading, state.spelers, state.aanval, state.verdediging, state.vak1Aanvallend]);

  const [tab, setTab] =
  useState<"dashboard" | "wedstrijdinzichten" | "spelersanalyse" | "teamanalyse" | "spelers" | "personenbeheer" | "teamsbeheer" | "seizoenenbeheer" | "wedstrijdbeheer" | "vakken" | "wedstrijd" | "verslag" | "insights" | "combinaties" | "profielen" | "opstelling" | "wisseladvies" | "doelen" | "portaal" | "voorbereiding" | "seizoen">("dashboard");
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

  // Fase 17.1: alle tabellen in KorbIQ zijn sorteerbaar via de kolomkop.
  // 1e klik = oplopend, 2e = aflopend, 3e = oorspronkelijke volgorde.
  useEffect(() => {
    type SortDirection = "asc" | "desc" | "original";
    const tableState = new WeakMap<HTMLTableElement, { column: number; direction: SortDirection }>();
    const originalOrder = new WeakMap<HTMLTableRowElement, number>();

    const valueForSort = (raw: string) => {
      const text = raw.replace(/[▲▼↕]/g, "").trim();
      if (!text || text === "—" || text === "-") return { empty: true, kind: 3, value: "" };

      const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (iso) return { empty: false, kind: 0, value: Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) };
      const nl = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (nl) return { empty: false, kind: 0, value: Date.UTC(Number(nl[3]), Number(nl[2]) - 1, Number(nl[1])) };

      const rank = text.match(/^#?\s*(\d+)\s*\/\s*\d+/);
      if (rank) return { empty: false, kind: 1, value: Number(rank[1]) };

      const cleaned = text
        .replace(/%/g, "")
        .replace(/\s*(min|sec|s|x)$/i, "")
        .replace(/\./g, "")
        .replace(",", ".");
      if (/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) {
        return { empty: false, kind: 1, value: Number(cleaned) };
      }
      return { empty: false, kind: 2, value: text.toLocaleLowerCase("nl-NL") };
    };

    const decorateTable = (table: HTMLTableElement) => {
      const headerRow = table.tHead?.rows?.[0];
      if (!headerRow) return;
      Array.from(headerRow.cells).forEach((cell) => {
        const th = cell as HTMLTableCellElement;
        if (th.colSpan > 1) return;
        th.style.cursor = "pointer";
        th.style.userSelect = "none";
        th.title = "Klik om deze kolom te sorteren";
        th.setAttribute("aria-sort", "none");
        if (!th.dataset.sortLabel) th.dataset.sortLabel = (th.textContent ?? "").trim();
      });
    };

    const decorateAll = () => document.querySelectorAll<HTMLTableElement>("table").forEach(decorateTable);
    decorateAll();
    const observer = new MutationObserver(decorateAll);
    observer.observe(document.body, { childList: true, subtree: true });

    const onClick = (event: MouseEvent) => {
      const th = (event.target as HTMLElement | null)?.closest("th") as HTMLTableCellElement | null;
      if (!th || th.colSpan > 1) return;
      const table = th.closest("table") as HTMLTableElement | null;
      const tbody = table?.tBodies?.[0];
      const headerRow = table?.tHead?.rows?.[0];
      if (!table || !tbody || !headerRow || !headerRow.contains(th)) return;

      const column = Array.from(headerRow.cells).indexOf(th);
      if (column < 0) return;
      const previous = tableState.get(table);
      const direction: SortDirection = previous?.column === column
        ? previous.direction === "asc" ? "desc" : previous.direction === "desc" ? "original" : "asc"
        : "asc";
      tableState.set(table, { column, direction });

      const rows = Array.from(tbody.rows);
      rows.forEach((row, index) => { if (!originalOrder.has(row)) originalOrder.set(row, index); });
      rows.sort((a, b) => {
        if (direction === "original") return (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0);
        const av = valueForSort(a.cells[column]?.textContent ?? "");
        const bv = valueForSort(b.cells[column]?.textContent ?? "");
        if (av.empty !== bv.empty) return av.empty ? 1 : -1;
        let cmp = 0;
        if (av.kind === bv.kind && typeof av.value === "number" && typeof bv.value === "number") cmp = av.value - bv.value;
        else cmp = String(av.value).localeCompare(String(bv.value), "nl-NL", { numeric: true, sensitivity: "base" });
        return direction === "desc" ? -cmp : cmp;
      });
      rows.forEach((row) => tbody.appendChild(row));

      Array.from(headerRow.cells).forEach((cell) => {
        const header = cell as HTMLTableCellElement;
        const label = header.dataset.sortLabel ?? (header.textContent ?? "").replace(/[▲▼↕]/g, "").trim();
        header.dataset.sortLabel = label;
        header.textContent = label + (header === th && direction !== "original" ? (direction === "asc" ? " ▲" : " ▼") : "");
        header.setAttribute("aria-sort", header === th && direction !== "original" ? (direction === "asc" ? "ascending" : "descending") : "none");
      });
    };

    document.addEventListener("click", onClick);
    return () => {
      observer.disconnect();
      document.removeEventListener("click", onClick);
    };
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
  const dbSheetsCacheRef = useRef<DatabaseSheets>(null);
  const [localFallbackDbSheets, setLocalFallbackDbSheets] = useState<DatabaseSheets>(null);
  type SupabaseHistoryStatus = "idle" | "loading" | "ready" | "error";
  const [supabaseHistoryStatus, setSupabaseHistoryStatus] = useState<SupabaseHistoryStatus>("idle");
  const [supabaseHistoryMessage, setSupabaseHistoryMessage] = useState("");
  const [supabaseHistoryCount, setSupabaseHistoryCount] = useState(0);
  const [localOnlyHistoryCount, setLocalOnlyHistoryCount] = useState(0);
  const [portalPlayerFromSupabase, setPortalPlayerFromSupabase] = useState<Player | null>(null);
  const [historyOwnerUserId, setHistoryOwnerUserId] = useState("");
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0);
  useEffect(() => { dbSheetsCacheRef.current = dbSheets; }, [dbSheets]);

  // Fase 26.4: analyses en historie worden standaard begrensd tot het actieve echte team.
  // Nieuwe wedstrijden hebben team_id. Oude wedstrijden zonder team_id worden bewust
  // niet stilzwijgend aan een team toegeschreven; die blijven beschikbaar voor een
  // latere eenmalige migratie.
  const legacyUnlinkedMatchCount = useMemo(
    () => (dbSheets?.matches ?? []).filter((m: any) => !String(m.team_id ?? "").trim()).length,
    [dbSheets]
  );

  const activeTeamHistoryDbSheets = useMemo<DatabaseSheetsData | null>(() => {
    if (!dbSheets) return null;
    // Een echt speleraccount krijgt uitsluitend het eigen, server-side gefilterde
    // pakket. Een medewerker zonder teamtoegang krijgt bewust helemaal niets uit
    // de lokale browsercache te zien.
    if (!activeTeamId) return isTruePlayerAccount ? dbSheets : emptyHistoryDatabase();

    const matches = (dbSheets.matches ?? []).filter(
      (m: any) => String(m.team_id ?? "").trim() === activeTeamId
    );
    const matchIds = new Set(
      matches.map((m: any) => String(m.wedstrijd_id ?? "").trim()).filter(Boolean)
    );
    const belongsToSelectedMatches = (row: any) =>
      matchIds.has(String(row.wedstrijd_id ?? "").trim());

    return {
      ...dbSheets,
      matches,
      events: (dbSheets.events ?? []).filter(belongsToSelectedMatches),
      attacks: (dbSheets.attacks ?? []).filter(belongsToSelectedMatches),
      wissels: (dbSheets.wissels ?? []).filter(belongsToSelectedMatches),
      vakperiodes: (dbSheets.vakperiodes ?? []).filter(belongsToSelectedMatches),
    };
  }, [dbSheets, activeTeamId, isTruePlayerAccount]);

  const accessibleHistoryDbSheets = useMemo<DatabaseSheetsData | null>(() => {
    if (!dbSheets) return null;
    const allowedTeamIds = new Set(teamContexts.filter((context) => showTestTeams || !context.teamIsTest).map((context) => context.teamId));
    const matches = (dbSheets.matches ?? []).filter((m: any) =>
      allowedTeamIds.has(String(m.team_id ?? "").trim())
    );
    const matchIds = new Set(matches.map((m: any) => String(m.wedstrijd_id ?? "").trim()).filter(Boolean));
    const belongsToAccessibleMatch = (row: any) => matchIds.has(String(row.wedstrijd_id ?? "").trim());
    return {
      ...dbSheets,
      matches,
      events: (dbSheets.events ?? []).filter(belongsToAccessibleMatch),
      attacks: (dbSheets.attacks ?? []).filter(belongsToAccessibleMatch),
      wissels: (dbSheets.wissels ?? []).filter(belongsToAccessibleMatch),
      vakperiodes: (dbSheets.vakperiodes ?? []).filter(belongsToAccessibleMatch),
    };
  }, [dbSheets, teamContexts, showTestTeams]);

  // Gearchiveerde wedstrijden blijven zichtbaar in Wedstrijden beheren, maar
  // tellen nergens mee in dashboards, voorbereiding, doelen of speleranalyses.
  const activeTeamDbSheets = useMemo<DatabaseSheetsData | null>(() => {
    if (!activeTeamHistoryDbSheets) return null;
    const matches = (activeTeamHistoryDbSheets.matches ?? []).filter((m: any) => !m.gearchiveerd);
    const matchIds = new Set(
      matches.map((m: any) => String(m.wedstrijd_id ?? "").trim()).filter(Boolean)
    );
    const belongsToActiveMatch = (row: any) =>
      matchIds.has(String(row.wedstrijd_id ?? "").trim());
    return {
      ...activeTeamHistoryDbSheets,
      matches,
      events: (activeTeamHistoryDbSheets.events ?? []).filter(belongsToActiveMatch),
      attacks: (activeTeamHistoryDbSheets.attacks ?? []).filter(belongsToActiveMatch),
      wissels: (activeTeamHistoryDbSheets.wissels ?? []).filter(belongsToActiveMatch),
      vakperiodes: (activeTeamHistoryDbSheets.vakperiodes ?? []).filter(belongsToActiveMatch),
    };
  }, [activeTeamHistoryDbSheets]);

  type AnalysisPeriodFilter = "all" | "veld_najaar" | "zaal" | "veld_voorjaar";
  const [analysisCompetitionYear, setAnalysisCompetitionYear] = useState("");
  const [analysisPeriod, setAnalysisPeriod] = useState<AnalysisPeriodFilter>("all");

  const competitionYearFromSeasonName = (value: unknown) => {
    const name = String(value ?? "").trim();
    const full = name.match(/(20\d{2})\s*\/\s*(20\d{2})/);
    if (full) return `${full[1]}/${full[2]}`;

    const single = name.match(/(20\d{2})/);
    if (!single) return "";
    const year = Number(single[1]);

    if (/voorjaar/i.test(name)) return `${year - 1}/${year}`;
    if (/najaar/i.test(name)) return `${year}/${year + 1}`;
    return "";
  };

  const analysisCompetitionYears = useMemo(() => {
    const values = new Set<string>();

    teamContexts
      .filter((c) => c.teamId === activeTeamId)
      .forEach((c) => {
        const year = competitionYearFromSeasonName(c.seasonName);
        if (year) values.add(year);
      });

    (activeTeamDbSheets?.matches ?? []).forEach((m: any) => {
      const year = competitionYearFromSeasonName(
        m.team_seizoen_naam ?? m.seizoen ?? ""
      );
      if (year) values.add(year);
    });

    return Array.from(values).sort((a, b) => b.localeCompare(a, "nl-NL"));
  }, [teamContexts, activeTeamId, activeTeamDbSheets]);

  useEffect(() => {
    if (!analysisCompetitionYears.length) {
      if (analysisCompetitionYear) setAnalysisCompetitionYear("");
      return;
    }
    if (!analysisCompetitionYears.includes(analysisCompetitionYear)) {
      setAnalysisCompetitionYear(analysisCompetitionYears[0]);
    }
  }, [analysisCompetitionYears, analysisCompetitionYear]);

  const analysisDbSheets = useMemo<DatabaseSheetsData | null>(() => {
    if (!activeTeamDbSheets) return null;
    if (!analysisCompetitionYear) return activeTeamDbSheets;

    const matches = (activeTeamDbSheets.matches ?? []).filter((m: any) => {
      const matchType = String(m.wedstrijdtype ?? "Competitie").trim();
      if (matchType !== "Competitie") return false;

      const seasonName = String(
        m.team_seizoen_naam ?? m.seizoen ?? ""
      ).trim();
      if (competitionYearFromSeasonName(seasonName) !== analysisCompetitionYear) {
        return false;
      }

      if (analysisPeriod === "all") return true;
      if (analysisPeriod === "veld_najaar") return /veld\s*najaar/i.test(seasonName);
      if (analysisPeriod === "zaal") return /zaal/i.test(seasonName);
      return /veld\s*voorjaar/i.test(seasonName);
    });

    const matchIds = new Set(
      matches.map((m: any) => String(m.wedstrijd_id ?? "").trim()).filter(Boolean)
    );
    const belongsToSelectedMatches = (row: any) =>
      matchIds.has(String(row.wedstrijd_id ?? "").trim());

    return {
      ...activeTeamDbSheets,
      matches,
      events: (activeTeamDbSheets.events ?? []).filter(belongsToSelectedMatches),
      attacks: (activeTeamDbSheets.attacks ?? []).filter(belongsToSelectedMatches),
      wissels: (activeTeamDbSheets.wissels ?? []).filter(belongsToSelectedMatches),
      vakperiodes: (activeTeamDbSheets.vakperiodes ?? []).filter(belongsToSelectedMatches),
    };
  }, [activeTeamDbSheets, analysisCompetitionYear, analysisPeriod]);

  const analysisTabs = [
    "dashboard","teamanalyse","insights","combinaties",
    "profielen","opstelling","wisseladvies","seizoen"
  ];

  const [databaseReady, setDatabaseReady] = useState(false);
  const [databaseSetupOpen, setDatabaseSetupOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [navSectionsOpen, setNavSectionsOpen] = useState({
    wedstrijd: false,
    analyse: true,
    coaching: false,
    beheer: false,
  });
  const [portalPlayerId, setPortalPlayerId] = useState<string>(() => localStorage.getItem("korbiq-portal-player") ?? "");
  useEffect(() => {
    if (portalPlayerId) localStorage.setItem("korbiq-portal-player", portalPlayerId);
    else localStorage.removeItem("korbiq-portal-player");
  }, [portalPlayerId]);
  
  // De browserdatabase blijft in fase 29 beschikbaar als cache en als terugval
  // voor nog niet gemigreerde Excel-historie. Supabase is de primaire bron.
  useEffect(() => {
    if (!authReady || !accessReady) return;
    setDatabaseReady(false);
    setHistoryOwnerUserId("");
    if (authProfile?.role === "speler") {
      const empty = emptyHistoryDatabase();
      dbSheetsCacheRef.current = empty;
      setPortalPlayerFromSupabase(null);
      setSupabaseHistoryStatus("idle");
      setSupabaseHistoryMessage("");
      setLocalFallbackDbSheets(empty);
      setDbSheets(empty);
      setDatabaseSetupOpen(false);
      setDatabaseReady(true);
      setHistoryOwnerUserId(authUser?.id ?? "");
      return;
    }

    if (!actualHasStaffRole) {
      const empty = emptyHistoryDatabase();
      dbSheetsCacheRef.current = empty;
      setLocalFallbackDbSheets(empty);
      setDbSheets(empty);
      setDatabaseSetupOpen(false);
      setDatabaseReady(true);
      setHistoryOwnerUserId(authUser?.id ?? "");
      return;
    }

    if (actualHasStaffRole && !activeTeamId) {
      const empty = emptyHistoryDatabase();
      dbSheetsCacheRef.current = empty;
      setPortalPlayerFromSupabase(null);
      setSupabaseHistoryStatus("idle");
      setSupabaseHistoryMessage("Geen team gekoppeld; er wordt geen lokale historie geladen.");
      setSupabaseHistoryCount(0);
      setLocalOnlyHistoryCount(0);
      setLocalFallbackDbSheets(empty);
      setDbSheets(empty);
      setDatabaseSetupOpen(false);
      setDatabaseReady(true);
      setHistoryOwnerUserId(authUser?.id ?? "");
      return;
    }

    const restrictLocalHistoryToAccess = (source: DatabaseSheetsData): DatabaseSheetsData => {
      if (actualIsAdmin || actualIsTc) return source;
      const allowedTeamIds = new Set(teamContexts.map((context) => context.teamId));
      const matches = (source.matches ?? []).filter((row:any) =>
        allowedTeamIds.has(String(row.team_id ?? "").trim())
      );
      const matchIds = new Set(matches.map((row:any)=>String(row.wedstrijd_id??"").trim()).filter(Boolean));
      const allowedDetail = (row:any) =>
        allowedTeamIds.has(String(row.team_id??"").trim()) ||
        matchIds.has(String(row.wedstrijd_id??"").trim());
      return {
        ...source,
        matches,
        events: (source.events ?? []).filter(allowedDetail),
        attacks: (source.attacks ?? []).filter(allowedDetail),
        wissels: (source.wissels ?? []).filter(allowedDetail),
        vakperiodes: (source.vakperiodes ?? []).filter(allowedDetail),
      };
    };

    let mounted = true;
    loadDatabaseFromBrowser()
      .then((saved) => {
        if (!mounted) return;
        const fallback = restrictLocalHistoryToAccess(saved ?? emptyHistoryDatabase());
        dbSheetsCacheRef.current = fallback;
        setLocalFallbackDbSheets(fallback);
        setDbSheets(fallback);
        setDatabaseSetupOpen(false);
      })
      .catch((err) => {
        console.warn("Kon browserdatabase niet laden", err);
        if (mounted) {
          const fallback = emptyHistoryDatabase();
          dbSheetsCacheRef.current = fallback;
          setLocalFallbackDbSheets(fallback);
          setDbSheets(fallback);
          setDatabaseSetupOpen(false);
        }
      })
      .finally(() => {
        if (!mounted) return;
        setDatabaseReady(true);
        setHistoryOwnerUserId(authUser?.id ?? "");
      });
    return () => { mounted = false; };
  }, [authReady, accessReady, authUser?.id, authProfile?.id, authProfile?.role, actualHasStaffRole, actualIsAdmin, actualIsTc, activeTeamId, teamContexts]);

  // Haal na het inloggen de centrale historie op van ieder team waarvoor de
  // gebruiker toegang heeft. Teamgerichte dashboards filteren deze set verder
  // op het actieve team; overzichts- en beheerschermen kunnen zo onafhankelijk
  // daarvan veilig "Alle teams" tonen. De bestaande RPC/RLS blijft leidend.
  useEffect(() => {
    if (!databaseReady || !authUser) return;
    if (!isTruePlayerAccount && !activeTeamId) return;
    let cancelled = false;

    const loadSupabaseHistory = async () => {
      setSupabaseHistoryStatus("loading");
      setSupabaseHistoryMessage(isTruePlayerAccount ? "Persoonlijke historie laden…" : "Wedstrijdhistorie uit Supabase laden…");
      const accessibleTeamIds = Array.from(new Set(teamContexts.map((context) => context.teamId).filter(Boolean)));
      const personalResult = isTruePlayerAccount
        ? await supabase.rpc("load_my_active_player_history")
        : null;
      const teamResults = isTruePlayerAccount
        ? []
        : await Promise.all(accessibleTeamIds.map(async (teamId) => ({
            teamId,
            result: await supabase.rpc("load_match_history", { p_team_id: teamId }),
          })));
      const failedTeamResult = teamResults.find(({ result }) => result.error);
      const data = isTruePlayerAccount
        ? personalResult?.data
        : teamResults.map(({ result }) => result.data);
      const error = isTruePlayerAccount ? personalResult?.error : failedTeamResult?.result.error;

      if (cancelled) return;
      if (error) {
        setSupabaseHistoryStatus("error");
        setSupabaseHistoryMessage(`Supabase-historie kon niet worden geladen: ${error.message}`);
        if (isTruePlayerAccount) {
          setPortalPlayerFromSupabase(null);
          setSupabaseHistoryCount(0);
          setLocalOnlyHistoryCount(0);
          setDbSheets(emptyHistoryDatabase());
        } else {
          setDbSheets((current) => current ?? localFallbackDbSheets ?? emptyHistoryDatabase());
        }
        return;
      }

      const remote = isTruePlayerAccount
        ? supabaseHistoryToDatabase(data)
        : teamResults.reduce<DatabaseSheetsData>((combined, { result: teamResult }) => {
            const teamHistory = supabaseHistoryToDatabase(teamResult.data);
            combined.matches.push(...teamHistory.matches);
            combined.events.push(...teamHistory.events);
            combined.attacks.push(...teamHistory.attacks);
            combined.wissels.push(...teamHistory.wissels);
            combined.vakperiodes ??= [];
            combined.vakperiodes.push(...(teamHistory.vakperiodes ?? []));
            return combined;
          }, emptyHistoryDatabase());
      if (isTruePlayerAccount) {
        const player = (data as any)?.player;
        setPortalPlayerFromSupabase(player?.id ? {
          id: String(player.id),
          naam: String(player.naam ?? authProfile?.speler_naam ?? "Speler"),
          geslacht: player.geslacht === "Heer" ? "Heer" : "Dame",
          status: player.status === "Gast" ? "Gast" : "Basisspeler",
          actief: player.actief !== false,
        } : null);
        setDbSheets(remote);
        setSupabaseHistoryCount(remote.matches.length);
        setLocalOnlyHistoryCount(0);
        setSupabaseHistoryStatus("ready");
        setSupabaseHistoryMessage(
          `${remote.matches.length} persoonlijke wedstrijd${remote.matches.length === 1 ? "" : "en"} veilig geladen.`
        );
        return;
      }

      setPortalPlayerFromSupabase(null);
      const remoteMatchIds = new Set(
        remote.matches.map((row: any) => String(row.wedstrijd_id ?? "")).filter(Boolean)
      );
      const local = dbSheetsCacheRef.current ?? localFallbackDbSheets ?? emptyHistoryDatabase();
      const accessibleTeamIdSet = new Set(accessibleTeamIds);
      // Rijen met een supabase_match_id zijn alleen een browsercache van de
      // centrale historie. Wanneer een wedstrijd centraal is verwijderd, mag
      // die oude cachekopie niet opnieuw in het overzicht terechtkomen.
      const cachedRemoteMatchIds = new Set(
        (local.matches ?? [])
          .filter((row: any) =>
            Boolean(String(row.supabase_match_id ?? "").trim()) &&
            accessibleTeamIdSet.has(String(row.team_id ?? ""))
          )
          .map((row: any) => String(row.wedstrijd_id ?? "").trim())
          .filter(Boolean)
      );
      const keepLocalMatch = (row: any) => {
        const teamId = String(row.team_id ?? "");
        const matchId = String(row.wedstrijd_id ?? "").trim();
        if (accessibleTeamIdSet.has(teamId) && Boolean(String(row.supabase_match_id ?? "").trim())) return false;
        return !accessibleTeamIdSet.has(teamId) || !remoteMatchIds.has(matchId);
      };
      const keepLocalDetail = (row: any) => {
        const matchId = String(row.wedstrijd_id ?? "").trim();
        return !remoteMatchIds.has(matchId) && !cachedRemoteMatchIds.has(matchId);
      };

      const merged: DatabaseSheetsData = {
        ...local,
        matches: [...(local.matches ?? []).filter(keepLocalMatch), ...remote.matches],
        events: [...(local.events ?? []).filter(keepLocalDetail), ...remote.events],
        attacks: [...(local.attacks ?? []).filter(keepLocalDetail), ...remote.attacks],
        wissels: [...(local.wissels ?? []).filter(keepLocalDetail), ...remote.wissels],
        vakperiodes: [...(local.vakperiodes ?? []).filter(keepLocalDetail), ...(remote.vakperiodes ?? [])],
      };

      setDbSheets(merged);
      setSupabaseHistoryCount(remote.matches.length);
      setLocalOnlyHistoryCount((local.matches ?? []).filter(keepLocalMatch).filter((row: any) => {
        const teamId = String(row.team_id ?? "");
        return !row.supabase_match_id && (accessibleTeamIdSet.has(teamId) || !teamId);
      }).length);
      setSupabaseHistoryStatus("ready");
      setSupabaseHistoryMessage(
        `${remote.matches.length} wedstrijd${remote.matches.length === 1 ? "" : "en"} van ${accessibleTeamIds.length} toegankelijk${accessibleTeamIds.length === 1 ? " team" : "e teams"} geladen.`
      );
      setDatabaseSetupOpen(false);
    };

    void loadSupabaseHistory();
    return () => { cancelled = true; };
  }, [databaseReady, authUser?.id, authProfile?.speler_naam, activeTeamId, isTruePlayerAccount, localFallbackDbSheets, historyRefreshVersion, teamContexts]);

  useEffect(() => {
    if (!databaseReady || !dbSheets) return;
    // Alleen TC/Admin onderhouden zolang fase 30 nog niet is uitgevoerd de
    // gedeelde migratiecache. Een coach mag zijn gefilterde weergave nooit
    // terugschrijven over cachegegevens van andere teams.
    if (isTruePlayerAccount || (!actualIsAdmin && !actualIsTc)) return;
    saveDatabaseToBrowser(dbSheets).catch((err) =>
      console.warn("Kon browserdatabase niet opslaan", err)
    );
  }, [dbSheets, databaseReady, isTruePlayerAccount, actualIsAdmin, actualIsTc]);

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
      const affectedVakId: VakId = vak === "aanvallend"
        ? (s.vak1Aanvallend ? 1 : 2)
        : (s.vak1Aanvallend ? 2 : 1);
  
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
  
      let next: AppState =
        vak === "aanvallend"
          ? { ...s, aanval: arr }
          : { ...s, verdediging: arr };

      // Tijdens een lopende/gestarte wedstrijd markeert iedere echte wissel een nieuwe
      // vakperiode. Vak 1/2 blijft de veldidentiteit; combinatieKey identificeert het viertal.
      if (logWissel && prevId !== spelerId && (s.tijdSeconden > 0 || s.attacks.length > 0 || s.klokLoopt)) {
        const periods = next.vakPeriods.map((period) =>
          period.vakId === affectedVakId && period.endSeconden == null
            ? { ...period, endSeconden: s.tijdSeconden }
            : period
        );
        const ids = playerIdsForVak(next, affectedVakId);
        periods.push({
          id: uid("vp"),
          vakId: affectedVakId,
          startSeconden: s.tijdSeconden,
          spelerIds: ids,
          combinatieKey: combinationKey(ids),
        });
        next = { ...next, vakPeriods: periods };
      }
  
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
      const initialized = ensureInitialVakPeriods(s);
      return { ...startAttackForVak(initialized, initialized.activeVak), klokLoopt: true };
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
    const eventVakId: VakId = vak === "aanvallend"
      ? (state.vak1Aanvallend ? 1 : 2)
      : (state.vak1Aanvallend ? 2 : 1);
    const eventSpelerIds = playerIdsForVak(state, eventVakId);

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
      vakId: eventVakId,
      spelerIds: eventSpelerIds,
      combinatieKey: combinationKey(eventSpelerIds),
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

// Fase 28: bouw één compleet pakket dat door save_match_bundle in één
// PostgreSQL-transactie wordt opgeslagen.
const buildSupabaseMatchBundle = (snapshot: AppState) => {
  const matchDate = snapshot.matchDate || new Date().toLocaleDateString("sv-SE");
  const opponentSlug = (snapshot.opponentName || "tegenstander")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "tegenstander";
  const legacyMatchId = snapshot.matchLegacyId ||
    `WED-${matchDate}-${snapshot.homeAway || "onbekend"}-${opponentSlug}`;

  const isCompetition = snapshot.matchType === "Competitie";
  const teamId = snapshot.matchTeamId || activeTeamContext?.teamId || "";
  const teamSeasonId = isCompetition
    ? (snapshot.matchTeamSeasonId || activeTeamContext?.id || "")
    : "";
  const seasonId = isCompetition
    ? (snapshot.matchSeasonId || activeTeamContext?.seasonId || "")
    : "";
  const teamName = snapshot.matchTeamName || activeTeamContext?.teamName || "Korbis";
  const seasonName = isCompetition
    ? (snapshot.matchSeasonName || activeTeamContext?.seasonName || snapshot.season)
    : "";

  if (!teamId) throw new Error("Er is geen team aan deze wedstrijd gekoppeld.");
  if (isCompetition && (!teamSeasonId || !seasonId)) {
    throw new Error("Er is geen geldige competitieperiode aan deze wedstrijd gekoppeld.");
  }

  const location = snapshot.homeAway === "thuis" ? "Thuis" : snapshot.homeAway === "uit" ? "Uit" : "";
  const opponentName = snapshot.opponentName.trim() || "Tegenstander";
  const matchName = snapshot.homeAway === "uit"
    ? `${opponentName} - ${teamName}`
    : `${teamName} - ${opponentName}`;
  const playerById = new Map(snapshot.spelers.map((player) => [player.id, player]));

  const chronologicalLog = snapshot.log.slice().reverse();
  let scoreFor = 0;
  let scoreAgainst = 0;
  const scoreAtEvent = new Map<string, { for: number; against: number }>();
  chronologicalLog.forEach((event) => {
    const ownGoal = event.soort === "Kans" && event.vak === "aanvallend" &&
      (event.reden === "Gescoord" || event.reden === "Doelpunt");
    const opponentGoal = event.soort === "Gemis" && event.vak === "verdedigend" &&
      (event.reden === "Doorgelaten" || event.reden === "Doelpunt");
    if (ownGoal) scoreFor += 1;
    if (opponentGoal) scoreAgainst += 1;
    scoreAtEvent.set(event.id, { for: scoreFor, against: scoreAgainst });
  });

  const findFieldEvent = (event: LogEvent) => {
    if (!event.attackId || !event.vak) return undefined;
    const candidates = snapshot.fieldEvents.filter(
      (fieldEvent) => fieldEvent.attackId === event.attackId && fieldEvent.vak === event.vak
    );
    return candidates.reduce<FieldEvent | undefined>((best, candidate) => {
      if (!best) return candidate;
      return Math.abs(candidate.tijdSeconden - event.tijdSeconden) <=
        Math.abs(best.tijdSeconden - event.tijdSeconden) ? candidate : best;
    }, undefined);
  };

  const halfSeconds = (Number.isFinite(snapshot.halfMinuten)
    ? snapshot.halfMinuten
    : DEFAULT_STATE.halfMinuten) * 60;

  const events = chronologicalLog
    .filter((event) => event.soort !== "Wissel")
    .map((event) => {
      const attack = event.attackId
        ? snapshot.attacks.find((candidate) => candidate.id === event.attackId)
        : undefined;
      const fieldEvent = findFieldEvent(event);
      const combinationPlayerIds = event.spelerIds ?? attack?.spelerIds ?? [];
      const eventScore = scoreAtEvent.get(event.id);
      const rawTeam = event.team ??
        (event.vak === "aanvallend" ? "thuis" : event.vak === "verdedigend" ? "uit" : undefined);
      const attackDuration = attack?.endSeconden != null
        ? Math.max(0, attack.endSeconden - attack.startSeconden)
        : null;
      const playerId = event.spelerId && event.spelerId !== TEGENSTANDER_ID
        ? event.spelerId
        : null;

      return {
        source_event_id: event.id,
        elapsed_seconds: event.tijdSeconden,
        remaining_seconds: event.resterendSeconden ?? Math.max(halfSeconds - (event.tijdSeconden % halfSeconds), 0),
        match_minute: event.wedstrijdMinuut ?? Math.max(1, Math.ceil(event.tijdSeconden / 60)),
        vak: event.vak ?? null,
        vak_id: event.vakId ?? attack?.vakId ?? null,
        combination_key: event.combinatieKey ?? attack?.combinatieKey ?? null,
        combination_player_ids: combinationPlayerIds,
        team_label: rawTeam === "thuis" ? teamName : rawTeam === "uit" ? opponentName : null,
        action: event.actie ?? event.type ?? event.soort,
        result: event.resultaat ?? null,
        reason: event.reden,
        player_id: playerId,
        player_name_snapshot: event.spelerId === TEGENSTANDER_ID
          ? "Tegenstander"
          : playerId ? playerById.get(playerId)?.naam ?? null : null,
        score_for: eventScore?.for ?? null,
        score_against: eventScore?.against ?? null,
        x_pct: fieldEvent ? Number(fieldEvent.x.toFixed(1)) : null,
        y_pct: fieldEvent ? Number(fieldEvent.y.toFixed(1)) : null,
        attack_number: event.attackIndex ?? attack?.index ?? null,
        attack_start_seconds: attack?.startSeconden ?? null,
        attack_end_seconds: attack?.endSeconden ?? null,
        attack_duration_seconds: attackDuration,
        payload: { ...event, field_event: fieldEvent ?? null },
      };
    });

  const attacks = snapshot.attacks.map((attack) => {
    const attackEvents = snapshot.log.filter((event) => event.attackId === attack.id);
    const endSeconds = attack.endSeconden ?? snapshot.tijdSeconden;
    return {
      attack_number: attack.index,
      team_label: attack.team === "thuis" ? teamName : opponentName,
      vak: attack.vak,
      vak_id: attack.vakId ?? null,
      combination_key: attack.combinatieKey ?? null,
      combination_player_ids: attack.spelerIds ?? [],
      start_seconds: attack.startSeconden,
      end_seconds: endSeconds,
      duration_seconds: Math.max(0, endSeconds - attack.startSeconden),
      shots: attackEvents.filter((event) => event.actie === "Schot").length,
      run_throughs: attackEvents.filter((event) => event.actie === "Doorloop").length,
      free_balls: attackEvents.filter((event) => event.actie === "Vrijebal").length,
      penalties: attackEvents.filter((event) => event.actie === "Strafworp").length,
      payload: attack,
    };
  });

  const substitutions = chronologicalLog
    .filter((event) => event.soort === "Wissel")
    .map((event) => {
      const eventScore = scoreAtEvent.get(event.id);
      const rawTeam = event.team ??
        (event.vak === "aanvallend" ? "thuis" : event.vak === "verdedigend" ? "uit" : undefined);
      const playerId = event.spelerId && event.spelerId !== TEGENSTANDER_ID
        ? event.spelerId
        : null;
      return {
        source_event_id: event.id,
        elapsed_seconds: event.tijdSeconden,
        match_minute: event.wedstrijdMinuut ?? Math.max(1, Math.ceil(event.tijdSeconden / 60)),
        vak: event.vak ?? null,
        vak_id: event.vakId ?? null,
        team_label: rawTeam === "thuis" ? teamName : rawTeam === "uit" ? opponentName : null,
        position: event.pos ?? null,
        substitution_type: event.reden,
        player_id: playerId,
        player_name_snapshot: playerId ? playerById.get(playerId)?.naam ?? null : null,
        score_for: eventScore?.for ?? null,
        score_against: eventScore?.against ?? null,
        payload: event,
      };
    });

  const vakPeriods = snapshot.vakPeriods.map((period) => {
    const endSeconds = period.endSeconden ?? snapshot.tijdSeconden;
    return {
      source_period_id: period.id,
      vak_id: String(period.vakId),
      start_seconds: period.startSeconden,
      end_seconds: endSeconds,
      duration_seconds: Math.max(0, endSeconds - period.startSeconden),
      combination_key: period.combinatieKey,
      combination_player_ids: period.spelerIds,
      payload: period,
    };
  });

  const possessionTotal = snapshot.possessionThuisSeconden + snapshot.possessionUitSeconden;
  let attackForSeconds = 0;
  let attackAgainstSeconds = 0;
  snapshot.attacks.forEach((attack) => {
    const endSeconds = attack.endSeconden ?? snapshot.tijdSeconden;
    const duration = Math.max(0, endSeconds - attack.startSeconden);
    if (attack.team === "thuis" && attack.vak === "aanvallend") attackForSeconds += duration;
    if (attack.team === "uit" && attack.vak === "verdedigend") attackAgainstSeconds += duration;
  });
  const attackTotal = attackForSeconds + attackAgainstSeconds;

  const match = {
    legacy_match_id: legacyMatchId,
    team_id: teamId,
    team_season_id: teamSeasonId || null,
    season_id: seasonId || null,
    team_name_snapshot: teamName,
    season_name_snapshot: seasonName || null,
    match_type: snapshot.matchType,
    match_date: matchDate,
    location: location || null,
    opponent_name: opponentName,
    match_name: matchName,
    half_duration_minutes: snapshot.halfMinuten,
    score_for: snapshot.scoreThuis,
    score_against: snapshot.scoreUit,
    possession_for_seconds: snapshot.possessionThuisSeconden,
    possession_against_seconds: snapshot.possessionUitSeconden,
    possession_for_pct: possessionTotal ? Number((snapshot.possessionThuisSeconden / possessionTotal * 100).toFixed(2)) : null,
    possession_against_pct: possessionTotal ? Number((snapshot.possessionUitSeconden / possessionTotal * 100).toFixed(2)) : null,
    attack_for_seconds: attackForSeconds,
    attack_against_seconds: attackAgainstSeconds,
    attack_for_pct: attackTotal ? Number((attackForSeconds / attackTotal * 100).toFixed(2)) : null,
    attack_against_pct: attackTotal ? Number((attackAgainstSeconds / attackTotal * 100).toFixed(2)) : null,
    player_playtime: snapshot.spelers.map((player) => ({
      player_id: player.id,
      player_name: player.naam,
      status: player.status,
      seconds: snapshot.speelSeconden[player.id] ?? 0,
    })),
    match_closed: snapshot.matchEnded,
    payload: {
      korbiq_phase: 28,
      local_match_id: legacyMatchId,
      state: snapshot,
    },
  };

  return { match, events, attacks, substitutions, vak_periods: vakPeriods };
};

const saveMatchToSupabase = async (snapshot: AppState) => {
  setMatchSaveStatus("saving");
  setMatchSaveMessage("Wedstrijd wordt veilig opgeslagen in Supabase…");
  try {
    const bundle = buildSupabaseMatchBundle(snapshot);
    const { data, error } = await supabase.rpc("save_match_bundle", { p_bundle: bundle });
    if (error) throw error;
    const result = data as any;
    setMatchSaveStatus("saved");
    setMatchSaveMessage(
      `Opgeslagen in Supabase: ${Number(result?.events ?? bundle.events.length)} acties, ` +
      `${Number(result?.attacks ?? bundle.attacks.length)} aanvallen, ` +
      `${Number(result?.substitutions ?? bundle.substitutions.length)} wissels en ` +
      `${Number(result?.vak_periods ?? bundle.vak_periods.length)} vakperiodes.`
    );
    setHistoryRefreshVersion((version) => version + 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setMatchSaveStatus("error");
    setMatchSaveMessage(`Opslaan in Supabase is mislukt: ${message}`);
  }
};

const retrySupabaseMatchSave = () => {
  if (!state.matchEnded) return;
  void saveMatchToSupabase(state);
};

const wisSeizoensdatabase = () => {
  const ok = confirm(
    "Lokale historiecache wissen?\n\nDe centrale wedstrijdhistorie in Supabase blijft behouden en wordt daarna opnieuw geladen. Alleen lokale historie die nog niet centraal is opgeslagen verdwijnt uit deze browser."
  );
  if (!ok) return;

  const vak1Ids = state.vak1Aanvallend ? state.aanval : state.verdediging;
  const vak2Ids = state.vak1Aanvallend ? state.verdediging : state.aanval;
  const spelerById = new Map(state.spelers.map((p) => [p.id, p]));
  const emptyDatabase: DatabaseSheetsData = {
    events: [],
    attacks: [],
    wissels: [],
    vakperiodes: [],
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

  setLocalFallbackDbSheets(emptyDatabase);
  setDbSheets(emptyDatabase);
  setDatabaseSetupOpen(false);
  saveDatabaseToBrowser(emptyDatabase).catch((err) =>
    console.warn("Kon lege browserdatabase niet opslaan", err)
  );
};

const resetAlles = () => {
  if (!confirm("Lokale appinstellingen en cache wissen? De centrale wedstrijdhistorie in Supabase blijft behouden.")) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  setLocalFallbackDbSheets(emptyHistoryDatabase());
  setDbSheets(emptyHistoryDatabase());
  setDatabaseSetupOpen(false);
  clearDatabaseFromBrowser().catch((err) => console.warn("Kon browserdatabase niet wissen", err));
  setState({ 
    ...DEFAULT_STATE,
    attacks: [],
    currentAttackId: null,
    vakPeriods: [],
  });
};

const eindeWedstrijd = () => {
  const ok = confirm(
    "Weet je zeker dat je de wedstrijd wilt beëindigen? Hierna kunnen geen nieuwe acties meer worden geregistreerd."
  );

  if (!ok) return;

  const now = state.tijdSeconden;
  const attacks = [...state.attacks];

  if (state.currentAttackId) {
      const idx = attacks.findIndex(
        (a) => a.id === state.currentAttackId
      );

      if (idx >= 0 && attacks[idx].endSeconden == null) {
        attacks[idx] = {
          ...attacks[idx],
          endSeconden: now,
        };
      }
  }

  const vakPeriods = state.vakPeriods.map((period) =>
    period.endSeconden == null ? { ...period, endSeconden: now } : period
  );
  const matchDate = state.matchDate || new Date().toLocaleDateString("sv-SE");
  const opponentSlug = (state.opponentName || "tegenstander")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "tegenstander";
  const matchLegacyId = state.matchLegacyId ||
    `WED-${matchDate}-${state.homeAway || "onbekend"}-${opponentSlug}`;

  const finishedState: AppState = {
    ...state,
    klokLoopt: false,
    matchEnded: true,
    attacks,
    currentAttackId: null,
    vakPeriods,
    matchDate,
    matchLegacyId,
  };

  setState(finishedState);
  setTab("verslag");
  void saveMatchToSupabase(finishedState);
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
    vakperiodes: [],
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

  setLocalFallbackDbSheets(emptyDatabase);
  setDbSheets(emptyDatabase);
  setDatabaseSetupOpen(false);
  // Een nieuwe database is direct klaar voor het instellen van de eerste wedstrijd.
  setTab("vakken");
};

const hasCurrentMatchData =
  state.klokLoopt ||
  state.tijdSeconden > 0 ||
  state.scoreThuis > 0 ||
  state.scoreUit > 0 ||
  state.log.length > 0 ||
  state.fieldEvents.length > 0 ||
  state.attacks.length > 0 ||
  Boolean(state.opponentName.trim()) ||
  Boolean(state.homeAway);

const requestNieuweWedstrijd = () => {
  if (!databaseReady || !dbSheets) {
    setDatabaseSetupOpen(true);
    return;
  }

  // Alleen waarschuwen wanneer er daadwerkelijk gegevens van een huidige
  // wedstrijd verloren kunnen gaan. Na een reset kan de gebruiker dus
  // direct door naar Wedstrijdinstellingen.
  if (hasCurrentMatchData) {
    const confirmed = confirm(
      "Nieuwe wedstrijd starten? De huidige, nog niet afgeronde wedstrijdgegevens worden uit de app verwijderd. Rond de wedstrijd eerst af als je deze wilt bewaren."
    );
    if (!confirmed) return;
  }

  clearWedstrijd(undefined, false);
  setTab("vakken");
};

const clearWedstrijd = (
  warningText = "Nieuwe wedstrijd starten? De huidige wedstrijdgegevens worden uit de app verwijderd. Rond de wedstrijd eerst af als je deze centraal wilt bewaren.",
  askConfirmation = true
) => {
  if (askConfirmation && !confirm(warningText)) {
    return;
  }

  setMatchSaveStatus("idle");
  setMatchSaveMessage("");

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
    vakPeriods: [],
    goalsSinceLastSwitch: 0,

    fieldEvents: [],
    markerGroup: 0,

    aanvalLinks: DEFAULT_STATE.aanvalLinks,
    activeVak: "aanvallend",
    vak1Aanvallend: true,

    opponentName: "",
    homeAway: "",
    matchEnded: false,
    matchTeamSeasonId: state.matchType === "Competitie" ? (activeTeamContext?.id ?? "") : "",
    matchTeamId: activeTeamContext?.teamId ?? "",
    matchTeamName: activeTeamContext?.teamName ?? "",
    matchSeasonId: state.matchType === "Competitie" ? (activeTeamContext?.seasonId ?? "") : "",
    matchSeasonName: state.matchType === "Competitie" ? (activeTeamContext?.seasonName ?? "") : "",
    matchDate: "",
    matchLegacyId: "",
  }));
};

// Afgeleide arrays voor modal
const spelersAanval = state.aanval.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));
const spelersVerdediging = state.verdediging.map((id) => (id ? spelersMap.get(id) : undefined)).filter((x): x is Player => Boolean(x));
const databaseMatches = dbSheets?.matches ?? [];
const latestDatabaseMatch = (activeTeamDbSheets?.matches ?? []).slice().sort((a:any,b:any)=>{ const av = typeof a.datum === "number" ? a.datum : Date.parse(String(a.datum ?? "")); const bv = typeof b.datum === "number" ? b.datum : Date.parse(String(b.datum ?? "")); return av - bv; }).at(-1);
const latestShareableDatabaseMatch = (activeTeamDbSheets?.matches ?? []).filter((m:any)=>Boolean(m.supabase_match_id)&&!Boolean(m.gearchiveerd)&&String(m.wedstrijd_afgesloten??"").toLowerCase()==="ja").slice().sort((a:any,b:any)=>String(b.datum??"").localeCompare(String(a.datum??"")))[0] ?? null;
const archivedHistoryCount = (activeTeamHistoryDbSheets?.matches ?? []).filter((m:any)=>Boolean(m.gearchiveerd)).length;
const activeSupabaseHistoryCount = (activeTeamDbSheets?.matches ?? []).filter((m:any)=>Boolean(m.supabase_match_id)).length;
const historySourceLabel = !databaseReady || supabaseHistoryStatus === "loading"
  ? "● Supabase-historie laden…"
  : supabaseHistoryStatus === "ready"
  ? isTruePlayerAccount
    ? `● Mijn historie · ${supabaseHistoryCount}`
    : `● Supabase ${supabaseHistoryCount} · lokaal ${localOnlyHistoryCount}`
  : supabaseHistoryStatus === "error"
  ? "● Lokale terugval actief"
  : "● Historie voorbereiden…";
const historySourceReady = supabaseHistoryStatus === "ready";
const verifiedPortalPlayer = portalPlayerFromSupabase?.id === authProfile?.speler_id
  ? portalPlayerFromSupabase
  : null;


  //////////////////////////////////////////////////////////////////////////////
  // UI ------------------------------------------------------------------------
  //////////////////////////////////////////////////////////////////////////////
  const sectionTitle: Record<typeof tab, string> = {
    dashboard: "Coach Dashboard",
    wedstrijdinzichten: "Wedstrijdinzichten",
    spelersanalyse: "Spelerinzichten",
    teamanalyse: "Team & Vakken",
    spelers: "Spelers beheren",
    personenbeheer: "Personen",
    teamsbeheer: "Teams",
    seizoenenbeheer: "Seizoenen",
    wedstrijdbeheer: "Wedstrijden beheren",
    vakken: "Wedstrijdinstellingen",
    wedstrijd: "Wedstrijdregistratie",
    verslag: "Wedstrijdverslag",
    voorbereiding: "Wedstrijdvoorbereiding",
    insights: "Insights & analyse",
    combinaties: "Vakcombinaties",
    seizoen: "Seizoensdashboard",
    profielen: "Spelerprofielen",
    opstelling: "Opstellingsassistent",
    wisseladvies: "Speeltijd & wisseladvies",
    doelen: "Wedstrijddoelen",
    portaal: "Spelersportaal",
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

  const CollapsibleNavSection = ({
    section,
    label,
    children,
    mobile = false,
  }: {
    section: "wedstrijd" | "analyse" | "coaching" | "beheer";
    label: string;
    children: React.ReactNode;
    mobile?: boolean;
  }) => {
    const open = navSectionsOpen[section];
    const hasFixture = Boolean(state.opponentName.trim());
    const hasRecordedProgress = state.klokLoopt || state.tijdSeconden > 0 || state.scoreThuis > 0 || state.scoreUit > 0 || state.log.length > 0 || state.fieldEvents.length > 0 || state.attacks.length > 0;
    const isActiveMatch = section === "wedstrijd" && hasFixture && !state.matchEnded && hasRecordedProgress;
    const ownTeamLabel = state.matchTeamName || activeTeamContext?.teamName || "Korbis";
    const fixture = state.homeAway === "uit" ? `${state.opponentName} – ${ownTeamLabel}` : `${ownTeamLabel} – ${state.opponentName}`;
    const matchMinute = state.tijdSeconden > 0 ? `${Math.max(1, Math.ceil(state.tijdSeconden / 60))}e minuut` : "Klaar voor start";
    return (
      <section className={mobile ? "border-t border-slate-200 pt-2" : "border-t border-slate-200 pt-2 first:border-t-0 first:pt-0"}>
        <button
          type="button"
          onClick={() => setNavSectionsOpen((prev) => ({
            wedstrijd: section === "wedstrijd" ? !prev.wedstrijd : false,
            analyse: section === "analyse" ? !prev.analyse : false,
            coaching: section === "coaching" ? !prev.coaching : false,
            beheer: section === "beheer" ? !prev.beheer : false,
          }))}
          className={`flex w-full items-start justify-between rounded-xl px-3 text-left transition hover:bg-slate-50 ${isActiveMatch ? "py-3" : "py-2"} ${open ? "text-blue-700" : "text-slate-600"}`}
          aria-expanded={open}
        >
          <span className="min-w-0">
            <span className="block text-[11px] font-extrabold uppercase tracking-[0.12em]">{label}</span>
            {isActiveMatch && <span className="mt-1 block">
              <span className="block truncate text-xs font-black normal-case tracking-normal text-slate-900">● {fixture}</span>
              <span className="mt-0.5 block text-[11px] font-bold normal-case tracking-normal text-blue-700">{matchMinute} · {state.scoreThuis} – {state.scoreUit}</span>
            </span>}
          </span>
          <span className={`text-sm transition-transform duration-200 ${open ? "rotate-180" : ""}`}>⌄</span>
        </button>
        {open && <div className={`mt-1 space-y-1 ${mobile ? "pb-2" : "pb-1"}`}>{children}</div>}
      </section>
    );
  };

  const sharedMatchRoute = window.location.pathname.replace(/\/+$/, "").match(/^\/wedstrijd-delen\/([0-9a-f-]{36})$/i);
  if (sharedMatchRoute) return <PublicSharedMatchPage token={sharedMatchRoute[1]} />;

  const isAccountActivationRoute = window.location.pathname.replace(/\/+$/, "") === "/account-activate";
  if (isAccountActivationRoute) return <AccountActivationScreen />;

  if (!authReady) return <div className="flex min-h-screen items-center justify-center bg-[#f6f8fc] text-sm font-semibold text-slate-500">KorbIQ account controleren…</div>;

  if (!authUser) return <KorbIQLogin />;

  if (!authProfile) return <div className="min-h-screen bg-[#f6f8fc] p-6"><div className="mx-auto mt-16 max-w-xl rounded-3xl border border-red-200 bg-white p-6 shadow-sm"><KorbIQLogo /><h2 className="mt-6 text-xl font-black">Accountprofiel niet beschikbaar</h2><p className="mt-2 text-sm text-slate-600">KorbIQ kon je profiel in Supabase niet laden.</p>{authError && <div className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{authError}</div>}<button onClick={()=>void supabase.auth.signOut()} className="mt-5 rounded-xl border px-4 py-2 text-sm font-bold">Uitloggen</button></div></div>;

  if (!accessReady) return <div className="flex min-h-screen items-center justify-center bg-[#f6f8fc] text-sm font-semibold text-slate-500">KorbIQ rechten en teams laden…</div>;

  if (accessError) return <div className="min-h-screen bg-[#f6f8fc] p-6"><div className="mx-auto mt-16 max-w-xl rounded-3xl border border-red-200 bg-white p-6 shadow-sm"><KorbIQLogo /><h2 className="mt-6 text-xl font-black">Rechten konden niet worden geladen</h2><p className="mt-2 text-sm text-slate-600">Controleer de nieuwe Supabase-tabellen en RLS-regels.</p><div className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{accessError}</div><button onClick={()=>void refreshAccess()} className="mt-5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white">Opnieuw proberen</button></div></div>;

  if (historyOwnerUserId !== authUser.id) return <div className="flex min-h-screen items-center justify-center bg-[#f6f8fc] text-sm font-semibold text-slate-500">Persoonlijke KorbIQ-omgeving voorbereiden…</div>;

  if (actualIsCoachRole && !actualIsAdmin && !actualIsTc && !activeTeamId) return <div className="min-h-screen bg-[#f6f8fc] p-6"><div className="mx-auto mt-16 max-w-xl rounded-3xl border border-amber-200 bg-white p-6 shadow-sm"><KorbIQLogo /><div className="mt-6 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-amber-800">Nog geen teamtoegang</div><h2 className="mt-3 text-xl font-black">Je coachaccount is nog niet aan een team gekoppeld</h2><p className="mt-2 text-sm leading-6 text-slate-600">Totdat een TC-lid of beheerder je aan minimaal één team koppelt, toont KorbIQ geen spelers, wedstrijden, lokale cache of analyses.</p><div className="mt-5 flex flex-wrap gap-3"><button onClick={()=>void refreshAccess()} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white">Toegang opnieuw controleren</button><button onClick={()=>void supabase.auth.signOut()} className="rounded-xl border bg-white px-4 py-2 text-sm font-bold text-slate-600">Uitloggen</button></div></div></div>;

  if (isTruePlayerAccount) return <div className="min-h-screen bg-[#f6f8fc] text-slate-900"><header className="border-b bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4"><KorbIQLogo /><div className="flex items-center gap-3"><div className="hidden text-right sm:block"><div className="text-xs font-bold uppercase tracking-wide text-blue-700">Speleraccount</div><div className="text-sm font-semibold text-slate-600">{authProfile.speler_naam || authProfile.email}</div></div><button onClick={()=>void supabase.auth.signOut()} className="rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Uitloggen</button></div></div></header><main className="mx-auto max-w-6xl p-4 sm:p-6">{supabaseHistoryStatus === "loading" && <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">Persoonlijke wedstrijdhistorie veilig laden…</div>}{supabaseHistoryStatus === "error" && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">{supabaseHistoryMessage}</div>}<SpelersportaalDashboard state={state} dbSheets={verifiedPortalPlayer && supabaseHistoryStatus === "ready" ? activeTeamDbSheets : emptyHistoryDatabase()} selectedPlayerId={authProfile.speler_id ?? ""} onSelectPlayer={()=>{}} locked playerOverride={verifiedPortalPlayer} /></main></div>;

  if (!hasStaffRole) return <div className="min-h-screen bg-[#f6f8fc] p-6"><div className="mx-auto mt-16 max-w-xl rounded-3xl border border-amber-200 bg-white p-6 shadow-sm"><KorbIQLogo /><h2 className="mt-6 text-xl font-black">Nog geen actieve KorbIQ-rol</h2><p className="mt-2 text-sm text-slate-600">Dit account is ingelogd, maar heeft nog geen actieve Admin-, TC- of Coachrol in de nieuwe rechtenstructuur.</p><button onClick={()=>void supabase.auth.signOut()} className="mt-5 rounded-xl border px-4 py-2 text-sm font-bold">Uitloggen</button></div></div>;

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
        <aside className="korbiq-desktop-sidebar sticky top-0 h-screen w-[250px] shrink-0 overflow-y-auto overscroll-contain border-r border-slate-200/90 bg-white px-4 py-5 shadow-[2px_0_16px_rgba(15,23,42,0.025)]">
          <div className="px-2 pb-4"><KorbIQLogo /></div>
          <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="flex items-center justify-between gap-2"><div className="text-[10px] font-extrabold uppercase tracking-wide text-blue-700">{roleLabel(primaryRole)}</div><span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500 ring-1 ring-slate-200">Korbis</span></div>
            <div className="mt-0.5 truncate text-xs font-semibold text-slate-600">{authProfile.email ?? authUser.email}</div>
            {teamOptions.length > 0 && <label className="mt-2 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Actief team<select value={activeTeamId} onChange={e=>selectTeam(e.target.value)} disabled={currentMatchHasDataForTeamLock && !state.matchEnded && Boolean(state.matchTeamId)} title={currentMatchHasDataForTeamLock && !state.matchEnded && state.matchTeamId ? "Team staat vast tijdens een lopende wedstrijd" : "Actief team kiezen"} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold normal-case text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400">{teamOptions.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
            {!teamOptions.length && <div className="mt-2 text-[11px] text-amber-700">Nog geen team beschikbaar.</div>}
            <button onClick={()=>void supabase.auth.signOut()} className="mt-2 text-xs font-bold text-slate-500 hover:text-blue-700">Uitloggen</button>
          </div>

          <nav className="space-y-2">
            <CollapsibleNavSection section="wedstrijd" label="Wedstrijd">
              <button onClick={requestNieuweWedstrijd} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"><span className="text-xl leading-none font-light">＋</span><span>Nieuwe wedstrijd</span></button>
              <SideNavButton id="wedstrijd" label="Huidige wedstrijd" icon="match" />
              <SideNavButton id="vakken" label="Wedstrijdinstellingen" icon="settings" />
              <SideNavButton id="verslag" label="Wedstrijdverslag" icon="insights" />
              <SideNavButton id="voorbereiding" label="Voorbereiding" icon="insights" />
            </CollapsibleNavSection>

            <CollapsibleNavSection section="analyse" label="Analyse">
              <SideNavButton id="dashboard" label="Coach Dashboard" icon="season" />
              <SideNavButton id="wedstrijdinzichten" label="Wedstrijdinzichten" icon="match" />
              <SideNavButton id="spelersanalyse" label="Spelerinzichten" icon="players" />
              <SideNavButton id="teamanalyse" label="Team & Vakken" icon="insights" />
            </CollapsibleNavSection>

            <CollapsibleNavSection section="coaching" label="Coaching">
              <SideNavButton id="opstelling" label="Opstellingsassistent" icon="players" />
              <SideNavButton id="wisseladvies" label="Speeltijd & wisseladvies" icon="season" />
              <SideNavButton id="doelen" label="Wedstrijddoelen" icon="insights" />
              <SideNavButton id="portaal" label="Spelersportaal" icon="players" />
            </CollapsibleNavSection>

            <CollapsibleNavSection section="beheer" label="Beheer">
              <SideNavButton id="wedstrijdbeheer" label="Wedstrijden" icon="match" />
              {canManageOrganisation && <>
                <SideNavButton id="personenbeheer" label="Personen" icon="players" />
                <SideNavButton id="teamsbeheer" label="Teams" icon="settings" />
                <SideNavButton id="seizoenenbeheer" label="Seizoenen" icon="season" />
              </>}
              <button onClick={wisSeizoensdatabase} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-orange-700 transition hover:bg-orange-50"><NavGlyph type="reset"/><span>Lokale historie wissen</span></button>
              <button onClick={resetAlles} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-red-600 transition hover:bg-red-50"><NavGlyph type="reset"/><span>Reset alles</span></button>
            </CollapsibleNavSection>
          </nav>

          <div className="mt-5 rounded-2xl bg-slate-50 p-3 text-xs text-slate-500 ring-1 ring-slate-200">
            <div className="font-bold text-slate-700">{state.season}</div>
            <div className="mt-1">{databaseMatches.length} wedstrijd{databaseMatches.length === 1 ? "" : "en"} opgeslagen</div>
            <div className={`mt-2 font-semibold ${historySourceReady ? "text-emerald-700" : "text-amber-700"}`} title={supabaseHistoryMessage}>
              {historySourceLabel}
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
                    {state.matchTeamSeasonId && currentMatchHasDataForTeamLock ? `${state.matchTeamName || activeTeamContext?.teamName || "Korbis"} · ${state.matchSeasonName || activeTeamContext?.seasonName || ""}${state.opponentName ? ` · ${state.opponentName}` : ""}` : activeTeamContext ? `${activeTeamContext.teamName}${state.opponentName ? ` · ${state.opponentName}` : ""}` : (state.opponentName ? `Korbis · ${state.opponentName}` : "KorbIQ · wedstrijddata en coaching")}
                  </div>
                </div>
              </div>
              <div className="hidden items-center gap-3 text-xs md:flex">
                {latestDatabaseMatch && <span className="text-slate-500">Laatste: {formatImportedDate(latestDatabaseMatch.datum)}{latestDatabaseMatch.tegenstander ? ` · ${latestDatabaseMatch.tegenstander}` : ""}</span>}
                <span title={supabaseHistoryMessage} className={`rounded-full px-3 py-1.5 font-semibold ${historySourceReady ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                  {historySourceLabel}
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
              <div className="lg:hidden max-h-[calc(100vh-70px)] overflow-y-auto overscroll-contain border-t border-slate-200 bg-white px-4 py-4 shadow-lg">
                <div className="mx-auto max-w-xl space-y-4">
                  <CollapsibleNavSection section="wedstrijd" label="Wedstrijd" mobile>
                    <button onClick={() => { setMobileMenuOpen(false); requestNieuweWedstrijd(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><span className="text-xl leading-none font-light">＋</span><span>Nieuwe wedstrijd</span></button>
                    <SideNavButton id="wedstrijd" label="Huidige wedstrijd" icon="match" />
                    <SideNavButton id="vakken" label="Wedstrijdinstellingen" icon="settings" />
                    <SideNavButton id="verslag" label="Wedstrijdverslag" icon="insights" />
                    <SideNavButton id="voorbereiding" label="Voorbereiding" icon="insights" />
                  </CollapsibleNavSection>
                  <CollapsibleNavSection section="analyse" label="Analyse" mobile>
                    <SideNavButton id="dashboard" label="Coach Dashboard" icon="season" />
                    <SideNavButton id="wedstrijdinzichten" label="Wedstrijdinzichten" icon="match" />
                    <SideNavButton id="spelersanalyse" label="Spelerinzichten" icon="players" />
                    <SideNavButton id="teamanalyse" label="Team & Vakken" icon="insights" />
                  </CollapsibleNavSection>
                  <CollapsibleNavSection section="coaching" label="Coaching" mobile>
                    <SideNavButton id="opstelling" label="Opstellingsassistent" icon="players" />
                    <SideNavButton id="wisseladvies" label="Speeltijd & wisseladvies" icon="season" />
                    <SideNavButton id="doelen" label="Wedstrijddoelen" icon="insights" />
                    <SideNavButton id="portaal" label="Spelersportaal" icon="players" />
                  </CollapsibleNavSection>
                  <CollapsibleNavSection section="beheer" label="Beheer" mobile>
                    <SideNavButton id="wedstrijdbeheer" label="Wedstrijden" icon="match" />
                    {canManageOrganisation && <>
                      <SideNavButton id="personenbeheer" label="Personen" icon="players" />
                      <SideNavButton id="teamsbeheer" label="Teams" icon="settings" />
                      <SideNavButton id="seizoenenbeheer" label="Seizoenen" icon="season" />
                    </>}
                    <button onClick={() => { setMobileMenuOpen(false); wisSeizoensdatabase(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-orange-700 hover:bg-orange-50"><NavGlyph type="reset"/><span>Lokale historie wissen</span></button>
                    <button onClick={() => { setMobileMenuOpen(false); resetAlles(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold text-red-600 hover:bg-red-50"><NavGlyph type="reset"/><span>Reset alles</span></button>
                  </CollapsibleNavSection>
                  <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500 ring-1 ring-slate-200">
                    <div className="font-bold text-slate-700">{state.season}</div>
                    <div className="mt-1">{databaseMatches.length} wedstrijd{databaseMatches.length === 1 ? "" : "en"} opgeslagen</div>
                    <div className={`mt-2 font-semibold ${historySourceReady ? "text-emerald-700" : "text-amber-700"}`} title={supabaseHistoryMessage}>
                      {historySourceLabel}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="overflow-x-auto border-t border-slate-100 lg:hidden">
              <div className="grid min-w-[650px] grid-cols-5 bg-white px-3">
                {([
                  { id: "dashboard", label: "Dashboard" },
                  { id: "spelersanalyse", label: "Spelers" },
                  { id: "teamanalyse", label: "Team" },
                  { id: "wedstrijd", label: "Wedstrijd" },
                  { id: "wisseladvies", label: "Wissels" },
                ] as const).map((t) => <button key={t.id} onClick={() => setTab(t.id)} className={`border-b-2 px-3 py-3 text-sm font-semibold ${tab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500"}`}>{t.label}</button>)}
              </div>
            </div>
          </header>

          <main className="korbiq-main mx-auto w-full max-w-[1500px] px-4 py-5 md:px-6 md:py-7 xl:px-8">
      {(teamRosterLoading || teamRosterError) && <div className={`mb-4 rounded-xl border px-3 py-2 text-xs font-semibold ${teamRosterError?"border-red-200 bg-red-50 text-red-700":"border-blue-100 bg-blue-50 text-blue-700"}`}>{teamRosterError?`Teamselectie kon niet uit Supabase worden geladen: ${teamRosterError}`:"Teamselectie uit Supabase laden…"}</div>}
      {supabaseHistoryStatus === "error" && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"><span>{supabaseHistoryMessage} De lokaal bewaarde historie blijft beschikbaar.</span><button type="button" onClick={()=>setHistoryRefreshVersion(version=>version+1)} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-bold">Opnieuw proberen</button></div>}
      {analysisTabs.includes(tab) && (
        <div className="mb-5 rounded-2xl border border-blue-100 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-blue-700">Analysefilter</div>
              <div className="mt-0.5 text-sm font-black text-slate-900">{activeTeamContext?.teamName ?? "Actief team"}</div>
              <div className="mt-1 text-xs text-slate-500">Standaard wordt alleen competitie-data van het gekozen team meegenomen.</div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-extrabold uppercase tracking-wide">
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">Supabase actief: {activeSupabaseHistoryCount}</span>
                {archivedHistoryCount>0&&<span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">Gearchiveerd: {archivedHistoryCount}</span>}
                <span className={`rounded-full px-2.5 py-1 ${localOnlyHistoryCount ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"}`}>Alleen lokaal: {localOnlyHistoryCount}</span>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[520px]">
              <label className="text-xs font-bold text-slate-600">Competitiejaar
                <select value={analysisCompetitionYear} onChange={e=>setAnalysisCompetitionYear(e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-800">
                  {analysisCompetitionYears.length ? analysisCompetitionYears.map(year=><option key={year} value={year}>{year}</option>) : <option value="">Geen competitiejaar</option>}
                </select>
              </label>
              <label className="text-xs font-bold text-slate-600">Periode
                <select value={analysisPeriod} onChange={e=>setAnalysisPeriod(e.target.value as AnalysisPeriodFilter)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-800">
                  <option value="all">Hele competitiejaar</option>
                  <option value="veld_najaar">Veld najaar</option>
                  <option value="zaal">Zaal</option>
                  <option value="veld_voorjaar">Veld voorjaar</option>
                </select>
              </label>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="rounded-full bg-blue-50 px-2.5 py-1 font-bold text-blue-700">{analysisDbSheets?.matches.length ?? 0} competitiewedstrijd{(analysisDbSheets?.matches.length ?? 0)===1?"":"en"}</span>
            <span>{analysisCompetitionYear || "—"} · {analysisPeriod==="all"?"hele competitiejaar":analysisPeriod==="veld_najaar"?"veld najaar":analysisPeriod==="zaal"?"zaal":"veld voorjaar"}</span>
          </div>
        </div>
      )}
      {legacyUnlinkedMatchCount > 0 && ["dashboard","spelersanalyse","teamanalyse","insights","combinaties","profielen","opstelling","wisseladvies","doelen","voorbereiding","seizoen"].includes(tab) && (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>Oude wedstrijddata:</b> {legacyUnlinkedMatchCount} wedstrijd{legacyUnlinkedMatchCount === 1 ? "" : "en"} zonder teamkoppeling {legacyUnlinkedMatchCount === 1 ? "wordt" : "worden"} niet meegenomen in de analyse van <b>{activeTeamContext?.teamName ?? "het actieve team"}</b>. Deze data kunnen we later éénmalig aan het juiste team koppelen.
        </div>
      )}
      {tab === "personenbeheer" && canManageOrganisation && (
        <OrganisationManagementDashboard mode="personen" isAdmin={isAdmin} isTcMember={actualIsTc} showTestData={showTestTeams} teamContexts={teamContexts} onRefreshAccess={refreshAccess} />
      )}
      {tab === "teamsbeheer" && canManageOrganisation && (
        <OrganisationManagementDashboard mode="teams" isAdmin={isAdmin} isTcMember={actualIsTc} showTestData={showTestTeams} teamContexts={teamContexts} onRefreshAccess={refreshAccess} onRosterChanged={()=>setTeamRosterVersion(v=>v+1)} />
      )}
      {tab === "seizoenenbeheer" && canManageOrganisation && (
        <OrganisationManagementDashboard mode="seizoenen" isAdmin={isAdmin} isTcMember={actualIsTc} showTestData={showTestTeams} teamContexts={teamContexts} onRefreshAccess={refreshAccess} />
      )}

      {tab === "wedstrijdbeheer" && hasStaffRole && (
        <MatchManagementDashboard
          matches={accessibleHistoryDbSheets?.matches ?? []}
          onChanged={()=>setHistoryRefreshVersion(version=>version+1)}
          canManageTestData={canManageOrganisation}
          showTestTeams={showTestTeams}
          testTeamCount={new Set(teamContexts.filter(context=>context.teamIsTest).map(context=>context.teamId)).size}
          onShowTestTeams={setShowTestTeams}
          onTestDataChanged={async()=>{setTeamRosterVersion(version=>version+1);setHistoryRefreshVersion(version=>version+1);await refreshAccess()}}
        />
      )}

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
          accountProfiles={accountProfiles}
          accountProfilesLoading={accountProfilesLoading}
          invitePlayerAccount={invitePlayerAccount}
          refreshAccountProfiles={refreshAccountProfiles}
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
          competitionPeriodOptions={competitionPeriodOptions.map((c) => c.seasonName)}
          setSeason={(value) =>
            setState((s) => ({ ...s, season: value }))
          }
          matchType={state.matchType}
          setMatchType={(value) =>
            setState((s) => ({
              ...s,
              matchType: value,
              season: value === "Competitie"
                ? (competitionPeriodOptions.some((c) => c.seasonName === s.season)
                    ? s.season
                    : (competitionPeriodOptions[0]?.seasonName ?? s.season))
                : s.season,
            }))
          }
          onOpenMatch={() => setTab("wedstrijd")}
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
          onOpenSettings={() => setTab("vakken")}
          onCancelMatch={() => clearWedstrijd("Wedstrijd annuleren? Alle gegevens van de huidige wedstrijd worden verwijderd en NIET aan de seizoensdatabase toegevoegd. Deze actie kan niet ongedaan worden gemaakt.")}
        />
      )}

      {tab === "verslag" && (
        <div className="space-y-5">
          <MatchReport
            state={state}
            spelersMap={spelersMap}
            dbSheets={activeTeamDbSheets}
            saveStatus={matchSaveStatus}
            saveMessage={matchSaveMessage}
            onRetrySave={retrySupabaseMatchSave}
            onBackToMatch={() => setTab("wedstrijd")}
          />
          {state.matchEnded && matchSaveStatus === "saved" && <LatestMatchSharePanel match={latestShareableDatabaseMatch} />}
        </div>
      )}

      {tab === "voorbereiding" && (
        <MatchPreparationDashboard
          state={state}
          dbSheets={activeTeamDbSheets}
          onSelectOpponent={(opponentName) => setState((current) => ({ ...current, opponentName }))}
          onOpenSettings={() => setTab("vakken")}
          onOpenMatch={() => setTab("wedstrijd")}
        />
      )}

      {tab === "dashboard" && (
        <CoachDashboard
          state={state}
          dbSheets={analysisDbSheets}
          onNavigate={setTab}
        />
      )}

      {tab === "wedstrijdinzichten" && (
        <InsightsErrorBoundary>
          <WedstrijdInsightsOverview
            state={state}
            spelersMap={spelersMap}
            dbSheets={activeTeamDbSheets}
          />
        </InsightsErrorBoundary>
      )}

      {tab === "spelersanalyse" && (
        <SpelerAnalyseHub state={state} dbSheets={activeTeamDbSheets} />
      )}

      {tab === "teamanalyse" && (
        <TeamAnalyseHub state={state} spelersMap={spelersMap} dbSheets={analysisDbSheets} />
      )}

      {tab === "insights" && (
        <InsightsTab
          state={state}
          spelersMap={spelersMap}
          opponentName={state.opponentName}
          dbSheets={analysisDbSheets}
        />
      )}

      {tab === "combinaties" && (
        <VakcombinatiesDashboard dbSheets={analysisDbSheets} spelers={state.spelers} />
      )}

      {tab === "profielen" && (
        <SpelerprofielenDashboard spelers={state.spelers} dbSheets={analysisDbSheets} />
      )}

      {tab === "opstelling" && (
        <OpstellingsassistentDashboard state={state} dbSheets={analysisDbSheets} />
      )}

      {tab === "wisseladvies" && (
        <SpeeltijdWisseladviesDashboard state={state} dbSheets={analysisDbSheets} />
      )}

      {tab === "doelen" && (
        <WedstrijddoelenDashboard state={state} dbSheets={activeTeamDbSheets} />
      )}

      {tab === "portaal" && (
        <SpelersportaalDashboard state={state} dbSheets={activeTeamDbSheets} selectedPlayerId={portalPlayerId} onSelectPlayer={setPortalPlayerId} />
      )}

      {tab === "seizoen" && (
        <SeasonDashboard
          state={state}
          dbSheets={analysisDbSheets}
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
                <h2 className="text-xl font-bold text-gray-900">Wedstrijdomgeving voorbereiden</h2>
                <p className="mt-2 text-sm text-gray-600 leading-6">
                  KorbIQ gebruikt Supabase als centrale database. Ga door om de wedstrijdinstellingen voor het actieve team te openen.
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl bg-gray-50 border border-gray-200 p-4 text-sm text-gray-600">
              <div className="font-semibold text-gray-800">Huidige app-instellingen</div>
              <div className="mt-1">Seizoen: {state.season} · {state.spelers.length} spelers in de spelerslijst</div>
              <div className="mt-1 text-xs text-gray-500">Spelers, teamkoppelingen en wedstrijdhistorie blijven centraal bewaard.</div>
            </div>

            <div className="mt-6">
              <Button
                className="w-full"
                onClick={startNieuweDatabase}
              >
                Naar wedstrijdinstellingen
              </Button>
            </div>
            <p className="mt-4 text-xs text-gray-500 text-center">De centrale wedstrijdomgeving wordt voor het actieve team geopend.</p>
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
          </main>
        </div>
      </div>
    </div>
  );
}
//////////////////////////////////////////////////////////////////////////////
// --- Teams & gebruikers ----------------------------------------------------
//////////////////////////////////////////////////////////////////////////////
function MatchManagementDashboard({
  matches,
  onChanged,
  canManageTestData,
  showTestTeams,
  testTeamCount,
  onShowTestTeams,
  onTestDataChanged,
}: {
  matches: any[];
  onChanged: () => void;
  canManageTestData: boolean;
  showTestTeams: boolean;
  testTeamCount: number;
  onShowTestTeams: (show: boolean) => void;
  onTestDataChanged: () => Promise<void>;
}) {
  type StatusFilter = "active" | "archived" | "all";
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [teamFilter, setTeamFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [busyId, setBusyId] = useState("");
  const [testDataBusy, setTestDataBusy] = useState<""|"create"|"cleanup">("");
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const types = Array.from(new Set(matches.map((m:any)=>String(m.wedstrijdtype??"").trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"nl-NL"));
  const teamOptionsMap=new Map<string,{id:string;name:string}>();
  matches.forEach((match:any)=>{const id=String(match.team_id??match.team_naam??"");if(id&&!teamOptionsMap.has(id))teamOptionsMap.set(id,{id,name:String(match.team_naam??"Onbekend team")})});
  const teams:Array<{id:string;name:string}>=Array.from(teamOptionsMap.values()).sort((a,b)=>a.name.localeCompare(b.name,"nl-NL"));
  const archivedCount = matches.filter((m:any)=>Boolean(m.gearchiveerd)).length;
  const localCount = matches.filter((m:any)=>!String(m.supabase_match_id??"").trim()).length;
  const normalizedSearch = search.trim().toLocaleLowerCase("nl-NL");
  const visibleMatches = matches
    .filter((m:any)=>teamFilter==="all" || String(m.team_id??m.team_naam??"")===teamFilter)
    .filter((m:any)=>statusFilter==="all" || (statusFilter==="archived" ? Boolean(m.gearchiveerd) : !m.gearchiveerd))
    .filter((m:any)=>typeFilter==="all" || String(m.wedstrijdtype??"")===typeFilter)
    .filter((m:any)=>!dateFrom || String(m.datum??"")>=dateFrom)
    .filter((m:any)=>!dateTo || String(m.datum??"")<=dateTo)
    .filter((m:any)=>!normalizedSearch || [m.tegenstander,m.wedstrijd_naam,m.seizoen,m.team_naam,m.locatie,m.wedstrijdtype].some(value=>String(value??"").toLocaleLowerCase("nl-NL").includes(normalizedSearch)))
    .slice()
    .sort((a:any,b:any)=>String(b.datum??"").localeCompare(String(a.datum??"")) || String(a.tegenstander??"").localeCompare(String(b.tegenstander??""),"nl-NL"));

  const setArchived = async (match:any, archived:boolean) => {
    const matchId=String(match.supabase_match_id??"");
    if(!matchId)return;
    const opponent=String(match.tegenstander??match.wedstrijd_naam??"deze wedstrijd");
    const question=archived
      ? `Wedstrijd tegen ${opponent} archiveren?\n\nDe wedstrijd blijft bewaard, maar wordt niet meer meegenomen in analyses.`
      : `Wedstrijd tegen ${opponent} herstellen?\n\nDe wedstrijd wordt daarna weer meegenomen in analyses.`;
    if(!confirm(question))return;
    setBusyId(matchId);setMessage("");setErrorMessage("");
    const {error}=await supabase.rpc("set_match_archived",{p_match_id:matchId,p_archived:archived});
    if(error)setErrorMessage(error.message);
    else{setMessage(archived?"Wedstrijd is gearchiveerd.":"Wedstrijd is hersteld en telt weer mee in analyses.");onChanged();}
    setBusyId("");
  };

  const deleteMatch = async (match:any) => {
    const matchId=String(match.supabase_match_id??"");
    if(!matchId)return;
    const opponent=String(match.tegenstander??match.wedstrijd_naam??"deze wedstrijd");
    const answer=prompt(`Je staat op het punt de wedstrijd tegen ${opponent} definitief te verwijderen.\n\nOok alle acties, aanvallen, wissels en vakperiodes worden verwijderd. Dit kan niet ongedaan worden gemaakt.\n\nTyp VERWIJDEREN om door te gaan.`);
    if(answer!=="VERWIJDEREN")return;
    setBusyId(matchId);setMessage("");setErrorMessage("");
    const {error}=await supabase.rpc("delete_match",{p_match_id:matchId});
    if(error)setErrorMessage(error.message);
    else{setMessage("Wedstrijd en alle bijbehorende wedstrijddata zijn definitief verwijderd.");onChanged();}
    setBusyId("");
  };

  const createTestData = async () => {
    const confirmed=confirm("Testomgeving (opnieuw) vullen?\n\nAlleen eerder gemarkeerde testdata wordt eerst opgeruimd. Echte teams, personen en wedstrijden blijven onaangetast.");
    if(!confirmed)return;
    setTestDataBusy("create");setMessage("");setErrorMessage("");
    const {data,error}=await supabase.rpc("create_korbiq_test_data");
    if(error)setErrorMessage(error.message);
    else{
      const result=data as any;
      onShowTestTeams(true);
      await onTestDataChanged();
      setMessage(`Testomgeving gevuld: ${Number(result?.teams??3)} teams, ${Number(result?.people??36)} personen en ${Number(result?.matches??0)} wedstrijden in ${String(result?.competition_year??"het actieve competitiejaar")}.`);
    }
    setTestDataBusy("");
  };

  const cleanupTestData = async () => {
    const answer=prompt("Alle gemarkeerde testteams, testpersonen en testwedstrijden definitief opruimen?\n\nEchte data wordt niet geraakt. Typ TESTDATA VERWIJDEREN om door te gaan.");
    if(answer!=="TESTDATA VERWIJDEREN")return;
    setTestDataBusy("cleanup");setMessage("");setErrorMessage("");
    const {data,error}=await supabase.rpc("cleanup_korbiq_test_data");
    if(error)setErrorMessage(error.message);
    else{
      const result=data as any;
      onShowTestTeams(false);
      await onTestDataChanged();
      setMessage(`Testdata opgeruimd: ${Number(result?.teams??0)} teams, ${Number(result?.people??0)} personen en ${Number(result?.matches??0)} wedstrijden verwijderd.`);
    }
    setTestDataBusy("");
  };

  return <div className="space-y-5">
    <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm">
      <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-700">Beheer</div>
      <h2 className="mt-1 text-2xl font-black">Wedstrijden beheren</h2>
      <p className="mt-1 max-w-4xl text-sm text-slate-600">Bekijk en filter alle wedstrijden van de teams waartoe je toegang hebt. De teamkeuze linksboven verandert dit overzicht niet. Archiveren bewaart een wedstrijd maar haalt haar uit alle analyses.</p>
      <div className="mt-4 flex flex-wrap gap-2 text-xs font-bold">
        <span className="rounded-full bg-white px-3 py-1.5 text-slate-700 ring-1 ring-slate-200">{matches.length} totaal</span>
        <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-700">{matches.length-archivedCount} actief</span>
        <span className="rounded-full bg-amber-50 px-3 py-1.5 text-amber-700">{archivedCount} gearchiveerd</span>
        {localCount>0&&<span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">{localCount} alleen lokaal</span>}
      </div>
    </div>

    {canManageTestData&&<div className="rounded-2xl border border-violet-200 bg-violet-50 p-4 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[.14em] text-violet-700">Afgescheiden testomgeving</div>
          <h3 className="mt-1 font-black text-slate-900">Realistische oefendata in Supabase</h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Maakt 3 herkenbare testteams met volledige spelersnamen, wedstrijden, acties, aanvallen, speeltijden, wissels en vakcombinaties. Alles krijgt een vaste testmarkering en is later in één keer veilig op te ruimen.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" disabled={Boolean(testDataBusy)} onClick={()=>void createTestData()} className="rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-extrabold text-white hover:bg-violet-700 disabled:cursor-wait disabled:opacity-60">{testDataBusy==="create"?"Testdata maken…":testTeamCount?"Testdata opnieuw vullen":"Testdata aanmaken"}</button>
          <button type="button" disabled={Boolean(testDataBusy)} onClick={()=>void cleanupTestData()} className="rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-extrabold text-red-700 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60">{testDataBusy==="cleanup"?"Opruimen…":"Testdata opruimen"}</button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-200 bg-white px-3 py-2.5">
        <div className="text-xs font-semibold text-slate-600">{testTeamCount?`${testTeamCount} testteams aanwezig. Ze blijven standaard buiten de gewone teamkeuze.`:"Nog geen testteams aanwezig."}</div>
        <label className={`flex items-center gap-2 text-xs font-bold ${testTeamCount?"text-violet-800":"text-slate-400"}`}><input type="checkbox" checked={showTestTeams} disabled={!testTeamCount||Boolean(testDataBusy)} onChange={event=>onShowTestTeams(event.target.checked)} className="h-4 w-4 rounded border-violet-300 text-violet-600"/>Testteams tonen in teamkeuze</label>
      </div>
    </div>}

    {(message||errorMessage)&&<div className={`rounded-xl border px-4 py-3 text-sm font-semibold ${errorMessage?"border-red-200 bg-red-50 text-red-700":"border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{errorMessage||message}</div>}

    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <label className="text-xs font-bold text-slate-600 xl:col-span-2">Zoeken
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Tegenstander, seizoen, locatie…" className="mt-1 w-full rounded-xl border px-3 py-2.5 text-sm font-medium outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
        </label>
        <label className="text-xs font-bold text-slate-600">Status
          <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value as StatusFilter)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-bold"><option value="active">Actief</option><option value="archived">Gearchiveerd</option><option value="all">Alle statussen</option></select>
        </label>
        <label className="text-xs font-bold text-slate-600">Team
          <select value={teamFilter} onChange={e=>setTeamFilter(e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-bold"><option value="all">Alle teams</option>{teams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select>
        </label>
        <label className="text-xs font-bold text-slate-600">Wedstrijdtype
          <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-bold"><option value="all">Alle typen</option>{types.map(type=><option key={type} value={type}>{type}</option>)}</select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-bold text-slate-600">Vanaf<input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 w-full rounded-xl border px-2 py-2.5 text-xs font-semibold"/></label>
          <label className="text-xs font-bold text-slate-600">T/m<input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 w-full rounded-xl border px-2 py-2.5 text-xs font-semibold"/></label>
        </div>
      </div>
    </div>

    <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><div className="font-black">Wedstrijdoverzicht</div><div className="text-xs font-semibold text-slate-500">{visibleMatches.length} zichtbaar</div></div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1050px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Datum</th><th className="px-4 py-3">Team</th><th className="px-4 py-3">Wedstrijd</th><th className="px-4 py-3">Type / seizoen</th><th className="px-4 py-3">Uitslag</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Beheer</th></tr></thead>
          <tbody>{visibleMatches.map((match:any,index:number)=>{const id=String(match.supabase_match_id??match.wedstrijd_id??index);const remote=Boolean(match.supabase_match_id);const archived=Boolean(match.gearchiveerd);return <tr key={id} className={`border-t ${archived?"bg-amber-50/40":"hover:bg-slate-50"}`}><td className="whitespace-nowrap px-4 py-3 font-bold">{formatImportedDate(match.datum)}</td><td className="px-4 py-3"><div className="font-bold">{match.team_naam||"Onbekend team"}</div><div className="text-xs text-slate-400">{match.locatie||"—"}</div></td><td className="px-4 py-3"><div className="font-black">{match.tegenstander||match.wedstrijd_naam||"Onbekende tegenstander"}</div><div className="mt-0.5 text-xs text-slate-400">{remote?"Supabase":"Alleen lokaal"}</div></td><td className="px-4 py-3"><div className="font-semibold">{match.wedstrijdtype||"—"}</div><div className="text-xs text-slate-400">{match.seizoen||"Geen seizoen"}</div></td><td className="whitespace-nowrap px-4 py-3 text-base font-black">{match.score_korbis??"?"} – {match.score_tegenstander??"?"}</td><td className="px-4 py-3">{archived?<span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">Gearchiveerd</span>:<span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-700">Actief</span>}</td><td className="px-4 py-3"><div className="flex justify-end gap-2">{remote?<><button disabled={busyId===id} onClick={()=>void setArchived(match,!archived)} className={`rounded-lg border px-3 py-2 text-xs font-bold disabled:opacity-50 ${archived?"border-emerald-200 bg-emerald-50 text-emerald-700":"border-amber-200 bg-amber-50 text-amber-800"}`}>{archived?"Herstellen":"Archiveren"}</button><button disabled={busyId===id} onClick={()=>void deleteMatch(match)} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50">Verwijderen</button></>:<span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-500">Alleen lokaal</span>}</div></td></tr>})}</tbody>
        </table>
      </div>
      {!visibleMatches.length&&<div className="p-10 text-center text-sm text-slate-500">Geen wedstrijden gevonden met deze filters.</div>}
    </div>
    {localCount>0&&<div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><b>Lokale cache:</b> deze oude regels zijn alleen in deze browser aanwezig en worden niet gebruikt als centrale testdata.</div>}
  </div>;
}

function OrganisationManagementDashboard({
  mode,
  isAdmin,
  isTcMember,
  showTestData,
  teamContexts,
  onRefreshAccess,
  onRosterChanged,
}: {
  mode: "personen" | "teams" | "seizoenen";
  isAdmin: boolean;
  isTcMember: boolean;
  showTestData: boolean;
  teamContexts: TeamSeasonContext[];
  onRefreshAccess: () => Promise<void>;
  onRosterChanged?: () => void;
}) {
  type PersonRow = { id:string; voornaam:string; tussenvoegsel:string|null; achternaam:string; actief:boolean; is_test:boolean };
  type PersonRoleRow = { id:string; person_id:string; role:KorbIQRole; team_season_id:string|null; actief:boolean };
  type ManagedPlayer = { id:string; person_id:string|null; naam:string; geslacht:Geslacht; actief:boolean };
  type PlayerMembership = { id:string; player_id:string; team_season_id:string; status:PlayerStatus; actief:boolean };
  type TcMembership = { id:string; person_id:string; team_season_id:string; actief:boolean };
  type ProfileWithPerson = AuthProfile & { person_id?:string|null };

  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [people,setPeople]=useState<PersonRow[]>([]);
  const [personRoles,setPersonRoles]=useState<PersonRoleRow[]>([]);
  const [profiles,setProfiles]=useState<ProfileWithPerson[]>([]);
  const [players,setPlayers]=useState<ManagedPlayer[]>([]);
  const [playerMemberships,setPlayerMemberships]=useState<PlayerMembership[]>([]);
  const [tcMemberships,setTcMemberships]=useState<TcMembership[]>([]);
  type ManagedSeason = { id:string; naam:string; actief:boolean; competition_year_id:string|null; periode:"veld_najaar"|"zaal"|"veld_voorjaar"|null };
  type CompetitionYearRow = { id:string; naam:string; startjaar:number; eindjaar:number; actief:boolean };
  const [seasons,setSeasons]=useState<ManagedSeason[]>([]);
  const [competitionYears,setCompetitionYears]=useState<CompetitionYearRow[]>([]);

  const [personOpen,setPersonOpen]=useState(false);
  const [personVoornaam,setPersonVoornaam]=useState("");
  const [personTussenvoegsel,setPersonTussenvoegsel]=useState("");
  const [personAchternaam,setPersonAchternaam]=useState("");
  const [personRoleSpeler,setPersonRoleSpeler]=useState(false);
  const [personRoleCoach,setPersonRoleCoach]=useState(false);
  const [personRoleTc,setPersonRoleTc]=useState(false);
  const [editingPersonId,setEditingPersonId]=useState<string|null>(null);
  const [editVoornaam,setEditVoornaam]=useState("");
  const [editTussenvoegsel,setEditTussenvoegsel]=useState("");
  const [editAchternaam,setEditAchternaam]=useState("");
  const [invitePersonId,setInvitePersonId]=useState<string|null>(null);
  const [inviteEmail,setInviteEmail]=useState("");
  const [accountPanelPersonId,setAccountPanelPersonId]=useState<string|null>(null);
  const [accountEmailEdit,setAccountEmailEdit]=useState("");
  const [personActionsId,setPersonActionsId]=useState<string|null>(null);
  const [personSearch,setPersonSearch]=useState("");
  const [personTeamFilter,setPersonTeamFilter]=useState("__all__");
  const [showArchivedPeople,setShowArchivedPeople]=useState(false);
  type PersonSortKey = "voornaam" | "achternaam" | "functie" | "team";
  const [personSortKey,setPersonSortKey]=useState<PersonSortKey>("achternaam");
  const [personSortDirection,setPersonSortDirection]=useState<"asc"|"desc">("asc");

  const [newCompetitionStartYear,setNewCompetitionStartYear]=useState(String(new Date().getFullYear()));
  const [newTeamName,setNewTeamName]=useState("");

  const [teamPersonId,setTeamPersonId]=useState("");
  const [teamPlayerGender,setTeamPlayerGender]=useState<Geslacht>("Dame");
  const [teamPlayerStatus,setTeamPlayerStatus]=useState<PlayerStatus>("Basisspeler");
  const [teamPlayerSearch,setTeamPlayerSearch]=useState("");
  const [teamCoachSearch,setTeamCoachSearch]=useState("");
  const [teamCoachPersonId,setTeamCoachPersonId]=useState("");
  const [teamTcSearch,setTeamTcSearch]=useState("");
  const [teamTcPersonId,setTeamTcPersonId]=useState("");
  const [managedTeamId,setManagedTeamId]=useState("__all__");

  const fullName=(p:PersonRow)=>[p.voornaam,p.tussenvoegsel,p.achternaam].filter(Boolean).join(" ");
  const contextById=useMemo(()=>new Map(teamContexts.map(c=>[c.id,c])),[teamContexts]);
  const profileByPersonId=useMemo(()=>{const m=new Map<string,ProfileWithPerson>();profiles.forEach(p=>{if(p.person_id)m.set(p.person_id,p)});return m},[profiles]);
  const playerByPersonId=useMemo(()=>{const m=new Map<string,ManagedPlayer>();players.forEach(p=>{if(p.person_id)m.set(p.person_id,p)});return m},[players]);
  const personById=useMemo(()=>new Map(people.map(p=>[p.id,p])),[people]);
  const playerById=useMemo(()=>new Map(players.map(p=>[p.id,p])),[players]);

  const load=async()=>{
    setBusy(true);setMessage("");
    const [a,b,c,d,e,f,g,h]=await Promise.all([
      supabase.from("people").select("id,voornaam,tussenvoegsel,achternaam,actief,is_test").order("achternaam").order("voornaam"),
      supabase.from("person_roles").select("id,person_id,role,team_season_id,actief"),
      supabase.from("profiles").select("id,email,role,speler_id,speler_naam,naam,voornaam,tussenvoegsel,achternaam,actief,account_status,invitation_status,invited_at,person_id"),
      supabase.from("players").select("id,person_id,naam,geslacht,actief"),
      supabase.from("player_team_memberships").select("id,player_id,team_season_id,status,actief"),
      supabase.from("team_tc_memberships").select("id,person_id,team_season_id,actief"),
      supabase.from("seasons").select("id,naam,actief,competition_year_id,periode").order("naam",{ascending:false}),
      supabase.from("competition_years").select("id,naam,startjaar,eindjaar,actief").order("startjaar",{ascending:false}),
    ]);
    const err=a.error||b.error||c.error||d.error||e.error||f.error||g.error||h.error;
    if(err)setMessage(err.message);else{
      setPeople((a.data??[]) as PersonRow[]);setPersonRoles((b.data??[]) as PersonRoleRow[]);setProfiles((c.data??[]) as ProfileWithPerson[]);setPlayers((d.data??[]) as ManagedPlayer[]);setPlayerMemberships((e.data??[]) as PlayerMembership[]);setTcMemberships((f.data??[]) as TcMembership[]);
      setSeasons((g.data??[]) as ManagedSeason[]);setCompetitionYears((h.data??[]) as CompetitionYearRow[]);
    }
    setBusy(false);
  };
  useEffect(()=>{void load()},[]);
  useEffect(()=>{
    if(mode==="personen") setShowArchivedPeople(false);
  },[mode]);

  const createPerson=async()=>{
    if(!personVoornaam.trim()||!personAchternaam.trim()){setMessage("Voornaam en achternaam zijn verplicht.");return}
    setBusy(true);setMessage("");
    const {data:personId,error}=await supabase.rpc("create_person",{p_voornaam:personVoornaam.trim(),p_tussenvoegsel:personTussenvoegsel.trim()||null,p_achternaam:personAchternaam.trim()});
    if(error||!personId){setMessage(error?.message??"Persoon kon niet worden aangemaakt.");setBusy(false);return}
    const selectedRoles:["speler"|"coach"|"tc",boolean][]=[["speler",personRoleSpeler],["coach",personRoleCoach],["tc",personRoleTc]];
    for(const [role,selected] of selectedRoles){
      if(!selected)continue;
      const {error:roleError}=await supabase.rpc("assign_person_role",{p_person_id:String(personId),p_role:role,p_team_season_id:null});
      if(roleError){setMessage(`Persoon aangemaakt, maar rol ${role} kon niet worden toegevoegd: ${roleError.message}`);await load();setBusy(false);return}
    }
    setPersonVoornaam("");setPersonTussenvoegsel("");setPersonAchternaam("");setPersonRoleSpeler(false);setPersonRoleCoach(false);setPersonRoleTc(false);setPersonOpen(false);setMessage("Persoon is toegevoegd. Rollen zijn opgeslagen; teamkoppelingen beheer je onder Teams.");await load();
    setBusy(false);
  };

  const openEdit=(p:PersonRow)=>{setEditingPersonId(p.id);setEditVoornaam(p.voornaam);setEditTussenvoegsel(p.tussenvoegsel??"");setEditAchternaam(p.achternaam)};
  const savePerson=async()=>{
    if(!editingPersonId)return;
    setBusy(true);setMessage("");
    const {error}=await supabase.rpc("update_person",{p_person_id:editingPersonId,p_voornaam:editVoornaam.trim(),p_tussenvoegsel:editTussenvoegsel.trim()||null,p_achternaam:editAchternaam.trim()});
    if(error)setMessage(error.message);else{setEditingPersonId(null);setMessage("Persoonsgegevens bijgewerkt.");await load()}
    setBusy(false);
  };
  const archivePerson=async(id:string)=>{if(!confirm("Deze persoon archiveren? De historie blijft bewaard."))return;setBusy(true);const {error}=await supabase.rpc("archive_person",{p_person_id:id});if(error)setMessage(error.message);else{setMessage("Persoon gearchiveerd.");await load()}setBusy(false)};
  const deletePerson=async(id:string)=>{if(!confirm("Deze persoon definitief verwijderen? Gebruik dit alleen voor een fout/testrecord."))return;setBusy(true);const {error}=await supabase.rpc("delete_person",{p_person_id:id});if(error)setMessage(error.message);else{setMessage("Persoon definitief verwijderd.");await load()}setBusy(false)};
  const reactivatePerson=async(id:string)=>{setBusy(true);const {error}=await supabase.rpc("reactivate_person",{p_person_id:id});if(error)setMessage(error.message);else{setMessage("Persoon opnieuw actief.");await load()}setBusy(false)};

  const addGlobalRole=async(personId:string,role:"tc"|"coach"|"speler")=>{setBusy(true);setMessage("");const {error}=await supabase.rpc("assign_person_role",{p_person_id:personId,p_role:role,p_team_season_id:null});if(error)setMessage(error.message);else{setMessage(role==="coach"?"Persoon is beschikbaar gemaakt als coach.":role==="speler"?"Persoon is beschikbaar gemaakt als speler.":"Persoon is TC-lid gemaakt.");await load()}setBusy(false)};
  const removeRole=async(roleId:string)=>{if(!confirm("Deze rol intrekken?"))return;setBusy(true);const {error}=await supabase.rpc("deactivate_person_role",{p_role_id:roleId});if(error)setMessage(error.message);else{setMessage("Rol ingetrokken.");await load()}setBusy(false)};
  const addCoach=async(personId:string,teamId:string)=>{if(!teamId)return;setBusy(true);const {error}=await supabase.rpc("add_coach_to_team_all_periods",{p_person_id:personId,p_team_id:teamId});if(error)setMessage(error.message);else{setMessage("Coach aan team gekoppeld voor alle competitieperioden.");await load()}setBusy(false)};
  const removeCoach=async(personId:string,teamId:string)=>{if(!teamId)return;setBusy(true);const {error}=await supabase.rpc("remove_coach_from_team_all_periods",{p_person_id:personId,p_team_id:teamId});if(error)setMessage(error.message);else{setMessage("Coach uit team verwijderd.");await load()}setBusy(false)};
  const addPlayerToTeam=async(personId:string,teamId:string,gender:Geslacht=teamPlayerGender,status:PlayerStatus=teamPlayerStatus)=>{if(!teamId)return;setBusy(true);const {error}=await supabase.rpc("add_player_to_team_all_periods",{p_person_id:personId,p_team_id:teamId,p_geslacht:gender,p_status:status});if(error)setMessage(error.message);else{setMessage("Speler aan team gekoppeld voor alle competitieperioden.");await load();onRosterChanged?.()}setBusy(false)};
  const removePlayer=async(personId:string,teamId:string)=>{if(!teamId)return;setBusy(true);const {error}=await supabase.rpc("remove_player_from_team_all_periods",{p_person_id:personId,p_team_id:teamId});if(error)setMessage(error.message);else{setMessage("Speler uit team verwijderd.");await load();onRosterChanged?.()}setBusy(false)};
  const addTc=async(personId:string,teamId:string)=>{if(!teamId)return;setBusy(true);const {error}=await supabase.rpc("add_tc_to_team_all_periods",{p_person_id:personId,p_team_id:teamId});if(error)setMessage(error.message);else{setMessage("TC-lid aan team gekoppeld voor alle competitieperioden.");await load()}setBusy(false)};
  const removeTc=async(personId:string,teamId:string)=>{if(!teamId)return;setBusy(true);const {error}=await supabase.rpc("remove_tc_from_team_all_periods",{p_person_id:personId,p_team_id:teamId});if(error)setMessage(error.message);else{setMessage("TC-lid uit team verwijderd.");await load()}setBusy(false)};

  const inviteAccount=async(personId:string)=>{
    const email=inviteEmail.trim().toLowerCase();if(!email){setMessage("Vul een e-mailadres in.");return}
    setBusy(true);setMessage("");
    const {data,error}=await supabase.functions.invoke("manage-user",{body:{action:"invite_existing_person",person_id:personId,email,redirect_to:`${KORBIQ_APP_ORIGIN}/account-activate`}});
    if(error)setMessage(error.message);else if(data?.error)setMessage(String(data.error));else{setMessage("Uitnodiging verstuurd.");setInvitePersonId(null);setInviteEmail("");await load()}
    setBusy(false);
  };

  const resendAccountInvite=async(personId:string)=>{
    if(!confirm("Nieuwe uitnodiging versturen? De vorige uitnodigingslink wordt hiermee vervangen."))return;
    setBusy(true);setMessage("");
    const {data,error}=await supabase.functions.invoke("manage-user",{body:{action:"resend_invite",person_id:personId,redirect_to:`${KORBIQ_APP_ORIGIN}/account-activate`}});
    if(error)setMessage(error.message);else if(data?.error)setMessage(String(data.error));else{setMessage("Nieuwe uitnodiging verstuurd.");await load()}
    setBusy(false);
  };

  const changeAccountEmail=async(personId:string)=>{
    const email=accountEmailEdit.trim().toLowerCase();
    if(!email){setMessage("Vul een nieuw e-mailadres in.");return}
    if(!confirm(`E-mailadres wijzigen naar ${email}?`))return;
    setBusy(true);setMessage("");
    const {data,error}=await supabase.functions.invoke("manage-user",{body:{action:"change_email",person_id:personId,email,redirect_to:`${KORBIQ_APP_ORIGIN}/account-activate`}});
    if(error)setMessage(error.message);else if(data?.error)setMessage(String(data.error));else{setMessage(data?.reinvited?"E-mailadres gewijzigd en een nieuwe uitnodiging verstuurd.":"E-mailadres gewijzigd.");setAccountEmailEdit("");await load()}
    setBusy(false);
  };

  const resetAccountPassword=async(personId:string)=>{
    if(!confirm("Wachtwoordherstelmail naar dit account sturen?"))return;
    setBusy(true);setMessage("");
    const {data,error}=await supabase.functions.invoke("manage-user",{body:{action:"reset_password",person_id:personId,redirect_to:`${KORBIQ_APP_ORIGIN}/account-activate?mode=recovery`}});
    if(error)setMessage(error.message);else if(data?.error)setMessage(String(data.error));else setMessage("Wachtwoordherstelmail verstuurd.");
    setBusy(false);
  };

  const unlinkAccount=async(personId:string)=>{
    if(!confirm("Loginaccount loskoppelen? De persoon, rollen, teams en historie blijven bestaan, maar het huidige loginaccount wordt definitief verwijderd."))return;
    if(!confirm("Weet je het zeker? Daarna kan deze persoon niet meer met het huidige account inloggen."))return;
    setBusy(true);setMessage("");
    const {data,error}=await supabase.functions.invoke("manage-user",{body:{action:"unlink_account",person_id:personId}});
    if(error)setMessage(error.message);else if(data?.error)setMessage(String(data.error));else{setMessage("Loginaccount losgekoppeld. De persoon en historie zijn behouden.");setAccountPanelPersonId(null);setAccountEmailEdit("");await load()}
    setBusy(false);
  };

  const createCompetitionYear=async()=>{
    const startjaar=Number(newCompetitionStartYear);
    if(!Number.isInteger(startjaar)||startjaar<2020||startjaar>2100){setMessage("Vul een geldig startjaar in, bijvoorbeeld 2027.");return}
    setBusy(true);setMessage("");
    const {error}=await supabase.rpc("create_competition_year",{p_startjaar:startjaar});
    if(error)setMessage(error.message);else{setMessage(`Competitiejaar ${startjaar}/${startjaar+1} is aangemaakt. Alle actieve teams zijn automatisch aan de drie competitieperioden gekoppeld.`);await onRefreshAccess();await load()}
    setBusy(false);
  };
  const setCompetitionYearActive=async(id:string,actief:boolean)=>{
    if(!actief&&!confirm("Dit competitiejaar archiveren? De historie blijft behouden, maar de periode verdwijnt uit de actieve teamkeuze."))return;
    setBusy(true);setMessage("");
    const {error}=await supabase.rpc("set_competition_year_active",{p_competition_year_id:id,p_actief:actief});
    if(error)setMessage(error.message);else{setMessage(actief?"Competitiejaar opnieuw geactiveerd.":"Competitiejaar gearchiveerd.");await onRefreshAccess();await load()}
    setBusy(false);
  };
  const createTeam=async()=>{const naam=newTeamName.trim();if(!naam)return;setBusy(true);setMessage("");const {error}=await supabase.rpc("create_team_for_all_competitions",{p_naam:naam});if(error)setMessage(error.message);else{setNewTeamName("");setMessage(`${naam} aangemaakt en automatisch aan alle actieve competitieperioden gekoppeld.`);await onRefreshAccess();await load()}setBusy(false)};
  const archiveTeam=async(id:string)=>{if(!confirm("Dit team voor dit seizoen archiveren?"))return;setBusy(true);const {error}=await supabase.rpc("archive_team_season",{p_team_season_id:id});if(error)setMessage(error.message);else{setMessage("Team-seizoen gearchiveerd.");await onRefreshAccess();await load()}setBusy(false)};

  const uniqueTeams=useMemo(()=>{
    const map=new Map<string,{id:string;name:string}>();
    teamContexts.forEach(c=>{if(c.teamIsTest&&!showTestData)return;if(!map.has(c.teamId))map.set(c.teamId,{id:c.teamId,name:c.teamName})});
    return Array.from(map.values()).sort((a,b)=>compareTeamNames(a.name,b.name));
  },[teamContexts,showTestData]);

  useEffect(()=>{
    if(managedTeamId==="__all__"||uniqueTeams.some(t=>t.id===managedTeamId))return;
    setManagedTeamId("__all__");
  },[managedTeamId,uniqueTeams]);

  const activeContext=teamContexts.find(c=>c.teamId===managedTeamId)??null;
  const activeTeamContextIds=new Set(teamContexts.filter(c=>c.teamId===managedTeamId).map(c=>c.id));

  const activePlayersByPerson=new Map<string,{m:PlayerMembership;player:ManagedPlayer}>();
  playerMemberships
    .filter(m=>activeTeamContextIds.has(m.team_season_id)&&m.actief)
    .forEach(m=>{
      const player=playerById.get(m.player_id);
      if(player?.person_id&&!activePlayersByPerson.has(player.person_id))activePlayersByPerson.set(player.person_id,{m,player});
    });
  const activePlayers=Array.from(activePlayersByPerson.values());

  const activeCoachesByPerson=new Map<string,PersonRoleRow>();
  personRoles
    .filter(r=>r.role==="coach"&&r.team_season_id!==null&&activeTeamContextIds.has(r.team_season_id)&&r.actief)
    .forEach(r=>{if(!activeCoachesByPerson.has(r.person_id))activeCoachesByPerson.set(r.person_id,r)});
  const activeCoaches=Array.from(activeCoachesByPerson.values());

  const activeTcsByPerson=new Map<string,TcMembership>();
  tcMemberships
    .filter(t=>activeTeamContextIds.has(t.team_season_id)&&t.actief)
    .forEach(t=>{if(!activeTcsByPerson.has(t.person_id))activeTcsByPerson.set(t.person_id,t)});
  const activeTcs=Array.from(activeTcsByPerson.values());

  const activePlayerPersonIds=new Set(activePlayers.map(x=>String(x.player.person_id??"")).filter(Boolean));
  const currentSeasonTeamIds=new Set(teamContexts.filter(c=>c.seasonId===activeContext?.seasonId).map(c=>c.id));
  const primaryPlayerPersonIdsThisSeason=new Set(
    playerMemberships
      .filter(m=>m.actief&&m.status==="Basisspeler"&&currentSeasonTeamIds.has(m.team_season_id))
      .map(m=>playerById.get(m.player_id)?.person_id)
      .filter((id):id is string=>Boolean(id))
  );
  const playerCandidateSearch=teamPlayerSearch.trim().toLocaleLowerCase("nl-NL");
  const teamPlayerCandidates=people
    .filter(p=>p.actief&&!activePlayerPersonIds.has(p.id))
    .filter(p=>personRoles.some(r=>r.person_id===p.id&&r.role==="speler"&&r.team_season_id===null&&r.actief))
    .filter(p=>teamPlayerStatus==="Gast"||!primaryPlayerPersonIdsThisSeason.has(p.id))
    .filter(p=>{
      if(!playerCandidateSearch)return true;
      const existingPlayer=playerByPersonId.get(p.id);
      const memberships=existingPlayer?playerMemberships.filter(m=>m.player_id===existingPlayer.id&&m.actief):[];
      const terms=[
        fullName(p),p.voornaam,p.tussenvoegsel??"",p.achternaam,existingPlayer?.geslacht??"",
        ...memberships.flatMap(m=>{const c=contextById.get(m.team_season_id);return [m.status,c?.teamName??"",c?.seasonName??""]})
      ].join(" ").toLocaleLowerCase("nl-NL");
      return terms.includes(playerCandidateSearch);
    })
    .sort((a,b)=>fullName(a).localeCompare(fullName(b),"nl-NL"));

  const personRoleSearchTerms=(p:PersonRow)=>{
    const roles=personRoles.filter(r=>r.person_id===p.id&&r.actief);
    const tcTeams=tcMemberships.filter(t=>t.person_id===p.id&&t.actief);
    return [
      fullName(p),p.voornaam,p.tussenvoegsel??"",p.achternaam,
      ...roles.flatMap(r=>{const c=r.team_season_id?contextById.get(r.team_season_id):null;return [r.role,c?.teamName??"",c?.seasonName??""]}),
      ...tcTeams.flatMap(t=>{const c=contextById.get(t.team_season_id);return ["tc",c?.teamName??"",c?.seasonName??""]})
    ].join(" ").toLocaleLowerCase("nl-NL");
  };
  const coachCandidateSearch=teamCoachSearch.trim().toLocaleLowerCase("nl-NL");
  const teamCoachCandidates=people
    .filter(p=>p.actief&&!activeCoaches.some(r=>r.person_id===p.id))
    .filter(p=>personRoles.some(r=>r.person_id===p.id&&r.role==="coach"&&r.team_season_id===null&&r.actief))
    .filter(p=>!coachCandidateSearch||personRoleSearchTerms(p).includes(coachCandidateSearch))
    .sort((a,b)=>fullName(a).localeCompare(fullName(b),"nl-NL"));
  const tcCandidateSearch=teamTcSearch.trim().toLocaleLowerCase("nl-NL");
  const teamTcCandidates=people
    .filter(p=>p.actief&&!activeTcs.some(t=>t.person_id===p.id))
    .filter(p=>personRoles.some(r=>r.person_id===p.id&&r.role==="tc"&&r.actief))
    .filter(p=>!tcCandidateSearch||personRoleSearchTerms(p).includes(tcCandidateSearch))
    .sort((a,b)=>fullName(a).localeCompare(fullName(b),"nl-NL"));

  const header=(title:string,sub:string)=><div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ beheer</div><h2 className="mt-1 text-2xl font-black">{title}</h2><p className="mt-1 max-w-4xl text-sm text-slate-500">{sub}</p></div>;

  const filteredPeople=people.filter(p=>{
    if(p.is_test&&!showTestData)return false;
    if(!showArchivedPeople&&!p.actief)return false;
    const q=personSearch.trim().toLocaleLowerCase("nl-NL");
    if(!q)return true;
    const roles=personRoles.filter(r=>r.person_id===p.id&&r.actief);
    const profile=profileByPersonId.get(p.id);
    const player=playerByPersonId.get(p.id);
    const tcTeams=tcMemberships.filter(t=>t.person_id===p.id&&t.actief).map(t=>contextById.get(t.team_season_id)?.teamName??"");
    const roleTerms=roles.flatMap(r=>{
      const context=r.team_season_id?contextById.get(r.team_season_id):null;
      return [roleLabel(r.role),r.role,context?.teamName??"",context?.seasonName??""];
    });
    const haystack=[
      fullName(p),p.voornaam,p.tussenvoegsel??"",p.achternaam,
      profile?.email??"",profile?.account_status??"",profile?.invitation_status??"",
      player?.geslacht??"",p.actief?"actief":"gearchiveerd",
      ...roleTerms,...tcTeams,roles.some(r=>r.role==="tc")?"tc lid":""
    ].join(" ").toLocaleLowerCase("nl-NL");
    return haystack.includes(q);
  });

  const personRoleLabels=(p:PersonRow)=>{
    const labels:string[]=[];
    const roles=personRoles.filter(r=>r.person_id===p.id&&r.actief);
    if(roles.some(r=>r.role==="admin"))labels.push("Admin");
    if(roles.some(r=>r.role==="tc"))labels.push("TC-lid");
    if(roles.some(r=>r.role==="coach"))labels.push("Coach");
    if(roles.some(r=>r.role==="speler"))labels.push("Speler");
    return labels;
  };
  const personTeamLabels=(p:PersonRow)=>{
    const names=new Set<string>();
    personRoles.filter(r=>r.person_id===p.id&&r.actief&&r.team_season_id).forEach(r=>{
      const name=contextById.get(String(r.team_season_id))?.teamName;if(name)names.add(name);
    });
    tcMemberships.filter(t=>t.person_id===p.id&&t.actief).forEach(t=>{
      const name=contextById.get(t.team_season_id)?.teamName;if(name)names.add(name);
    });
    const player=playerByPersonId.get(p.id);
    if(player)playerMemberships.filter(m=>m.player_id===player.id&&m.actief).forEach(m=>{
      const name=contextById.get(m.team_season_id)?.teamName;if(name)names.add(name);
    });
    return Array.from(names).sort(compareTeamNames);
  };
  const personTeamFilteredPeople=filteredPeople.filter(p=>
    personTeamFilter==="__all__" || personTeamLabels(p).includes(uniqueTeams.find(team=>team.id===personTeamFilter)?.name??"")
  );
  const sortedPeople=personTeamFilteredPeople.slice().sort((a,b)=>{
    const value=(p:PersonRow)=>personSortKey==="voornaam"?p.voornaam:
      personSortKey==="achternaam"?`${p.achternaam} ${p.tussenvoegsel??""}`:
      personSortKey==="functie"?personRoleLabels(p).join(" "):
      personTeamLabels(p).join(" ");
    const compared=value(a).localeCompare(value(b),"nl-NL",{sensitivity:"base",numeric:true});
    if(compared!==0)return personSortDirection==="asc"?compared:-compared;
    return fullName(a).localeCompare(fullName(b),"nl-NL");
  });
  const changePersonSort=(key:PersonSortKey)=>{
    if(personSortKey===key)setPersonSortDirection(direction=>direction==="asc"?"desc":"asc");
    else{setPersonSortKey(key);setPersonSortDirection("asc")}
  };
  const personSortIndicator=(key:PersonSortKey)=>personSortKey===key?(personSortDirection==="asc"?" ▲":" ▼"):"";
  const teamSummaries=uniqueTeams.map(team=>{
    const contextIds=new Set(teamContexts.filter(context=>context.teamId===team.id).map(context=>context.id));
    const playerIds=new Set(playerMemberships.filter(m=>m.actief&&contextIds.has(m.team_season_id)).map(m=>m.player_id));
    const coachIds=new Set(personRoles.filter(r=>r.actief&&r.role==="coach"&&Boolean(r.team_season_id)&&contextIds.has(String(r.team_season_id))).map(r=>r.person_id));
    const tcIds=new Set(tcMemberships.filter(m=>m.actief&&contextIds.has(m.team_season_id)).map(m=>m.person_id));
    return {team,players:playerIds.size,coaches:coachIds.size,tcs:tcIds.size,periods:contextIds.size};
  });

  if(mode==="personen") return <div className="space-y-5">
    {header("Personen","Iedereen staat één keer in KorbIQ. Sorteer op naam, functie of team; uitgebreide bediening blijft per persoon beschikbaar.")}
    {message&&<div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">{message}</div>}
    <div className="rounded-2xl border bg-white p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div><h3 className="text-lg font-black">Personen</h3><p className="text-xs text-slate-500">Rollen bepalen de beschikbaarheid; teamkoppelingen beheer je onder Teams.</p></div>
        <button onClick={()=>setPersonOpen(v=>!v)} className="shrink-0 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white">+ Persoon</button>
      </div>
      <div className="mt-3 flex flex-col gap-2 rounded-xl border bg-slate-50 p-2.5 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input value={personSearch} onChange={e=>setPersonSearch(e.target.value)} placeholder="Zoek op naam, team, rol of e-mail…" className="w-full rounded-lg border bg-white py-2 pl-9 pr-9 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>{personSearch&&<button type="button" onClick={()=>setPersonSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-1 text-slate-400" aria-label="Zoekopdracht wissen">×</button>}</div>
        <select value={personTeamFilter} onChange={e=>setPersonTeamFilter(e.target.value)} className="rounded-lg border bg-white px-2.5 py-2 text-xs font-bold"><option value="__all__">Alle teams</option>{uniqueTeams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select>
        <div className="flex items-center gap-2"><select value={personSortKey} onChange={e=>setPersonSortKey(e.target.value as PersonSortKey)} className="rounded-lg border bg-white px-2 py-2 text-xs font-bold"><option value="voornaam">Voornaam</option><option value="achternaam">Achternaam</option><option value="functie">Functie</option><option value="team">Team</option></select><button type="button" onClick={()=>setPersonSortDirection(d=>d==="asc"?"desc":"asc")} className="rounded-lg border bg-white px-2.5 py-2 text-xs font-black" title="Sorteerrichting">{personSortDirection==="asc"?"A–Z":"Z–A"}</button></div>
        <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs font-semibold text-slate-600"><input type="checkbox" checked={showArchivedPeople} onChange={e=>setShowArchivedPeople(e.target.checked)} className="h-4 w-4 rounded border-slate-300"/>Archief tonen</label>
        <div className="text-xs font-semibold text-slate-400">{sortedPeople.length} resultaat{sortedPeople.length===1?"":"en"}</div>
      </div>

      {personOpen&&<div className="mt-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4"><div className="grid gap-3 md:grid-cols-3"><input value={personVoornaam} onChange={e=>setPersonVoornaam(e.target.value)} placeholder="Voornaam" className="rounded-xl border px-3 py-2.5 text-sm"/><input value={personTussenvoegsel} onChange={e=>setPersonTussenvoegsel(e.target.value)} placeholder="Tussenvoegsel" className="rounded-xl border px-3 py-2.5 text-sm"/><input value={personAchternaam} onChange={e=>setPersonAchternaam(e.target.value)} placeholder="Achternaam" className="rounded-xl border px-3 py-2.5 text-sm"/></div><div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-xs font-extrabold uppercase tracking-wide text-slate-500">Rollen</span><label className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold ${personRoleSpeler?"border-emerald-300 bg-emerald-50 text-emerald-700":"bg-white text-slate-600"}`}><input type="checkbox" checked={personRoleSpeler} onChange={e=>setPersonRoleSpeler(e.target.checked)}/>Speler</label><label className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold ${personRoleCoach?"border-cyan-300 bg-cyan-50 text-cyan-700":"bg-white text-slate-600"}`}><input type="checkbox" checked={personRoleCoach} onChange={e=>setPersonRoleCoach(e.target.checked)}/>Coach</label>{isAdmin&&<label className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold ${personRoleTc?"border-blue-300 bg-blue-50 text-blue-700":"bg-white text-slate-600"}`}><input type="checkbox" checked={personRoleTc} onChange={e=>setPersonRoleTc(e.target.checked)}/>TC-lid</label>}</div><div className="mt-3 flex justify-end gap-2"><button onClick={()=>{setPersonOpen(false);setPersonRoleSpeler(false);setPersonRoleCoach(false);setPersonRoleTc(false)}} className="rounded-xl border bg-white px-4 py-2 text-sm font-bold">Annuleren</button><button disabled={busy} onClick={()=>void createPerson()} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Opslaan</button></div></div>}

      <div className="mt-3 overflow-x-auto rounded-xl border">
        <div className="min-w-[1040px]">
          <div className="grid grid-cols-[130px_170px_270px_180px_minmax(210px,1fr)_44px] items-center gap-2 border-b bg-slate-50 px-3 py-2 text-[11px] font-extrabold uppercase tracking-wide text-slate-500">
            <button type="button" onClick={()=>changePersonSort("voornaam")} className="text-left">Voornaam{personSortIndicator("voornaam")}</button>
            <button type="button" onClick={()=>changePersonSort("achternaam")} className="text-left">Achternaam{personSortIndicator("achternaam")}</button>
            <button type="button" onClick={()=>changePersonSort("functie")} className="text-left">Functie{personSortIndicator("functie")}</button>
            <button type="button" onClick={()=>changePersonSort("team")} className="text-left">Team{personSortIndicator("team")}</button>
            <span>Account</span><span />
          </div>
          {sortedPeople.map(p=>{
            const roles=personRoles.filter(r=>r.person_id===p.id&&r.actief);
            const profile=profileByPersonId.get(p.id);
            const globalTcRole=roles.find(r=>r.role==="tc"&&r.team_season_id===null);
            const globalCoachRole=roles.find(r=>r.role==="coach"&&r.team_season_id===null);
            const globalPlayerRole=roles.find(r=>r.role==="speler"&&r.team_season_id===null);
            const teamLabels=personTeamLabels(p);
            const actionsOpen=personActionsId===p.id;
            return <div key={p.id} className={`border-b last:border-b-0 ${p.actief?"bg-white":"bg-slate-50 opacity-70"}`}>
              {editingPersonId===p.id?<div className="p-3"><div className="grid gap-2 md:grid-cols-3"><input value={editVoornaam} onChange={e=>setEditVoornaam(e.target.value)} className="rounded-lg border px-3 py-2 text-sm"/><input value={editTussenvoegsel} onChange={e=>setEditTussenvoegsel(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" placeholder="Tussenvoegsel"/><input value={editAchternaam} onChange={e=>setEditAchternaam(e.target.value)} className="rounded-lg border px-3 py-2 text-sm"/></div><div className="mt-2 flex justify-end gap-2"><button onClick={()=>setEditingPersonId(null)} className="rounded-lg border px-3 py-1.5 text-xs font-bold">Annuleren</button><button onClick={()=>void savePerson()} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white">Opslaan</button></div></div>:<div className="grid grid-cols-[130px_170px_270px_180px_minmax(210px,1fr)_44px] items-center gap-2 px-3 py-2">
                <div className="truncate text-sm font-bold text-slate-900">{p.voornaam}</div>
                <div className="truncate text-sm font-bold text-slate-900">{[p.tussenvoegsel,p.achternaam].filter(Boolean).join(" ")}{!p.actief&&<span className="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-[9px] font-extrabold text-slate-600">ARCHIEF</span>}</div>
                <div className="flex flex-wrap gap-1"><button disabled={busy||!p.actief} onClick={()=>globalPlayerRole?void removeRole(globalPlayerRole.id):void addGlobalRole(p.id,"speler")} className={`rounded-md border px-2 py-1 text-[10px] font-extrabold disabled:opacity-40 ${globalPlayerRole?"border-emerald-300 bg-emerald-50 text-emerald-700":"bg-white text-slate-500"}`}>{globalPlayerRole?"✓ Speler":"+ Speler"}</button><button disabled={busy||!p.actief} onClick={()=>globalCoachRole?void removeRole(globalCoachRole.id):void addGlobalRole(p.id,"coach")} className={`rounded-md border px-2 py-1 text-[10px] font-extrabold disabled:opacity-40 ${globalCoachRole?"border-cyan-300 bg-cyan-50 text-cyan-700":"bg-white text-slate-500"}`}>{globalCoachRole?"✓ Coach":"+ Coach"}</button>{isAdmin&&<button disabled={busy||!p.actief} onClick={()=>globalTcRole?void removeRole(globalTcRole.id):void addGlobalRole(p.id,"tc")} className={`rounded-md border px-2 py-1 text-[10px] font-extrabold disabled:opacity-40 ${globalTcRole?"border-blue-300 bg-blue-50 text-blue-700":"bg-white text-slate-500"}`}>{globalTcRole?"✓ TC":"+ TC"}</button>}{roles.some(r=>r.role==="admin")&&<span className="rounded-md bg-purple-100 px-2 py-1 text-[10px] font-extrabold text-purple-700">ADMIN</span>}</div>
                <div className="truncate text-xs text-slate-600" title={teamLabels.join(", ")}>{teamLabels.join(", ")||"—"}</div>
                <div className="min-w-0"><div className="truncate text-xs text-slate-600">{profile?.email??"Geen loginaccount"}</div>{profile&&<div className={`mt-0.5 text-[9px] font-extrabold uppercase ${profile.account_status==="actief"?"text-emerald-700":profile.account_status==="gedeactiveerd"?"text-slate-500":"text-amber-700"}`}>{profile.account_status==="actief"?"Actief":profile.account_status==="gedeactiveerd"?"Gedeactiveerd":"Uitgenodigd"}</div>}</div>
                <button type="button" onClick={()=>{setPersonActionsId(v=>v===p.id?null:p.id);setInvitePersonId(null);setAccountPanelPersonId(null)}} className={`grid h-8 w-8 place-items-center rounded-lg border text-slate-500 ${actionsOpen?"border-blue-300 bg-blue-50 text-blue-700":"bg-white"}`} aria-label={`Beheer ${fullName(p)}`} title="Beheer">•••</button>
              </div>}
              {actionsOpen&&<div className="border-t bg-slate-50/70 px-3 py-2.5"><div className="flex flex-wrap gap-2"><button onClick={()=>openEdit(p)} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-bold">Bewerken</button>{!profile?<button onClick={()=>{setInvitePersonId(p.id);setInviteEmail("");setAccountPanelPersonId(null)}} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700">Account uitnodigen</button>:<button onClick={()=>{setAccountPanelPersonId(v=>v===p.id?null:p.id);setAccountEmailEdit(profile.email??"");setInvitePersonId(null)}} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700">{accountPanelPersonId===p.id?"Account sluiten":"Account beheren"}</button>}{p.actief?<><button onClick={()=>void archivePerson(p.id)} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-bold text-orange-700">Archiveren</button>{!profile&&<button onClick={()=>void deletePerson(p.id)} className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-600">Definitief verwijderen</button>}</>:<button onClick={()=>void reactivatePerson(p.id)} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-bold text-emerald-700">Heractiveren</button>}</div></div>}
              {invitePersonId===p.id&&<div className="border-t border-amber-200 bg-amber-50 p-3"><div className="text-sm font-bold">Loginaccount uitnodigen voor {fullName(p)}</div><div className="mt-2 flex gap-2"><input type="email" value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="E-mailadres" className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"/><button onClick={()=>setInvitePersonId(null)} className="rounded-lg border bg-white px-3 py-2 text-xs font-bold">Annuleren</button><button disabled={busy} onClick={()=>void inviteAccount(p.id)} className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Uitnodigen</button></div></div>}
              {accountPanelPersonId===p.id&&profile&&<div className="border-t border-blue-200 bg-blue-50/50 p-3"><div className="flex items-center justify-between gap-3"><div><div className="text-sm font-black">Loginaccount beheren</div><div className="text-xs text-slate-500">{profile.email??"geen"}</div></div><span className="rounded-full bg-white px-2 py-1 text-[10px] font-extrabold uppercase">{profile.account_status??profile.invitation_status??"onbekend"}</span></div><div className="mt-3 grid gap-2 lg:grid-cols-[1fr_auto]"><input type="email" value={accountEmailEdit} onChange={e=>setAccountEmailEdit(e.target.value)} placeholder="Nieuw e-mailadres" className="rounded-lg border bg-white px-3 py-2 text-sm"/><button disabled={busy||!accountEmailEdit.trim()||accountEmailEdit.trim().toLowerCase()===(profile.email??"").trim().toLowerCase()} onClick={()=>void changeAccountEmail(p.id)} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">E-mail wijzigen</button></div><div className="mt-3 flex flex-wrap gap-2">{profile.account_status!=="actief"&&profile.invitation_status!=="actief"&&<button disabled={busy} onClick={()=>void resendAccountInvite(p.id)} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700">Opnieuw uitnodigen</button>}{(profile.account_status==="actief"||profile.invitation_status==="actief")&&<button disabled={busy} onClick={()=>void resetAccountPassword(p.id)} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-bold">Wachtwoord herstellen</button>}<button disabled={busy} onClick={()=>void unlinkAccount(p.id)} className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-600">Account loskoppelen</button></div></div>}
            </div>;
          })}
          {!sortedPeople.length&&<div className="p-8 text-center text-sm text-slate-500">{personSearch.trim()?"Geen personen gevonden met deze zoekopdracht.":showArchivedPeople?"Er zijn geen personen om te tonen.":"Geen actieve personen gevonden."}</div>}
        </div>
      </div>
    </div>
  </div>;

  if(mode==="teams") return <div className="space-y-5">
    {header("Teams","Beheer het team één keer. Spelers, coaches en TC gelden automatisch voor veld najaar, zaal en veld voorjaar.")}
    {message&&<div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">{message}</div>}
    <div className="rounded-2xl border bg-white p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <select value={managedTeamId} onChange={e=>{setManagedTeamId(e.target.value);setTeamPersonId("");setTeamPlayerSearch("")}} className="min-w-[260px] rounded-xl border px-3 py-2.5 font-bold"><option value="__all__">Alle teams</option>{uniqueTeams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
          {activeContext&&<button onClick={()=>void archiveTeam(activeContext.id)} className="rounded-xl border border-orange-200 px-3 py-2 text-xs font-bold text-orange-700">Team archiveren</button>}
        </div>
        {(isAdmin||isTcMember)&&<div className="min-w-0 lg:w-[420px]">
          <div className="text-sm font-black">Nieuw team</div>
          <div className="mt-1 text-xs text-slate-500">Admin en TC-leden kunnen teams aanmaken. Het team wordt automatisch aan alle actieve competitieperioden gekoppeld.</div>
          <div className="mt-2 flex gap-2">
            <input value={newTeamName} onChange={e=>setNewTeamName(e.target.value)} placeholder="Bijv. K4 of U17-2" className="min-w-0 flex-1 rounded-xl border px-3 py-2"/>
            <button disabled={!newTeamName.trim()||busy} onClick={()=>void createTeam()} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Team aanmaken</button>
          </div>
        </div>}
      </div>
      {!(isAdmin||isTcMember)&&<div className="mt-3 text-xs text-slate-500">Nieuwe teams kunnen alleen door Admin of TC worden aangemaakt.</div>}
    </div>
    {!activeContext?<div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-black">Alle teams</h3><p className="mt-1 text-sm text-slate-500">Dit overzicht staat los van de teamkeuze linksboven. Open een team om de koppelingen te beheren.</p></div><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">{teamSummaries.length} teams</span></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{teamSummaries.map(summary=><button type="button" key={summary.team.id} onClick={()=>setManagedTeamId(summary.team.id)} className="rounded-2xl border p-4 text-left transition hover:border-blue-300 hover:bg-blue-50/40"><div className="flex items-center justify-between gap-3"><div className="text-lg font-black">{summary.team.name}</div><span className="text-xs font-bold text-blue-700">Beheren →</span></div><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-xl bg-slate-50 px-2 py-2"><div className="text-lg font-black">{summary.players}</div><div className="text-[10px] font-bold uppercase text-slate-500">Spelers</div></div><div className="rounded-xl bg-slate-50 px-2 py-2"><div className="text-lg font-black">{summary.coaches}</div><div className="text-[10px] font-bold uppercase text-slate-500">Coaches</div></div><div className="rounded-xl bg-slate-50 px-2 py-2"><div className="text-lg font-black">{summary.tcs}</div><div className="text-[10px] font-bold uppercase text-slate-500">TC</div></div></div><div className="mt-2 text-xs text-slate-400">{summary.periods} gekoppelde competitieperiode{summary.periods===1?"":"n"}</div></button>)}{!teamSummaries.length&&<div className="text-sm text-slate-500">Nog geen actief team beschikbaar.</div>}</div></div>:<div className="grid gap-4 xl:grid-cols-3">
      <div className="rounded-2xl border bg-white p-5">
        <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-black">Spelers</h3><p className="mt-1 text-xs text-slate-500">Basisspelers horen bij dit team. Gastspelers kunnen uit de hele personenlijst worden gekozen.</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">{activePlayers.length}</span></div>
        <div className="mt-3 space-y-2">{activePlayers.map(({m,player})=>{const person=player?.person_id?personById.get(player.person_id):null;return person?<div key={m.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><div><div className="font-bold">{fullName(person)}</div><div className="text-xs text-slate-500">{m.status==="Gast"?"Gastspeler":"Basisspeler"} · {player?.geslacht}</div></div><button onClick={()=>void removePlayer(person.id,managedTeamId)} className="text-xs font-bold text-red-600">Verwijderen</button></div>:null})}{!activePlayers.length&&<div className="text-sm text-slate-400">Geen spelers gekoppeld.</div>}</div>

        <div className="mt-4 border-t pt-4">
          <div className="text-sm font-black">Speler toevoegen</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" onClick={()=>{setTeamPlayerStatus("Basisspeler");setTeamPersonId("")}} className={`rounded-xl border px-3 py-2 text-sm font-bold ${teamPlayerStatus==="Basisspeler"?"border-emerald-400 bg-emerald-50 text-emerald-700":"bg-white text-slate-600"}`}>Basisspeler</button>
            <button type="button" onClick={()=>{setTeamPlayerStatus("Gast");setTeamPersonId("")}} className={`rounded-xl border px-3 py-2 text-sm font-bold ${teamPlayerStatus==="Gast"?"border-amber-400 bg-amber-50 text-amber-700":"bg-white text-slate-600"}`}>Gastspeler</button>
          </div>
          <div className="mt-2 relative">
            <input value={teamPlayerSearch} onChange={e=>{setTeamPlayerSearch(e.target.value);setTeamPersonId("")}} placeholder="Zoek op naam, team of seizoen…" className="w-full rounded-xl border px-3 py-2.5 pr-9 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
            {teamPlayerSearch&&<button type="button" onClick={()=>{setTeamPlayerSearch("");setTeamPersonId("")}} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100">×</button>}
          </div>
          <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border bg-white">
            {teamPlayerCandidates.slice(0,80).map(p=>{
              const existingPlayer=playerByPersonId.get(p.id);
              const existingMemberships=existingPlayer?playerMemberships.filter(m=>m.player_id===existingPlayer.id&&m.actief):[];
              const teamLabels=existingMemberships.map(m=>{const c=contextById.get(m.team_season_id);return c?`${c.teamName} (${m.status==="Gast"?"gast":"basis"})`:""}).filter(Boolean);
              const selected=teamPersonId===p.id;
              return <button type="button" key={p.id} onClick={()=>{setTeamPersonId(p.id);if(existingPlayer?.geslacht)setTeamPlayerGender(existingPlayer.geslacht)}} className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2.5 text-left last:border-0 ${selected?"bg-blue-50":"hover:bg-slate-50"}`}><div className="min-w-0"><div className="truncate text-sm font-bold text-slate-800">{fullName(p)}</div><div className="truncate text-[11px] text-slate-500">{teamLabels.length?teamLabels.join(" · "):existingPlayer?"Speler zonder actieve teamkoppeling":"Nog geen spelersprofiel"}</div></div>{selected&&<span className="shrink-0 text-xs font-black text-blue-600">Gekozen</span>}</button>
            })}
            {!teamPlayerCandidates.length&&<div className="p-4 text-center text-sm text-slate-400">{teamPlayerSearch.trim()?"Geen personen gevonden.":teamPlayerStatus==="Gast"?"Geen beschikbare spelers. Geef iemand eerst de rol Speler bij Personen.":"Geen beschikbare basisspelers. Kies Gastspeler om ook spelers uit andere teams te zien."}</div>}
          </div>
          {teamPlayerCandidates.length>80&&<div className="mt-1 text-[11px] text-slate-400">Eerste 80 resultaten getoond. Gebruik de zoekbalk om gerichter te zoeken.</div>}
          <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
            <select value={teamPlayerGender} onChange={e=>setTeamPlayerGender(e.target.value as Geslacht)} className="rounded-xl border px-2 py-2 text-sm"><option>Dame</option><option>Heer</option></select>
            <button disabled={!teamPersonId||busy} onClick={()=>void addPlayerToTeam(teamPersonId,managedTeamId)} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">+ {teamPlayerStatus==="Gast"?"Gastspeler":"Basisspeler"} koppelen</button>
          </div>
          {teamPlayerStatus==="Gast"&&<div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">Bij Gastspeler worden ook spelers getoond die al basisspeler zijn bij een ander team in dit seizoen. De speler blijft daar gewoon gekoppeld.</div>}
        </div>
      </div>
      <div className="rounded-2xl border bg-white p-5">
        <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-black">Coaches</h3><p className="mt-1 text-xs text-slate-500">Zoek op naam, huidig team, rol of seizoen.</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">{activeCoaches.length}</span></div>
        <div className="mt-3 space-y-2">{activeCoaches.map(r=>{const person=personById.get(r.person_id);return person?<div key={r.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><span className="font-bold">{fullName(person)}</span><button onClick={()=>void removeCoach(person.id,managedTeamId)} className="text-xs font-bold text-red-600">Verwijderen</button></div>:null})}{!activeCoaches.length&&<div className="text-sm text-slate-400">Geen coaches gekoppeld.</div>}</div>
        <div className="mt-4 border-t pt-4">
          <div className="relative"><input value={teamCoachSearch} onChange={e=>{setTeamCoachSearch(e.target.value);setTeamCoachPersonId("")}} placeholder="Zoek coach op naam, team of rol…" className="w-full rounded-xl border px-3 py-2.5 pr-9 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>{teamCoachSearch&&<button type="button" onClick={()=>{setTeamCoachSearch("");setTeamCoachPersonId("")}} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100">×</button>}</div>
          <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border bg-white">{teamCoachCandidates.slice(0,80).map(p=>{const selected=teamCoachPersonId===p.id;const coachTeams=personRoles.filter(r=>r.person_id===p.id&&r.role==="coach"&&r.actief&&r.team_season_id).map(r=>contextById.get(String(r.team_season_id))?.teamName).filter(Boolean);return <button type="button" key={p.id} onClick={()=>setTeamCoachPersonId(p.id)} className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2.5 text-left last:border-0 ${selected?"bg-blue-50":"hover:bg-slate-50"}`}><div className="min-w-0"><div className="truncate text-sm font-bold text-slate-800">{fullName(p)}</div><div className="truncate text-[11px] text-slate-500">{coachTeams.length?`Coach: ${coachTeams.join(" · ")}`:"Nog niet als coach aan een team gekoppeld"}</div></div>{selected&&<span className="shrink-0 text-xs font-black text-blue-600">Gekozen</span>}</button>})}{!teamCoachCandidates.length&&<div className="p-4 text-center text-sm text-slate-400">Geen coaches/personen gevonden.</div>}</div>
          {teamCoachCandidates.length>80&&<div className="mt-1 text-[11px] text-slate-400">Eerste 80 resultaten getoond. Zoek gerichter om de lijst te verkleinen.</div>}
          <button disabled={!teamCoachPersonId||busy} onClick={async()=>{await addCoach(teamCoachPersonId,managedTeamId);setTeamCoachPersonId("");setTeamCoachSearch("")}} className="mt-2 w-full rounded-xl bg-cyan-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">+ Coach koppelen</button>
        </div>
      </div>
      <div className="rounded-2xl border bg-white p-5">
        <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-black">TC</h3><p className="mt-1 text-xs text-slate-500">Alleen personen met de rol TC-lid worden hier aangeboden.</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">{activeTcs.length}</span></div>
        <div className="mt-3 space-y-2">{activeTcs.map(t=>{const person=personById.get(t.person_id);return person?<div key={t.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><span className="font-bold">{fullName(person)}</span><button onClick={()=>void removeTc(person.id,managedTeamId)} className="text-xs font-bold text-red-600">Verwijderen</button></div>:null})}{!activeTcs.length&&<div className="text-sm text-slate-400">Geen TC-lid gekoppeld.</div>}</div>
        <div className="mt-4 border-t pt-4">
          <div className="relative"><input value={teamTcSearch} onChange={e=>{setTeamTcSearch(e.target.value);setTeamTcPersonId("")}} placeholder="Zoek TC-lid op naam of team…" className="w-full rounded-xl border px-3 py-2.5 pr-9 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>{teamTcSearch&&<button type="button" onClick={()=>{setTeamTcSearch("");setTeamTcPersonId("")}} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100">×</button>}</div>
          <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border bg-white">{teamTcCandidates.slice(0,80).map(p=>{const selected=teamTcPersonId===p.id;const tcTeams=tcMemberships.filter(t=>t.person_id===p.id&&t.actief).map(t=>contextById.get(t.team_season_id)?.teamName).filter(Boolean);return <button type="button" key={p.id} onClick={()=>setTeamTcPersonId(p.id)} className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2.5 text-left last:border-0 ${selected?"bg-blue-50":"hover:bg-slate-50"}`}><div className="min-w-0"><div className="truncate text-sm font-bold text-slate-800">{fullName(p)}</div><div className="truncate text-[11px] text-slate-500">{tcTeams.length?`TC: ${tcTeams.join(" · ")}`:"TC-lid · nog niet aan een team gekoppeld"}</div></div>{selected&&<span className="shrink-0 text-xs font-black text-blue-600">Gekozen</span>}</button>})}{!teamTcCandidates.length&&<div className="p-4 text-center text-sm text-slate-400">Geen TC-leden gevonden. Geef iemand eerst de rol TC-lid bij Personen.</div>}</div>
          {teamTcCandidates.length>80&&<div className="mt-1 text-[11px] text-slate-400">Eerste 80 resultaten getoond. Zoek gerichter om de lijst te verkleinen.</div>}
          <button disabled={!teamTcPersonId||busy} onClick={async()=>{await addTc(teamTcPersonId,managedTeamId);setTeamTcPersonId("");setTeamTcSearch("")}} className="mt-2 w-full rounded-xl bg-blue-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">+ TC-lid koppelen</button>
        </div>
      </div>
    </div>}
  </div>;

  const periodLabel=(periode:ManagedSeason["periode"])=>periode==="veld_najaar"?"Veld najaar":periode==="zaal"?"Zaal":periode==="veld_voorjaar"?"Veld voorjaar":"Overig";

  return <div className="space-y-5">
    {header("Seizoenen","Beheer competitiejaren. KorbIQ maakt automatisch veld najaar, zaal en veld voorjaar aan en koppelt alle actieve teams.")}
    {message&&<div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">{message}</div>}
    <div className="rounded-2xl border bg-white p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><h3 className="text-lg font-black">Nieuw competitiejaar</h3><p className="mt-1 text-sm text-slate-500">Je vult alleen het eerste jaar in. KorbIQ maakt automatisch de drie competitieperioden en alle teamkoppelingen.</p></div><div className="flex gap-2"><input type="number" min="2020" max="2100" value={newCompetitionStartYear} onChange={e=>setNewCompetitionStartYear(e.target.value)} className="w-28 rounded-xl border px-3 py-2"/><div className="flex items-center text-sm font-bold text-slate-500">/ {Number(newCompetitionStartYear||0)+1||"…"}</div><button disabled={busy||!newCompetitionStartYear} onClick={()=>void createCompetitionYear()} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">+ Competitiejaar</button></div></div>
    </div>
    <div className="space-y-3">{competitionYears.map(y=>{const yearSeasons=seasons.filter(s=>s.competition_year_id===y.id).sort((a,b)=>["veld_najaar","zaal","veld_voorjaar"].indexOf(String(a.periode))-["veld_najaar","zaal","veld_voorjaar"].indexOf(String(b.periode)));return <div key={y.id} className={`rounded-2xl border bg-white p-5 ${y.actief?"":"opacity-70"}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-extrabold uppercase tracking-[.12em] text-blue-700">Competitiejaar</div><h3 className="mt-0.5 text-xl font-black">{y.naam}</h3><div className="mt-1 text-xs text-slate-500">{y.actief?"Actief":"Gearchiveerd"} · teams worden automatisch gekoppeld</div></div><button disabled={busy} onClick={()=>void setCompetitionYearActive(y.id,!y.actief)} className={`rounded-xl px-3 py-2 text-xs font-extrabold ${y.actief?"border border-slate-200 bg-white text-slate-600":"bg-emerald-600 text-white"}`}>{y.actief?"Archiveren":"Opnieuw activeren"}</button></div><div className="mt-4 grid gap-2 md:grid-cols-3">{yearSeasons.map(s=><div key={s.id} className={`rounded-xl border px-3 py-3 ${s.actief?"border-blue-100 bg-blue-50/60":"bg-slate-50"}`}><div className="font-bold">{periodLabel(s.periode)}</div><div className="mt-0.5 text-xs text-slate-500">{s.naam}</div></div>)}</div></div>})}{!competitionYears.length&&<div className="rounded-2xl border border-dashed bg-white p-8 text-center text-sm text-slate-500">Nog geen competitiejaren gevonden. Voer eerst Query 24 uit en maak daarna hierboven je eerste competitiejaar aan.</div>}</div>
    <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Wedstrijdtypen</h3><p className="mt-1 text-sm leading-6 text-slate-500"><b>Competitie</b> gebruikt één van de drie competitieperioden. <b>Oefenwedstrijd</b> en <b>Toernooi</b> blijven losse wedstrijden en worden niet als seizoen aangemaakt.</p></div>
  </div>;
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
  accountProfiles,
  accountProfilesLoading,
  invitePlayerAccount,
  refreshAccountProfiles,
}: {
  spelers: Player[];
  speelSeconden: Record<string, number>;
  addSpeler: (naam: string, geslacht: Geslacht, status: PlayerStatus, foto?: string) => void;
  delSpeler: (id: string) => void;
  updateSpelerStatus: (id: string, status: PlayerStatus) => void;
  updateSpelerActief: (id: string, actief: boolean) => void;
  exportTeam: () => void;
  triggerImportTeam: () => void;
  accountProfiles: AuthProfile[];
  accountProfilesLoading: boolean;
  invitePlayerAccount: (player: Player, email: string) => Promise<void>;
  refreshAccountProfiles: () => Promise<void>;
}) {
  const [naam, setNaam] = useState("");
  const [geslacht, setGeslacht] = useState<Geslacht>("Dame");
  const [status, setStatus] = useState<PlayerStatus>("Basisspeler");
  const [foto, setFoto] = useState("");
  const [invitePlayerId, setInvitePlayerId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMessage, setInviteMessage] = useState("");

  const profileByPlayerId = useMemo(() => {
    const map = new Map<string, AuthProfile>();
    accountProfiles.forEach((profile) => {
      if (profile.speler_id) map.set(profile.speler_id, profile);
    });
    return map;
  }, [accountProfiles]);

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
        <div className="mb-2 flex items-center justify-between gap-3"><h2 className="font-semibold">Spelerslijst</h2><button type="button" onClick={()=>void refreshAccountProfiles()} disabled={accountProfilesLoading} className="text-xs font-bold text-blue-700 hover:underline disabled:opacity-50">{accountProfilesLoading ? "Accounts laden…" : "Accounts vernieuwen"}</button></div>
        <div className="flex flex-col gap-2">
          {spelers.length === 0 && (
            <div className="text-gray-500">Nog geen spelers toegevoegd.</div>
          )}
          {spelers.map((p) => {
            const account = profileByPlayerId.get(p.id);
            const invitationOpen = invitePlayerId === p.id;
            const accountState = account?.invitation_status === "actief"
              ? "actief"
              : account
                ? "uitgenodigd"
                : "geen";
            return (
              <div
                key={p.id}
                className={`border rounded-xl p-3 ${p.actief ? "bg-white" : "bg-gray-100 opacity-70"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <Avatar url={p.foto} naam={p.naam} />
                    <div className="min-w-0">
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
                    className="shrink-0 text-red-600 text-sm"
                    onClick={() => delSpeler(p.id)}
                  >
                    Verwijder
                  </button>
                </div>

                {p.status === "Basisspeler" ? (
                  <div className="mt-3 border-t pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">KorbIQ-account</div>
                        {accountState === "actief" && <div className="mt-1 text-xs font-semibold text-emerald-700">● Actief{account?.email ? ` · ${account.email}` : ""}</div>}
                        {accountState === "uitgenodigd" && <div className="mt-1 text-xs font-semibold text-amber-700">● Uitnodiging verstuurd{account?.email ? ` · ${account.email}` : ""}</div>}
                        {accountState === "geen" && <div className="mt-1 text-xs font-semibold text-slate-500">● Geen account</div>}
                      </div>
                      {accountState === "geen" && (
                        <button
                          type="button"
                          onClick={() => {
                            setInviteMessage("");
                            setInviteEmail("");
                            setInvitePlayerId(invitationOpen ? null : p.id);
                          }}
                          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-100"
                        >
                          {invitationOpen ? "Annuleren" : "Uitnodigen"}
                        </button>
                      )}
                    </div>

                    {invitationOpen && accountState === "geen" && (
                      <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
                        <label className="block text-xs font-bold text-slate-700">E-mailadres speler
                          <input
                            type="email"
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder="speler@voorbeeld.nl"
                            className="mt-1.5 w-full rounded-lg border bg-white px-3 py-2 text-sm"
                          />
                        </label>
                        {inviteMessage && <div className="mt-2 text-xs font-semibold text-red-700">{inviteMessage}</div>}
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            disabled={inviteBusy}
                            onClick={async () => {
                              setInviteBusy(true);
                              setInviteMessage("");
                              try {
                                await invitePlayerAccount(p, inviteEmail);
                                setInvitePlayerId(null);
                                setInviteEmail("");
                              } catch (error) {
                                setInviteMessage(error instanceof Error ? error.message : "Uitnodiging versturen is mislukt.");
                              } finally {
                                setInviteBusy(false);
                              }
                            }}
                            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-extrabold text-white hover:bg-blue-700 disabled:opacity-60"
                          >
                            {inviteBusy ? "Versturen…" : "Uitnodiging versturen"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 border-t pt-3 text-xs text-slate-500">Invallers / gasten krijgen geen standaard KorbIQ-account.</div>
                )}
              </div>
            );
          })}
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
  competitionPeriodOptions,
  setSeason,
  matchType,
  setMatchType,
  onOpenMatch,
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
  competitionPeriodOptions: string[];
  setSeason: (value: string) => void;
  matchType: MatchType;
  setMatchType: (value: MatchType) => void;
  onOpenMatch: () => void;
}) {
  const beschikbare = spelers.filter((s) => s.actief && !toegewezen.has(s.id));

  // JSX VakindelingTab
  const opstellingCompleet = [...aanval, ...verdediging].every(Boolean);
  const wedstrijdgegevensCompleet =
    Boolean(opponentName.trim()) &&
    Boolean(homeAway) &&
    (matchType !== "Competitie" || Boolean(season));


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
            <h3 className="font-bold">Wedstrijdinstellingen</h3>
            <p className="text-xs text-gray-500">
              Kies hier het wedstrijdtype. Alleen bij competitie is een competitieperiode nodig.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
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
              <div className="mt-1 text-xs text-gray-500">
                Oefenwedstrijden en toernooien vallen buiten de competitieperiode.
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Competitieperiode{matchType === "Competitie" ? " *" : ""}
              </label>
              {matchType === "Competitie" ? (
                competitionPeriodOptions.length ? (
                  <select
                    className="border rounded-lg px-2 py-2 text-sm w-full"
                    value={season}
                    onChange={(e) => setSeason(e.target.value)}
                  >
                    {competitionPeriodOptions.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                ) : (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    Voor dit team is nog geen actieve competitieperiode beschikbaar.
                  </div>
                )
              ) : (
                <div className="rounded-lg border bg-white px-3 py-2 text-sm text-gray-500">
                  Niet van toepassing
                </div>
              )}
              <div className="mt-1 text-xs text-gray-500">
                Competitieperioden beheer je centraal onder Beheer → Seizoenen.
              </div>
            </div>
          </div>
        </div>

        <div className={`rounded-2xl border p-4 ${opstellingCompleet && wedstrijdgegevensCompleet ? "border-blue-200 bg-blue-50" : "border-amber-200 bg-amber-50"}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-bold">Klaar met instellen?</div>
              <p className="mt-0.5 text-xs text-gray-600">
                Open de huidige wedstrijd. De wedstrijd en klok starten pas wanneer je dat daar zelf kiest.
              </p>
              {(!opstellingCompleet || !wedstrijdgegevensCompleet) && (
                <p className="mt-1 text-xs font-semibold text-amber-700">
                  Je kunt alvast doorgaan; ontbrekende gegevens worden gecontroleerd wanneer je de wedstrijd echt start.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onOpenMatch}
              className="shrink-0 rounded-xl bg-blue-600 px-5 py-3 text-sm font-black text-white shadow-sm transition hover:bg-blue-700"
            >
              Naar huidige wedstrijd →
            </button>
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
  onOpenSettings,
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
  onOpenSettings: () => void;
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

  // Live momentum: een compacte indicatie van wie de laatste fase van de wedstrijd domineert.
  // De score gebruikt recente goals, kansen, rebounds en balverlies en is bewust geen eindconclusie.
  const recentHomeTurnovers = recentHomeEvents.filter((e) =>
    ["Bal onderschept", "Pass Onderschept", "Bal uit"].includes(String(e.reden ?? ""))
  ).length;
  const momentumRaw =
    recentHomeGoals * 3 +
    recentHomeAttempts.length * 0.35 +
    recentWonRebounds * 0.8 -
    recentAwayGoals * 3 -
    recentAwayAttempts.length * 0.2 -
    recentHomeTurnovers * 1.2;
  const momentumPct = Math.max(8, Math.min(92, 50 + momentumRaw * 6));
  const momentumLabel =
    momentumPct >= 66 ? "Korbis heeft momentum" :
    momentumPct <= 34 ? `${opponentName || "Tegenstander"} heeft momentum` :
    "Wedstrijd in balans";
  const momentumTone = momentumPct >= 66 ? "green" : momentumPct <= 34 ? "red" : "blue";

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
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="mt-3 w-full rounded-xl border border-amber-400 bg-white px-4 py-2.5 text-sm font-extrabold text-amber-900 transition hover:bg-amber-100"
                  >
                    Naar wedstrijdinstellingen →
                  </button>
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

                  <div className="text-sm text-gray-500">Je kunt de wedstrijd nu bekijken in het wedstrijdverslag en na het opslaan delen via een openbare link.</div>
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

          {/* Fase 15: live momentum. Geeft de recente wedstrijdstroom visueel weer. */}
          {wedstrijdGestart && !wedstrijdAfgelopen && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-no-pause>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="flex items-center gap-2"><SignalDot tone={momentumTone}/><div className="font-bold">Live momentum</div></div>
                  <div className="mt-1 text-xs text-slate-500">Laatste fase op basis van goals, kansen, aanvallende rebounds en balverlies.</div>
                </div>
                <div className="text-left lg:text-right">
                  <div className={`text-sm font-extrabold ${momentumTone === "green" ? "text-emerald-700" : momentumTone === "red" ? "text-red-700" : "text-blue-700"}`}>{momentumLabel}</div>
                  <div className="text-xs text-slate-500">{recentHomeGoals}-{recentAwayGoals} goals · {recentHomeAttempts.length}-{recentAwayAttempts.length} kansen in recente aanvallen</div>
                </div>
              </div>
              <div className="mt-4">
                <div className="mb-1 flex justify-between text-[11px] font-bold text-slate-500"><span>{opponentName || "Tegenstander"}</span><span>Korbis</span></div>
                <div className="relative h-3 overflow-hidden rounded-full bg-gradient-to-r from-red-400 via-slate-200 to-emerald-400">
                  <div className="absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-slate-900 shadow" style={{ left: `calc(${momentumPct}% - 2px)` }} />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5"><span className="text-slate-500">Korfgericht</span><div className="font-bold">{recentHomeAttempts.length ? `${((recentHomeGoals + recentHomeAttempts.filter((e) => e.resultaat === "Korf").length) / recentHomeAttempts.length * 100).toFixed(0)}%` : "–"}</div></div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5"><span className="text-slate-500">Rebound</span><div className="font-bold">{recentReboundPct == null ? "–" : `${recentReboundPct.toFixed(0)}%`}</div></div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5"><span className="text-slate-500">Balverlies</span><div className="font-bold">{recentHomeTurnovers}</div></div>
                </div>
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
  dbSheets,
  saveStatus,
  saveMessage,
  onRetrySave,
  onBackToMatch,
}: {
  state: AppState;
  spelersMap: Map<string, Player>;
  dbSheets: DatabaseSheetsData | null;
  saveStatus: "idle" | "saving" | "saved" | "error";
  saveMessage: string;
  onRetrySave: () => void;
  onBackToMatch: () => void;
}) {
  const opponent = state.opponentName || "Tegenstander";
  const reportNorm = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const attemptActions = new Set(["schot", "doorloop", "vrijebal", "vrije bal", "vrije", "strafworp"]);
  const isAttemptEvent = (event: { actie?: unknown }) => attemptActions.has(reportNorm(event.actie));
  const isOwnAttempt = (event: LogEvent) => isAttemptEvent(event) && event.team !== "uit" && (event.team === "thuis" || event.vak === "aanvallend" || event.soort === "Kans" || event.soort === "Schot");
  const isMadeAttempt = (event: { resultaat?: unknown; reden?: unknown }) => reportNorm(event.resultaat) === "raak" || ["doelpunt", "gescoord"].includes(reportNorm(event.reden));
  const isDirectedAttempt = (event: { resultaat?: unknown; reden?: unknown }) => isMadeAttempt(event) || reportNorm(event.resultaat) === "korf" || reportNorm(event.reden) === "korf";
  // Het verslag gebruikt dezelfde logregels als de spelerskaarten en de opgeslagen database.
  // Veldmarkers zijn alleen voor de heatmap en gebruiken bewust lowercase actienamen.
  const attempts = state.log.filter(isOwnAttempt);
  const totalAttempts = attempts.length;
  const goalsFromAttempts = attempts.filter(isMadeAttempt).length;
  const onTarget = attempts.filter(isDirectedAttempt).length;
  const scorePct = totalAttempts ? goalsFromAttempts / totalAttempts * 100 : 0;
  const quality = totalAttempts ? onTarget / totalAttempts * 100 : 0;
  const reboundsWon = state.log.filter((e) => e.reden === "Rebound" && e.team !== "uit").length;
  const reboundsLost = state.log.filter((e) => e.reden === "Geen Rebound" || (e.reden === "Rebound" && e.team === "uit")).length;
  const reboundTotal = reboundsWon + reboundsLost;
  const reboundPct = reboundTotal ? reboundsWon / reboundTotal * 100 : 0;
  const turnovers = state.log.filter((e) => e.team !== "uit" && ["Bal onderschept", "Pass Onderschept", "Bal uit"].includes(String(e.reden ?? ""))).length;

  const korbisAttacks = state.attacks.filter((a) => a.team === "thuis");
  const chancesPerAttack = korbisAttacks.length ? totalAttempts / korbisAttacks.length : 0;

  const historicalMatches = (dbSheets?.matches ?? []).filter((m:any) =>
    String(m.seizoen ?? "") === state.season &&
    String(m.wedstrijdtype ?? "Competitie") === state.matchType
  );
  const historicalIds = new Set(historicalMatches.map((m:any) => String(m.wedstrijd_id ?? "")));
  const historicalEvents = (dbSheets?.events ?? []).filter((e:any) => historicalIds.has(String(e.wedstrijd_id ?? "")));
  const historicalAttacks = (dbSheets?.attacks ?? []).filter((a:any) => historicalIds.has(String(a.wedstrijd_id ?? "")));
  const histIsKorbis = (e:any) => ["korbis", "thuis"].includes(String(e.team ?? "").trim().toLowerCase());
  const histAttempts = historicalEvents.filter((e:any) => histIsKorbis(e) && isAttemptEvent(e));
  const histGoals = histAttempts.filter((e:any) => String(e.uitkomst ?? e.resultaat ?? "").toLowerCase() === "raak").length;
  const histDirected = histAttempts.filter((e:any) => ["raak", "korf"].includes(String(e.uitkomst ?? e.resultaat ?? "").toLowerCase())).length;
  const histWonRebounds = historicalEvents.filter((e:any) => histIsKorbis(e) && String(e.reden ?? "") === "Rebound").length;
  const histLostRebounds = historicalEvents.filter((e:any) => histIsKorbis(e) && String(e.reden ?? "") === "Geen Rebound").length;
  const histOwnAttacks = historicalAttacks.filter((a:any) => ["korbis", "thuis"].includes(String(a.team ?? "").trim().toLowerCase())).length;
  const seasonBaseline = {
    scorePct: histAttempts.length ? histGoals / histAttempts.length * 100 : null,
    quality: histAttempts.length ? histDirected / histAttempts.length * 100 : null,
    rebound: histWonRebounds + histLostRebounds ? histWonRebounds / (histWonRebounds + histLostRebounds) * 100 : null,
    chancesPerAttack: histOwnAttacks ? histAttempts.length / histOwnAttacks : null,
  };
  const compareText = (value:number, base:number|null, suffix="%") => base === null ? "Nog geen seizoensbasis" : `${value >= base ? "+" : ""}${(value-base).toFixed(1)}${suffix} vs seizoen`;

  const vakStats = ([1, 2] as VakId[]).map((vakId) => {
    const attacksForVak = korbisAttacks.filter((a) => a.vakId === vakId);
    const attackIds = new Set(attacksForVak.map((a) => a.id));
    const vakAttempts = attempts.filter((e) => e.vakId === vakId || (e.attackId && attackIds.has(e.attackId)));
    const goals = vakAttempts.filter(isMadeAttempt).length;
    return { vakId, attacks: attacksForVak.length, attempts: vakAttempts.length, goals, goals10: attacksForVak.length ? goals / attacksForVak.length * 10 : 0 };
  });

  const combinationRows = Array.from(new Set(state.vakPeriods.map((p) => p.combinatieKey).filter(Boolean))).map((key) => {
    const periods = state.vakPeriods.filter((p) => p.combinatieKey === key);
    const seconds = periods.reduce((sum, p) => sum + Math.max(0, (p.endSeconden ?? state.tijdSeconden) - p.startSeconden), 0);
    const ids = periods[0]?.spelerIds ?? [];
    const comboAttacks = korbisAttacks.filter((a) => a.combinatieKey === key);
    const attackIds = new Set(comboAttacks.map((a) => a.id));
    const comboAttempts = attempts.filter((e) => e.combinatieKey === key || (e.attackId && attackIds.has(e.attackId)));
    const goals = comboAttempts.filter(isMadeAttempt).length;
    const directed = comboAttempts.filter(isDirectedAttempt).length;
    const knownPlayerNames = new Map<string,string>();
    state.spelers.forEach((player)=>knownPlayerNames.set(player.id,player.naam));
    spelersMap.forEach((player,id)=>knownPlayerNames.set(id,player.naam));
    (dbSheets?.events ?? []).forEach((event:any)=>{const id=String(event.spelerId??"");const name=String(event.spelerNaam??"").trim();if(id&&name&&name!==id)knownPlayerNames.set(id,name);});
    const readableName = (id:string) => knownPlayerNames.get(id) ?? (id.includes("-") && id.length >= 32 ? "Onbekende speler" : id);
    return { key, ids, seconds, attacks: comboAttacks.length, attempts: comboAttempts.length, goals,
      goalsPer10: comboAttacks.length ? goals / comboAttacks.length * 10 : 0,
      quality: comboAttempts.length ? directed / comboAttempts.length * 100 : 0,
      names: ids.map(readableName) };
  }).filter((row) => row.ids.length === 4).sort((a,b) => b.goalsPer10-a.goalsPer10 || b.seconds-a.seconds);

  const reliabilityLabel = (seconds:number) => seconds >= 3600 ? "Sterke basis" : seconds >= 1800 ? "Redelijke basis" : seconds >= 900 ? "Beperkte basis" : "Zeer beperkte basis";
  const bestCombination = combinationRows.find((row) => row.goals > 0 && row.attacks >= 2) ?? null;

  const playerRows = Array.from(spelersMap.values()).map((p) => {
    const logs = state.log.filter((e) => e.spelerId === p.id);
    const playerAttempts = logs.filter(isOwnAttempt);
    const goals = playerAttempts.filter(isMadeAttempt).length;
    const rebounds = logs.filter((e) => e.reden === "Rebound").length;
    const defense = logs.filter((e) => ["Schot afgevangen", "Pass Onderschept", "Bal onderschept", "Verdedigd"].includes(String(e.reden ?? ""))).length;
    const impact = goals * 3 + rebounds * 1.5 + defense * 2;
    return { p, goals, attempts: playerAttempts.length, rebounds, defense, impact };
  }).filter((x) => x.goals + x.rebounds + x.defense > 0).sort((a,b) => b.impact-a.impact).slice(0,4);

  const scoreEvents = state.log.filter((e) => e.reden === "Doelpunt" || e.reden === "Gescoord" || e.reden === "Doorgelaten").slice().sort((a,b) => a.tijdSeconden-b.tijdSeconden);
  let home=0, away=0;
  const progression = scoreEvents.map((e) => { const isOpp = e.team === "uit" || e.reden === "Doorgelaten"; if (isOpp) away += 1; else home += 1; return { ...e, home, away, isOpp }; });

  const phaseLength = 600;
  const phaseCount = Math.max(1, Math.ceil(Math.max(state.tijdSeconden, 1) / phaseLength));
  const phases = Array.from({length: phaseCount}, (_,i) => {
    const start=i*phaseLength, end=Math.min((i+1)*phaseLength, Math.max(state.tijdSeconden,(i+1)*phaseLength));
    const phaseScores=progression.filter((e)=>e.tijdSeconden>=start && e.tijdSeconden<end);
    const hg=phaseScores.filter((e)=>!e.isOpp).length, ag=phaseScores.filter((e)=>e.isOpp).length;
    const phaseAttempts=attempts.filter((e)=>e.tijdSeconden>=start && e.tijdSeconden<end).length;
    const raw=(hg-ag)*3 + phaseAttempts*0.25;
    return { start, end, hg, ag, raw, tone: raw>=2 ? "green" as const : raw<=-2 ? "red" as const : "blue" as const };
  });
  const strongestPhase = phases.slice().sort((a,b)=>b.raw-a.raw)[0];
  const weakestPhase = phases.slice().sort((a,b)=>a.raw-b.raw)[0];
  const minuteRange = (p:{start:number;end:number}) => `${Math.floor(p.start/60)}'–${Math.ceil(p.end/60)}'`;

  const strengths: string[] = [];
  const attention: { tone: "orange" | "red"; text: string }[] = [];
  if (scorePct >= (seasonBaseline.scorePct ?? 30) + 3 && totalAttempts >= 5) strengths.push(`Afronding lag boven het gebruikelijke niveau: ${scorePct.toFixed(1)}% raak (${compareText(scorePct, seasonBaseline.scorePct)}).`);
  if (quality >= (seasonBaseline.quality ?? 55) + 5 && totalAttempts >= 5) strengths.push(`Korfgerichtheid was sterk met ${quality.toFixed(0)}%.`);
  if (reboundPct >= (seasonBaseline.rebound ?? 50) + 6 && reboundTotal >= 4) strengths.push(`Aanvallende rebound lag duidelijk boven het seizoensniveau: ${reboundPct.toFixed(0)}%.`);
  if (bestCombination && bestCombination.attacks >= 2) strengths.push(`${bestCombination.names.join(" · ")} was het productiefste viertal met ${bestCombination.goalsPer10.toFixed(1)} goals per 10 aanvallen.`);
  if (scorePct < (seasonBaseline.scorePct ?? 30) - 4 && totalAttempts >= 5) attention.push({tone:"orange", text:`Afronding bleef achter: ${scorePct.toFixed(1)}% raak (${compareText(scorePct, seasonBaseline.scorePct)}).`});
  if (reboundPct < (seasonBaseline.rebound ?? 50) - 7 && reboundTotal >= 4) attention.push({tone:"orange", text:`Aanvallende rebound bleef met ${reboundPct.toFixed(0)}% onder het gebruikelijke niveau.`});
  if (turnovers >= 5) attention.push({tone:"orange", text:`Er zijn ${turnovers} momenten van balverlies/onderschepping geregistreerd.`});
  if (state.scoreUit > state.scoreThuis) attention.push({tone:"red", text:`${opponent} won met ${state.scoreUit}-${state.scoreThuis}.`});
  if (!strengths.length) strengths.push("Geen onderdeel week voldoende positief af om als uitgesproken sterk punt te markeren.");
  if (!attention.length) attention.push({tone:"orange", text:"Geen groot aandachtspunt springt op basis van de geregistreerde wedstrijddata direct naar voren."});

  const resultText = state.scoreThuis > state.scoreUit ? "Korbis won" : state.scoreThuis < state.scoreUit ? "Korbis verloor" : "De wedstrijd eindigde gelijk";
  const matchStory = `${resultText} met ${state.scoreThuis}-${state.scoreUit}. Korbis creëerde ${totalAttempts} geregistreerde kansen uit ${korbisAttacks.length} aanvallen (${chancesPerAttack.toFixed(2)} per aanval) en schoot ${scorePct.toFixed(1)}% raak. ${strongestPhase && strongestPhase.raw > 0 ? `De sterkste fase lag tussen ${minuteRange(strongestPhase)}.` : "Er was geen uitgesproken dominante fase."}${weakestPhase && weakestPhase.raw < -1 ? ` De lastigste fase lag tussen ${minuteRange(weakestPhase)}.` : ""}`;

  const fixture = state.homeAway === "uit" ? `${opponent} - Korbis` : `Korbis - ${opponent}`;
  return <div className="space-y-5">
    <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm"><div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Match Report</div><h2 className="mt-1 text-2xl font-bold">Wedstrijdverslag</h2><p className="mt-1 text-sm text-slate-500">Automatische nabespreking van wedstrijdbeeld, spelers, viertallen en seizoen.</p></div><div className="flex items-center gap-4 rounded-2xl border border-blue-100 bg-white px-5 py-3 shadow-sm"><div><div className="text-xs text-slate-500">{fixture}</div><div className="text-3xl font-extrabold text-slate-900">{state.scoreThuis} - {state.scoreUit}</div></div><span className={`rounded-full px-3 py-1 text-xs font-extrabold ${state.scoreThuis>state.scoreUit?"bg-green-100 text-green-800":state.scoreThuis<state.scoreUit?"bg-red-100 text-red-800":"bg-slate-100 text-slate-700"}`}>{state.scoreThuis>state.scoreUit?"Winst":state.scoreThuis<state.scoreUit?"Verlies":"Gelijk"}</span></div></div></div>
    {state.matchEnded && saveStatus !== "idle" && <div className={`rounded-2xl border p-4 text-sm ${saveStatus==="saved"?"border-emerald-200 bg-emerald-50 text-emerald-900":saveStatus==="error"?"border-red-200 bg-red-50 text-red-900":"border-blue-200 bg-blue-50 text-blue-900"}`}><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><b>{saveStatus==="saved"?"Wedstrijd opgeslagen":saveStatus==="error"?"Opslaan mislukt":"Wedstrijd opslaan"}</b><div className="mt-1">{saveMessage}</div></div>{saveStatus==="error"&&<button type="button" onClick={onRetrySave} className="shrink-0 rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white">Opnieuw proberen</button>}</div></div>}
    {!state.matchEnded && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><b>Voorlopig verslag.</b> De wedstrijd is nog niet afgesloten.</div>}

    <div className="rounded-2xl border border-blue-100 bg-blue-50/60 p-5"><div className="text-xs font-extrabold uppercase tracking-[0.14em] text-blue-600">Wedstrijdbeeld</div><p className="mt-2 text-sm leading-6 text-slate-700">{matchStory}</p></div>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[
      ["Doelpunten",state.scoreThuis,"bg-green-50 border-green-100 text-green-800"],
      ["Kansen",totalAttempts,"bg-blue-50 border-blue-100 text-blue-800"],
      ["Raak",`${scorePct.toFixed(0)}%`,"bg-indigo-50 border-indigo-100 text-indigo-800"],
      ["Korfgericht",`${quality.toFixed(0)}%`,"bg-cyan-50 border-cyan-100 text-cyan-800"],
      ["Rebound",`${reboundPct.toFixed(0)}%`,"bg-orange-50 border-orange-100 text-orange-800"]
    ].map(([label,value,cls])=><div key={String(label)} className={`rounded-2xl border p-4 ${cls}`}><div className="text-xs font-bold uppercase tracking-wide opacity-70">{label}</div><div className="mt-1 text-3xl font-extrabold">{value}</div></div>)}</div>

    <div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Sterke punten</h3><div className="mt-4 space-y-3">{strengths.slice(0,4).map((text,i)=><div key={i} className="flex gap-3 rounded-xl bg-green-50 p-3 text-sm text-green-950"><SignalDot tone="green"/><span>{text}</span></div>)}</div></div><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Aandachtspunten</h3><div className="mt-4 space-y-3">{attention.slice(0,4).map((item,i)=><div key={i} className={`flex gap-3 rounded-xl p-3 text-sm ${item.tone==='red'?'bg-red-50 text-red-950':'bg-orange-50 text-orange-950'}`}><SignalDot tone={item.tone}/><span>{item.text}</span></div>)}</div></div></div>

    <div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold">Momentum & wedstrijdfases</h3><p className="text-xs text-slate-500">Per blok van 10 minuten: groen Korbis, rood tegenstander, blauw in balans.</p></div></div><div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">{phases.map((p,i)=><div key={i} className={`rounded-xl p-3 ${p.tone==='green'?'bg-green-50':p.tone==='red'?'bg-red-50':'bg-blue-50'}`}><div className="flex items-center gap-2"><SignalDot tone={p.tone}/><b className="text-sm">{minuteRange(p)}</b></div><div className="mt-2 text-xs text-slate-600">Goals {p.hg}-{p.ag}</div></div>)}</div></div>

    <div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Scoreverloop</h3><p className="text-xs text-slate-500">Doelpunten in chronologische volgorde.</p><div className="mt-4 flex min-h-16 items-center gap-1.5 overflow-x-auto pb-1">{progression.length?progression.map((e,i)=><div key={e.id+i} className="min-w-[54px] text-center"><div className={`mx-auto flex h-8 w-10 items-center justify-center rounded-lg text-xs font-extrabold text-white ${e.isOpp?'bg-red-500':'bg-green-500'}`}>{e.home}-{e.away}</div><div className="mt-1 text-[9px] text-slate-400">{Math.floor(e.tijdSeconden/60)}'</div></div>):<div className="text-sm text-slate-400">Geen doelpunten geregistreerd.</div>}</div></div><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Opvallende spelers</h3><p className="text-xs text-slate-500">Gebaseerd op geregistreerde goals, rebounds en verdedigende acties.</p><div className="mt-4 grid gap-2 sm:grid-cols-2">{playerRows.length?playerRows.map((x)=><div key={x.p.id} className="rounded-xl bg-slate-50 p-3"><div className="font-bold">{x.p.naam}</div><div className="mt-1 text-xs text-slate-600">{x.goals} goals · {x.attempts} kansen · {x.rebounds} reb. · {x.defense} verd.</div></div>):<div className="text-sm text-slate-400">Nog onvoldoende individuele acties.</div>}</div></div></div>

    <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Vakcombinaties in deze wedstrijd</h3><p className="text-sm text-slate-500">De werkelijke viertallen, onafhankelijk van de naam Vak 1 of Vak 2. Betrouwbaarheid blijft zichtbaar.</p><div className="mt-4 grid gap-3 lg:grid-cols-2">{combinationRows.length?combinationRows.map((r)=><div key={r.key} className="rounded-xl border border-slate-100 bg-slate-50 p-4"><div className="flex items-start justify-between gap-3"><div><div className="font-bold">{r.names.join(" · ")}</div><div className="mt-1 text-xs text-slate-500">{Math.round(r.seconds/60)} min · {reliabilityLabel(r.seconds)}</div></div>{r===bestCombination&&<span className="rounded-full bg-green-100 px-2 py-1 text-xs font-bold text-green-800">Beste aanval</span>}</div><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div><b>{r.goalsPer10.toFixed(1)}</b><div className="text-[10px] text-slate-500">Goals / 10 aanv.</div></div><div><b>{r.attempts}</b><div className="text-[10px] text-slate-500">Kansen</div></div><div><b>{r.quality.toFixed(0)}%</b><div className="text-[10px] text-slate-500">Korfgericht</div></div></div></div>):<div className="text-sm text-slate-400">Geen vakperiodes geregistreerd.</div>}</div></div>

    <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Prestatie versus seizoen</h3><p className="text-sm text-slate-500">Vergelijking met eerdere {state.matchType.toLowerCase()}en in {state.season}. De huidige wedstrijd wordt alleen meegenomen als hij al in de database staat.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
      ["Raak",scorePct,seasonBaseline.scorePct], ["Korfgericht",quality,seasonBaseline.quality], ["Aanv. rebound",reboundPct,seasonBaseline.rebound], ["Kansen / aanval",chancesPerAttack,seasonBaseline.chancesPerAttack]
    ].map(([label,val,base])=>{const v=Number(val); const b=base===null?null:Number(base); const delta=b===null?null:v-b; const tone=delta===null?"blue":delta>=4?"green":delta<=-4?"red":"orange"; return <div key={String(label)} className="rounded-xl bg-slate-50 p-4"><div className="flex items-center gap-2"><SignalDot tone={tone}/><span className="text-xs font-bold text-slate-500">{label}</span></div><div className="mt-2 text-2xl font-extrabold">{label==="Kansen / aanval"?v.toFixed(2):`${v.toFixed(1)}%`}</div><div className="mt-1 text-xs text-slate-500">{b===null?"Nog geen seizoensbasis":`Seizoen ${label==="Kansen / aanval"?b.toFixed(2):`${b.toFixed(1)}%`}`}</div></div>})}</div></div>

    <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border bg-white p-4"><div className="text-xs font-bold text-slate-500">Vak 1</div><div className="mt-1 text-lg font-extrabold">{vakStats[0].goals10.toFixed(1)} goals / 10 aanv.</div><div className="text-xs text-slate-500">{vakStats[0].goals} goals · {vakStats[0].attempts} kansen</div></div><div className="rounded-2xl border bg-white p-4"><div className="text-xs font-bold text-slate-500">Vak 2</div><div className="mt-1 text-lg font-extrabold">{vakStats[1].goals10.toFixed(1)} goals / 10 aanv.</div><div className="text-xs text-slate-500">{vakStats[1].goals} goals · {vakStats[1].attempts} kansen</div></div></div>

    <div className="flex justify-end"><button onClick={onBackToMatch} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700">Terug naar wedstrijd</button></div>
  </div>;
}


function VakcombinatiesDashboard({ dbSheets, spelers = [] }: { dbSheets: DatabaseSheetsData | null; spelers?: Player[] }) {
  const periods = dbSheets?.vakperiodes ?? [];
  const events = dbSheets?.events ?? [];
  const attacks = dbSheets?.attacks ?? [];

  type CombinationStat = {
    key:string; names:string[]; seconds:number; matches:Set<string>; attacks:number; attempts:number; goals:number;
    quality:number; reboundsWon:number; reboundsLost:number; turnovers:number; oppAttempts:number; oppGoals:number; defensive:number;
  };
  const isKorbis = (row:any) => ["korbis","thuis"].includes(String(row.team ?? "").trim().toLowerCase());
  const action = (row:any) => String(row.actie ?? "").trim().toLowerCase();
  const outcome = (row:any) => String(row.uitkomst ?? row.resultaat ?? "").trim().toLowerCase();
  const reason = (row:any) => String(row.reden ?? "").trim().toLowerCase();
  const isAttempt = (row:any) => ["schot","doorloop","vrijebal","vrije bal","strafworp"].includes(action(row));
  const isMade = (row:any) => outcome(row)==="raak" || reason(row)==="doelpunt" || reason(row)==="gescoord";
  const isKorf = (row:any) => outcome(row)==="korf" || reason(row)==="korf";
  const isTurnover = (row:any) => ["bal onderschept","bal uit","pass onderschept","overtreding"].includes(reason(row));
  const isDefensivePositive = (row:any) => reason(row)==="verdedigd" || reason(row)==="pass onderschept" || reason(row)==="bal onderschept";
  const playerNameById = new Map<string,string>();
  spelers.forEach((player)=>playerNameById.set(player.id,player.naam));
  (dbSheets?.spelers ?? []).forEach((player:any)=>{const id=String(player.speler_id??player.id??"");const name=String(player.naam??player.speler_naam??"").trim();if(id&&name)playerNameById.set(id,name);});
  events.forEach((event:any)=>{const id=String(event.spelerId??event.speler_id??"");const name=String(event.spelerNaam??event.speler_naam??"").trim();if(id&&name&&name!==id)playerNameById.set(id,name);});
  const combinationNamesFor = (row:any) => {
    let ids:string[]=[];
    const rawIds=row.combinatie_speler_ids;
    if(Array.isArray(rawIds)) ids=rawIds.map(String);
    else { try { const parsed=JSON.parse(String(rawIds??"[]")); if(Array.isArray(parsed))ids=parsed.map(String); } catch {} }
    const supplied=String(row.combinatie_spelers??"").split(" · ").map((value)=>value.trim()).filter(Boolean);
    const values=ids.length?ids:supplied;
    return values.map((value,index)=>playerNameById.get(value) ?? (supplied[index] && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(supplied[index]) ? supplied[index] : "Onbekende speler"));
  };

  const stats = useMemo(() => {
    const map = new Map<string, CombinationStat>();
    const ensure = (key:string, names:string[]) => {
      if (!map.has(key)) map.set(key, { key, names, seconds:0, matches:new Set(), attacks:0, attempts:0, goals:0, quality:0, reboundsWon:0, reboundsLost:0, turnovers:0, oppAttempts:0, oppGoals:0, defensive:0 });
      const row=map.get(key)!; if (!row.names.length && names.length) row.names=names; return row;
    };
    for (const p of periods) {
      const key=String(p.combinatie_key ?? ""); if (!key) continue;
      const names=combinationNamesFor(p);
      const r=ensure(key,names); r.seconds += Number(p.duur_seconden ?? 0) || 0; r.matches.add(String(p.wedstrijd_id ?? ""));
    }
    for (const a of attacks) {
      const key=String(a.combinatie_key ?? ""); if (!key || !isKorbis(a)) continue;
      const names=combinationNamesFor(a); ensure(key,names).attacks += 1;
    }
    for (const e of events) {
      const key=String(e.combinatie_key ?? ""); if (!key) continue;
      const names=combinationNamesFor(e); const r=ensure(key,names);
      if (isKorbis(e)) {
        if (isAttempt(e)) { r.attempts += 1; if (isMade(e)) r.goals += 1; if (isMade(e) || isKorf(e)) r.quality += 1; }
        if (action(e)==="rebound" && reason(e)==="rebound") r.reboundsWon += 1;
        if (action(e)==="rebound" && reason(e)==="geen rebound") r.reboundsLost += 1;
        if (isTurnover(e)) r.turnovers += 1;
        if (isDefensivePositive(e)) r.defensive += 1;
      } else if (isAttempt(e)) {
        r.oppAttempts += 1; if (isMade(e)) r.oppGoals += 1;
      }
    }
    return [...map.values()].filter(r=>r.names.length).sort((a,b)=>b.seconds-a.seconds);
  }, [periods, events, attacks, spelers]);

  const totals=stats.reduce((t,r)=>({seconds:t.seconds+r.seconds,attacks:t.attacks+r.attacks,attempts:t.attempts+r.attempts,goals:t.goals+r.goals,quality:t.quality+r.quality,reboundsWon:t.reboundsWon+r.reboundsWon,reboundsLost:t.reboundsLost+r.reboundsLost,turnovers:t.turnovers+r.turnovers,oppAttempts:t.oppAttempts+r.oppAttempts,oppGoals:t.oppGoals+r.oppGoals,defensive:t.defensive+r.defensive}),{seconds:0,attacks:0,attempts:0,goals:0,quality:0,reboundsWon:0,reboundsLost:0,turnovers:0,oppAttempts:0,oppGoals:0,defensive:0});
  const safePct=(a:number,b:number)=>b?a/b*100:0;
  const baseline={
    goals10: totals.attacks ? totals.goals/totals.attacks*10 : 0,
    chancesAttack: totals.attacks ? totals.attempts/totals.attacks : 0,
    quality: safePct(totals.quality,totals.attempts),
    rebound: safePct(totals.reboundsWon,totals.reboundsWon+totals.reboundsLost),
    turnovers10: totals.attacks ? totals.turnovers/totals.attacks*10 : 0,
    oppScore: safePct(totals.oppGoals,totals.oppAttempts),
  };
  const reliability=(seconds:number)=>seconds<15*60?{level:1,label:"Zeer beperkte data",tone:"blue" as const}:seconds<30*60?{level:2,label:"Beperkte data",tone:"blue" as const}:seconds<60*60?{level:3,label:"Redelijke basis",tone:"orange" as const}:{level:4,label:"Sterke basis",tone:"green" as const};
  const toneFor=(value:number, base:number, higherBetter=true, tolerance=.08):"green"|"orange"|"red"|"blue"=>{ if(!base && !value)return "blue"; const diff=base?((value-base)/Math.abs(base)):0; const adjusted=higherBetter?diff:-diff; return adjusted>=tolerance?"green":adjusted<=-tolerance?"red":"orange"; };
  const enriched=stats.map(r=>{
    const goals10=r.attacks?r.goals/r.attacks*10:0, chancesAttack=r.attacks?r.attempts/r.attacks:0, quality=safePct(r.quality,r.attempts), rebound=safePct(r.reboundsWon,r.reboundsWon+r.reboundsLost), turnovers10=r.attacks?r.turnovers/r.attacks*10:0, oppScore=safePct(r.oppGoals,r.oppAttempts);
    const tones=[toneFor(goals10,baseline.goals10,true,.10),toneFor(chancesAttack,baseline.chancesAttack,true,.10),toneFor(quality,baseline.quality,true,.08),toneFor(rebound,baseline.rebound,true,.10),toneFor(turnovers10,baseline.turnovers10,false,.12),toneFor(oppScore,baseline.oppScore,false,.10)];
    const score=tones.reduce((n,t)=>n+(t==="green"?1:t==="red"?-1:0),0);
    return {...r,goals10,chancesAttack,qualityPct:quality,reboundPct:rebound,turnovers10,oppScorePct:oppScore,reliability:reliability(r.seconds),tones,score};
  });
  const proven=enriched.filter(r=>r.seconds>=60*60);
  const promising=enriched.filter(r=>r.seconds<60*60).sort((a,b)=>b.score-a.score || b.seconds-a.seconds)[0];
  const bestProven=[...proven].sort((a,b)=>b.score-a.score || b.goals10-a.goals10)[0];
  const bestAttack=[...enriched].filter(r=>r.attacks>=3).sort((a,b)=>b.goals10-a.goals10)[0];
  const attention=[...enriched].filter(r=>r.seconds>=30*60).sort((a,b)=>a.score-b.score || b.seconds-a.seconds)[0];

  const duoStats = useMemo(() => {
    const map=new Map<string,{names:string[];seconds:number;goals:number;attempts:number;attacks:number}>();
    for(const r of stats){ for(let i=0;i<r.names.length;i++) for(let j=i+1;j<r.names.length;j++){ const pair=[r.names[i],r.names[j]].sort(); const key=pair.join("||"); const d=map.get(key)??{names:pair,seconds:0,goals:0,attempts:0,attacks:0}; d.seconds+=r.seconds;d.goals+=r.goals;d.attempts+=r.attempts;d.attacks+=r.attacks;map.set(key,d); } }
    return [...map.values()].map(d=>({...d,reliability:reliability(d.seconds),goals10:d.attacks?d.goals/d.attacks*10:0,scorePct:safePct(d.goals,d.attempts)})).sort((a,b)=>b.seconds-a.seconds).slice(0,12);
  },[stats]);

  const MetricBadge=({label,value,base,tone,suffix=""}:{label:string;value:string;base:string;tone:"green"|"orange"|"red"|"blue";suffix?:string})=>{const cls=tone==="green"?"bg-emerald-50 text-emerald-800 border-emerald-200":tone==="red"?"bg-red-50 text-red-800 border-red-200":tone==="orange"?"bg-orange-50 text-orange-800 border-orange-200":"bg-blue-50 text-blue-800 border-blue-200";return <div className="min-w-0"><div className={`rounded-xl border px-3 py-2 ${cls}`}><div className="font-extrabold">{value}{suffix}</div><div className="text-[11px] opacity-70">Team {base}{suffix}</div></div><div className="mt-1.5 px-1 text-[11px] font-semibold leading-tight text-slate-400">{label}</div></div>};
  const Reliability=({seconds}:{seconds:number})=>{const rel=reliability(seconds);return <div className="flex items-center gap-2"><div className="flex gap-1" aria-label={`${rel.level} van 4 betrouwbaarheidsstappen`}>{[1,2,3,4].map(i=><span key={i} className={`h-2 w-2 rounded-full ${i<=rel.level?(rel.tone==="green"?"bg-emerald-500":rel.tone==="orange"?"bg-orange-400":"bg-blue-500"):"bg-slate-200"}`}/>)}</div><span className="text-xs text-slate-500">{rel.label}</span></div>};
  const SummaryCard=({label,row,tone}:{label:string;row:typeof enriched[number]|undefined;tone:"green"|"orange"|"red"|"blue"})=>{const cls=tone==="green"?"border-emerald-200 bg-emerald-50/60":tone==="red"?"border-red-200 bg-red-50/60":tone==="orange"?"border-orange-200 bg-orange-50/60":"border-blue-200 bg-blue-50/60";return <div className={`rounded-2xl border p-4 ${cls}`}><div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-slate-500"><SignalDot tone={tone}/>{label}</div>{row?<><div className="mt-2 font-bold text-slate-900">{row.names.join(" · ")}</div><div className="mt-1 text-sm text-slate-600">{Math.round(row.seconds/60)} min · {row.goals10.toFixed(2)} goals / 10 aanv.</div><div className="mt-2"><Reliability seconds={row.seconds}/></div></>:<div className="mt-2 text-sm text-slate-500">Nog onvoldoende data voor deze conclusie.</div>}</div>};

  return <div className="space-y-5">
    <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Combinations</div><h2 className="mt-1 text-2xl font-bold">Vakcombinaties</h2><p className="mt-1 max-w-4xl text-sm text-slate-500">Prestaties worden vanaf de eerste minuut meegenomen. De betrouwbaarheidsindicator voorkomt dat een korte, toevallig sterke periode dezelfde waarde krijgt als een combinatie die al veel samen heeft gespeeld.</p></div>
    {!stats.length ? <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500">Nog geen vakcombinaties in de database. Speel een wedstrijd met deze versie of laad een backup met het tabblad Vakperiodes.</div> : <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><SummaryCard label="Bewezen sterk" row={bestProven} tone="green"/><SummaryCard label="Veelbelovend" row={promising} tone="blue"/><SummaryCard label="Beste aanval" row={bestAttack} tone="green"/><SummaryCard label="Aandacht" row={attention && attention.score<0?attention:undefined} tone="orange"/></div>
      <div className="rounded-2xl border bg-white p-5"><div className="flex flex-col gap-1 lg:flex-row lg:items-end lg:justify-between"><div><h3 className="text-lg font-bold">Viertallen – prestatie versus team</h3><p className="text-sm text-slate-500">Groen is bovengemiddeld, oranje ligt rond het teamniveau en rood is een aandachtspunt. Betrouwbaarheid staat daar los van.</p></div><div className="text-xs text-slate-500">Drempels: 0–15 · 15–30 · 30–60 · 60+ minuten</div></div><div className="mt-4 space-y-3">{enriched.map(r=><div key={r.key} className="rounded-2xl border border-slate-200 p-4"><div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between"><div><div className="font-bold text-slate-900">{r.names.join(" · ")}</div><div className="mt-1 text-xs text-slate-500">{r.matches.size} wedstr. · {Math.round(r.seconds/60)} min · {r.attacks} aanvallen · {r.attempts} kansen</div><div className="mt-2"><Reliability seconds={r.seconds}/></div></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"><MetricBadge label="Goals / 10 aanv." value={r.goals10.toFixed(2)} base={baseline.goals10.toFixed(2)} tone={r.tones[0]}/><MetricBadge label="Kansen / aanval" value={r.chancesAttack.toFixed(2)} base={baseline.chancesAttack.toFixed(2)} tone={r.tones[1]}/><MetricBadge label="Korfgerichtheid" value={r.qualityPct.toFixed(1)} base={baseline.quality.toFixed(1)} tone={r.tones[2]} suffix="%"/><MetricBadge label="Aanv. rebound" value={r.reboundPct.toFixed(1)} base={baseline.rebound.toFixed(1)} tone={r.tones[3]} suffix="%"/><MetricBadge label="Balverlies / 10" value={r.turnovers10.toFixed(2)} base={baseline.turnovers10.toFixed(2)} tone={r.tones[4]}/><MetricBadge label="Tegenstander raak" value={r.oppScorePct.toFixed(1)} base={baseline.oppScore.toFixed(1)} tone={r.tones[5]} suffix="%"/></div></div></div>)}</div></div>
      <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Duo's binnen vakken</h3><p className="mb-4 text-sm text-slate-500">Ook duo's tellen vanaf de eerste minuut mee. De betrouwbaarheidsindicator blijft zichtbaar, omdat een duo in verschillende viertallen kan voorkomen.</p><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{duoStats.map((d,i)=><div key={d.names.join("-")} className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100"><div className="flex items-start justify-between gap-3"><div className="font-bold">{d.names.join(" + ")}</div><span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-slate-500">#{i+1}</span></div><div className="mt-2 text-sm text-slate-600">{Math.round(d.seconds/60)} min · {d.goals10.toFixed(2)} goals / 10 aanv. · {d.scorePct.toFixed(1)}% raak</div><div className="mt-2"><Reliability seconds={d.seconds}/></div></div>)}</div></div>
    </>}
  </div>;
}

function CoachDashboard({
  state,
  dbSheets,
  onNavigate,
}: {
  state: AppState;
  dbSheets: DatabaseSheetsData | null;
  onNavigate: (tab: "dashboard" | "spelersanalyse" | "teamanalyse" | "spelers" | "vakken" | "wedstrijd" | "verslag" | "insights" | "combinaties" | "profielen" | "opstelling" | "wisseladvies" | "doelen" | "voorbereiding" | "seizoen") => void;
}) {
  const pct = (a: number, b: number) => b ? (a / b) * 100 : 0;
  const matches = dbSheets?.matches ?? [];
  const eventsAll = dbSheets?.events ?? [];
  const seasons = Array.from(new Set(matches.map((m:any) => String(m.seizoen ?? "")).filter(Boolean))).sort().reverse();
  const [season, setSeason] = useState(() => seasons.includes(state.season) ? state.season : (seasons[0] ?? state.season));
  const seasonMatches = matches.filter((m:any) => String(m.seizoen ?? "") === season && String(m.wedstrijdtype ?? "Competitie") === "Competitie")
    .slice().sort((a:any,b:any) => String(a.datum ?? "").localeCompare(String(b.datum ?? "")));
  const ids = new Set(seasonMatches.map((m:any) => String(m.wedstrijd_id)));
  const events = eventsAll.filter((e:any) => ids.has(String(e.wedstrijd_id)));
  const isKorbis = (e:any) => String(e.team ?? "").trim().toLowerCase() === "korbis";
  const isAttempt = (e:any) => ["Schot","Doorloop","Vrijebal","Strafworp"].includes(String(e.actie ?? "")) && ["Raak","Mis","Korf","Verdedigd"].includes(String(e.uitkomst ?? ""));
  const own = events.filter((e:any) => isKorbis(e) && isAttempt(e));
  const goals = own.filter((e:any) => e.uitkomst === "Raak").length;
  const wonRebounds = events.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Rebound").length;
  const lostRebounds = events.filter((e:any) => isKorbis(e) && e.actie === "Rebound" && e.reden === "Geen Rebound").length;
  const turnovers = events.filter((e:any) => isKorbis(e) && ["Bal onderschept","Pass Onderschept","Bal uit"].includes(String(e.reden ?? ""))).length;
  const goalsFor = seasonMatches.reduce((n:number,m:any)=>n+Number(m.score_korbis||0),0);
  const goalsAgainst = seasonMatches.reduce((n:number,m:any)=>n+Number(m.score_tegenstander||0),0);
  const wins = seasonMatches.filter((m:any)=>Number(m.score_korbis)>Number(m.score_tegenstander)).length;

  const matchMetrics = seasonMatches.map((m:any, i:number) => {
    const me = eventsAll.filter((e:any)=>String(e.wedstrijd_id)===String(m.wedstrijd_id));
    const ma = me.filter((e:any)=>isKorbis(e)&&isAttempt(e));
    const mg = ma.filter((e:any)=>e.uitkomst==="Raak").length;
    const mrw = me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Rebound").length;
    const mrl = me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Geen Rebound").length;
    const mt = me.filter((e:any)=>isKorbis(e)&&["Bal onderschept","Pass Onderschept","Bal uit"].includes(String(e.reden??""))).length;
    const date=String(m.datum??"").slice(0,10);
    return { label:date?date.slice(5):`W${i+1}`, score:pct(mg,ma.length), rebound:pct(mrw,mrw+mrl), turnovers:mt, goals:mg, gf:Number(m.score_korbis||0), ga:Number(m.score_tegenstander||0), result:Number(m.score_korbis||0)>Number(m.score_tegenstander||0)?1:Number(m.score_korbis||0)<Number(m.score_tegenstander||0)?-1:0 };
  });
  const recent = matchMetrics.slice(-5);
  const previous = matchMetrics.slice(Math.max(0, matchMetrics.length-10), Math.max(0, matchMetrics.length-5));
  const avg = (arr:number[]) => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
  const recentScore=avg(recent.map(x=>x.score)), seasonScore=pct(goals,own.length);
  const recentRebound=avg(recent.map(x=>x.rebound)), seasonRebound=pct(wonRebounds,wonRebounds+lostRebounds);
  const recentTurnovers=avg(recent.map(x=>x.turnovers)), prevTurnovers=avg(previous.map(x=>x.turnovers));

  const playerNames = Array.from(new Set(events.filter((e:any)=>isKorbis(e)&&e.spelerNaam).map((e:any)=>String(e.spelerNaam))));
  const playerRows = playerNames.map(name => {
    const pe=events.filter((e:any)=>isKorbis(e)&&String(e.spelerNaam??"")===name);
    const pa=pe.filter(isAttempt); const pg=pa.filter((e:any)=>e.uitkomst==="Raak").length;
    const reb=pe.filter((e:any)=>e.actie==="Rebound"&&e.reden==="Rebound").length;
    const def=pe.filter((e:any)=>["Bal onderschept","Pass Onderschept"].includes(String(e.reden??"")) || e.uitkomst==="Verdedigd").length;
    const loss=pe.filter((e:any)=>["Bal onderschept","Pass Onderschept","Bal uit"].includes(String(e.reden??""))).length;
    const score=pct(pg,pa.length);
    const overall=pg*3+score*.12+reb*.7+def*.8-loss*.9;
    return {name,goals:pg,attempts:pa.length,score,reb,overall};
  }).sort((a,b)=>b.overall-a.overall);

  const comboMap=new Map<string,{names:string;attempts:number;goals:number;reb:number;events:number}>();
  events.filter(isKorbis).forEach((e:any)=>{ const key=String(e.combinatie_key??""); if(!key)return; const cur=comboMap.get(key)??{names:String(e.combinatie_spelers??key),attempts:0,goals:0,reb:0,events:0}; cur.events++; if(isAttempt(e)){cur.attempts++; if(e.uitkomst==="Raak")cur.goals++;} if(e.actie==="Rebound"&&e.reden==="Rebound")cur.reb++; comboMap.set(key,cur); });
  const combos=Array.from(comboMap.values()).filter(c=>c.attempts>=15).map(c=>({...c,score:pct(c.goals,c.attempts),rating:c.goals*2+pct(c.goals,c.attempts)*.15+c.reb*.5})).sort((a,b)=>b.rating-a.rating).slice(0,3);

  const signals:{tone:"green"|"orange"|"blue";title:string;text:string}[]=[];
  if(recent.length){ const d=recentScore-seasonScore; signals.push({tone:d>=0?"green":"orange",title:d>=0?"Aanval in vorm":"Aanvallend aandachtspunt",text:`De laatste ${recent.length} wedstrijden ligt het scoringspercentage ${Math.abs(d).toFixed(1)} procentpunt ${d>=0?"boven":"onder"} het seizoensgemiddelde.`}); }
  if(recent.length){ const d=recentRebound-seasonRebound; signals.push({tone:d>=0?"green":"orange",title:d>=0?"Rebound ontwikkelt positief":"Rebound vraagt aandacht",text:`Recente reboundcontrole: ${recentRebound.toFixed(1)}% tegenover ${seasonRebound.toFixed(1)}% over het seizoen.`}); }
  if(previous.length&&recent.length){ const d=recentTurnovers-prevTurnovers; signals.push({tone:d<=0?"green":"orange",title:d<=0?"Meer balvast":"Balverlies loopt op",text:`Gemiddeld ${recentTurnovers.toFixed(1)} turnovers in de laatste ${recent.length} wedstrijden, ${Math.abs(d).toFixed(1)} ${d<=0?"minder":"meer"} dan de voorgaande reeks.`}); }
  if(playerRows[0]) signals.push({tone:"blue",title:"Speler om te volgen",text:`${playerRows[0].name} staat op basis van de huidige seizoendata bovenaan de gecombineerde coachscore.`});

  if(!dbSheets) return <div className="rounded-2xl border bg-white p-6 text-slate-600">Laad eerst een database om het Coach Dashboard op te bouwen.</div>;
  return <div className="space-y-5">
    <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-600 via-blue-600 to-cyan-600 p-5 text-white shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-100">KorbIQ Coach</div><h2 className="mt-1 text-2xl font-black">Coach Dashboard</h2><p className="mt-1 text-sm text-blue-100">Van wedstrijddata naar aandachtspunten voor de coach.</p></div><label className="flex flex-col gap-1"><span className="text-xs font-semibold text-blue-100">Seizoen</span><select value={season} onChange={e=>setSeason(e.target.value)} className="min-w-[210px] rounded-xl border border-white/30 bg-white px-3 py-2 font-semibold text-slate-900">{seasons.map(x=><option key={x}>{x}</option>)}</select></label></div>
    </div>
    {seasonMatches.length===0 ? <div className="rounded-2xl border bg-white p-6 text-slate-600">Nog geen competitiewedstrijden gevonden voor {season}.</div> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
        {label:"Teamvorm",value:`${wins}/${seasonMatches.length} winst`,sub:`${goalsFor}–${goalsAgainst}`,tone:"blue",series:{labels:matchMetrics.map(x=>x.label),values:matchMetrics.map(x=>x.gf-x.ga)} as MetricDetailSeries},
        {label:"Aanval",value:`${seasonScore.toFixed(1)}% raak`,sub:`${recentScore.toFixed(1)}% laatste ${recent.length}`,tone:recentScore>=seasonScore?"green":"orange",series:{labels:matchMetrics.map(x=>x.label),values:matchMetrics.map(x=>x.score),comparisonValues:matchMetrics.map(()=>seasonScore),comparisonLabel:"Seizoensgem.",suffix:"%"} as MetricDetailSeries},
        {label:"Rebound",value:`${seasonRebound.toFixed(1)}% gewonnen`,sub:`${recentRebound.toFixed(1)}% recent`,tone:recentRebound>=seasonRebound?"green":"orange",series:{labels:matchMetrics.map(x=>x.label),values:matchMetrics.map(x=>x.rebound),comparisonValues:matchMetrics.map(()=>seasonRebound),comparisonLabel:"Seizoensgem.",suffix:"%"} as MetricDetailSeries},
        {label:"Balverlies",value:`${(turnovers/Math.max(1,seasonMatches.length)).toFixed(1)} p/w`,sub:`${recentTurnovers.toFixed(1)} recent`,tone:recentTurnovers<=turnovers/Math.max(1,seasonMatches.length)?"green":"orange",inverse:true,series:{labels:matchMetrics.map(x=>x.label),values:matchMetrics.map(x=>x.turnovers)} as MetricDetailSeries}
      ].map((card)=>{const cls=card.tone==="green"?"border-emerald-200 bg-emerald-50":card.tone==="orange"?"border-orange-200 bg-orange-50":"border-blue-200 bg-blue-50";return <MetricInsightCard key={card.label} label={card.label} value={card.value} sub={card.sub} inverse={card.inverse} series={card.series} className={cls}/>})}</div>
      <div className="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
        <div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="text-lg font-black">KorbIQ Coach Insights</h3><p className="text-sm text-slate-500">Automatische signalen uit recente vorm en seizoendata.</p></div></div><div className="mt-4 space-y-3">{signals.map((x,i)=>{const cls=x.tone==="green"?"border-emerald-100 bg-emerald-50 text-emerald-950":x.tone==="orange"?"border-orange-100 bg-orange-50 text-orange-950":"border-blue-100 bg-blue-50 text-blue-950";return <div key={i} className={`rounded-xl border p-3 ${cls}`}><div className="flex gap-2"><SignalDot tone={x.tone}/><div><div className="font-bold">{x.title}</div><div className="mt-0.5 text-sm opacity-80">{x.text}</div></div></div></div>})}</div></div>
        <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Snel naar</h3><div className="mt-3 grid gap-2">{[["voorbereiding","Wedstrijdvoorbereiding"],["opstelling","Opstellingsassistent"],["spelersanalyse","Spelers & ontwikkeling"],["teamanalyse","Team, vakken & seizoen"]].map(([id,label])=><button key={id} onClick={()=>onNavigate(id as "voorbereiding"|"opstelling"|"spelersanalyse"|"teamanalyse")} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-left text-sm font-bold hover:border-blue-200 hover:bg-blue-50">{label} →</button>)}</div></div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between"><h3 className="text-lg font-black">Spelers in beeld</h3><button onClick={()=>onNavigate("profielen")} className="text-xs font-bold text-blue-700">Alle profielen →</button></div><div className="mt-3 overflow-auto"><table className="w-full text-sm"><thead><tr><th className="py-2 text-left">#</th><th className="text-left">Speler</th><th className="text-right">Goals</th><th className="text-right">% raak</th><th className="text-right">Reb.</th></tr></thead><tbody>{playerRows.slice(0,5).map((p,i)=><tr key={p.name} className="border-t"><td className="py-2 font-black text-blue-700">#{i+1}</td><td className="font-bold">{p.name}</td><td className="text-right">{p.goals}</td><td className="text-right">{p.score.toFixed(1)}%</td><td className="text-right">{p.reb}</td></tr>)}</tbody></table></div></div>
        <div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between"><h3 className="text-lg font-black">Sterke vakcombinaties</h3><button onClick={()=>onNavigate("combinaties")} className="text-xs font-bold text-blue-700">Analyse →</button></div><div className="mt-3 space-y-2">{combos.length?combos.map((c,i)=><div key={`${c.names}-${i}`} className="rounded-xl border border-slate-100 bg-slate-50 p-3"><div className="flex justify-between gap-3"><div className="min-w-0"><div className="truncate font-bold">{c.names}</div><div className="text-xs text-slate-500">{c.attempts} kansen · {c.reb} rebounds</div></div><div className="text-right"><div className="font-black text-blue-700">{c.score.toFixed(1)}%</div><div className="text-[11px] text-slate-500">raak</div></div></div></div>):<div className="text-sm text-slate-500">Nog onvoldoende combinatie-data.</div>}</div></div>
      </div>
      <div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="text-lg font-black">Laatste wedstrijden</h3><p className="text-sm text-slate-500">Snelle context voor de actuele teamvorm.</p></div><button onClick={()=>onNavigate("seizoen")} className="text-xs font-bold text-blue-700">Seizoen bekijken →</button></div><div className="mt-3 overflow-auto"><table className="w-full min-w-[620px] text-sm"><thead><tr><th className="py-2 text-left">Datum</th><th className="text-left">Tegenstander</th><th className="text-right">Uitslag</th><th className="text-right">Resultaat</th></tr></thead><tbody>{seasonMatches.slice(-5).reverse().map((m:any)=>{const a=Number(m.score_korbis||0),b=Number(m.score_tegenstander||0);return <tr key={String(m.wedstrijd_id)} className="border-t"><td className="py-2">{String(m.datum??"").slice(0,10)}</td><td className="font-bold">{m.tegenstander||m.wedstrijd_naam||"-"}</td><td className="text-right font-bold">{a}–{b}</td><td className={`text-right font-black ${a>b?"text-emerald-700":a<b?"text-red-600":"text-orange-600"}`}>{a>b?"W":a<b?"V":"G"}</td></tr>})}</tbody></table></div></div>
    </>}
  </div>;
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
    const od=oa.filter((e:any)=>e.uitkomst==="Verdedigd").length;
    const mr=me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Rebound").length;
    const ml=me.filter((e:any)=>isKorbis(e)&&e.actie==="Rebound"&&e.reden==="Geen Rebound").length;
    const matchOwnAttacks=attacks.filter((a:any)=>String(a.wedstrijd_id)===id && String(a.team??"").trim().toLowerCase()==="korbis");
    const date=String(m.datum??"").slice(0,10);
    return {id,date,label:date?date.slice(5):`W${i+1}`,opponent:String(m.tegenstander ?? "-"),score:pct(mg,ma.length),quality:pct(mg+mk,ma.length),rebound:pct(mr,mr+ml),oppScore:pct(og,oa.length),defended:pct(od,oa.length),chancesPerAttack:matchOwnAttacks.length?ma.length/matchOwnAttacks.length:0,gf:Number(m.score_korbis||0),ga:Number(m.score_tegenstander||0)};
  });
  const seasonSeries = (key:"score"|"quality"|"rebound"|"oppScore"|"defended"|"chancesPerAttack"|"gf"|"ga", suffix="", comparisonKey?:"ga"): MetricDetailSeries => ({
    labels:perMatch.map(x=>x.label),
    detailLabels:perMatch.map(x=>`${x.date || x.label} · ${x.opponent}`),
    values:perMatch.map(x=>Number(x[key]??0)),
    comparisonValues:comparisonKey?perMatch.map(x=>Number(x[comparisonKey]??0)):undefined,
    comparisonLabel:comparisonKey==="ga"?"Tegenstander":undefined,
    suffix,
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
    {!dbSheets ? <div className="border rounded-2xl p-6 bg-white text-sm text-gray-600">De centrale wedstrijdhistorie is nog niet geladen. Probeer het seizoensdashboard opnieuw zodra Supabase beschikbaar is.</div> : seasonMatches.length===0 ? <div className="border rounded-2xl p-6 bg-white text-sm text-gray-600">Voor <b>{season||"dit seizoen"}</b> zijn binnen dit filter nog geen wedstrijden gevonden.</div> : <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">{[
        {label:"Wedstrijden",value:seasonMatches.length,tone:"blue"},
        {label:"Winst / gelijk / verlies",value:`${wins} / ${draws} / ${losses}`,tone:wins>=losses?"green":"orange"},
        {label:"Doelpunten",value:`${goalsFor} - ${goalsAgainst}`,tone:goalsFor>=goalsAgainst?"green":"red",series:seasonSeries("gf","","ga")},
        {label:"Kansen raak",value:`${pct(goals,own.length).toFixed(1)}%`,tone:"blue",series:seasonSeries("score","%")},
        {label:"Aanv. rebound gewonnen",value:`${pct(wonRebounds,wonRebounds+lostRebounds).toFixed(1)}%`,tone:"orange",series:seasonSeries("rebound","%")}
      ].map((card)=>{const cls=card.tone==="green"?"border-emerald-200 bg-emerald-50/70 text-emerald-900":card.tone==="red"?"border-red-200 bg-red-50/70 text-red-900":card.tone==="orange"?"border-orange-200 bg-orange-50/70 text-orange-900":"border-blue-200 bg-blue-50/70 text-blue-900";return <MetricInsightCard key={card.label} label={card.label} value={card.value} series={card.series} className={cls}/>})}</div>
      <div className="grid gap-4 lg:grid-cols-2"><div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Coachsignalen</div><div className="space-y-2">{insights.map((x,i)=>{const lower=x.toLowerCase();const negative=lower.includes("aandacht")||lower.includes("loopt terug")||lower.includes("lager")||lower.includes("meer van hun kansen");const positive=lower.includes("verbetert")||lower.includes("positief")||lower.includes("minder van hun kansen");const tone=negative?"orange":positive?"green":"blue";const cls=tone==="green"?"bg-emerald-50 border-emerald-100 text-emerald-900":tone==="orange"?"bg-orange-50 border-orange-100 text-orange-900":"bg-blue-50 border-blue-100 text-blue-900";return <div key={i} className={`flex gap-2 rounded-xl border px-3 py-2 text-sm ${cls}`}><SignalDot tone={tone}/><span>{x}</span></div>})}</div></div><div className="border rounded-2xl p-5 bg-gradient-to-br from-white to-blue-50/60"><div className="text-lg font-bold mb-3">Seizoensprofiel</div><div className="grid grid-cols-2 gap-2 text-sm"><MetricInsightCard label="Korfgerichtheid" value={`${pct(goals+korf,own.length).toFixed(1)}%`} series={seasonSeries("quality","%")} className="bg-blue-50 border-blue-100"/><MetricInsightCard label="Kansen per aanval" value={ownAttacks.length?(own.length/ownAttacks.length).toFixed(2):"0.00"} series={seasonSeries("chancesPerAttack")} className="bg-emerald-50 border-emerald-100"/><MetricInsightCard label="Tegenstander raak" value={`${pct(oppGoals,opp.length).toFixed(1)}%`} series={seasonSeries("oppScore","%")} className="bg-red-50 border-red-100"/><MetricInsightCard label="Pogingen verdedigd" value={`${pct(defended,opp.length).toFixed(1)}%`} series={seasonSeries("defended","%")} className="bg-orange-50 border-orange-100"/></div></div></div>
      <div><h3 className="text-xl font-bold">Ontwikkeling door het seizoen</h3><p className="text-sm text-gray-500">Per wedstrijd; gebruik Insights voor de uitgebreidere 3-tegen-3 analyse.</p></div><div className="grid gap-4 lg:grid-cols-2"><MiniTrend title="Kansen raak" keyName="score"/><MiniTrend title="Korfgerichtheid" keyName="quality"/><MiniTrend title="Aanvallende rebounds gewonnen" keyName="rebound"/><MiniTrend title="Kansen tegenstander raak" keyName="oppScore"/></div>
      <div className="grid gap-4 lg:grid-cols-2"><div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Vak 1 vs Vak 2 – seizoen</div><div className="overflow-auto"><table className="w-full text-sm"><thead><tr className="text-gray-500"><th className="text-left py-2">Kengetal</th><th className="text-right">Vak 1</th><th className="text-right">Vak 2</th></tr></thead><tbody>{[["Kansen",v1.attempts,v2.attempts],["Goals",v1.goals,v2.goals],["Kansen raak",`${v1.score.toFixed(1)}%`,`${v2.score.toFixed(1)}%`],["Tegenstander kansen raak",`${v1.oppScore.toFixed(1)}%`,`${v2.oppScore.toFixed(1)}%`]].map(([l,a,b])=><tr key={String(l)} className="border-t"><td className="py-2 font-semibold">{l}</td><td className="text-right">{a}</td><td className="text-right">{b}</td></tr>)}</tbody></table></div></div><div className="border rounded-2xl p-5 bg-white"><div className="text-lg font-bold mb-3">Spelers – seizoen</div><div className="overflow-auto max-h-[260px]"><table className="w-full text-sm"><thead className="sticky top-0 bg-white"><tr className="text-gray-500"><th className="text-left py-2">Speler</th><th className="text-right">Goals</th><th className="text-right">Kansen</th><th className="text-right">% raak</th><th className="text-right">Reb.</th></tr></thead><tbody>{playerRows.map(p=><tr key={p.name} className="border-t"><td className="py-2 font-semibold">{p.name}</td><td className="text-right">{p.goals}</td><td className="text-right">{p.attempts}</td><td className="text-right">{p.score.toFixed(1)}%</td><td className="text-right">{p.rebounds}</td></tr>)}</tbody></table></div></div></div>
      <div className="border rounded-2xl overflow-hidden bg-white"><div className="p-4 border-b font-bold">Wedstrijden – {season}</div><div className="overflow-auto"><table className="w-full text-sm min-w-[720px]"><thead className="bg-gray-50"><tr><th className="text-left p-3">Datum</th><th className="text-left p-3">Tegenstander</th><th className="text-left p-3">Type</th><th className="text-right p-3">Uitslag</th><th className="text-right p-3">Kansen raak</th></tr></thead><tbody>{seasonMatches.map((m:any)=>{const pm=perMatch.find(x=>x.id===String(m.wedstrijd_id));return <tr key={String(m.wedstrijd_id)} className="border-t"><td className="p-3">{String(m.datum??"").slice(0,10)}</td><td className="p-3 font-semibold">{m.tegenstander||m.wedstrijd_naam||"-"}</td><td className="p-3">{m.wedstrijdtype||"Competitie"}</td><td className="p-3 text-right font-bold">{m.score_korbis}-{m.score_tegenstander}</td><td className="p-3 text-right">{pm?`${pm.score.toFixed(1)}%`:"-"}</td></tr>})}</tbody></table></div></div>
    </>}
  </div>;
}


function MatchPreparationDashboard({
  state,
  dbSheets,
  onSelectOpponent,
  onOpenSettings,
  onOpenMatch,
}: {
  state: AppState;
  dbSheets: DatabaseSheetsData | null;
  onSelectOpponent: (opponentName: string) => void;
  onOpenSettings: () => void;
  onOpenMatch: () => void;
}) {
  const opponent = state.opponentName.trim();
  const matches = dbSheets?.matches ?? [];
  const events = dbSheets?.events ?? [];
  const attacks = dbSheets?.attacks ?? [];
  const periods = ((dbSheets as any)?.vakperiodes ?? []) as any[];
  const norm = (v:any) => String(v ?? "").trim().toLowerCase();
  const opponentOptionMap = new Map<string, { name: string; count: number; latest: string }>();
  matches.forEach((match:any) => {
    const name = String(match.tegenstander ?? "").trim();
    const archived = match.gearchiveerd === true || norm(match.gearchiveerd) === "true";
    if (!name || archived) return;
    const key = norm(name);
    const current = opponentOptionMap.get(key) ?? { name, count: 0, latest: "" };
    const date = formatImportedDate(match.datum);
    current.count += 1;
    if (date > current.latest) current.latest = date;
    opponentOptionMap.set(key, current);
  });
  const opponentOptions = Array.from(opponentOptionMap.values()).sort((a,b)=>a.name.localeCompare(b.name,"nl-NL"));
  const matchingOpponent = opponentOptions.find((item)=>norm(item.name)===norm(opponent));
  const [manualOpponentMode, setManualOpponentMode] = useState(false);
  const showManualOpponent = manualOpponentMode || Boolean(opponent && !matchingOpponent);
  const opponentSelection = showManualOpponent ? "__manual__" : matchingOpponent?.name ?? "";
  const opponentLocked = !state.matchEnded && (state.klokLoopt || state.tijdSeconden > 0 || state.scoreThuis > 0 || state.scoreUit > 0 || state.log.length > 0 || state.fieldEvents.length > 0 || state.attacks.length > 0);
  const own = (e:any) => ["korbis","thuis"].includes(norm(e.team));
  const result = (e:any) => norm(e.uitkomst ?? e.resultaat);
  const isAttempt = (e:any) => ["schot","doorloop","vrijebal","strafworp"].includes(norm(e.actie));
  const history = opponent ? matches.filter((m:any)=>norm(m.tegenstander)===norm(opponent)).sort((a:any,b:any)=>String(formatImportedDate(b.datum)).localeCompare(String(formatImportedDate(a.datum)))) : [];
  const ids = new Set(history.map((m:any)=>String(m.wedstrijd_id ?? "")));
  const histEvents = events.filter((e:any)=>ids.has(String(e.wedstrijd_id ?? "")));
  const ownAttempts = histEvents.filter((e:any)=>own(e)&&isAttempt(e));
  const ownGoals = ownAttempts.filter((e:any)=>result(e)==="raak").length;
  const ownKorf = ownAttempts.filter((e:any)=>result(e)==="korf").length;
  const oppAttempts = histEvents.filter((e:any)=>!own(e)&&isAttempt(e));
  const oppGoals = oppAttempts.filter((e:any)=>result(e)==="raak").length;
  const wins = history.filter((m:any)=>Number(m.score_korbis)>Number(m.score_tegenstander)).length;
  const draws = history.filter((m:any)=>Number(m.score_korbis)===Number(m.score_tegenstander)).length;
  const losses = history.length-wins-draws;
  const avgFor = history.length ? history.reduce((a:number,m:any)=>a+Number(m.score_korbis||0),0)/history.length : 0;
  const avgAgainst = history.length ? history.reduce((a:number,m:any)=>a+Number(m.score_tegenstander||0),0)/history.length : 0;
  const rebound = histEvents.filter((e:any)=>own(e)&&norm(e.reden)==="rebound").length;
  const noRebound = histEvents.filter((e:any)=>own(e)&&norm(e.reden)==="geen rebound").length;
  const reboundPct = rebound+noRebound ? rebound/(rebound+noRebound)*100 : null;
  const histAttacks = attacks.filter((a:any)=>ids.has(String(a.wedstrijd_id ?? ""))&&own(a));
  const attemptsPerAttack = histAttacks.length ? ownAttempts.length/histAttacks.length : null;
  const playerMap = new Map<string,{name:string;goals:number;attempts:number;rebounds:number}>();
  histEvents.filter((e:any)=>own(e)&&e.spelerNaam).forEach((e:any)=>{const n=String(e.spelerNaam);const x=playerMap.get(n)??{name:n,goals:0,attempts:0,rebounds:0};if(isAttempt(e)){x.attempts++;if(result(e)==="raak")x.goals++;}if(norm(e.reden)==="rebound")x.rebounds++;playerMap.set(n,x);});
  const comboMap=new Map<string,{names:string;minutes:number;attacks:number;goals:number}>();
  periods.filter((v:any)=>ids.has(String(v.wedstrijd_id??""))).forEach((v:any)=>{const k=String(v.combinatie_key??v.combinatie_spelers??"");if(!k)return;const x=comboMap.get(k)??{names:String(v.combinatie_spelers??k),minutes:0,attacks:0,goals:0};x.minutes+=Number(v.duur_seconden??0)/60;comboMap.set(k,x);});
  histAttacks.forEach((a:any)=>{const k=String(a.combinatie_key??a.combinatie_spelers??"");const x=comboMap.get(k);if(x)x.attacks++;});
  histEvents.filter((e:any)=>own(e)&&result(e)==="raak").forEach((e:any)=>{const k=String(e.combinatie_key??e.combinatie_spelers??"");const x=comboMap.get(k);if(x)x.goals++;});
  // Fase 23: Tegenstanderanalyse 2.0 – patronen, trends, match-ups en coachbriefing.
  const historyChronological = [...history].sort((a:any,b:any)=>String(formatImportedDate(a.datum)).localeCompare(String(formatImportedDate(b.datum))));
  const opponentTrend = historyChronological.map((m:any,i:number)=>{
    const id=String(m.wedstrijd_id??"");
    const me=events.filter((e:any)=>String(e.wedstrijd_id??"")===id);
    const oa=me.filter((e:any)=>!own(e)&&isAttempt(e));
    const og=oa.filter((e:any)=>result(e)==="raak").length;
    return {
      label:String(formatImportedDate(m.datum)).slice(0,10)||`W${i+1}`,
      detail:`${String(formatImportedDate(m.datum)).slice(0,10)||`Wedstrijd ${i+1}`} · ${String(m.tegenstander??opponent)}`,
      goalsAgainst:Number(m.score_tegenstander||0),
      oppScorePct:oa.length?og/oa.length*100:0,
      goalsFor:Number(m.score_korbis||0),
    };
  });
  const opponentScoreSeries:MetricDetailSeries={labels:opponentTrend.map(x=>x.label.slice(5)),detailLabels:opponentTrend.map(x=>x.detail),values:opponentTrend.map(x=>x.oppScorePct),suffix:"%"};
  const goalsAgainstSeries:MetricDetailSeries={labels:opponentTrend.map(x=>x.label.slice(5)),detailLabels:opponentTrend.map(x=>x.detail),values:opponentTrend.map(x=>x.goalsAgainst)};
  const actionLabels:Record<string,string>={schot:"Afstandsschot",doorloop:"Doorloopbal",vrijebal:"Vrije bal",strafworp:"Strafworp"};
  const oppByAction=["schot","doorloop","vrijebal","strafworp"].map(key=>{const xs=oppAttempts.filter((e:any)=>norm(e.actie)===key);const g=xs.filter((e:any)=>result(e)==="raak").length;return {key,label:actionLabels[key],attempts:xs.length,goals:g,pct:xs.length?g/xs.length*100:0};}).filter(x=>x.attempts>0).sort((a,b)=>b.pct-a.pct);
  const minuteOf=(e:any)=>{const direct=Number(e.wedstrijd_minuut);if(Number.isFinite(direct)&&direct>=0)return direct;const t=Number(e.tijd_verstreken);return Number.isFinite(t)?t/60:0;};
  const phaseRows=[{label:"0–10 min",from:0,to:10},{label:"10–20 min",from:10,to:20},{label:"20–30 min",from:20,to:30},{label:"30+ min",from:30,to:999}].map(ph=>{const xs=oppAttempts.filter((e:any)=>{const m=minuteOf(e);return m>=ph.from&&m<ph.to;});const g=xs.filter((e:any)=>result(e)==="raak").length;return {...ph,attempts:xs.length,goals:g,pct:xs.length?g/xs.length*100:0};}).filter(x=>x.attempts>0);
  const allHistOwnAttacks=histAttacks.length;
  const teamGoals10=allHistOwnAttacks?ownGoals/allHistOwnAttacks*10:0;
  const comboMatchups=Array.from(comboMap.values()).filter(x=>x.attacks>0).map(x=>({...x,goals10:x.goals/x.attacks*10,delta:(x.goals/x.attacks*10)-teamGoals10})).sort((a,b)=>b.delta-a.delta).slice(0,5);
  const teamPlayerScore=ownAttempts.length?ownGoals/ownAttempts.length*100:0;
  const playerMatchups=Array.from(playerMap.values()).filter(x=>x.attempts>=2).map(x=>({...x,pct:x.goals/x.attempts*100,delta:(x.goals/x.attempts*100)-teamPlayerScore})).sort((a,b)=>b.delta-a.delta).slice(0,5);
  const bestOppAction=oppByAction[0]??null;
  const worstPhase=[...phaseRows].sort((a,b)=>b.pct-a.pct)[0]??null;
  const briefing:string[]=[];
  if(bestOppAction) briefing.push(`${opponent} is in de geregistreerde duels het efficiëntst uit ${bestOppAction.label.toLowerCase()}: ${bestOppAction.pct.toFixed(1)}% raak (${bestOppAction.goals}/${bestOppAction.attempts}).`);
  if(worstPhase) briefing.push(`Meeste verdedigende druk zit in ${worstPhase.label}: ${worstPhase.pct.toFixed(1)}% van hun kansen werd daar raak geschoten.`);
  if(comboMatchups[0]&&comboMatchups[0].delta>0.25) briefing.push(`${comboMatchups[0].names} ligt tegen ${opponent} ${comboMatchups[0].delta.toFixed(1)} goals per 10 aanvallen boven het eigen teamgemiddelde.`);
  if(playerMatchups[0]&&playerMatchups[0].delta>3) briefing.push(`${playerMatchups[0].name} schiet tegen deze tegenstander ${playerMatchups[0].delta.toFixed(1)} procentpunt boven het Korbis-gemiddelde in deze duels.`);
  if(opponentTrend.length>=2){const last=opponentTrend.slice(-2);const first=opponentTrend.slice(0,Math.min(2,opponentTrend.length));const recent=last.reduce((n,x)=>n+x.oppScorePct,0)/last.length;const early=first.reduce((n,x)=>n+x.oppScorePct,0)/first.length;if(recent>=early+4) briefing.push(`Waarschuwing: het schotrendement van ${opponent} ligt in de recente ontmoetingen ${Math.abs(recent-early).toFixed(1)} procentpunt hoger dan eerder.`);else if(recent<=early-4) briefing.push(`Positief: het schotrendement van ${opponent} ligt recent ${Math.abs(recent-early).toFixed(1)} procentpunt lager dan in eerdere duels.`);}
  const seasonMatches = matches.filter((m:any) => String(m.seizoen ?? "") === state.season && String(m.wedstrijdtype ?? "Competitie") === state.matchType);
  const recentSeasonMatches = seasonMatches.slice().sort((a:any,b:any)=>String(formatImportedDate(b.datum)).localeCompare(String(formatImportedDate(a.datum)))).slice(0,5);
  const recentSeasonWins = recentSeasonMatches.filter((m:any)=>Number(m.score_korbis)>Number(m.score_tegenstander)).length;
  const recentSeasonGoals = recentSeasonMatches.length ? recentSeasonMatches.reduce((sum:number,m:any)=>sum+Number(m.score_korbis||0),0)/recentSeasonMatches.length : null;
  const seasonIds = new Set(seasonMatches.map((m:any)=>String(m.wedstrijd_id ?? "")));
  const seasonPeriods = periods.filter((v:any)=>seasonIds.has(String(v.wedstrijd_id??"")));
  const seasonComboMap = new Map<string,{names:string;minutes:number}>();
  seasonPeriods.forEach((v:any)=>{const k=String(v.combinatie_key??v.combinatie_spelers??"");if(!k)return;const x=seasonComboMap.get(k)??{names:String(v.combinatie_spelers??k),minutes:0};x.minutes+=Number(v.duur_seconden??0)/60;seasonComboMap.set(k,x);});
  const mostUsedSeasonCombo = Array.from(seasonComboMap.values()).sort((a,b)=>b.minutes-a.minutes)[0] ?? null;
  const signals:{tone:"green"|"orange"|"red"|"blue";text:string}[]=[];
  if(history.length){
    if(wins>losses) signals.push({tone:"green",text:`Positieve historie: ${wins} winst, ${draws} gelijk en ${losses} verlies.`});
    else if(losses>wins) signals.push({tone:"orange",text:`Lastige tegenstander: ${losses} van de ${history.length} eerdere wedstrijden verloren.`});
    if(ownAttempts.length) signals.push({tone:ownGoals/ownAttempts.length>=0.30?"green":"orange",text:`KorbIS scoorde ${((ownGoals/ownAttempts.length)*100).toFixed(1)}% van de geregistreerde kansen tegen ${opponent}.`});
    if(oppAttempts.length && oppGoals/oppAttempts.length>=0.30) signals.push({tone:"red",text:`Verdedigend aandachtspunt: tegenstander scoorde ${((oppGoals/oppAttempts.length)*100).toFixed(1)}% van de kansen.`});
    if(reboundPct!==null) signals.push({tone:reboundPct>=55?"green":"orange",text:`Aanvallende rebound tegen deze tegenstander: ${reboundPct.toFixed(0)}%.`});
  }
  return <div className="space-y-5">
    <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm">
      <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Preparation</div>
      <h2 className="mt-1 text-2xl font-bold">Wedstrijdvoorbereiding</h2>
      <p className="mt-1 text-sm text-gray-500">Dé analyseplek vóór de wedstrijd: tegenstanderhistorie, patronen, vakcombinaties en coachaandachtspunten.</p>
    </div>
    <div className="rounded-2xl border border-blue-100 bg-white p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-extrabold uppercase tracking-[.14em] text-blue-700">Tegenstander kiezen</div>
          <h3 className="mt-1 text-lg font-black">Gebruik een eerder gespeelde tegenstander</h3>
          <p className="mt-1 text-sm text-slate-500">De keuze wordt direct overgenomen in de wedstrijdinstellingen en laadt hieronder de beschikbare historie.</p>
        </div>
        <div className="grid w-full gap-3 sm:grid-cols-2 lg:max-w-2xl">
          <label className="text-xs font-bold text-slate-600">Opgeslagen tegenstanders
            <select
              value={opponentSelection}
              disabled={opponentLocked}
              onChange={(event)=>{
                const value=event.target.value;
                if(value==="__manual__"){
                  setManualOpponentMode(true);
                  if(matchingOpponent) onSelectOpponent("");
                  return;
                }
                setManualOpponentMode(false);
                onSelectOpponent(value);
              }}
              className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              <option value="">Kies een tegenstander…</option>
              {opponentOptions.map((item)=><option key={norm(item.name)} value={item.name}>{item.name} · {item.count} duel{item.count===1?"":"s"}{item.latest?` · laatst ${item.latest}`:""}</option>)}
              <option value="__manual__">Andere tegenstander invoeren…</option>
            </select>
          </label>
          <label className={`text-xs font-bold text-slate-600 ${showManualOpponent?"":"opacity-50"}`}>Nieuwe tegenstander
            <input
              value={showManualOpponent ? opponent : ""}
              disabled={!showManualOpponent || opponentLocked}
              onChange={(event)=>onSelectOpponent(event.target.value)}
              placeholder="Naam van vereniging of team"
              className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:bg-slate-100"
            />
          </label>
        </div>
      </div>
      {!opponentOptions.length && <div className="mt-4 rounded-xl border border-dashed bg-slate-50 px-4 py-3 text-sm text-slate-500">Voor dit team zijn nog geen eerdere tegenstanders opgeslagen. Kies ‘Andere tegenstander invoeren’ om een nieuwe naam te gebruiken.</div>}
      {opponentLocked && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">De tegenstander staat vast omdat de wedstrijd al is begonnen.</div>}
    </div>
    <div className="rounded-2xl border bg-white p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><div className="text-xs font-bold uppercase tracking-wide text-slate-500">Komende wedstrijd</div><div className="mt-1 text-2xl font-black">{opponent ? `${state.homeAway==="uit"?opponent:"Korbis"} – ${state.homeAway==="uit"?"Korbis":opponent}` : "Tegenstander nog niet gekozen"}</div><div className="mt-1 text-sm text-slate-500">{state.season} · {state.matchType} · {state.homeAway ? (state.homeAway==="thuis"?"Thuis":"Uit") : "Locatie nog kiezen"}</div></div><div className="flex gap-2"><button onClick={onOpenSettings} className="rounded-xl border bg-white px-4 py-2 text-sm font-bold text-slate-700">Instellingen</button><button onClick={onOpenMatch} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white">Naar wedstrijd</button></div></div>
    </div>
    <div className="rounded-2xl border bg-white p-5">
      <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-bold">Eigen vorm</h3><p className="text-sm text-slate-500">Actuele context uit {state.season}, ook wanneer KorbIQ de tegenstander nog niet kent.</p></div><div className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">Laatste {recentSeasonMatches.length || 0}</div></div>
      {recentSeasonMatches.length ? <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-emerald-50 p-3"><div className="text-xs font-semibold text-emerald-700">Recente resultaten</div><div className="mt-1 text-xl font-black">{recentSeasonWins}/{recentSeasonMatches.length} winst</div></div>
        <div className="rounded-xl bg-blue-50 p-3"><div className="text-xs font-semibold text-blue-700">Gem. goals Korbis</div><div className="mt-1 text-xl font-black">{recentSeasonGoals?.toFixed(1) ?? "—"}</div></div>
        <div className="rounded-xl bg-violet-50 p-3"><div className="text-xs font-semibold text-violet-700">Meest gebruikte combinatie</div><div className="mt-1 font-bold leading-snug">{mostUsedSeasonCombo?.names ?? "Nog geen combinatiedata"}</div>{mostUsedSeasonCombo && <div className="mt-1 text-xs text-slate-500">{Math.round(mostUsedSeasonCombo.minutes)} min dit seizoen</div>}</div>
      </div> : <div className="mt-3 text-sm text-slate-500">Nog geen afgeronde wedstrijden in dit seizoen/type beschikbaar.</div>}
    </div>
    {!opponent ? <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500">Vul bij Wedstrijdinstellingen eerst een tegenstander in. De eigen vorm hierboven blijft wel beschikbaar.</div> : !history.length ? <div className="rounded-2xl border bg-white p-6"><h3 className="text-lg font-bold">Eerste ontmoeting in de database</h3><p className="mt-1 text-sm text-slate-500">Er is nog geen historische vergelijking met {opponent}. De huidige vakindeling en wedstrijdregistratie vormen na afloop automatisch de basis voor een volgende voorbeschouwing.</p></div> : <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[["Eerdere duels",history.length],["W / G / V",`${wins} / ${draws} / ${losses}`],["Gem. voor",avgFor.toFixed(1)],["Gem. tegen",avgAgainst.toFixed(1)],["Kansen / aanval",attemptsPerAttack!==null?attemptsPerAttack.toFixed(2):"—"]].map(([l,v])=><div key={String(l)} className="rounded-2xl border bg-white p-4"><div className="text-xs font-bold uppercase tracking-wide text-slate-500">{l}</div><div className="mt-1 text-2xl font-black">{v}</div></div>)}</div>
      <div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Coachsignalen</h3><p className="text-sm text-slate-500">Wat springt eruit uit eerdere ontmoetingen?</p><div className="mt-4 space-y-2">{signals.map((x,i)=><div key={i} className="flex gap-2 rounded-xl bg-slate-50 p-3 text-sm"><SignalDot tone={x.tone}/><span>{x.text}</span></div>)}</div></div><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Kerncijfers</h3><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><MetricInsightCard label="Kansen raak" value={ownAttempts.length?`${(ownGoals/ownAttempts.length*100).toFixed(1)}%`:"—"}/><MetricInsightCard label="Korfgericht" value={ownAttempts.length?`${((ownGoals+ownKorf)/ownAttempts.length*100).toFixed(1)}%`:"—"}/><MetricInsightCard label="Aanv. rebound" value={reboundPct!==null?`${reboundPct.toFixed(0)}%`:"—"}/><MetricInsightCard label="Tegenstander raak" value={oppAttempts.length?`${(oppGoals/oppAttempts.length*100).toFixed(1)}%`:"—"} series={opponentScoreSeries} inverse/></div></div></div>
      <div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Aanvalspatroon {opponent}</h3><p className="text-sm text-slate-500">Waaruit maakt deze tegenstander tegen Korbis zijn kansen af?</p><div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-slate-500"><th className="py-2">Actie</th><th className="text-right">Kansen</th><th className="text-right">Goals</th><th className="text-right">Raak</th></tr></thead><tbody>{oppByAction.map(x=><tr key={x.key} className="border-b border-slate-100"><td className="py-2 font-semibold">{x.label}</td><td className="text-right">{x.attempts}</td><td className="text-right">{x.goals}</td><td className="text-right font-black">{x.pct.toFixed(1)}%</td></tr>)}</tbody></table></div></div><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Momenten in de wedstrijd</h3><p className="text-sm text-slate-500">Schotrendement van de tegenstander per wedstrijdfase.</p><div className="mt-4 space-y-2">{phaseRows.map(x=><div key={x.label} className="flex items-center justify-between rounded-xl bg-slate-50 p-3 text-sm"><div><b>{x.label}</b><div className="text-xs text-slate-500">{x.goals}/{x.attempts} raak</div></div><div className="text-lg font-black">{x.pct.toFixed(1)}%</div></div>)}</div></div></div>
      <div className="grid gap-4 lg:grid-cols-2"><MetricInsightCard label={`Schotrendement ${opponent}`} value={oppAttempts.length?`${(oppGoals/oppAttempts.length*100).toFixed(1)}%`:"—"} sub="Ontwikkeling over eerdere ontmoetingen" series={opponentScoreSeries} inverse/><MetricInsightCard label="Tegendoelpunten" value={avgAgainst.toFixed(1)} sub="Gemiddeld per ontmoeting" series={goalsAgainstSeries} inverse/></div>
      <div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Vak-match-ups tegen {opponent}</h3><p className="text-sm text-slate-500">Rendement ten opzichte van het Korbis-gemiddelde in dezelfde onderlinge duels.</p><div className="mt-4 space-y-2">{comboMatchups.length?comboMatchups.map((c,i)=><div key={i} className="rounded-xl border bg-slate-50 p-3"><div className="font-bold">{c.names}</div><div className="mt-1 text-xs text-slate-500">{Math.round(c.minutes)} min · {c.attacks} aanvallen · {c.goals10.toFixed(1)} goals / 10 aanv.</div><div className={`mt-1 text-xs font-bold ${c.delta>=0?"text-emerald-700":"text-orange-700"}`}>{c.delta>=0?"+":""}{c.delta.toFixed(1)} versus teamgemiddelde</div></div>):<div className="text-sm text-slate-500">Nog geen vakcombinatiedata uit deze ontmoetingen.</div>}</div></div><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Speler-match-ups tegen {opponent}</h3><p className="text-sm text-slate-500">Individueel schotrendement versus het Korbis-gemiddelde in deze duels.</p><div className="mt-4 space-y-2">{playerMatchups.length?playerMatchups.map(p=><div key={p.name} className="flex items-center justify-between rounded-xl bg-slate-50 p-3"><div><div className="font-bold">{p.name}</div><div className="text-xs text-slate-500">{p.goals} goals · {p.attempts} kansen · {p.rebounds} rebounds</div></div><div className="text-right"><div className="font-black">{p.pct.toFixed(1)}%</div><div className={`text-xs font-bold ${p.delta>=0?"text-emerald-700":"text-orange-700"}`}>{p.delta>=0?"+":""}{p.delta.toFixed(1)} pp</div></div></div>):<div className="text-sm text-slate-500">Nog onvoldoende individuele eventdata.</div>}</div></div></div>
      <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-5"><div className="text-xs font-extrabold uppercase tracking-[.14em] text-indigo-700">KorbIQ Coach Briefing</div><h3 className="mt-1 text-lg font-black">Wat nemen we mee naar deze wedstrijd?</h3><div className="mt-4 grid gap-2">{briefing.length?briefing.map((x,i)=><div key={i} className="flex gap-3 rounded-xl border border-indigo-100 bg-white p-3 text-sm"><span className="font-black text-indigo-600">{i+1}.</span><span>{x}</span></div>):<div className="text-sm text-slate-500">Nog onvoldoende patroondata voor een automatische briefing.</div>}</div></div>
      <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-xs text-blue-800">De voorbereiding is een historische analyse. KorbIQ geeft hiermee signalen en context, geen automatisch opstellings- of wisseladvies.</div>
    </>}
  </div>;
}


function OpstellingsassistentDashboard({ state, dbSheets }: { state: AppState; dbSheets: DatabaseSheetsData | null }) {
  const [openAdviceIndex,setOpenAdviceIndex]=useState<number|null>(0);
  const events = dbSheets?.events ?? [];
  const periods = dbSheets?.vakperiodes ?? [];
  const matches = dbSheets?.matches ?? [];
  const base = state.spelers.filter(p => p.actief && p.status === "Basisspeler");
  const currentIds = [...state.aanval, ...state.verdediging].filter((id): id is string => Boolean(id));
  const currentUnique = Array.from(new Set(currentIds));
  const currentPlayers = currentUnique.map(id => state.spelers.find(p => p.id === id)).filter((p): p is Player => Boolean(p));
  const sourcePlayers = currentPlayers.length === 8 ? currentPlayers : base;
  const men = sourcePlayers.filter(p => p.geslacht === "Heer");
  const women = sourcePlayers.filter(p => p.geslacht === "Dame");
  const usable = men.length === 4 && women.length === 4;
  const matchIds = new Set(matches.map((m:any)=>String(m.wedstrijd_id ?? "")));
  const own = (e:any) => ["korbis","thuis"].includes(String(e.team ?? "").trim().toLowerCase());
  const action = (e:any) => String(e.actie ?? "").trim().toLowerCase();
  const result = (e:any) => String(e.uitkomst ?? e.resultaat ?? "").trim().toLowerCase();
  const reason = (e:any) => String(e.reden ?? "").trim().toLowerCase();
  const isAttempt = (e:any) => ["schot","doorloop","vrijebal","strafworp"].includes(action(e));
  const playerMetric = (p:Player) => {
    const pe=events.filter((e:any)=>matchIds.has(String(e.wedstrijd_id ?? "")) && own(e) && (String(e.spelerId ?? "")===p.id || String(e.spelerNaam ?? "")===p.naam));
    const at=pe.filter(isAttempt); const goals=at.filter((e:any)=>result(e)==="raak").length;
    const reb=pe.filter((e:any)=>action(e)==="rebound" && reason(e)==="rebound").length;
    const def=pe.filter((e:any)=>["verdedigd","bal onderschept","pass onderschept"].includes(reason(e))).length;
    const tov=pe.filter((e:any)=>["bal uit","pass onderschept"].includes(reason(e))).length;
    const score=at.length ? goals/at.length*100 : 0;
    return {p, goals, attempts:at.length, reb, def, tov, score};
  };
  const metrics=sourcePlayers.map(playerMetric);
  const max=(key:"goals"|"attempts"|"reb"|"def"|"tov")=>Math.max(1,...metrics.map(m=>m[key]));
  const individualScore=(id:string)=>{const m=metrics.find(x=>x.p.id===id); if(!m)return 0; return (m.goals/max("goals"))*24+(m.attempts/max("attempts"))*12+(m.score/100)*18+(m.reb/max("reb"))*18+(m.def/max("def"))*18+(1-m.tov/max("tov"))*10;};
  const comboHistory=(ids:string[])=>{
    const key=[...ids].sort().join("|"); const ps=periods.filter((v:any)=>String(v.combinatie_key ?? "")===key);
    const seconds=ps.reduce((n:number,v:any)=>n+(Number(v.duur_seconden ?? 0)||0),0);
    const ev=events.filter((e:any)=>String(e.combinatie_key ?? "")===key && own(e)); const at=ev.filter(isAttempt); const goals=at.filter((e:any)=>result(e)==="raak").length;
    const reb=ev.filter((e:any)=>action(e)==="rebound"&&reason(e)==="rebound").length; const tov=ev.filter((e:any)=>["bal uit","pass onderschept"].includes(reason(e))).length;
    const historyScore=at.length ? Math.min(100,(goals/at.length*100)*2.2 + Math.min(25,reb*1.2) - Math.min(20,tov*1.5)) : 50;
    const reliability=Math.min(1,seconds/3600); return {minutes:seconds/60, attempts:at.length, goals, score:historyScore, reliability};
  };
  const pairs=<T,>(arr:T[])=>arr.flatMap((a,i)=>arr.slice(i+1).map(b=>[a,b] as [T,T]));
  type Advice={vak1:Player[];vak2:Player[];score:number;individual:number;history:number;balance:number;h1:ReturnType<typeof comboHistory>;h2:ReturnType<typeof comboHistory>};
  const advices:Advice[]=[];
  if(usable){
    for(const mp of pairs(men)){ for(const wp of pairs(women)){
      const v1=[...mp,...wp]; const ids1=new Set(v1.map(p=>p.id)); const v2=sourcePlayers.filter(p=>!ids1.has(p.id));
      if(v2.length!==4)continue;
      const canonical=[...v1.map(p=>p.id)].sort().join("|"); const other=[...v2.map(p=>p.id)].sort().join("|"); if(canonical>other)continue;
      const s1=v1.reduce((n,p)=>n+individualScore(p.id),0)/4; const s2=v2.reduce((n,p)=>n+individualScore(p.id),0)/4;
      const individual=(s1+s2)/2; const balance=Math.max(0,100-Math.abs(s1-s2)*2.2); const h1=comboHistory(v1.map(p=>p.id)); const h2=comboHistory(v2.map(p=>p.id));
      const hist=((h1.score*h1.reliability)+(h2.score*h2.reliability)+50*(2-h1.reliability-h2.reliability))/2;
      const score=individual*.48+balance*.22+hist*.30; advices.push({vak1:v1,vak2:v2,score,individual,history:hist,balance,h1,h2});
    }}
  }
  advices.sort((a,b)=>b.score-a.score);
  const reliabilityLabel=(minutes:number)=>minutes>=60?"sterke historie":minutes>=30?"redelijke historie":minutes>=15?"beperkte historie":"weinig historie";
  return <div className="space-y-5">
    <div className="rounded-3xl border border-violet-100 bg-gradient-to-r from-violet-50 via-white to-blue-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-violet-700">KorbIQ Line-up Intelligence</div><h2 className="mt-1 text-2xl font-black">Opstellingsassistent</h2><p className="mt-1 max-w-4xl text-sm text-slate-600">Vergelijkt mogelijke 2 heer / 2 dame-vakken op individuele prestaties, balans tussen beide vakken en werkelijk gespeelde historische combinaties. Het resultaat is coachadvies, geen automatische selectie.</p></div>
    <div className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-black">Geselecteerde acht</h3><p className="text-sm text-slate-500">{currentPlayers.length===8?"Gebaseerd op de huidige wedstrijdopstelling.":"Gebaseerd op de actieve basisspelers."}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${usable?"bg-emerald-50 text-emerald-700":"bg-amber-50 text-amber-700"}`}>{men.length} heren · {women.length} dames</span></div><div className="mt-3 flex flex-wrap gap-2">{sourcePlayers.map(p=><span key={p.id} className="rounded-full border bg-slate-50 px-3 py-1.5 text-sm font-semibold">{p.naam}</span>)}</div></div>
    {!usable?<div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900"><b>Nog geen geldige groep van acht.</b><div className="mt-1">De assistent heeft exact 4 actieve heren en 4 actieve dames nodig. Zet acht spelers in de wedstrijdopstelling of zorg dat de actieve basisspelers uit 4 heren en 4 dames bestaan.</div></div>:<>
      <div className="grid items-start gap-4 md:grid-cols-3">{advices.slice(0,3).map((a,i)=>{const open=openAdviceIndex===i;return <div key={i} className={`rounded-2xl border p-5 ${i===0?"border-violet-200 bg-violet-50":"bg-white"}`}><div className="flex justify-between gap-3"><div className="font-black">{i===0?"🏆 Advies 1":`Alternatief ${i+1}`}</div><div title="48% individuele kwaliteit + 22% balans + 30% combinatiehistorie" className="text-xl font-black text-violet-700">{a.score.toFixed(0)}</div></div><div className="mt-1 text-xs text-slate-500">KorbIQ score / 100</div><div className="mt-4 space-y-3"><div><div className="text-xs font-bold uppercase text-slate-500">Vak 1</div><div className="font-bold">{a.vak1.map(p=>p.naam).join(" · ")}</div><div className="text-xs text-slate-500">{Math.round(a.h1.minutes)} min samen · {reliabilityLabel(a.h1.minutes)}</div></div><div><div className="text-xs font-bold uppercase text-slate-500">Vak 2</div><div className="font-bold">{a.vak2.map(p=>p.naam).join(" · ")}</div><div className="text-xs text-slate-500">{Math.round(a.h2.minutes)} min samen · {reliabilityLabel(a.h2.minutes)}</div></div></div><button type="button" onClick={()=>setOpenAdviceIndex(open?null:i)} title="Bekijk de gebruikte prestaties, balans en combinatiehistorie" className="mt-4 w-full rounded-xl border border-violet-200 bg-white px-3 py-2 text-xs font-extrabold text-violet-700">{open?"Onderbouwing sluiten":"Waarom dit advies?"}</button>{open&&<div className="mt-3 space-y-2 rounded-xl border border-violet-100 bg-white p-3 text-xs text-slate-600"><div><b className="text-blue-700">48% individuele kwaliteit · {a.individual.toFixed(0)}</b><br/>Goals, kansen, rendement, rebounds, verdedigende acties en balvastheid van de acht spelers.</div><div><b className="text-emerald-700">22% vakbalans · {a.balance.toFixed(0)}</b><br/>Hoe kleiner het kwaliteitsverschil tussen Vak 1 en Vak 2, hoe hoger deze score.</div><div><b className="text-violet-700">30% combinatiehistorie · {a.history.toFixed(0)}</b><br/>Vak 1: {a.h1.goals}/{a.h1.attempts} raak uit kansen in {Math.round(a.h1.minutes)} min. Vak 2: {a.h2.goals}/{a.h2.attempts} in {Math.round(a.h2.minutes)} min. Weinig gezamenlijke minuten tellen als lagere betrouwbaarheid.</div><div className="border-t pt-2 font-semibold text-slate-700">Eindscore: 0,48 × {a.individual.toFixed(0)} + 0,22 × {a.balance.toFixed(0)} + 0,30 × {a.history.toFixed(0)} = {a.score.toFixed(1)}</div></div>}</div>})}</div>
      <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Alle berekende opstellingen</h3><p className="text-sm text-slate-500">Klik op de kolomtitels om te sorteren; de bestaande tabelsortering van KorbIQ blijft actief.</p><div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">#</th><th className="p-2">Vak 1</th><th className="p-2">Vak 2</th><th className="p-2">Score</th><th className="p-2">Balans</th><th className="p-2">Historie</th></tr></thead><tbody>{advices.map((a,i)=><tr key={i} className="border-b border-slate-100"><td className="p-2 font-bold">{i+1}</td><td className="p-2">{a.vak1.map(p=>p.naam).join(" · ")}</td><td className="p-2">{a.vak2.map(p=>p.naam).join(" · ")}</td><td className="p-2 font-black text-violet-700">{a.score.toFixed(1)}</td><td className="p-2">{a.balance.toFixed(0)}</td><td className="p-2">{a.history.toFixed(0)}</td></tr>)}</tbody></table></div></div>
    </>}
  </div>;
}


function WedstrijddoelenDashboard({ state, dbSheets }: { state: AppState; dbSheets: DatabaseSheetsData | null }) {
  type GoalTargets = { goals: number; scorePct: number; rebounds: number; turnovers: number; attemptsPerAttack: number; defendedPct: number };
  const key = `korbiq_match_goals_${state.season}_${state.opponentName || "zonder-tegenstander"}_${state.homeAway || "thuis"}`;
  const dbMatches=dbSheets?.matches??[]; const dbEvents=dbSheets?.events??[]; const dbAttacks=dbSheets?.attacks??[];
  const gNorm=(v:any)=>String(v??"").trim().toLowerCase(); const gOwn=(e:any)=>["korbis","thuis"].includes(gNorm(e.team)); const gAttempt=(e:any)=>["schot","doorloop","vrijebal","strafworp"].includes(gNorm(e.actie)); const gResult=(e:any)=>gNorm(e.uitkomst??e.resultaat);
  const oppHistory=state.opponentName?dbMatches.filter((m:any)=>gNorm(m.tegenstander)===gNorm(state.opponentName)):[];
  const oppIds=new Set(oppHistory.map((m:any)=>String(m.wedstrijd_id??""))); const histE=dbEvents.filter((e:any)=>oppIds.has(String(e.wedstrijd_id??"")));
  const histOwnAttempts=histE.filter((e:any)=>gOwn(e)&&gAttempt(e)); const histGoals=histOwnAttempts.filter((e:any)=>gResult(e)==="raak").length; const histRebounds=histE.filter((e:any)=>gOwn(e)&&gNorm(e.reden)==="rebound").length; const histTurnovers=histE.filter((e:any)=>gOwn(e)&&["bal uit","pass onderschept"].includes(gNorm(e.reden))).length; const histDefended=histOwnAttempts.filter((e:any)=>gResult(e)==="verdedigd").length; const histOwnAttacks=dbAttacks.filter((a:any)=>oppIds.has(String(a.wedstrijd_id??""))&&gOwn(a)).length;
  const suggestion:GoalTargets={goals:oppHistory.length?Math.max(1,Math.round(oppHistory.reduce((n:number,m:any)=>n+Number(m.score_korbis||0),0)/oppHistory.length)):20,scorePct:histOwnAttempts.length?Number((histGoals/histOwnAttempts.length*100+1.5).toFixed(1)):20,rebounds:oppHistory.length?Math.max(1,Math.round(histRebounds/oppHistory.length)):12,turnovers:oppHistory.length?Math.max(1,Math.round(histTurnovers/oppHistory.length)):10,attemptsPerAttack:histOwnAttacks?Number((histOwnAttempts.length/histOwnAttacks).toFixed(2)):2.2,defendedPct:histOwnAttempts.length?Number(Math.max(0,histDefended/histOwnAttempts.length*100-1).toFixed(1)):15};
  const [targets, setTargets] = useState<GoalTargets>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return { goals: 20, scorePct: 20, rebounds: 12, turnovers: 10, attemptsPerAttack: 2.2, defendedPct: 15, ...JSON.parse(raw) };
    } catch {}
    return { goals: 20, scorePct: 20, rebounds: 12, turnovers: 10, attemptsPerAttack: 2.2, defendedPct: 15 };
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(targets)); } catch {}
  }, [key, targets]);
  const eventTeam = (e: LogEvent): AttackTeam | undefined => e.team ?? (e.vak === "aanvallend" ? "thuis" : e.vak === "verdedigend" ? "uit" : undefined);
  const ownEvents = state.log.filter(e => eventTeam(e) === "thuis");
  const attempts = ownEvents.filter(e => ["Schot","Doorloop","Vrijebal","Strafworp"].includes(String(e.actie ?? "")));
  const goals = attempts.filter(e => e.resultaat === "Raak").length;
  const rebounds = ownEvents.filter(e => e.reden === "Rebound").length;
  const turnovers = ownEvents.filter(e => e.reden === "Bal uit" || e.reden === "Pass Onderschept").length;
  const defended = attempts.filter(e => e.resultaat === "Verdedigd").length;
  const ownAttacks = state.attacks.filter(a => a.team === "thuis").length;
  const scorePct = attempts.length ? goals / attempts.length * 100 : 0;
  const attemptsPerAttack = ownAttacks ? attempts.length / ownAttacks : 0;
  const defendedPct = attempts.length ? defended / attempts.length * 100 : 0;
  const update = (name: keyof GoalTargets, value: number) => setTargets(t => ({ ...t, [name]: Number.isFinite(value) ? value : 0 }));
  const cards = [
    { key:"goals" as const, label:"Doelpunten", value:goals, target:targets.goals, suffix:"", higher:true },
    { key:"scorePct" as const, label:"Raakpercentage", value:scorePct, target:targets.scorePct, suffix:"%", higher:true },
    { key:"rebounds" as const, label:"Rebounds", value:rebounds, target:targets.rebounds, suffix:"", higher:true },
    { key:"turnovers" as const, label:"Balverlies", value:turnovers, target:targets.turnovers, suffix:"", higher:false },
    { key:"attemptsPerAttack" as const, label:"Kansen / aanval", value:attemptsPerAttack, target:targets.attemptsPerAttack, suffix:"", higher:true },
    { key:"defendedPct" as const, label:"Verdedigd", value:defendedPct, target:targets.defendedPct, suffix:"%", higher:false },
  ];
  const met = cards.filter(c => c.higher ? c.value >= c.target : c.value <= c.target).length;
  return <div className="space-y-5">
    <div className="rounded-3xl border border-violet-100 bg-gradient-to-r from-violet-50 via-white to-blue-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-violet-700">KorbIQ Match Targets</div><h2 className="mt-1 text-2xl font-black">Wedstrijddoelen</h2><p className="mt-1 max-w-4xl text-sm text-slate-600">Stel vooraf concrete wedstrijddoelen in en volg tijdens de wedstrijd live hoe Korbis ervoor staat. De doelen worden per seizoen en tegenstander lokaal onthouden.</p></div>
    <div className="grid gap-4 md:grid-cols-3"><MetricInsightCard label="Doelen op koers" value={`${met} / ${cards.length}`} sub={state.tijdSeconden ? `na ${Math.floor(state.tijdSeconden/60)} minuten` : "wedstrijd nog niet gestart"}/><MetricInsightCard label="Score" value={`${state.scoreThuis} – ${state.scoreUit}`} sub={state.opponentName || "Nog geen tegenstander"}/><MetricInsightCard label="Aanvallen" value={String(ownAttacks)} sub={`${attempts.length} geregistreerde kansen`}/></div>
    {state.opponentName&&oppHistory.length>0&&<div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5"><div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><div><div className="text-xs font-extrabold uppercase tracking-wide text-indigo-700">Tegenstander-specifiek KorbIQ-advies</div><div className="mt-1 font-black">Gebaseerd op {oppHistory.length} eerdere duel{oppHistory.length===1?"":"s"} met {state.opponentName}</div><p className="mt-1 text-sm text-slate-600">Voorstel: {suggestion.goals} goals · {suggestion.scorePct}% raak · {suggestion.rebounds} rebounds · max. {suggestion.turnovers} balverlies · {suggestion.attemptsPerAttack} kansen/aanval · max. {suggestion.defendedPct}% verdedigd.</p></div><button onClick={()=>setTargets(suggestion)} className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white">Gebruik KorbIQ-advies</button></div></div>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{cards.map(c=>{const ok=c.higher?c.value>=c.target:c.value<=c.target;const progress=c.higher?Math.min(100,c.target?c.value/c.target*100:100):Math.min(100,c.value<=c.target?100:(c.target/Math.max(c.value,1))*100);return <div key={c.key} className={`rounded-2xl border p-5 ${ok?"border-emerald-200 bg-emerald-50/50":"border-slate-200 bg-white"}`}><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-extrabold uppercase tracking-wide text-slate-500">{c.label}</div><div className="mt-1 text-3xl font-black text-slate-900">{c.value.toFixed(c.key==="scorePct"||c.key==="attemptsPerAttack"||c.key==="defendedPct"?1:0)}{c.suffix}</div></div><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${ok?"bg-emerald-100 text-emerald-700":"bg-amber-100 text-amber-700"}`}>{ok?"Op koers":"Aandacht"}</span></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${ok?"bg-emerald-500":"bg-blue-500"}`} style={{width:`${Math.max(4,progress)}%`}} /></div><label className="mt-4 flex items-center justify-between gap-3 text-sm"><span className="text-slate-500">Doel {c.higher?"minimaal":"maximaal"}</span><span className="flex items-center gap-1"><input type="number" step={c.key==="scorePct"||c.key==="attemptsPerAttack"||c.key==="defendedPct"?"0.1":"1"} value={c.target} onChange={e=>update(c.key,Number(e.target.value))} className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-right font-bold" />{c.suffix}</span></label></div>})}</div>
    <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900"><b>Coachgebruik:</b> doelen zijn richtinggevend. Een groen doel betekent dat de huidige waarde aan de ingestelde grens voldoet; bij maximumdoelen zoals balverlies kan dit tijdens de wedstrijd weer veranderen.</div>
  </div>;
}

function SpelersportaalDashboard({ state, dbSheets, selectedPlayerId, onSelectPlayer, locked = false, playerOverride = null }: { state: AppState; dbSheets: DatabaseSheetsData | null; selectedPlayerId: string; onSelectPlayer: (id:string)=>void; locked?: boolean; playerOverride?: Player | null }) {
  const players = playerOverride
    ? [playerOverride]
    : state.spelers.filter(p=>p.actief && p.status === "Basisspeler");
  const player = players.find(p=>p.id===selectedPlayerId) ?? null;
  const events = dbSheets?.events ?? [];
  const matches = dbSheets?.matches ?? [];
  const own=(e:any)=>String(e.team??"").trim().toLowerCase()==="korbis";
  const isAttempt=(e:any)=>["Schot","Doorloop","Vrijebal","Strafworp"].includes(String(e.actie??""));
  const pe = player ? events.filter((e:any)=>own(e) && (String(e.spelerId??"")===player.id || String(e.spelerNaam??"")===player.naam)) : [];
  const attempts=pe.filter(isAttempt);
  const goals=attempts.filter((e:any)=>String(e.uitkomst??"")==="Raak").length;
  const rebounds=pe.filter((e:any)=>String(e.reden??"").toLowerCase().includes("rebound")).length;
  const turnovers=pe.filter((e:any)=>{
    const reason = String(e.reden??"").trim().toLowerCase();
    return reason.includes("balverlies") || reason === "bal uit" || reason === "pass onderschept";
  }).length;
  const played = player ? matches.filter((m:any)=>{ try { const d=JSON.parse(String(m.speeltijd_spelers_json??"[]")); return Array.isArray(d)&&d.some((x:any)=>(String(x.spelerId??"")===player.id||String(x.spelerNaam??"")===player.naam)&&Number(x.seconden??0)>0); } catch { return false; }}).length : 0;
  const minutes = player ? matches.reduce((sum:number,m:any)=>{ try { const d=JSON.parse(String(m.speeltijd_spelers_json??"[]")); const r=Array.isArray(d)?d.find((x:any)=>String(x.spelerId??"")===player.id||String(x.spelerNaam??"")===player.naam):null; return sum+Number(r?.seconden??0)/60; } catch { return sum; }},0) : 0;
  if (!player) return <div className="space-y-5"><div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-6"><div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-700">KorbIQ Player Portal</div><h2 className="mt-1 text-2xl font-black">Spelersportaal</h2><p className="mt-2 max-w-3xl text-sm text-slate-600">{locked ? "Je account is ingelogd, maar het gekoppelde spelersprofiel kon niet uit Supabase worden geladen." : "Kies hieronder een basisspeler om het spelersportaal als coach te bekijken."}</p></div>{!locked && <div className="rounded-2xl border bg-white p-5"><h3 className="font-black">Portaal bekijken als speler</h3><p className="mt-1 text-sm text-slate-500">Gastspelers krijgen standaard geen eigen spelersaccount.</p><select className="mt-4 w-full max-w-md rounded-xl border p-3" value="" onChange={e=>onSelectPlayer(e.target.value)}><option value="">Kies een speler…</option>{players.map(p=><option key={p.id} value={p.id}>{p.naam}</option>)}</select></div>}{locked && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><b>Nog geen data zichtbaar.</b> Controleer bij Personen of dit loginaccount aan de juiste speler is gekoppeld.</div>}</div>;
  return <div className="space-y-5"><div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-violet-50 via-white to-blue-50 p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-700">Mijn KorbIQ</div><h2 className="mt-1 text-2xl font-black">Welkom, {player.naam}</h2><p className="mt-1 text-sm text-slate-600">Jouw eigen prestaties en ontwikkeling. Teambeheer, andere spelers en coachfuncties horen niet in dit portaal.</p></div>{!locked && <button onClick={()=>onSelectPlayer("")} className="rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-600">Andere speler</button>}</div></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><MetricInsightCard label="Wedstrijden" value={played}/><MetricInsightCard label="Speelminuten" value={`${Math.round(minutes)} min`}/><MetricInsightCard label="Doelpunten" value={goals}/><MetricInsightCard label="Raak" value={attempts.length?`${(goals/attempts.length*100).toFixed(1)}%`:"—"}/><MetricInsightCard label="Rebounds" value={rebounds} sub={`${turnovers} × balverlies`}/></div><div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Mijn ontwikkeling</h3><p className="mt-1 text-sm text-slate-500">De uitgebreide speleranalyse blijft de bron voor vorm, trends en rankings. In een volgende spelersportaalfase kan dit als persoonlijke tijdlijn worden uitgebreid.</p><div className="mt-4 rounded-xl bg-slate-50 p-4 text-sm"><b>{attempts.length}</b> geregistreerde kansen · <b>{goals}</b> goals · <b>{rebounds}</b> rebounds.</div></div><div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Privacy & toegang</h3><p className="mt-1 text-sm text-slate-500">Een speleromgeving toont alleen gegevens van de ingelogde speler. Coachfuncties en gegevens van teamgenoten blijven buiten beeld.</p><div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">{locked ? "Je persoonlijke wedstrijdhistorie wordt rechtstreeks en afgeschermd uit Supabase geladen." : "Je bekijkt dit portaal als coach. Een speler krijgt na inloggen alleen zijn eigen gekoppelde portaal te zien."}</div></div></div></div>;
}

function SpeeltijdWisseladviesDashboard({ state, dbSheets }: { state: AppState; dbSheets: DatabaseSheetsData | null }) {
  const active = state.spelers.filter((p) => p.actief);
  const fieldIds = new Set([...state.aanval, ...state.verdediging].filter((id): id is string => Boolean(id)));
  const events = dbSheets?.events ?? [];
  const matches = dbSheets?.matches ?? [];
  const seasonMatches = matches.filter((m:any)=>String(m.seizoen ?? "")===state.season);
  const seasonIds = new Set(seasonMatches.map((m:any)=>String(m.wedstrijd_id ?? "")));
  const own = (e:any) => ["korbis","thuis"].includes(String(e.team ?? "").trim().toLowerCase());
  const action = (e:any) => String(e.actie ?? "").trim().toLowerCase();
  const result = (e:any) => String(e.uitkomst ?? e.resultaat ?? "").trim().toLowerCase();
  const reason = (e:any) => String(e.reden ?? "").trim().toLowerCase();
  const isAttempt = (e:any) => ["schot","doorloop","vrijebal","strafworp"].includes(action(e));
  const currentMinutes = (id:string) => Number(state.speelSeconden?.[id] ?? 0) / 60;
  const historical = (p:Player) => {
    const pe=events.filter((e:any)=>seasonIds.has(String(e.wedstrijd_id ?? "")) && own(e) && (String(e.spelerId ?? "")===p.id || String(e.spelerNaam ?? "")===p.naam));
    const attempts=pe.filter(isAttempt); const goals=attempts.filter((e:any)=>result(e)==="raak").length;
    const reb=pe.filter((e:any)=>action(e)==="rebound"&&reason(e)==="rebound").length;
    const def=pe.filter((e:any)=>["verdedigd","bal onderschept","pass onderschept"].includes(reason(e))).length;
    const loss=pe.filter((e:any)=>["bal uit","pass onderschept"].includes(reason(e))).length;
    const score=attempts.length?goals/attempts.length*100:0;
    return {attempts:attempts.length,goals,reb,def,loss,score,impact:goals*3+score*.12+reb*.7+def*.8-loss*.9};
  };
  const rows=active.map(p=>({p,onField:fieldIds.has(p.id),minutes:currentMinutes(p.id),...historical(p)}));
  const baseRows=rows.filter(r=>r.p.status==="Basisspeler");
  const guestRows=rows.filter(r=>r.p.status==="Gast");
  const fieldRows=baseRows.filter(r=>r.onField); const benchRows=baseRows.filter(r=>!r.onField);
  const avgField=fieldRows.length?fieldRows.reduce((n,r)=>n+r.minutes,0)/fieldRows.length:0;
  const loadTone=(m:number)=>m>=avgField+5?"hoog":m<=Math.max(0,avgField-8)?"laag":"normaal";
  const candidates=fieldRows.map(r=>{const load=Math.max(0,r.minutes-avgField);const performancePenalty=Math.max(0,40-r.impact)*.08;return {...r,adviceScore:load*1.4+performancePenalty};}).sort((a,b)=>b.adviceScore-a.adviceScore);
  const incoming=[...benchRows].sort((a,b)=>b.impact-a.impact || a.minutes-b.minutes);
  const out=candidates[0], incomingPlayer=incoming[0];
  const enoughCurrent=state.tijdSeconden>0 && fieldRows.length>0;
  const advice = enoughCurrent && out && incomingPlayer ? `${out.p.naam} heeft met ${out.minutes.toFixed(0)} minuten relatief veel speeltijd binnen de basisspelers. ${incomingPlayer.p.naam} is op basis van seizoensbijdrage en huidige speeltijd de logischste wisseloptie.` : "Zodra de wedstrijd loopt en er basisspelers op het veld en op de bank staan, geeft KorbIQ hier een wisselsuggestie.";
  const sortedMatches=[...seasonMatches].sort((a:any,b:any)=>String(a.datum??"").localeCompare(String(b.datum??"")));
  const minuteSeries=(p:Player):MetricDetailSeries=>{const vals=sortedMatches.map((m:any)=>{ try { const data=JSON.parse(String(m.speeltijd_spelers_json??"[]")); const row=Array.isArray(data)?data.find((x:any)=>String(x.spelerId??"")===p.id || String(x.spelerNaam??"")===p.naam):null; return Number(row?.seconden??0)/60; } catch { return 0; }});return {labels:sortedMatches.map((m:any,i:number)=>String(m.datum??"").slice(5,10)||`W${i+1}`),detailLabels:sortedMatches.map((m:any,i:number)=>`${String(m.datum??"").slice(0,10)||`Wedstrijd ${i+1}`} · ${String(m.tegenstander??"-")}`),values:vals,suffix:" min"};};
  return <div className="space-y-5">
    <div className="rounded-3xl border border-cyan-100 bg-gradient-to-r from-cyan-50 via-white to-blue-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-cyan-700">KorbIQ Rotation Intelligence</div><h2 className="mt-1 text-2xl font-black">Speeltijd & wisseladvies</h2><p className="mt-1 max-w-4xl text-sm text-slate-600">Het automatische wisseladvies vergelijkt uitsluitend basisspelers. Gastspelers worden wel zichtbaar bijgehouden, maar tellen niet mee in speeltijdgemiddelden, belasting of automatische wisselsuggesties.</p></div>
    <div className="grid gap-4 md:grid-cols-3"><MetricInsightCard label="Wedstrijdminuut" value={`${Math.floor(state.tijdSeconden/60)}'`} sub={state.klokLoopt?"Wedstrijd loopt":"Klok staat stil"}/><MetricInsightCard label="Gem. speeltijd basis op veld" value={`${avgField.toFixed(0)} min`} sub={`${fieldRows.length} basisspelers op het veld`}/><MetricInsightCard label="Grootste basisbelasting" value={fieldRows.length?`${Math.max(...fieldRows.map(r=>r.minutes)).toFixed(0)} min`:`0 min`} sub={[...fieldRows].sort((a,b)=>b.minutes-a.minutes)[0]?.p.naam ?? "Nog geen data"}/></div>
    <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5"><div className="text-xs font-extrabold uppercase tracking-wide text-blue-700">Actueel coachadvies</div><div className="mt-2 text-lg font-black text-slate-900">{advice}</div>{enoughCurrent&&out&&incomingPlayer?<div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-white px-3 py-1.5 text-sm font-bold text-orange-700 ring-1 ring-orange-200">Uit: {out.p.naam}</span><span className="rounded-full bg-white px-3 py-1.5 text-sm font-bold text-emerald-700 ring-1 ring-emerald-200">In: {incomingPlayer.p.naam}</span></div>:null}</div>
    <div className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-lg font-black">Speeltijd basisspelers</h3><p className="text-sm text-slate-500">Alleen deze spelers bepalen de belasting en wisselvolgorde.</p></div></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{baseRows.sort((a,b)=>Number(b.onField)-Number(a.onField)||b.minutes-a.minutes).map(r=><MetricInsightCard key={r.p.id} label={`${r.onField?"● Veld":"○ Bank"} · ${r.p.naam}`} value={`${r.minutes.toFixed(0)} min`} sub={<><span className={loadTone(r.minutes)==="hoog"?"font-bold text-orange-700":loadTone(r.minutes)==="laag"?"font-bold text-blue-700":"text-slate-500"}>{loadTone(r.minutes)} belast</span> · seizoenimpact {r.impact.toFixed(0)}</>} series={minuteSeries(r.p)} className={r.onField?"border-emerald-100 bg-emerald-50/40":"bg-slate-50"}/>)}</div></div>
    {guestRows.length>0&&<div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50/30 p-5"><h3 className="text-lg font-black">Gastspelers</h3><p className="text-sm text-slate-500">Speeltijd wordt geregistreerd, maar gasten beïnvloeden het basisgemiddelde en het automatische wisseladvies niet.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{guestRows.map(r=><MetricInsightCard key={r.p.id} label={`${r.onField?"● Veld":"○ Bank"} · ${r.p.naam}`} value={`${r.minutes.toFixed(0)} min`} sub={<><span className="font-bold text-violet-700">Gast</span> · buiten wisselbalans</>} series={minuteSeries(r.p)} className="border-violet-100 bg-white"/>)}</div></div>}
    <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-black">Wisselvolgorde basisspelers</h3><p className="text-sm text-slate-500">Gastspelers worden bewust niet als automatische invaloptie of uitwisseladvies gebruikt.</p><div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">Speler</th><th className="p-2">Status</th><th className="p-2 text-right">Minuten</th><th className="p-2 text-right">Seizoen impact</th><th className="p-2">Signaal</th></tr></thead><tbody>{baseRows.map(r=><tr key={r.p.id} className="border-b border-slate-100"><td className="p-2 font-bold">{r.p.naam}</td><td className="p-2">{r.onField?"Veld":"Bank"}</td><td className="p-2 text-right">{r.minutes.toFixed(0)}</td><td className="p-2 text-right">{r.impact.toFixed(1)}</td><td className="p-2">{r.onField&&loadTone(r.minutes)==="hoog"?<span className="font-bold text-orange-700">Wisselmoment bewaken</span>:!r.onField&&r.impact>0?<span className="font-bold text-emerald-700">Invaloptie</span>:"—"}</td></tr>)}</tbody></table></div></div>
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">KorbIQ gebruikt alleen geregistreerde data. Een wisseladvies houdt nog geen rekening met blessures, vermoeidheid die niet uit speeltijd blijkt, tactische opdrachten, persoonlijke afspraken of het directe wedstrijdbeeld.</div>
  </div>;
}

function SpelerprofielenDashboard({
  spelers,
  dbSheets,
  initialSelectedId,
}: {
  spelers: Player[];
  dbSheets: DatabaseSheetsData | null;
  initialSelectedId?: string;
}) {
  const [selectedId, setSelectedId] = useState<string>(() => initialSelectedId ?? spelers[0]?.id ?? "");
  const [seasonFilter, setSeasonFilter] = useState<string>("__all__");

  useEffect(() => {
    if (!spelers.length) {
      if (selectedId) setSelectedId("");
      return;
    }
    if (!spelers.some((p) => p.id === selectedId)) setSelectedId(spelers[0].id);
  }, [spelers, selectedId]);

  const matches = dbSheets?.matches ?? [];
  const events = dbSheets?.events ?? [];
  const attacks = dbSheets?.attacks ?? [];
  const vakperiodes = ((dbSheets as any)?.vakperiodes ?? []) as any[];
  const selected = spelers.find((p) => p.id === selectedId);
  const seasons = Array.from(new Set(matches.map((m:any) => String(m.seizoen ?? "").trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  const selectedMatches = matches.filter((m:any) => seasonFilter === "__all__" || String(m.seizoen ?? "") === seasonFilter);
  const matchIds = new Set(selectedMatches.map((m:any) => String(m.wedstrijd_id ?? "")));
  const own = (e:any) => ["korbis","thuis"].includes(String(e.team ?? "").trim().toLowerCase());
  const result = (e:any) => String(e.uitkomst ?? e.resultaat ?? "").trim().toLowerCase();
  const isAttempt = (e:any) => ["schot","doorloop","vrijebal","strafworp"].includes(String(e.actie ?? "").trim().toLowerCase());
  const playerEvents = events.filter((e:any) => matchIds.has(String(e.wedstrijd_id ?? "")) && own(e) && (String(e.spelerId ?? "") === selectedId || (!!selected?.naam && String(e.spelerNaam ?? "") === selected.naam)));
  const attempts = playerEvents.filter(isAttempt);
  const goals = attempts.filter((e:any) => result(e) === "raak").length;
  const korf = attempts.filter((e:any) => result(e) === "korf").length;
  const rebounds = playerEvents.filter((e:any) => String(e.actie ?? "").toLowerCase() === "rebound" && String(e.reden ?? "").toLowerCase() === "rebound").length;
  const defense = playerEvents.filter((e:any) => ["verdedigd","bal onderschept","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
  const turnovers = playerEvents.filter((e:any) => ["bal uit","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
  const scorePct = attempts.length ? goals / attempts.length * 100 : 0;
  const qualityPct = attempts.length ? (goals + korf) / attempts.length * 100 : 0;

  const minutesByMatch = new Map<string, number>();
  selectedMatches.forEach((m:any) => {
    let parsed:any[] = [];
    try { parsed = JSON.parse(String(m.speeltijd_spelers_json ?? "[]")); } catch { parsed = []; }
    const row = parsed.find((x:any) => String(x.spelerId ?? x.id ?? "") === selectedId || (!!selected?.naam && String(x.spelerNaam ?? x.naam ?? "") === selected.naam));
    const sec = Number(row?.seconden ?? row?.seconds ?? 0);
    if (Number.isFinite(sec) && sec > 0) minutesByMatch.set(String(m.wedstrijd_id ?? ""), sec / 60);
  });
  if (!minutesByMatch.size && vakperiodes.length) {
    vakperiodes.filter((v:any) => matchIds.has(String(v.wedstrijd_id ?? ""))).forEach((v:any) => {
      const raw = String(v.combinatie_speler_ids ?? "");
      if (!raw.includes(selectedId)) return;
      const id = String(v.wedstrijd_id ?? "");
      const sec = Number(v.duur_seconden ?? 0);
      if (Number.isFinite(sec)) minutesByMatch.set(id, (minutesByMatch.get(id) ?? 0) + sec / 60);
    });
  }
  const totalMinutes = Array.from(minutesByMatch.values()).reduce((a,b)=>a+b,0);
  const playedMatches = minutesByMatch.size || new Set(playerEvents.map((e:any)=>String(e.wedstrijd_id ?? ""))).size;
  const reliability = totalMinutes >= 300 ? {label:"Sterk", dots:"●●●●", cls:"text-emerald-700"} : totalMinutes >= 150 ? {label:"Redelijk", dots:"●●●○", cls:"text-blue-700"} : totalMinutes >= 60 ? {label:"Beperkt", dots:"●●○○", cls:"text-amber-700"} : {label:"Zeer beperkt", dots:"●○○○", cls:"text-slate-500"};

  const teamAttempts = events.filter((e:any) => matchIds.has(String(e.wedstrijd_id ?? "")) && own(e) && isAttempt(e));
  const teamGoals = teamAttempts.filter((e:any)=>result(e)==="raak").length;
  const teamKorf = teamAttempts.filter((e:any)=>result(e)==="korf").length;
  const teamScore = teamAttempts.length ? teamGoals/teamAttempts.length*100 : 0;
  const teamQuality = teamAttempts.length ? (teamGoals+teamKorf)/teamAttempts.length*100 : 0;

  // Fase 17: eerlijke teambenchmarks en rankings. Basisspelers worden onderling vergeleken;
  // bij te weinig basisspelers vallen we terug op alle actieve spelers. Volume-statistieken zijn per 60 minuten.
  const rankingPlayers = (() => {
    const base = spelers.filter((p) => p.actief && p.status === "Basisspeler");
    return base.length >= 2 ? base : spelers.filter((p) => p.actief);
  })();
  const playerStats = rankingPlayers.map((p) => {
    const pe = events.filter((e:any) => matchIds.has(String(e.wedstrijd_id ?? "")) && own(e) && (String(e.spelerId ?? "") === p.id || String(e.spelerNaam ?? "") === p.naam));
    const pa = pe.filter(isAttempt);
    const pg = pa.filter((e:any) => result(e) === "raak").length;
    const pk = pa.filter((e:any) => result(e) === "korf").length;
    const shot = pa.filter((e:any) => String(e.actie ?? "").trim().toLowerCase() === "schot");
    const shotGoals = shot.filter((e:any) => result(e) === "raak").length;
    const run = pa.filter((e:any) => String(e.actie ?? "").trim().toLowerCase() === "doorloop");
    const runGoals = run.filter((e:any) => result(e) === "raak").length;
    const reb = pe.filter((e:any) => String(e.actie ?? "").toLowerCase() === "rebound" && String(e.reden ?? "").toLowerCase() === "rebound").length;
    const def = pe.filter((e:any) => ["verdedigd","bal onderschept","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
    const tov = pe.filter((e:any) => ["bal uit","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
    let minutes = 0;
    selectedMatches.forEach((m:any) => {
      let parsed:any[] = [];
      try { parsed = JSON.parse(String(m.speeltijd_spelers_json ?? "[]")); } catch { parsed = []; }
      const row = parsed.find((x:any) => String(x.spelerId ?? x.id ?? "") === p.id || String(x.spelerNaam ?? x.naam ?? "") === p.naam);
      const sec = Number(row?.seconden ?? row?.seconds ?? 0);
      if (Number.isFinite(sec) && sec > 0) minutes += sec / 60;
    });
    if (!minutes && vakperiodes.length) vakperiodes.filter((v:any) => matchIds.has(String(v.wedstrijd_id ?? "")) && String(v.combinatie_speler_ids ?? "").includes(p.id)).forEach((v:any) => { minutes += (Number(v.duur_seconden ?? 0) || 0) / 60; });
    const per60 = (n:number) => minutes > 0 ? n / minutes * 60 : 0;
    return {
      id:p.id, name:p.naam, minutes, attempts:pa.length, goals:pg, rebounds:reb, defense:def, turnovers:tov,
      goals60:per60(pg), attempts60:per60(pa.length), rebounds60:per60(reb), defense60:per60(def), turnovers60:per60(tov),
      scorePct:pa.length ? pg/pa.length*100 : 0, qualityPct:pa.length ? (pg+pk)/pa.length*100 : 0,
      shotScore:shot.length ? shotGoals/shot.length*100 : 0, shotVolume:per60(shot.length),
      runScore:run.length ? runGoals/run.length*100 : 0, runVolume:per60(run.length),
    };
  });
  const eligibleStats = playerStats.filter((p) => p.minutes >= 60);
  const rankedPool = eligibleStats.length >= 2 ? eligibleStats : playerStats.filter((p) => p.minutes > 0);
  const avg = (key:keyof typeof playerStats[number]) => rankedPool.length ? rankedPool.reduce((sum,p) => sum + Number(p[key] ?? 0), 0) / rankedPool.length : 0;
  const rankOf = (key:keyof typeof playerStats[number], inverse=false) => {
    const sorted=[...rankedPool].sort((a,b)=>inverse ? Number(a[key])-Number(b[key]) : Number(b[key])-Number(a[key]));
    const pos=sorted.findIndex((p)=>p.id===selectedId); return pos>=0 ? pos+1 : null;
  };
  const percentileScore = (key:keyof typeof playerStats[number], inverse=false) => {
    const rank=rankOf(key,inverse); if (!rank || rankedPool.length<=1) return rank ? 100 : 0;
    return 100 * (rankedPool.length-rank) / (rankedPool.length-1);
  };
  const scoringComposite = percentileScore("goals60")*.45 + percentileScore("scorePct")*.35 + percentileScore("attempts60")*.20;
  const shotComposite = percentileScore("shotScore")*.65 + percentileScore("shotVolume")*.35;
  const runComposite = percentileScore("runScore")*.65 + percentileScore("runVolume")*.35;
  const reboundComposite = percentileScore("rebounds60");
  const defenseComposite = percentileScore("defense60");
  const attackComposite = percentileScore("qualityPct")*.40 + percentileScore("attempts60")*.25 + percentileScore("goals60")*.25 + percentileScore("turnovers60",true)*.10;
  const overallComposite = scoringComposite*.25 + shotComposite*.12 + runComposite*.10 + reboundComposite*.18 + defenseComposite*.18 + attackComposite*.17;
  const compositeRank = (getter:(p:typeof playerStats[number])=>number) => {
    const scored=rankedPool.map((p)=>({id:p.id,score:getter(p)})).sort((a,b)=>b.score-a.score);
    const pos=scored.findIndex((x)=>x.id===selectedId); return pos>=0 ? pos+1 : null;
  };
  const compositeFor = (p:typeof playerStats[number], kind:"scoring"|"shot"|"run"|"attack"|"overall") => {
    const rankScore=(key:keyof typeof playerStats[number], inverse=false) => {
      const sorted=[...rankedPool].sort((a,b)=>inverse ? Number(a[key])-Number(b[key]) : Number(b[key])-Number(a[key]));
      const r=sorted.findIndex(x=>x.id===p.id)+1; return r>0 && sorted.length>1 ? 100*(sorted.length-r)/(sorted.length-1) : r===1?100:0;
    };
    const scoring=rankScore("goals60")*.45+rankScore("scorePct")*.35+rankScore("attempts60")*.20;
    const shotC=rankScore("shotScore")*.65+rankScore("shotVolume")*.35;
    const runC=rankScore("runScore")*.65+rankScore("runVolume")*.35;
    const attackC=rankScore("qualityPct")*.40+rankScore("attempts60")*.25+rankScore("goals60")*.25+rankScore("turnovers60",true)*.10;
    if(kind==="scoring")return scoring; if(kind==="shot")return shotC; if(kind==="run")return runC; if(kind==="attack")return attackC;
    return scoring*.25+shotC*.12+runC*.10+rankScore("rebounds60")*.18+rankScore("defense60")*.18+attackC*.17;
  };
  const rankings = [
    {label:"Overall", icon:"🏆", rank:compositeRank(p=>compositeFor(p,"overall")), score:overallComposite},
    {label:"Scorend", icon:"🎯", rank:compositeRank(p=>compositeFor(p,"scoring")), score:scoringComposite},
    {label:"Schot", icon:"🏹", rank:compositeRank(p=>compositeFor(p,"shot")), score:shotComposite},
    {label:"Doorloop", icon:"⚡", rank:compositeRank(p=>compositeFor(p,"run")), score:runComposite},
    {label:"Rebound", icon:"🧲", rank:rankOf("rebounds60"), score:reboundComposite},
    {label:"Verdedigend", icon:"🛡️", rank:rankOf("defense60"), score:defenseComposite},
    {label:"Aanvallend", icon:"💎", rank:compositeRank(p=>compositeFor(p,"attack")), score:attackComposite},
    {label:"Balvastheid", icon:"🔒", rank:rankOf("turnovers60",true), score:percentileScore("turnovers60",true)},
  ];
  const selectedStat = playerStats.find((p)=>p.id===selectedId);
  const benchmarkCards = [
    {label:"Goals / 60", value:selectedStat?.goals60 ?? 0, team:avg("goals60"), suffix:""},
    {label:"Kansen / 60", value:selectedStat?.attempts60 ?? 0, team:avg("attempts60"), suffix:""},
    {label:"Raak", value:selectedStat?.scorePct ?? 0, team:avg("scorePct"), suffix:"%"},
    {label:"Korfgericht", value:selectedStat?.qualityPct ?? 0, team:avg("qualityPct"), suffix:"%"},
    {label:"Rebound / 60", value:selectedStat?.rebounds60 ?? 0, team:avg("rebounds60"), suffix:""},
    {label:"Verdedigend / 60", value:selectedStat?.defense60 ?? 0, team:avg("defense60"), suffix:""},
  ];
  const metricSignal = (value:number, benchmark:number, threshold:number) => value >= benchmark + threshold ? "green" : value <= benchmark - threshold ? "red" : "orange";
  const signalClass = (tone:"green"|"orange"|"red") => tone === "green" ? "bg-emerald-50 text-emerald-800 border-emerald-200" : tone === "red" ? "bg-red-50 text-red-800 border-red-200" : "bg-amber-50 text-amber-800 border-amber-200";

  const perMatch = selectedMatches.map((m:any) => {
    const id=String(m.wedstrijd_id ?? "");
    const ev=playerEvents.filter((e:any)=>String(e.wedstrijd_id ?? "")===id);
    const at=ev.filter(isAttempt); const g=at.filter((e:any)=>result(e)==="raak").length; const k=at.filter((e:any)=>result(e)==="korf").length;
    const reb=ev.filter((e:any)=>String(e.actie ?? "").toLowerCase()==="rebound" && String(e.reden ?? "").toLowerCase()==="rebound").length;
    const def=ev.filter((e:any)=>["verdedigd","bal onderschept","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
    const tov=ev.filter((e:any)=>["bal uit","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
    return {id, date:formatImportedDate(m.datum), opponent:String(m.tegenstander ?? m.wedstrijd_naam ?? "-"), minutes:minutesByMatch.get(id) ?? 0, attempts:at.length, goals:g, rebounds:reb, defense:def, turnovers:tov, score:at.length?g/at.length*100:0, quality:at.length?(g+k)/at.length*100:0};
  }).filter(x=>x.minutes>0 || x.attempts>0 || x.rebounds>0 || x.defense>0 || x.turnovers>0).sort((a,b)=>a.date.localeCompare(b.date));

  const comboMap = new Map<string,{names:string; minutes:number; attacks:number; goals:number}>();
  vakperiodes.filter((v:any)=>matchIds.has(String(v.wedstrijd_id ?? "")) && String(v.combinatie_speler_ids ?? "").includes(selectedId)).forEach((v:any)=>{
    const key=String(v.combinatie_key ?? v.combinatie_spelers ?? ""); if(!key)return;
    const cur=comboMap.get(key) ?? {names:String(v.combinatie_spelers ?? key),minutes:0,attacks:0,goals:0};
    cur.minutes += Number(v.duur_seconden ?? 0)/60; comboMap.set(key,cur);
  });
  attacks.filter((a:any)=>matchIds.has(String(a.wedstrijd_id ?? "")) && String(a.combinatie_speler_ids ?? "").includes(selectedId)).forEach((a:any)=>{const key=String(a.combinatie_key ?? a.combinatie_spelers ?? ""); const cur=comboMap.get(key); if(cur)cur.attacks+=1;});
  events.filter((e:any)=>matchIds.has(String(e.wedstrijd_id ?? "")) && own(e) && result(e)==="raak" && String(e.combinatie_speler_ids ?? "").includes(selectedId)).forEach((e:any)=>{const key=String(e.combinatie_key ?? e.combinatie_spelers ?? ""); const cur=comboMap.get(key); if(cur)cur.goals+=1;});
  const combos=Array.from(comboMap.values()).sort((a,b)=>b.minutes-a.minutes).slice(0,5);

  // Fase 19: vorm en spelerontwikkeling. We vergelijken de laatste 5 gespeelde wedstrijden
  // met de 5 wedstrijden daarvoor en tonen daarnaast de ontwikkeling per wedstrijd.
  const chronologicalMatches = [...selectedMatches].sort((a:any,b:any) => String(a.datum ?? "").localeCompare(String(b.datum ?? "")));
  const playedIds = new Set(perMatch.map(x=>x.id));
  const playedChronological = chronologicalMatches.filter((m:any)=>playedIds.has(String(m.wedstrijd_id ?? "")));
  const recent5 = playedChronological.slice(-5);
  const previous5 = playedChronological.slice(-10,-5);
  const windowStats = (windowMatches:any[]) => {
    const ids=new Set(windowMatches.map((m:any)=>String(m.wedstrijd_id ?? "")));
    const ev=playerEvents.filter((e:any)=>ids.has(String(e.wedstrijd_id ?? "")));
    const at=ev.filter(isAttempt);
    const g=at.filter((e:any)=>result(e)==="raak").length;
    const reb=ev.filter((e:any)=>String(e.actie ?? "").toLowerCase()==="rebound" && String(e.reden ?? "").toLowerCase()==="rebound").length;
    const def=ev.filter((e:any)=>["verdedigd","bal onderschept","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
    const tov=ev.filter((e:any)=>["bal uit","pass onderschept"].includes(String(e.reden ?? "").trim().toLowerCase())).length;
    const mins=windowMatches.reduce((sum:number,m:any)=>sum+(minutesByMatch.get(String(m.wedstrijd_id ?? "")) ?? 0),0);
    const per60=(n:number)=>mins>0?n/mins*60:0;
    return {matches:windowMatches.length,minutes:mins,goals60:per60(g),attempts60:per60(at.length),scorePct:at.length?g/at.length*100:0,rebounds60:per60(reb),defense60:per60(def),turnovers60:per60(tov)};
  };
  const recentForm=windowStats(recent5);
  const previousForm=windowStats(previous5);
  const formDelta = (recentForm.goals60-previousForm.goals60)*1.5 + (recentForm.scorePct-previousForm.scorePct)*.35 + (recentForm.rebounds60-previousForm.rebounds60)*.7 + (recentForm.defense60-previousForm.defense60)*.7 - (recentForm.turnovers60-previousForm.turnovers60)*.8;
  const formStatus = previous5.length < 2 || recent5.length < 2 ? {label:"Nog te weinig data",icon:"⚪",cls:"border-slate-200 bg-slate-50 text-slate-700"} : formDelta >= 5 ? {label:"Uitstekende vorm",icon:"🔥",cls:"border-emerald-200 bg-emerald-50 text-emerald-800"} : formDelta >= 1.5 ? {label:"Goede vorm",icon:"🟢",cls:"border-emerald-200 bg-emerald-50 text-emerald-800"} : formDelta <= -5 ? {label:"Teruglopende vorm",icon:"🟠",cls:"border-orange-200 bg-orange-50 text-orange-800"} : formDelta <= -1.5 ? {label:"Lichte terugval",icon:"🟡",cls:"border-amber-200 bg-amber-50 text-amber-800"} : {label:"Stabiele vorm",icon:"⚪",cls:"border-blue-200 bg-blue-50 text-blue-800"};
  const trendMetric=(label:string,current:number,previous:number,suffix:string,inverse=false)=>{
    const delta=current-previous; const improved=inverse?delta<0:delta>0; const worsened=inverse?delta>0:delta<0;
    return {label,current,previous,suffix,delta,arrow:Math.abs(delta)<.05?"→":improved?"↑":"↓",cls:Math.abs(delta)<.05?"text-slate-500":improved?"text-emerald-700":worsened?"text-red-700":"text-slate-500"};
  };
  const formMetrics=[trendMetric("Goals / 60",recentForm.goals60,previousForm.goals60,""),trendMetric("Kansen / 60",recentForm.attempts60,previousForm.attempts60,""),trendMetric("Raak",recentForm.scorePct,previousForm.scorePct,"%"),trendMetric("Rebound / 60",recentForm.rebounds60,previousForm.rebounds60,""),trendMetric("Verdedigend / 60",recentForm.defense60,previousForm.defense60,""),trendMetric("Balverlies / 60",recentForm.turnovers60,previousForm.turnovers60,"",true)];
  const developmentRows=perMatch.map((x,i)=>{
    const goals60=x.minutes>0?x.goals/x.minutes*60:0;
    const attempts60=x.minutes>0?x.attempts/x.minutes*60:0;
    const rebounds60=x.minutes>0?x.rebounds/x.minutes*60:0;
    const defense60=x.minutes>0?x.defense/x.minutes*60:0;
    const turnovers60=x.minutes>0?x.turnovers/x.minutes*60:0;
    const rolling=perMatch.slice(Math.max(0,i-4),i+1);
    const rollingMinutes=rolling.reduce((sum,r)=>sum+r.minutes,0);
    const rollingGoals=rolling.reduce((sum,r)=>sum+r.goals,0);
    return {...x,goals60,attempts60,rebounds60,defense60,turnovers60,rollingGoals60:rollingMinutes>0?rollingGoals/rollingMinutes*60:0};
  });
  const profileLabels = developmentRows.map((x,i)=>x.date ? x.date.slice(0,5) : `W${i+1}`);
  const profileSeries = (key:"goals60"|"attempts60"|"score"|"quality"|"rebounds60"|"defense60"|"turnovers60"|"minutes"|"goals"|"attempts"|"rebounds"|"defense"|"turnovers", suffix="", comparison?:number, comparisonLabel="Teamgem."): MetricDetailSeries => ({
    labels: profileLabels,
    detailLabels: developmentRows.map((x,i)=>`${x.date || profileLabels[i]} · ${x.opponent}`),
    values: developmentRows.map((x)=>Number(x[key] ?? 0)),
    comparisonValues: comparison == null ? undefined : developmentRows.map(()=>comparison),
    comparisonLabel,
    suffix,
  });
  const profileSeriesForLabel = (label:string): MetricDetailSeries | undefined => {
    if(label==="Goals / 60") return profileSeries("goals60","",avg("goals60"));
    if(label==="Kansen / 60") return profileSeries("attempts60","",avg("attempts60"));
    if(label==="Raak") return profileSeries("score","%",avg("scorePct"));
    if(label==="Korfgericht") return profileSeries("quality","%",avg("qualityPct"));
    if(label==="Rebound / 60") return profileSeries("rebounds60","",avg("rebounds60"));
    if(label==="Verdedigend / 60") return profileSeries("defense60","",avg("defense60"));
    if(label==="Balverlies / 60") return profileSeries("turnovers60");
    return undefined;
  };
  const maxDevelopment=Math.max(1,...developmentRows.slice(-10).map(x=>x.rollingGoals60));

  if (!dbSheets) return <div className="rounded-2xl border bg-white p-6 text-slate-600">Laad eerst een database om spelerprofielen op te bouwen.</div>;
  if (!spelers.length) return <div className="rounded-2xl border bg-white p-6 text-slate-600">Voeg eerst spelers toe.</div>;

  const strengths:{tone:"green"|"orange"|"red"; title:string; text:string}[] = [];
  if (attempts.length) strengths.push({tone:metricSignal(scorePct,teamScore,4),title:"Scorend vermogen",text:`${scorePct.toFixed(1)}% raak tegenover ${teamScore.toFixed(1)}% teamgemiddeld.`});
  if (attempts.length) strengths.push({tone:metricSignal(qualityPct,teamQuality,6),title:"Korfgerichtheid",text:`${qualityPct.toFixed(1)}% raak of korf tegenover ${teamQuality.toFixed(1)}% teamgemiddeld.`});
  if (rebounds) strengths.push({tone:"green",title:"Reboundbijdrage",text:`${rebounds} gewonnen aanvallende rebounds in de gekozen periode.`});
  if (turnovers) strengths.push({tone:turnovers <= Math.max(1,playedMatches) ? "orange" : "red",title:"Balverlies",text:`${turnovers} geregistreerde momenten van balverlies.`});

  return <div className="space-y-5">
    <div className="space-y-4">
      <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm">
        <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Insights</div>
        <h2 className="mt-1 text-2xl font-bold">Spelerprofiel</h2>
        <p className="mt-1 text-sm text-gray-500">Ontwikkeling, rendement en samenwerking over meerdere wedstrijden.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
        <label><div className="mb-1 text-xs font-semibold text-gray-500">Speler</div><select value={selectedId} onChange={e=>setSelectedId(e.target.value)} className="w-full rounded-xl border bg-white px-3 py-2 text-sm font-semibold text-slate-800">{spelers.map(p=><option key={p.id} value={p.id}>{p.naam}</option>)}</select></label>
        <label><div className="mb-1 text-xs font-semibold text-gray-500">Seizoen</div><select value={seasonFilter} onChange={e=>setSeasonFilter(e.target.value)} className="w-full rounded-xl border bg-white px-3 py-2 text-sm font-semibold text-slate-800"><option value="__all__">Alle seizoenen</option>{seasons.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
      </div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {benchmarkCards.map((m)=><MetricInsightCard key={m.label} label={m.label} value={`${m.value.toFixed(1)}${m.suffix}`} metric={m.value} benchmark={m.team} sub={<>Teamgem.: <span className="font-bold text-slate-700">{m.team.toFixed(1)}{m.suffix}</span></>} series={profileSeriesForLabel(m.label)} />)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MetricInsightCard label="Wedstrijden" value={playedMatches} sub="Aantal wedstrijden met speeltijd of geregistreerde acties" />
      <MetricInsightCard label="Minuten" value={Math.round(totalMinutes)} sub="Totaal gespeelde minuten" series={profileSeries("minutes")} />
      <MetricInsightCard label="Totaal goals" value={goals} sub="Goals in de geselecteerde periode" series={profileSeries("goals")} />
      <MetricInsightCard label="Totaal kansen" value={attempts.length} sub="Pogingen in de geselecteerde periode" series={profileSeries("attempts")} />
    </div>
    <div className="rounded-2xl border bg-white p-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-lg font-bold">Teamranking</h3><p className="text-sm text-slate-500">Vergelijking met {rankedPool.length} basisspelers met voldoende data. Volume is omgerekend per 60 minuten.</p></div><div className="text-xs font-semibold text-slate-500">Minimaal 60 minuten voor de standaardranking</div></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{rankings.map(r=><div key={r.label} className={`rounded-xl border p-3 ${r.rank===1?'border-amber-200 bg-amber-50':r.rank && r.rank<=3?'border-blue-200 bg-blue-50':'bg-slate-50'}`}><div className="flex items-center justify-between gap-2"><div className="font-bold text-slate-800">{r.icon} {r.label}</div><div className="text-lg font-black text-slate-900">{r.rank ? `#${r.rank} / ${rankedPool.length}` : '—'}</div></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-blue-600" style={{width:`${Math.max(0,Math.min(100,r.score))}%`}} /></div></div>)}</div>
    </div>
    <div className="rounded-2xl border bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">Fase 19 · ontwikkeling</div><h3 className="mt-1 text-xl font-black">Vorm laatste 5 wedstrijden</h3><p className="text-sm text-slate-500">Vergelijking met de vijf gespeelde wedstrijden daarvoor. Waarden met volume zijn per 60 minuten.</p></div><div className={`rounded-xl border px-4 py-3 text-sm font-black ${formStatus.cls}`}>{formStatus.icon} {formStatus.label}</div></div>
      {previous5.length>=2 && recent5.length>=2 ? <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{formMetrics.map(m=><MetricInsightCard key={m.label} label={m.label} value={`${m.current.toFixed(1)}${m.suffix}`} sub={<>Vorige 5: <b>{m.previous.toFixed(1)}{m.suffix}</b> · <span className={m.cls}>{m.arrow} {Math.abs(m.delta).toFixed(1)}{m.suffix}</span></>} inverse={m.label==="Balverlies / 60"} series={profileSeriesForLabel(m.label)} className="bg-slate-50" />)}</div> : <div className="mt-4 rounded-xl border border-dashed bg-slate-50 p-4 text-sm text-slate-500">Voor een betrouwbare vormvergelijking zijn minimaal twee recente én twee eerdere wedstrijden nodig.</div>}
    </div>
    <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
      <div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold">Ontwikkeling goals / 60</h3><p className="text-sm text-slate-500">5-wedstrijd voortschrijdend gemiddelde; zo weegt één uitschieter minder zwaar.</p></div><div className="text-xs font-bold text-slate-500">laatste {Math.min(10,developmentRows.length)}</div></div><div className="mt-5 flex h-44 items-end gap-2">{developmentRows.slice(-10).map(x=><div key={x.id} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"><div className="text-[10px] font-bold text-slate-600">{x.rollingGoals60.toFixed(1)}</div><div className="w-full rounded-t-md bg-blue-500" style={{height:`${Math.max(4,x.rollingGoals60/maxDevelopment*120)}px`}} title={`${x.opponent}: ${x.rollingGoals60.toFixed(1)} goals / 60`} /><div className="max-w-full truncate text-[9px] text-slate-400">{x.opponent}</div></div>)}</div>{!developmentRows.length&&<div className="mt-4 text-sm text-slate-500">Nog geen wedstrijddata beschikbaar.</div>}</div>
      <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Ontwikkelingsbeeld</h3><p className="text-sm text-slate-500">Korte interpretatie van de recente vorm.</p><div className="mt-4 space-y-3">{formMetrics.slice(0,5).map(m=><div key={m.label} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><span className="text-sm font-semibold text-slate-700">{m.label}</span><span className={`text-sm font-black ${m.cls}`}>{m.arrow} {m.current.toFixed(1)}{m.suffix}</span></div>)}</div></div>
    </div>
    <div className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
      <div className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold">Profielsignalen</h3><p className="text-sm text-slate-500">Vergelijking met Korbis in dezelfde geselecteerde wedstrijden.</p></div><div className={`text-right text-sm font-bold ${reliability.cls}`}><div>{reliability.dots}</div><div>{reliability.label} · {Math.round(totalMinutes)} min</div></div></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{strengths.length?strengths.map((x,i)=><div key={i} className={`rounded-xl border p-3 ${signalClass(x.tone)}`}><div className="font-bold">{x.tone==='green'?'●':x.tone==='red'?'●':'●'} {x.title}</div><div className="mt-1 text-sm">{x.text}</div></div>):<div className="text-sm text-slate-500">Nog onvoldoende acties voor inhoudelijke signalen.</div>}</div></div>
      <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Bijdrage</h3><div className="mt-4 grid grid-cols-3 gap-3"><MetricInsightCard label="Rebounds" value={rebounds} series={profileSeries("rebounds")} className="bg-orange-50"/><MetricInsightCard label="Verdedigend" value={defense} series={profileSeries("defense")} className="bg-blue-50"/><MetricInsightCard label="Balverlies" value={turnovers} inverse series={profileSeries("turnovers")} className="bg-red-50"/></div></div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Ontwikkeling per wedstrijd</h3><p className="text-sm text-slate-500">Laat zien of prestaties stabiel zijn of veranderen.</p><div className="mt-4 overflow-auto"><table className="w-full min-w-[520px] text-sm"><thead><tr className="text-slate-500"><th className="py-2 text-left">Datum</th><th className="text-left">Tegenstander</th><th className="text-right">Min.</th><th className="text-right">Goals</th><th className="text-right">Kansen</th><th className="text-right">Raak</th><th className="text-right">Goals/60</th><th className="text-right">Kansen/60</th></tr></thead><tbody>{developmentRows.slice(-10).map(x=><tr key={x.id} className="border-t"><td className="py-2">{x.date}</td><td className="font-semibold">{x.opponent}</td><td className="text-right">{Math.round(x.minutes)}</td><td className="text-right font-bold">{x.goals}</td><td className="text-right">{x.attempts}</td><td className="text-right">{x.attempts?`${x.score.toFixed(1)}%`:'—'}</td><td className="text-right">{x.goals60.toFixed(1)}</td><td className="text-right">{x.attempts60.toFixed(1)}</td></tr>)}</tbody></table></div></div>
      <div className="rounded-2xl border bg-white p-5"><h3 className="text-lg font-bold">Vakcombinaties met {selected?.naam}</h3><p className="text-sm text-slate-500">De meest gebruikte viertallen waarin deze speler voorkomt.</p><div className="mt-4 space-y-2">{combos.length?combos.map((c,i)=><div key={`${c.names}-${i}`} className="rounded-xl border bg-slate-50 p-3"><div className="font-bold text-slate-800">{c.names}</div><div className="mt-1 flex flex-wrap gap-x-4 text-xs text-slate-500"><span>{Math.round(c.minutes)} min samen</span><span>{c.attacks} aanvallen</span><span>{c.goals} goals</span><span>{c.attacks?`${(c.goals/c.attacks*10).toFixed(1)} goals / 10 aanvallen`:'—'}</span></div></div>):<div className="text-sm text-slate-500">Nog geen vakcombinatiedata voor deze speler.</div>}</div></div>
    </div>
  </div>;
}


function AnalysisHubTabs<T extends string>({ tabs, active, onChange }: { tabs: readonly { id: T; label: string; hint: string }[]; active: T; onChange: (id: T) => void }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm"><div className="grid gap-2 md:grid-cols-3">{tabs.map((item) => <button key={item.id} type="button" onClick={() => onChange(item.id)} className={`rounded-xl px-4 py-3 text-left transition ${active === item.id ? "bg-blue-600 text-white shadow-sm" : "bg-slate-50 text-slate-700 hover:bg-blue-50"}`}><div className="text-sm font-black">{item.label}</div><div className={`mt-0.5 text-xs ${active === item.id ? "text-blue-100" : "text-slate-500"}`}>{item.hint}</div></button>)}</div></div>;
}

function subsetDatabaseSheets(dbSheets: DatabaseSheetsData | null, matchIds: Set<string>): DatabaseSheetsData | null {
  if (!dbSheets) return null;
  const belongs = (row: any) => matchIds.has(String(row.wedstrijd_id ?? ""));
  return {
    ...dbSheets,
    matches: (dbSheets.matches ?? []).filter(belongs),
    events: (dbSheets.events ?? []).filter(belongs),
    attacks: (dbSheets.attacks ?? []).filter(belongs),
    wissels: (dbSheets.wissels ?? []).filter(belongs),
    vakperiodes: (dbSheets.vakperiodes ?? []).filter(belongs),
  };
}

function LatestMatchSharePanel({ match }: { match: any | null }) {
  const matchId = String(match?.supabase_match_id ?? "");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(Boolean(matchId));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const shareUrl = token ? `${KORBIQ_APP_ORIGIN}/wedstrijd-delen/${token}` : "";

  useEffect(() => {
    let active = true;
    if (!matchId) { setLoading(false); setToken(""); return; }
    setLoading(true);
    supabase.rpc("get_match_share_status", { p_match_id: matchId }).then(({data,error})=>{
      if(!active)return;
      setToken(!error && data?.active && data?.token ? String(data.token) : "");
      setLoading(false);
    });
    return ()=>{active=false;};
  }, [matchId]);

  const createLink = async () => {
    if(!matchId)return;
    setBusy(true); setMessage("");
    const {data,error}=await supabase.rpc("create_match_share_link",{p_match_id:matchId});
    if(error){setMessage(error.message.includes("function")?"Voer eerst Query 33 uit in Supabase.":error.message);}
    else if(data?.token){setToken(String(data.token));setMessage("De openbare link is klaar om te delen.");}
    setBusy(false);
  };
  const copyLink = async () => {
    if(!shareUrl)return;
    try{await navigator.clipboard.writeText(shareUrl);setMessage("Link gekopieerd.");}catch{setMessage("Kopiëren lukte niet automatisch. Selecteer de link hieronder.");}
  };
  const shareLink = async () => {
    if(!shareUrl)return;
    if(navigator.share){try{await navigator.share({title:`${match?.team_naam||"Korbis"} – ${match?.tegenstander||"Tegenstander"}`,text:"Bekijk de wedstrijdsamenvatting in KorbIQ.",url:shareUrl});}catch{}return;}
    await copyLink();
  };
  const revokeLink = async () => {
    if(!matchId || !window.confirm("Weet je zeker dat je deze openbare link wilt intrekken?"))return;
    setBusy(true); setMessage("");
    const {error}=await supabase.rpc("revoke_match_share_link",{p_match_id:matchId});
    if(error)setMessage(error.message);else{setToken("");setMessage("De openbare link is ingetrokken.");}
    setBusy(false);
  };

  return <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-blue-50 p-5">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><div className="text-xs font-extrabold uppercase tracking-[.14em] text-indigo-700">Delen met spelers en ouders</div><h3 className="mt-1 text-lg font-black">Laatste wedstrijd delen</h3>{match?<p className="mt-1 text-sm text-slate-600">{formatImportedDate(match.datum)} · {safeDisplayText(match.team_naam,"Korbis")} – {safeDisplayText(match.tegenstander,"Tegenstander")} · {safeDisplayText(match.score_korbis,"0")}–{safeDisplayText(match.score_tegenstander,"0")}</p>:<p className="mt-1 text-sm text-slate-600">Er is nog geen afgesloten Supabase-wedstrijd om te delen.</p>}</div><div className="flex flex-wrap gap-2">{!token?<button type="button" disabled={!matchId||busy||loading} onClick={()=>void createLink()} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">{loading?"Controleren…":busy?"Link maken…":"Maak openbare link"}</button>:<><button type="button" onClick={()=>void copyLink()} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white">Link kopiëren</button><button type="button" onClick={()=>void shareLink()} className="rounded-xl border border-indigo-200 bg-white px-4 py-2.5 text-sm font-bold text-indigo-700">Delen…</button><button type="button" disabled={busy} onClick={()=>void revokeLink()} className="rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-bold text-red-700">Link intrekken</button></>}</div></div>
    {shareUrl&&<div className="mt-4"><label className="text-xs font-bold text-slate-500">Openbare link<input readOnly value={shareUrl} onFocus={event=>event.currentTarget.select()} className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-700" /></label><p className="mt-2 text-xs text-slate-500">Iedereen met deze link kan de alleen-lezen wedstrijdsamenvatting bekijken. Inloggen is niet nodig.</p></div>}
    {message&&<div className={`mt-4 rounded-xl px-3 py-2 text-sm font-semibold ${message.toLowerCase().includes("niet")||message.toLowerCase().includes("voer eerst")?"bg-amber-50 text-amber-800":"bg-emerald-50 text-emerald-800"}`}>{message}</div>}
  </div>;
}

function StoredMatchSnapshot({ dbSheets }: { dbSheets: DatabaseSheetsData | null }) {
  const matches=dbSheets?.matches??[];const events=dbSheets?.events??[];const attacks=dbSheets?.attacks??[];const periods=dbSheets?.vakperiodes??[];
  const norm=(value:any)=>String(value??"").trim().toLowerCase();
  const own=(row:any)=>["korbis","thuis"].includes(norm(row.team));
  const attempt=(row:any)=>["schot","doorloop","vrijebal","strafworp"].includes(norm(row.actie));
  const result=(row:any)=>norm(row.uitkomst??row.resultaat);const reason=(row:any)=>norm(row.reden);
  const ownEvents=events.filter(own);const attempts=ownEvents.filter(attempt);const goals=attempts.filter(row=>result(row)==="raak");const directed=attempts.filter(row=>["raak","korf"].includes(result(row)));
  const opponentAttempts=events.filter(row=>!own(row)&&attempt(row));const opponentGoals=opponentAttempts.filter(row=>result(row)==="raak");
  const wonRebounds=ownEvents.filter(row=>norm(row.actie)==="rebound"&&reason(row)==="rebound").length;const lostRebounds=ownEvents.filter(row=>norm(row.actie)==="rebound"&&reason(row)==="geen rebound").length;
  const turnovers=ownEvents.filter(row=>["bal uit","pass onderschept","balverlies"].includes(reason(row))).length;const defensive=ownEvents.filter(row=>["verdedigd","bal onderschept","pass onderschept","schot afgevangen"].includes(reason(row))).length;
  const ownAttacks=attacks.filter(own);const pct=(part:number,total:number)=>total?part/total*100:0;
  const playerNames=Array.from(new Set(ownEvents.map(row=>String(row.spelerNaam??"").trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"nl-NL"));
  const players=playerNames.map(name=>{const pe=ownEvents.filter(row=>String(row.spelerNaam??"").trim()===name);const pa=pe.filter(attempt);const pg=pa.filter(row=>result(row)==="raak").length;const pk=pa.filter(row=>result(row)==="korf").length;return{name,goals:pg,attempts:pa.length,score:pct(pg,pa.length),quality:pct(pg+pk,pa.length),rebounds:pe.filter(row=>norm(row.actie)==="rebound"&&reason(row)==="rebound").length,defense:pe.filter(row=>["verdedigd","bal onderschept","pass onderschept","schot afgevangen"].includes(reason(row))).length,turnovers:pe.filter(row=>["bal uit","pass onderschept","balverlies"].includes(reason(row))).length}}).sort((a,b)=>b.goals-a.goals||b.quality-a.quality);
  const actionRows=["Schot","Doorloop","Vrijebal","Strafworp"].map(label=>{const rows=attempts.filter(row=>norm(row.actie)===label.toLowerCase());const made=rows.filter(row=>result(row)==="raak").length;return{label,attempts:rows.length,goals:made,score:pct(made,rows.length)}});
  const comboMap=new Map<string,{names:string;minutes:number;attacks:number;goals:number;attempts:number}>();
  periods.forEach((row:any)=>{const key=String(row.combinatie_key??row.combinatie_spelers??"");if(!key)return;const current=comboMap.get(key)??{names:String(row.combinatie_spelers??"Onbekende combinatie"),minutes:0,attacks:0,goals:0,attempts:0};current.minutes+=Number(row.duur_seconden??0)/60;comboMap.set(key,current)});
  attacks.filter(own).forEach((row:any)=>{const current=comboMap.get(String(row.combinatie_key??row.combinatie_spelers??""));if(current)current.attacks++});
  attempts.forEach((row:any)=>{const current=comboMap.get(String(row.combinatie_key??row.combinatie_spelers??""));if(current){current.attempts++;if(result(row)==="raak")current.goals++}});
  const combos=Array.from(comboMap.values()).filter(combo=>combo.names&&!/[0-9a-f]{8}-[0-9a-f-]{27}/i.test(combo.names)).sort((a,b)=>b.minutes-a.minutes).slice(0,6);
  const matchRows=[...matches].sort((a:any,b:any)=>String(b.datum??"").localeCompare(String(a.datum??"")));
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8"><MetricInsightCard label="Goals" value={goals.length}/><MetricInsightCard label="Kansen" value={attempts.length}/><MetricInsightCard label="Raak" value={attempts.length?`${pct(goals.length,attempts.length).toFixed(1)}%`:"—"}/><MetricInsightCard label="Korfgericht" value={attempts.length?`${pct(directed.length,attempts.length).toFixed(1)}%`:"—"}/><MetricInsightCard label="Aanvallen" value={ownAttacks.length}/><MetricInsightCard label="Kansen / aanval" value={ownAttacks.length?(attempts.length/ownAttacks.length).toFixed(2):"—"}/><MetricInsightCard label="Rebound" value={wonRebounds+lostRebounds?`${pct(wonRebounds,wonRebounds+lostRebounds).toFixed(0)}%`:"—"}/><MetricInsightCard label="Balverlies" value={turnovers}/></div>
  <div className="grid gap-4 xl:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h3 className="font-black">Wedstrijdbeeld</h3><p className="mt-2 text-sm leading-6 text-slate-600">{matches.length===1?`${goals.length} doelpunten uit ${attempts.length} kansen in ${ownAttacks.length} aanvallen.`:`${matches.length} wedstrijden: ${goals.length} doelpunten uit ${attempts.length} kansen.`} De tegenstander kwam tot {opponentGoals.length} goals uit {opponentAttempts.length} geregistreerde kansen. Korbis noteerde {wonRebounds} gewonnen rebounds, {defensive} verdedigende acties en {turnovers} momenten van balverlies.</p><div className="mt-4 grid grid-cols-4 gap-2">{actionRows.map(row=><div key={row.label} className="rounded-xl bg-slate-50 p-3"><div className="text-xs font-bold text-slate-500">{row.label}</div><div className="mt-1 font-black">{row.goals}/{row.attempts}</div><div className="text-[11px] text-slate-500">{row.attempts?`${row.score.toFixed(0)}% raak`:"geen kans"}</div></div>)}</div></div>
  <div className="overflow-hidden rounded-2xl border bg-white"><div className="border-b p-4"><h3 className="font-black">Spelersbijdrage</h3><p className="text-xs text-slate-500">Aanval, rebound, verdediging en balverlies naast elkaar.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="p-3 text-left">Speler</th><th className="p-3 text-right">Goals</th><th className="p-3 text-right">Kansen</th><th className="p-3 text-right">Raak</th><th className="p-3 text-right">Korfgericht</th><th className="p-3 text-right">Reb.</th><th className="p-3 text-right">Verd.</th><th className="p-3 text-right">Balverlies</th></tr></thead><tbody>{players.map(player=><tr key={player.name} className="border-t"><td className="p-3 font-bold">{player.name}</td><td className="p-3 text-right font-black">{player.goals}</td><td className="p-3 text-right">{player.attempts}</td><td className="p-3 text-right">{player.attempts?`${player.score.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{player.attempts?`${player.quality.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{player.rebounds}</td><td className="p-3 text-right">{player.defense}</td><td className="p-3 text-right">{player.turnovers}</td></tr>)}</tbody></table></div></div></div>
  <div className="grid gap-4 xl:grid-cols-2"><div className="overflow-hidden rounded-2xl border bg-white"><div className="border-b p-4"><h3 className="font-black">Resultaten in selectie</h3></div><div className="divide-y">{matchRows.map((match:any)=><div key={String(match.wedstrijd_id)} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><div><div className="font-bold">{formatImportedDate(match.datum)} · {safeDisplayText(match.tegenstander??match.wedstrijd_naam,"Onbekend")}</div><div className="text-xs text-slate-500">{safeDisplayText(match.seizoen??match.team_seizoen_naam)}</div></div><div className={`text-lg font-black ${Number(match.score_korbis)>Number(match.score_tegenstander)?"text-emerald-700":Number(match.score_korbis)<Number(match.score_tegenstander)?"text-red-600":"text-amber-700"}`}>{safeDisplayText(match.score_korbis,"0")} – {safeDisplayText(match.score_tegenstander,"0")}</div></div>)}</div></div><div className="overflow-hidden rounded-2xl border bg-white"><div className="border-b p-4"><h3 className="font-black">Meest gebruikte vakcombinaties</h3><p className="text-xs text-slate-500">Rendement wordt alleen getoond als aanvallen zijn geregistreerd.</p></div><div className="divide-y">{combos.map((combo,index)=><div key={`${combo.names}-${index}`} className="px-4 py-3"><div className="font-bold">{safeDisplayText(combo.names,"Onbekende combinatie")}</div><div className="mt-1 text-xs text-slate-500">{Math.round(combo.minutes)} min · {combo.attacks} aanvallen · {combo.goals}/{combo.attempts} raak · {combo.attacks?(combo.goals/combo.attacks*10).toFixed(1):"—"} goals / 10 aanvallen</div></div>)}{!combos.length&&<div className="p-5 text-sm text-slate-500">Geen bruikbare vakcombinaties in deze selectie.</div>}</div></div></div></div>;
}

function WedstrijdInsightsOverview({ state, spelersMap, dbSheets }: { state: AppState; spelersMap: Map<string, Player>; dbSheets: DatabaseSheetsData | null }) {
  const [seasonFilter, setSeasonFilter] = useState("__all__");
  const [periodFilter, setPeriodFilter] = useState<"all" | "veld_najaar" | "zaal" | "veld_voorjaar">("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<{ type: "match" | "period"; matchId?: string } | null>(null);
  const matches = dbSheets?.matches ?? [];
  const latestShareableMatch = [...matches].filter((m:any)=>Boolean(m.supabase_match_id)&&!Boolean(m.gearchiveerd)&&String(m.wedstrijd_afgesloten??"").toLowerCase()==="ja").sort((a:any,b:any)=>String(b.datum??"").localeCompare(String(a.datum??"")))[0] ?? null;
  const seasons = Array.from(new Set(matches.map((m:any) => String(m.seizoen ?? m.team_seizoen_naam ?? "").trim()).filter(Boolean))).sort((a,b)=>b.localeCompare(a,"nl-NL"));
  const periodMatches = matches.filter((m:any) => {
    const season = String(m.seizoen ?? m.team_seizoen_naam ?? "");
    if (seasonFilter !== "__all__" && season !== seasonFilter) return false;
    if (periodFilter === "veld_najaar" && !/veld\s*najaar/i.test(season)) return false;
    if (periodFilter === "zaal" && !/zaal/i.test(season)) return false;
    if (periodFilter === "veld_voorjaar" && !/veld\s*voorjaar/i.test(season)) return false;
    const needle = search.trim().toLowerCase();
    return !needle || String(m.tegenstander ?? m.wedstrijd_naam ?? "").toLowerCase().includes(needle);
  }).sort((a:any,b:any)=>String(b.datum??"").localeCompare(String(a.datum??"")));
  const selectedIds = new Set(periodMatches.map((m:any)=>String(m.wedstrijd_id ?? "")));
  const goalsFor = periodMatches.reduce((n:number,m:any)=>n+Number(m.score_korbis??0),0);
  const goalsAgainst = periodMatches.reduce((n:number,m:any)=>n+Number(m.score_tegenstander??0),0);
  const wins = periodMatches.filter((m:any)=>Number(m.score_korbis)>Number(m.score_tegenstander)).length;
  const overviewStats=(matchId:string)=>{const rows=(dbSheets?.events??[]).filter((event:any)=>String(event.wedstrijd_id??"")===matchId&&["korbis","thuis"].includes(String(event.team??"").trim().toLowerCase()));const chanceEvents=rows.filter((event:any)=>["schot","doorloop","vrijebal","strafworp"].includes(String(event.actie??"").trim().toLowerCase()));const goals=chanceEvents.filter((event:any)=>String(event.uitkomst??event.resultaat??"").trim().toLowerCase()==="raak").length;const directed=chanceEvents.filter((event:any)=>["raak","korf"].includes(String(event.uitkomst??event.resultaat??"").trim().toLowerCase())).length;const matchAttacks=(dbSheets?.attacks??[]).filter((attack:any)=>String(attack.wedstrijd_id??"")===matchId&&["korbis","thuis"].includes(String(attack.team??"").trim().toLowerCase())).length;return{chances:chanceEvents.length,score:chanceEvents.length?goals/chanceEvents.length*100:0,quality:chanceEvents.length?directed/chanceEvents.length*100:0,perAttack:matchAttacks?chanceEvents.length/matchAttacks:0}};

  if (detail) {
    const ids = detail.type === "match" ? new Set([detail.matchId ?? ""]) : selectedIds;
    const selectedSheets = subsetDatabaseSheets(dbSheets, ids);
    const selectedMatch = detail.type === "match" ? matches.find((m:any)=>String(m.wedstrijd_id)===detail.matchId) : null;
    return <div className="space-y-5">
      <button type="button" onClick={()=>setDetail(null)} className="rounded-xl border bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">← Terug naar wedstrijdoverzicht</button>
      <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5"><div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-700">Wedstrijdinzichten</div><h2 className="mt-1 text-2xl font-black">{selectedMatch ? `${formatImportedDate(selectedMatch.datum)} · ${safeDisplayText(selectedMatch.tegenstander??selectedMatch.wedstrijd_naam,"Onbekende tegenstander")}` : "Analyse van geselecteerde periode"}</h2><p className="mt-1 text-sm text-slate-500">{selectedMatch ? "Detailanalyse van deze wedstrijd." : `${periodMatches.length} wedstrijden binnen je huidige selectie.`}</p></div>
      <StoredMatchSnapshot dbSheets={selectedSheets}/>
      <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3"><div className="font-black text-blue-900">Verdiepende trends en vergelijkingen</div><div className="text-xs text-blue-700">Onderstaande analyse voegt verloop, teamgemiddelden, vaktrends en ontwikkelpunten toe.</div></div>
      <InsightsTab state={state} spelersMap={spelersMap} opponentName={state.opponentName} dbSheets={selectedSheets} forcedMode="team" initialMatchId={detail.type === "match" ? detail.matchId : "__all__"} />
    </div>;
  }

  return <div className="space-y-5">
    <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-700">KorbIQ Match Intelligence</div><h2 className="mt-1 text-2xl font-black">Wedstrijdinzichten</h2><p className="mt-1 max-w-3xl text-sm text-slate-500">Begin met het wedstrijdoverzicht. Filter eventueel op periode en open daarna één wedstrijd of analyseer de hele selectie.</p></div>
    <LatestMatchSharePanel match={latestShareableMatch} />
    <div className="rounded-2xl border bg-white p-4"><div className="grid gap-3 md:grid-cols-3"><label className="text-xs font-bold text-slate-600">Seizoen<select value={seasonFilter} onChange={e=>setSeasonFilter(e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm"><option value="__all__">Alle seizoenen</option>{seasons.map(s=><option key={s} value={s}>{s}</option>)}</select></label><label className="text-xs font-bold text-slate-600">Periode<select value={periodFilter} onChange={e=>setPeriodFilter(e.target.value as typeof periodFilter)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm"><option value="all">Alle perioden</option><option value="veld_najaar">Veld najaar</option><option value="zaal">Zaal</option><option value="veld_voorjaar">Veld voorjaar</option></select></label><label className="text-xs font-bold text-slate-600">Tegenstander zoeken<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Bijv. PKC" className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm" /></label></div></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricInsightCard label="Wedstrijden" value={periodMatches.length}/><MetricInsightCard label="Gewonnen" value={wins}/><MetricInsightCard label="Voor" value={goalsFor}/><MetricInsightCard label="Tegen" value={goalsAgainst}/></div>
    <div className="rounded-2xl border bg-white overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><div><h3 className="font-black">Alle wedstrijden</h3><p className="text-xs text-slate-500">Vergelijk kerncijfers direct of open een wedstrijd voor de volledige analyse.</p></div><button type="button" disabled={!periodMatches.length} onClick={()=>setDetail({type:"period"})} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">Analyseer selectie</button></div><div className="overflow-auto"><table className="w-full min-w-[980px] text-sm"><thead className="bg-slate-50"><tr><th className="p-3 text-left">Datum</th><th className="p-3 text-left">Tegenstander</th><th className="p-3 text-left">Seizoen</th><th className="p-3 text-right">Uitslag</th><th className="p-3 text-right">Kansen</th><th className="p-3 text-right">Raak</th><th className="p-3 text-right">Korfgericht</th><th className="p-3 text-right">Kansen / aanv.</th><th className="p-3 text-right"></th></tr></thead><tbody>{periodMatches.map((m:any)=>{const id=String(m.wedstrijd_id??"");const own=Number(m.score_korbis??0),opp=Number(m.score_tegenstander??0);const stats=overviewStats(id);return <tr key={id} className="border-t hover:bg-blue-50/40"><td className="p-3 whitespace-nowrap">{formatImportedDate(m.datum)}</td><td className="p-3 font-bold">{safeDisplayText(m.tegenstander??m.wedstrijd_naam,"Onbekend")}</td><td className="p-3 text-slate-500">{safeDisplayText(m.seizoen??m.team_seizoen_naam)}</td><td className={`p-3 text-right font-black ${own>opp?"text-emerald-700":own<opp?"text-red-600":"text-amber-700"}`}>{own} – {opp}</td><td className="p-3 text-right">{stats.chances}</td><td className="p-3 text-right">{stats.chances?`${stats.score.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{stats.chances?`${stats.quality.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{stats.perAttack?stats.perAttack.toFixed(2):"—"}</td><td className="p-3 text-right"><button type="button" onClick={()=>setDetail({type:"match",matchId:id})} className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-bold text-blue-700">Bekijk analyse →</button></td></tr>})}{!periodMatches.length&&<tr><td colSpan={9} className="p-8 text-center text-slate-500">Geen wedstrijden binnen deze selectie.</td></tr>}</tbody></table></div></div>
  </div>;
}

function SpelerAnalyseHub({ state, dbSheets }: { state: AppState; dbSheets: DatabaseSheetsData | null }) {
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const events = dbSheets?.events ?? [];
  const matches = dbSheets?.matches ?? [];
  const isOwn = (e:any) => ["korbis","thuis"].includes(String(e.team??"").trim().toLowerCase());
  const isAttempt = (e:any) => ["schot","doorloop","vrijebal","strafworp"].includes(String(e.actie??"").trim().toLowerCase());
  const eventResult=(e:any)=>String(e.uitkomst??e.resultaat??"").trim().toLowerCase();
  const eventReason=(e:any)=>String(e.reden??"").trim().toLowerCase();
  const rows = state.spelers.filter(p=>p.actief).map(player=>{
    const pe=events.filter((e:any)=>isOwn(e)&&(String(e.spelerId??"")===player.id||String(e.spelerNaam??"")===player.naam));
    const attempts=pe.filter(isAttempt); const goals=attempts.filter((e:any)=>eventResult(e)==="raak").length;const directed=attempts.filter((e:any)=>["raak","korf"].includes(eventResult(e))).length;
    const rebounds=pe.filter((e:any)=>String(e.actie??"").trim().toLowerCase()==="rebound"&&eventReason(e)==="rebound").length;
    const defense=pe.filter((e:any)=>["verdedigd","bal onderschept","pass onderschept","schot afgevangen"].includes(eventReason(e))).length;
    const turnovers=pe.filter((e:any)=>["bal uit","pass onderschept","balverlies"].includes(eventReason(e))).length;
    const playedIds=new Set(pe.map((e:any)=>String(e.wedstrijd_id??"")));
    let minutes=0; matches.forEach((m:any)=>{let data:any[]=[];try{data=JSON.parse(String(m.speeltijd_spelers_json??"[]"));}catch{}const row=data.find((x:any)=>String(x.spelerId??x.id??"")===player.id||String(x.spelerNaam??x.naam??"")===player.naam);const seconds=Number(row?.seconden??row?.seconds??0);minutes+=seconds/60;if(seconds>0)playedIds.add(String(m.wedstrijd_id??""));});
    return {player,played:playedIds.size,minutes,goals,attempts:attempts.length,pct:attempts.length?goals/attempts.length*100:0,quality:attempts.length?directed/attempts.length*100:0,rebounds,defense,turnovers,goals60:minutes?goals/minutes*60:0};
  }).sort((a,b)=>a.player.naam.localeCompare(b.player.naam,"nl-NL"));
  const totalGoals=rows.reduce((sum,row)=>sum+row.goals,0);const totalAttempts=rows.reduce((sum,row)=>sum+row.attempts,0);const totalMinutes=rows.reduce((sum,row)=>sum+row.minutes,0);const leader=[...rows].sort((a,b)=>b.goals-a.goals||b.pct-a.pct)[0];
  if (selectedPlayerId) return <div className="space-y-5"><button type="button" onClick={()=>setSelectedPlayerId(null)} className="rounded-xl border bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">← Terug naar spelersoverzicht</button><SpelerprofielenDashboard spelers={state.spelers} dbSheets={dbSheets} initialSelectedId={selectedPlayerId} /></div>;
  return <div className="space-y-5"><div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[.16em] text-blue-700">KorbIQ Player Intelligence</div><h2 className="mt-1 text-2xl font-black">Spelerinzichten</h2><p className="mt-1 max-w-3xl text-sm text-slate-500">Vergelijk het volledige team op speeltijd, aanval, rebound en verdediging. Open daarna één speler voor diens ontwikkeling per wedstrijd.</p></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricInsightCard label="Actieve spelers" value={rows.length}/><MetricInsightCard label="Teamproductie" value={`${totalGoals} / ${totalAttempts}`} sub={totalAttempts?`${(totalGoals/totalAttempts*100).toFixed(1)}% raak`:"Nog geen kansen"}/><MetricInsightCard label="Totaal speeltijd" value={`${Math.round(totalMinutes)} min`}/><MetricInsightCard label="Meeste goals" value={leader?.player.naam??"—"} sub={leader?`${leader.goals} goals · ${leader.goals60.toFixed(1)} per 60 min`:"Nog geen data"}/></div><div className="rounded-2xl border bg-white overflow-hidden"><div className="border-b p-4"><h3 className="font-black">Alle spelers</h3><p className="text-xs text-slate-500">Alle zichtbare wedstrijden van het gekozen analyseteam. Klik op kolomtitels om te sorteren.</p></div><div className="overflow-auto"><table className="w-full min-w-[1180px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="p-3 text-left">Speler</th><th className="p-3 text-left">Status</th><th className="p-3 text-right">Wedstr.</th><th className="p-3 text-right">Min.</th><th className="p-3 text-right">Goals</th><th className="p-3 text-right">Kansen</th><th className="p-3 text-right">Raak</th><th className="p-3 text-right">Korfgericht</th><th className="p-3 text-right">Goals / 60</th><th className="p-3 text-right">Reb.</th><th className="p-3 text-right">Verd.</th><th className="p-3 text-right">Balverlies</th><th className="p-3 text-right"></th></tr></thead><tbody>{rows.map(r=><tr key={r.player.id} className="border-t hover:bg-blue-50/40"><td className="p-3 font-bold">{r.player.naam}</td><td className="p-3 text-slate-500">{r.player.status}</td><td className="p-3 text-right">{r.played}</td><td className="p-3 text-right">{Math.round(r.minutes)}</td><td className="p-3 text-right font-black">{r.goals}</td><td className="p-3 text-right">{r.attempts}</td><td className="p-3 text-right">{r.attempts?`${r.pct.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{r.attempts?`${r.quality.toFixed(1)}%`:"—"}</td><td className="p-3 text-right">{r.minutes?r.goals60.toFixed(1):"—"}</td><td className="p-3 text-right">{r.rebounds}</td><td className="p-3 text-right">{r.defense}</td><td className="p-3 text-right">{r.turnovers}</td><td className="p-3 text-right"><button type="button" onClick={()=>setSelectedPlayerId(r.player.id)} className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-bold text-blue-700">Bekijk speler →</button></td></tr>)}</tbody></table></div></div></div>;
}

function TeamAnalyseHub({ state, spelersMap, dbSheets }: { state: AppState; spelersMap: Map<string, Player>; dbSheets: DatabaseSheetsData | null }) {
  const [view, setView] = useState<"team" | "vakken" | "seizoen">("team");
  const tabs = [{ id: "team", label: "Team Insights", hint: "Aanval, verdediging en wedstrijdanalyse" }, { id: "vakken", label: "Vakken & combinaties", hint: "Viertallen, duo's en betrouwbaarheid" }, { id: "seizoen", label: "Seizoen", hint: "Ontwikkeling en trends door het seizoen" }] as const;
  return <div className="space-y-5"><div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 shadow-sm"><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-blue-600">KorbIQ Team Intelligence</div><h2 className="mt-1 text-2xl font-black">Team & Vakken</h2><p className="mt-1 max-w-4xl text-sm text-slate-500">Teamprestaties, vakcombinaties en seizoenstrends zijn samengebracht in één analyseomgeving.</p></div><AnalysisHubTabs<"team" | "vakken" | "seizoen"> tabs={tabs} active={view} onChange={setView} />{view === "team" && <InsightsTab state={state} spelersMap={spelersMap} opponentName={state.opponentName} dbSheets={dbSheets} forcedMode="team" />}{view === "vakken" && <VakcombinatiesDashboard dbSheets={dbSheets} spelers={state.spelers} />}{view === "seizoen" && <SeasonDashboard state={state} dbSheets={dbSheets} />}</div>;
}

function InsightsTab({
  state,
  spelersMap,
  opponentName,
  dbSheets,
  forcedMode,
  initialMatchId,
}: {
  state: AppState;
  spelersMap: Map<string, Player>;
  opponentName: string;
  dbSheets: { events: any[]; attacks: any[]; wissels: any[]; matches: any[] } | null;
  forcedMode?: "speler" | "team";
  initialMatchId?: string;
}) {
  const ACTIONS = ["Schot", "Doorloop", "Vrijebal", "Strafworp"] as const;
  type ActionKind = (typeof ACTIONS)[number];

  const [analysisMode, setAnalysisMode] = useState<"speler" | "team">(() => forcedMode ?? "speler");
  const [insightMatchId, setInsightMatchId] = useState<string>(() => initialMatchId ?? "__live__");
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

  useEffect(() => {
    if (forcedMode && analysisMode !== forcedMode) setAnalysisMode(forcedMode);
  }, [forcedMode, analysisMode]);

  const databaseMatches = dbSheets?.matches ?? [];
  const insightModeButtons = forcedMode ? null : (
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
        {databaseMatches.length > 0 && <option value="__all__">Alle wedstrijden</option>}
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
    const oppGoals = opp.filter((e:any) => e.uitkomst === "Raak").length;
    const goals = own.filter((e:any) => e.uitkomst === "Raak").length;
    const korf = own.filter((e:any) => e.uitkomst === "Korf").length;
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
      return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")} W${week}`;
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
      const w=560,h=225,left=54,right=18,top=16,bottom=78;
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
      return <div className="border rounded-2xl p-4 bg-white"><div className="font-bold">{title}</div><div className="text-xs text-gray-500 mb-2">{values.length?`Laatste: ${values[values.length-1].toFixed(isPercent?1:values[values.length-1] % 1 === 0 ? 0 : 1)}${suffix}${latestComparison!=null?` · ${comparisonLabel}: ${latestComparison.toFixed(isPercent?1:latestComparison % 1 === 0 ? 0 : 1)}${suffix}`:` · Gemiddeld: ${avg.toFixed(isPercent?1:avg % 1 === 0 ? 0 : 1)}${suffix}`}`:"Geen data"}</div><svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[225px]">{ticks.map((tick,i)=><g key={`yt-${i}`}><line x1={left} y1={y(tick)} x2={w-right} y2={y(tick)} stroke="#e5e7eb"/><text x={left-8} y={y(tick)+4} textAnchor="end" fontSize="10" fill="#6b7280">{isPercent?`${tick.toFixed(0)}%`:tick.toFixed(tick%1===0?0:1)}</text></g>)}{comparisonValues&&comparisonValues.length===values.length&&<polyline points={comparisonPts} fill="none" stroke="#2563eb" strokeWidth="2" strokeDasharray="6 5" strokeLinejoin="round" strokeLinecap="round"/>}{!comparisonValues&&values.length>0&&<line x1={left} y1={y(avg)} x2={w-right} y2={y(avg)} stroke="#94a3b8" strokeDasharray="5 5"/>}<line x1={left} y1={top} x2={left} y2={h-bottom} stroke="#d1d5db"/><polyline points={pts} fill="none" stroke="#64748b" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>{values.map((v,i)=><g key={i}><circle cx={x(i)} cy={y(v)} r="5" fill={pointIsGood(v,i)?"#16a34a":"#dc2626"} stroke="white" strokeWidth="1.5"/><text x={x(i)} y={h-bottom+10} textAnchor="end" fontSize="9" fill="#6b7280" transform={`rotate(-90 ${x(i)} ${h-bottom+10})`}>{labels?.[i] ?? `W${i+1}`}</text></g>)}</svg>{comparisonValues&&<div className="mt-1 flex items-center gap-2 text-xs text-gray-500"><span className="inline-block w-6 border-t-2 border-dashed border-blue-600"></span><span>{comparisonLabel}</span></div>}</div>
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
      const defensiveActions = playerEvents.filter((e:any) => {
        const vak = String(e.vak ?? "").toLowerCase();
        return vak.includes("verdedig") && (String(e.uitkomst ?? "") === "Verdedigd" || e.reden === "Schot afgevangen" || e.reden === "Pass Onderschept");
      }).length;
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
        defensiveActions,
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
              ? "Analyse op basis van de geselecteerde wedstrijdhistorie."
              : "Analyse van de geselecteerde wedstrijd."}
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
              const series = card.label === "Acties"
                ? { labels: playerPeriodTrend.map((m) => m.axisLabel), values: playerPeriodTrend.map((m) => m.attempts), comparisonValues: playerPeriodTrend.map((m) => m.teamAttemptsAvg), comparisonLabel: "Teamgem. per speler" }
                : card.label === "Doelpunten"
                  ? { labels: playerPeriodTrend.map((m) => m.axisLabel), values: playerPeriodTrend.map((m) => m.goals) }
                  : card.label === "Schotkwaliteit"
                    ? { labels: playerPeriodTrend.map((m) => m.axisLabel), values: playerPeriodTrend.map((m) => m.qualityPct), comparisonValues: playerPeriodTrend.map((m) => m.teamQualityPct), comparisonLabel: "Team", suffix: "%" }
                    : card.label === "Rebounds"
                      ? { labels: playerPeriodTrend.map((m) => m.axisLabel), values: playerPeriodTrend.map((m) => m.rebounds), comparisonValues: playerPeriodTrend.map((m) => m.teamReboundsAvg), comparisonLabel: "Teamgem. per speler" }
                      : { labels: playerPeriodTrend.map((m) => m.axisLabel), values: playerPeriodTrend.map((m) => m.defensiveActions) };
              return <MetricInsightCard key={card.label} label={card.label} value={card.value} metric={card.metric} benchmark={card.benchmark} sub={card.sub} series={series}/>;
            })}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{[
          {label:"Wedstrijden",value:selectedMatches.length,series:undefined,inverse:false},
          {label:"Kansen raak",value:own.length?`${scorePct.toFixed(1)}%`:"—",series:{labels:trend.map(m=>m.axisLabel),values:trend.map(m=>m.score),suffix:"%"},inverse:false},
          {label:"Korfgerichtheid",value:own.length?`${qualityPct.toFixed(1)}%`:"—",series:{labels:trend.map(m=>m.axisLabel),values:trend.map(m=>m.quality),suffix:"%"},inverse:false},
          {label:"Aanvallende rebounds gewonnen",value:rebounds+noRebounds?`${reboundPct.toFixed(0)}%`:"—",series:{labels:trend.map(m=>m.axisLabel),values:trend.map(m=>m.reboundPct),suffix:"%"},inverse:false},
          {label:"Kansen tegenstander raak",value:opp.length?`${oppPct.toFixed(1)}%`:"—",series:{labels:trend.map(m=>m.axisLabel),values:trend.map(m=>m.oppScore),suffix:"%"},inverse:true},
        ].map((card)=><MetricInsightCard key={card.label} label={card.label} value={card.value} series={card.series} inverse={card.inverse}/>)}</div>
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
      .map((id, index) => spelersMap.get(id)?.naam ?? (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? `Onbekende speler ${index + 1}` : id));
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

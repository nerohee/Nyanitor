// 고양이 목록(카탈로그)과 에이전트 연결 (docs/01-planning/cat-assets.md §A8 · §A9).
// 목록 = "어떤 고양이가 있고 자세 그림이 어느 파일인가", 연결 = "에이전트가 어느 고양이를 가리키나". 둘은 따로 둔다 (D-31).
import agentCatsJson from "../../assets/cats/agent-cats.json";
import catalogJson from "../../assets/cats/catalog.json";

export const CAT_IDS = ["mukmul", "nabi", "mulgam", "danchu", "kkaebi", "dubu", "gureum"] as const;
export type CatId = (typeof CAT_IDS)[number];

export const POSES = ["sit", "loaf", "sleep", "walk", "groom"] as const;
export type PoseName = (typeof POSES)[number];

/** 물건과 한 장으로 그린 합친 그림 — 자리(물건)마다 하나 (cat-assets.md §A8) */
export const WITH_KEYS = ["bowl", "cushion", "box", "ball", "tower", "wheel"] as const;
export type WithKey = (typeof WITH_KEYS)[number];

export interface PoseEntry {
  /** 순서대로 돌리는 그림 파일 (한 장이면 그대로 서 있음) */
  frames: readonly string[];
  /** 깜빡임 그림 (`sit` 만) */
  blink?: string;
}

export interface CatEntry {
  id: string;
  name: string;
  fur: string;
  /** 기본 자세 표시 배율 — 두부 0.85. 합친 그림에는 쓰지 않는다 */
  scale?: number;
  /** 맞춘 `sit` 그림에서 고양이가 차지하는 높이(px). 기본 자세에만 쓴다 */
  bodyHeight?: number;
  poses: Partial<Record<PoseName, PoseEntry>>;
  /** 합친 그림 (물건 자리용). 없는 물건 자리에는 가지 않는다 */
  with?: Partial<Record<WithKey, PoseEntry>>;
}

export interface Catalog {
  version: number;
  cats: readonly CatEntry[];
}

export interface AgentLinks {
  version: number;
  agents: Readonly<Record<string, string>>;
}

function readEntry(raw: unknown): PoseEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { frames, blink } = raw as { frames?: unknown; blink?: unknown };
  if (!Array.isArray(frames) || !frames.every((file) => typeof file === "string")) return null;
  return { frames: frames as string[], ...(typeof blink === "string" ? { blink } : {}) };
}

/**
 * 목록 파일(JSON)을 읽는다 — 모르는 자세 · 물건 이름은 무시한다.
 * `version: 1` 목록(1판 — `eat` · `back` · `play` · `run` 자세)은 `with` 없이 5가지 기본 자세만 읽어 사용자 고양이를 깨뜨리지 않는다.
 * 고양이 하나가 깨져 있으면(id · 이름 없음) 그 고양이만 건너뛴다.
 */
export function readCatalog(raw: unknown): Catalog {
  const source = raw as { version?: unknown; cats?: unknown };
  const cats: CatEntry[] = [];
  for (const item of Array.isArray(source?.cats) ? source.cats : []) {
    const cat = item as Record<string, unknown>;
    if (typeof cat?.id !== "string" || typeof cat.name !== "string") continue;
    const poses: Partial<Record<PoseName, PoseEntry>> = {};
    for (const pose of POSES) {
      const entry = readEntry((cat.poses as Record<string, unknown> | undefined)?.[pose]);
      if (entry) poses[pose] = entry;
    }
    const withArt: Partial<Record<WithKey, PoseEntry>> = {};
    if (source.version === 2) {
      for (const key of WITH_KEYS) {
        const entry = readEntry((cat.with as Record<string, unknown> | undefined)?.[key]);
        if (entry) withArt[key] = entry;
      }
    }
    cats.push({
      id: cat.id,
      name: cat.name,
      fur: typeof cat.fur === "string" ? cat.fur : "",
      ...(typeof cat.scale === "number" ? { scale: cat.scale } : {}),
      ...(typeof cat.bodyHeight === "number" ? { bodyHeight: cat.bodyHeight } : {}),
      poses,
      ...(Object.keys(withArt).length > 0 ? { with: withArt } : {}),
    });
  }
  return { version: typeof source?.version === "number" ? source.version : 1, cats };
}

export const DEFAULT_CATALOG: Catalog = readCatalog(catalogJson);
export const DEFAULT_LINKS: AgentLinks = agentCatsJson;

/** 연결이 모두 어긋났을 때 마지막으로 돌아가는 고양이 (D-37 — 오케스트레이터) */
export const FALLBACK_CAT: CatId = "mukmul";

/** 없는 자세는 앞에서부터 찾아 대신 쓴다 (cat-assets.md §A8). `sit` · `walk` 만 있어도 장면에 들어간다 */
const POSE_FALLBACK: Record<PoseName, readonly PoseName[]> = {
  sit: [],
  walk: ["sit"],
  loaf: ["sit"],
  groom: ["sit"],
  sleep: ["loaf", "sit"],
};

export interface ResolvedPose {
  /** 실제로 쓰는 자세 (대체가 일어났으면 요청한 것과 다르다) */
  pose: PoseName;
  frames: readonly string[];
  blink?: string;
}

/** 자세 그림을 찾는다. 없으면 대체 규칙대로. `sit` 도 없으면 null. */
export function resolvePose(cat: CatEntry, pose: PoseName): ResolvedPose | null {
  for (const candidate of [pose, ...POSE_FALLBACK[pose]]) {
    const entry = cat.poses[candidate];
    if (entry && entry.frames.length > 0) return { pose: candidate, frames: entry.frames, blink: entry.blink };
  }
  return null;
}

/** 그 고양이의 합친 그림. 없으면 null (그 물건 자리에는 가지 않는다) */
export function resolveWith(cat: CatEntry, key: WithKey): PoseEntry | null {
  const entry = cat.with?.[key];
  return entry && entry.frames.length > 0 ? entry : null;
}

/** 카탈로그에서 고양이 한 마리. 없으면 undefined */
export function findCat(id: string, catalog: Catalog = DEFAULT_CATALOG): CatEntry | undefined {
  return catalog.cats.find((cat) => cat.id === id);
}

/**
 * 에이전트 이름(메인 대화는 `main`)이 가리키는 고양이 id.
 * 사용자 연결 → 기본 연결 → `mukmul`. 가리킨 고양이가 목록에 없으면 한 단계 아래로 내려간다.
 */
export function catForAgent(
  agent: string,
  options: { user?: Readonly<Record<string, string>>; links?: AgentLinks; catalog?: Catalog } = {},
): string {
  const { user, links = DEFAULT_LINKS, catalog = DEFAULT_CATALOG } = options;
  const userCat = user?.[agent];
  if (userCat !== undefined && findCat(userCat, catalog)) return userCat;
  const defaultCat = links.agents[agent];
  if (defaultCat !== undefined && findCat(defaultCat, catalog)) return defaultCat;
  return FALLBACK_CAT;
}

const images = import.meta.glob<string>("../../assets/cats/*/*.webp", {
  query: "?url",
  import: "default",
  eager: true,
});

/** 그 고양이 폴더 안 그림 파일의 주소. 없으면 undefined */
export function catImageUrl(id: string, file: string): string | undefined {
  return images[`../../assets/cats/${id}/${file}`];
}

/** 맞춘 그림 판(512)의 발 기준점 (cat-assets.md §A3) */
export const PLATE = { size: 512, feetX: 256, feetY: 481 } as const;

/** 장면 축척의 기준 — 앉은 고양이 키 300px 인 세계 (cat-assets.md §A5) */
const REFERENCE_BODY_HEIGHT = 300;

/** 판 → 장면 배율에 곱하는 고양이별 배율 = (300 ÷ bodyHeight) × scale */
export function catScale(cat: CatEntry): number {
  return (REFERENCE_BODY_HEIGHT / (cat.bodyHeight ?? REFERENCE_BODY_HEIGHT)) * (cat.scale ?? 1);
}

// 브라우저(`npm run dev`)에서 채팅 입력줄의 스킬 고르기가 돌도록 하는 가짜 스킬 목록. Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/skills/`)와 같은 명령 · 결과 모양을 흉내 낸다. 실제 폴더는 건드리지 않는다.
// 목록은 시제품(`variants/fixtures-workspace.ts` 의 `SKILLS`)과 같은 여섯 줄이다 (하네스 다섯 + 내가 만든 것 하나). 문구는 `ko.ts` 의 `variant.fixture.skill.*`.
// 고르는 법은 기존 가짜(`fakeHouse.ts`)처럼 주소 쿼리:
//   ?skills=full (기본) · ?skills=no_harness (하네스 없음 = 빈 목록) · ?skills=broken (부를 수 없는 것 · 읽을 수 없는 것이 섞임)
// 시험은 `reset(...)` 로 쿼리 대신 값을 정한다.
import { t } from "../i18n/ko";
import type { SkillEntry, SkillInfo, SkillsList } from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;

export type FakeSkillsMode = "full" | "no_harness" | "broken";

const MODES: readonly FakeSkillsMode[] = ["full", "no_harness", "broken"];

/** 주소 쿼리 → 가짜 설정. 모르는 값은 기본값. */
export function parseFakeSkillsQuery(search: string): FakeSkillsMode {
  const value = new URLSearchParams(search).get("skills");
  return MODES.find((mode) => mode === value) ?? "full";
}

function skill(name: string, description: string, argumentHint: string | null, origin: SkillInfo["origin"], userInvocable = true): SkillEntry {
  return { state: "ok", name, command: `/${name}`, description, argumentHint, origin, userInvocable };
}

/** 폴더 이름 순 (진짜 목록과 같다) */
function fullSkills(): SkillEntry[] {
  return [
    skill("desktop-app", t("variant.fixture.skill.desktop"), "[요구사항.md 경로]", "harness"),
    skill("harness-resume", t("variant.fixture.skill.resume"), "[프로젝트 폴더 (비우면 지금 폴더)]", "harness"),
    skill("harness-setup", t("variant.fixture.skill.setup"), "[바꾸고 싶은 것]", "harness"),
    skill("translate-docs", t("variant.fixture.skill.translate"), null, "mine"),
    skill("web-full", t("variant.fixture.skill.webFull"), "[요구사항.md 경로]", "harness"),
    skill("web-lite", t("variant.fixture.skill.webLite"), "[요구사항.md 경로]", "harness"),
  ];
}

function skillsFor(mode: FakeSkillsMode): SkillsList {
  if (mode === "no_harness") return { state: "no_harness", skills: [] };
  if (mode === "broken") {
    return {
      state: "ok",
      skills: [
        ...fullSkills(),
        skill("internal-helper", "다른 스킬이 부르는 것", null, "mine", false),
        { state: "unreadable", folder: "half-written", origin: "mine", reason: "no_frontmatter" },
      ],
    };
  }
  return { state: "ok", skills: fullSkills() };
}

export function createFakeSkills() {
  /** 시험이 정한 값. 없으면 부를 때마다 주소 쿼리를 읽는다. */
  let override: FakeSkillsMode | null = null;
  const mode = (): FakeSkillsMode => override ?? parseFakeSkillsQuery(typeof window === "undefined" ? "" : window.location.search);

  const handlers: Record<string, Handler> = {
    skills_list: (): SkillsList => skillsFor(mode()),
  };

  return {
    handlers,
    /** 시험용: 쿼리 대신 값을 정한다 (인자 없이 부르면 다시 쿼리를 읽는다) */
    reset(next?: FakeSkillsMode) {
      override = next ?? null;
    },
  };
}

export const fakeSkills = createFakeSkills();

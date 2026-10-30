// 단계 승인 질문 글 읽기 (하네스 약속 §7-2) — 네 줄 · 빠진 칸 · 순서 다름 · 승인이 아닌 글.
import { describe, expect, it } from "vitest";
import { approvalChoiceOf, approvalLabel, parseApproval, plainLabel } from "./approval";

const FULL = [
  "단계 승인 — P4 하네스 설치 · 업데이트",
  "- 무엇을: 앱에서 하네스를 받아 설치하고 원본 업데이트를 미리 본다",
  "- 왜 지금: 고양이 집이 에이전트 목록을 읽기 전에 설치돼 있어야 한다",
  "- 산출물: 설치 화면, 미리보기, 백업 · 되돌리기",
  "- 하지 않는 것: 에이전트 · 스킬 편집 화면 (P9)",
].join("\n");

describe("parseApproval", () => {
  it("네 줄이 다 있으면 네 칸으로 읽는다", () => {
    expect(parseApproval(FULL)).toEqual({
      title: "단계 승인 — P4 하네스 설치 · 업데이트",
      phase: "P4",
      name: "하네스 설치 · 업데이트",
      what: "앱에서 하네스를 받아 설치하고 원본 업데이트를 미리 본다",
      why: "고양이 집이 에이전트 목록을 읽기 전에 설치돼 있어야 한다",
      outputs: "설치 화면, 미리보기, 백업 · 되돌리기",
      notDoing: "에이전트 · 스킬 편집 화면 (P9)",
    });
  });

  it("순서가 달라도 찾는다", () => {
    const shuffled = ["단계 승인 — P2 시안", "- 하지 않는 것: 구현", "- 산출물: 시안 셋", "- 왜 지금: 고르기 전에", "- 무엇을: 시안 만들기"].join("\n");
    expect(parseApproval(shuffled)).toMatchObject({ phase: "P2", name: "시안", what: "시안 만들기", why: "고르기 전에", outputs: "시안 셋", notDoing: "구현" });
  });

  it("빠진 칸은 null (읽을 수 없음) — 있는 칸은 읽는다", () => {
    const partial = ["단계 승인 — P5 고양이 집", "- 무엇을: 첫 화면", "- 산출물: 화면"].join("\n");
    expect(parseApproval(partial)).toMatchObject({ what: "첫 화면", why: null, outputs: "화면", notDoing: null });
  });

  it("값이 빈 칸도 읽을 수 없음, 같은 칸이 두 번이면 먼저 나온 것", () => {
    const text = ["단계 승인 — P1 시작", "- 무엇을:", "- 왜 지금: 처음", "- 왜 지금: 나중", "- 산출물: a", "- 하지 않는 것: b"].join("\n");
    expect(parseApproval(text)).toMatchObject({ what: null, why: "처음" });
  });

  it("줄 끝 \r · 앞 빈 줄 · 전각 콜론 · 이름 없는 단계도 읽는다", () => {
    const text = "\r\n단계 승인 — P7\r\n- 무엇을： 둥근 창문\r\n- 왜 지금: 진행\r\n- 산출물: 창\r\n- 하지 않는 것: 알림\r\n";
    expect(parseApproval(text)).toMatchObject({ phase: "P7", name: "", what: "둥근 창문", notDoing: "알림" });
  });

  it("승인 모양이 아니면 null — 첫 줄이 다름 · 네 줄이 하나도 없음 · 빈 글", () => {
    expect(parseApproval("어떤 색이 좋아요?")).toBeNull();
    expect(parseApproval("- 무엇을: 뭔가\n- 왜 지금: 그냥\n- 산출물: x\n- 하지 않는 것: y")).toBeNull();
    expect(parseApproval("단계 승인 — P4 하네스\n이 계획으로 시작할까요?")).toBeNull();
    expect(parseApproval("단계 승인")).toBeNull();
    expect(parseApproval("")).toBeNull();
  });
});

describe("선택지 이름", () => {
  const question = { question: FULL, header: "단계 승인", multiSelect: false, options: [{ label: "승인 (권장)", description: null, preview: null }, { label: "고쳐서 다시", description: null, preview: null }] };

  it("(권장) 을 떼고 같은 이름으로 본다 — 답은 질문의 선택지 이름 그대로 보낸다", () => {
    expect(plainLabel("승인 (권장)")).toBe("승인");
    expect(approvalLabel(question, "approve")).toBe("승인 (권장)");
    expect(approvalLabel(question, "redo")).toBe("고쳐서 다시");
    // 선택지에 없으면 이름 그대로
    expect(approvalLabel({ ...question, options: [] }, "approve")).toBe("승인");
  });

  it("답한 값이 승인 · 고쳐서 다시 · 직접 쓴 글 가운데 무엇인가", () => {
    expect(approvalChoiceOf("승인 (권장)")).toBe("approve");
    expect(approvalChoiceOf("승인")).toBe("approve");
    expect(approvalChoiceOf(["고쳐서 다시"])).toBe("redo");
    expect(approvalChoiceOf("P4 에 이름표도 넣어 주세요")).toBe("other");
    expect(approvalChoiceOf(undefined)).toBeNull();
  });
});

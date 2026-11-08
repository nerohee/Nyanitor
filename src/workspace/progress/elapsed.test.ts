import { describe, expect, it } from "vitest";
import { agoText, workedText } from "./elapsed";

const MIN = 60_000;

describe("지난 시간 표기 — 59분까지 분, 60분부터 시간", () => {
  it("일한 지", () => {
    expect(workedText(0, 59_999)).toBe("방금 시작했어요");
    expect(workedText(0, MIN)).toBe("1분째");
    expect(workedText(0, 59 * MIN + 59_999)).toBe("59분째");
    expect(workedText(0, 60 * MIN)).toBe("1시간째");
    expect(workedText(0, 119 * MIN)).toBe("1시간째");
    expect(workedText(0, 120 * MIN)).toBe("2시간째");
  });

  it("끝난 지", () => {
    expect(agoText(0, 30_000)).toBe("방금");
    expect(agoText(0, 59 * MIN)).toBe("59분 전");
    expect(agoText(0, 60 * MIN)).toBe("1시간 전");
    expect(agoText(0, 185 * MIN)).toBe("3시간 전");
  });
});

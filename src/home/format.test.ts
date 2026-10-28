import { describe, expect, it } from "vitest";
import { barPercent, formatAgo, formatReset, percentOf } from "./format";

/** 이 PC 의 시간대로 만든 시각 → 유닉스 초 */
function unix(y: number, mo: number, d: number, h: number, mi: number): number {
  return Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
}

describe("사용률", () => {
  it("0~1 을 % 로 반올림하고, 100% 를 넘기면 그대로 보이되 막대는 100 에서 멈춘다", () => {
    expect(percentOf(0.424)).toBe(42);
    expect(percentOf(0.426)).toBe(43);
    expect(percentOf(0)).toBe(0);
    expect(percentOf(1.05)).toBe(105);
    expect(barPercent(1.05)).toBe(100);
    expect(barPercent(0.18)).toBe(18);
  });

  it("음수 · 이상한 값도 0 아래로 내려가지 않는다", () => {
    expect(percentOf(-0.2)).toBe(0);
    expect(barPercent(-0.2)).toBe(0);
  });
});

describe("초기화 시각 — 사람 말", () => {
  const now = new Date(2026, 9, 28, 13, 20);

  it("같은 날은 오늘, 다음 날은 내일, 그 뒤는 날짜", () => {
    expect(formatReset(unix(2026, 10, 28, 15, 30), now)).toBe("오늘 오후 3:30");
    expect(formatReset(unix(2026, 10, 29, 9, 5), now)).toBe("내일 오전 9:05");
    expect(formatReset(unix(2026, 11, 2, 15, 30), now)).toBe("11월 2일 오후 3:30");
  });

  it("자정 · 정오는 12 시로", () => {
    expect(formatReset(unix(2026, 10, 29, 0, 0), now)).toBe("내일 오전 12:00");
    expect(formatReset(unix(2026, 10, 28, 12, 0), new Date(2026, 9, 28, 8, 0))).toBe("오늘 오후 12:00");
  });

  it("오늘이 끝나기 직전에 보아도 자정 넘은 시각은 내일", () => {
    expect(formatReset(unix(2026, 10, 29, 0, 30), new Date(2026, 9, 28, 23, 50))).toBe("내일 오전 12:30");
  });

  it("이미 지났으면 곧", () => {
    expect(formatReset(unix(2026, 10, 28, 13, 0), now)).toBe("곧");
    expect(formatReset(unix(2026, 10, 28, 13, 20), now)).toBe("곧");
  });
});

describe("읽은 때 — n분 전", () => {
  const now = new Date(2026, 9, 28, 13, 20);
  const nowSec = Math.floor(now.getTime() / 1000);

  it("방금 · 분 · 시간 · 일", () => {
    expect(formatAgo(nowSec - 20, now)).toBe("방금");
    expect(formatAgo(nowSec - 60, now)).toBe("1분 전");
    expect(formatAgo(nowSec - 5 * 60, now)).toBe("5분 전");
    expect(formatAgo(nowSec - 59 * 60, now)).toBe("59분 전");
    expect(formatAgo(nowSec - 60 * 60, now)).toBe("1시간 전");
    expect(formatAgo(nowSec - 5 * 3600, now)).toBe("5시간 전");
    expect(formatAgo(nowSec - 2 * 86400, now)).toBe("2일 전");
  });

  it("읽은 때가 미래(PC 시계 차이)여도 방금", () => {
    expect(formatAgo(nowSec + 300, now)).toBe("방금");
  });
});

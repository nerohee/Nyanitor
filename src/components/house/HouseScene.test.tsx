import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { FAKE_PLANS, staticPlacements } from "./schedule";
import { HouseScene } from "./HouseScene";
import { useCatPanel } from "./useCatPanel";

function zOf(element: HTMLElement): number {
  return Number(element.style.zIndex);
}

describe("고양이 집 장면", () => {
  it("7마리가 누를 수 있는 단추로 있고, 이름 · 역할 · 하는 일이 접근 이름이 된다", () => {
    const placements = staticPlacements(FAKE_PLANS[0]);
    const panel = { openCat: null, register: () => {}, toggle: () => {}, close: () => {} };
    render(<HouseScene time="day" label="고양이들" placements={placements} interaction={{ panel, renderPanel: () => null, bubbleLayer: null }} />);

    const scene = screen.getByRole("region", { name: "고양이들" });
    const cats = within(scene).getAllByRole("button");
    expect(cats).toHaveLength(7);
    expect(screen.getByRole("button", { name: "먹물, 오케스트레이터, 댓돌에서 사용자를 기다리는 중" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "단추, 화면 구현, 캣휠에서 일하는 중" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "구름, 점검, 캣타워에서 살피는 중" })).toBeInTheDocument();
  });

  it("깊이는 발 y 순서 — 댓돌의 먹물이 아래쪽 상자의 나비보다 앞이고, 캣타워 위 구름은 타워보다 앞", () => {
    const placements = staticPlacements(FAKE_PLANS[0]);
    const panel = { openCat: null, register: () => {}, toggle: () => {}, close: () => {} };
    render(<HouseScene time="day" label="고양이들" placements={placements} interaction={{ panel, renderPanel: () => null, bubbleLayer: null }} />);

    const z = (name: RegExp) => zOf(screen.getByRole("button", { name }));
    expect(z(/^먹물,/)).toBeGreaterThan(z(/^나비,/));
    expect(z(/^두부,/)).toBeLessThan(z(/^먹물,/));
    const towerZ = zOf(document.querySelector<HTMLElement>(".hs-prop--tower") as HTMLElement);
    expect(z(/^구름,/)).toBeGreaterThan(towerZ);
    // 앞 덤불은 모든 고양이보다 앞
    const bush = zOf(document.querySelector<HTMLElement>(".hs-prop--bush-front") as HTMLElement);
    for (const button of screen.getAllByRole("button")) expect(bush).toBeGreaterThan(zOf(button));
  });

  it("고양이가 달리면 캣휠이 돌고, 공을 치면 공이 구른다 — 그 자리에 없으면 멈춰 있다", () => {
    const { container, rerender } = render(<HouseScene time="day" placements={staticPlacements(FAKE_PLANS[0])} />);
    expect(container.querySelector(".hs-prop--wheel-ring")).toHaveAttribute("data-spin", "true");
    expect(container.querySelector(".hs-prop--ball")).toHaveAttribute("data-roll", "true");

    rerender(<HouseScene time="day" placements={staticPlacements(FAKE_PLANS[3])} />);
    expect(container.querySelector(".hs-prop--wheel-ring")).not.toHaveAttribute("data-spin");
  });

  it("장식으로만 쓰면 단추도 이름표도 없고 화면 읽기 프로그램에서 숨는다 (작업 공간의 창문)", () => {
    const { container } = render(<HouseScene time="night" placements={staticPlacements(FAKE_PLANS[0])} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(container.querySelector(".hs-tag")).toBeNull();
    expect(container.querySelector(".hs")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".hs")).toHaveAttribute("data-time", "night");
  });

  it("잘라 보기: 보여 줄 영역을 변수로 넘긴다", () => {
    const { container } = render(
      <HouseScene time="day" placements={[]} crop={{ x: 100, y: 200, w: 600, h: 450 }} />,
    );
    const root = container.querySelector<HTMLElement>(".hs") as HTMLElement;
    expect(root.style.getPropertyValue("--cw")).toBe("600");
    expect(root.style.getPropertyValue("--ch")).toBe("450");
    expect(root.style.getPropertyValue("--cx")).toBe("400");
    expect(root.style.getPropertyValue("--cy")).toBe("425");
  });

  it("상자의 고양이는 앞 테두리(V) 아래가 잘려 들어가 있는 모습 — 걸어 들어오는 동안은 몸이 다 보인다", () => {
    const sitting = staticPlacements(FAKE_PLANS[0]);
    const { container, rerender } = render(<HouseScene time="day" placements={sitting} />);
    const plate = () => container.querySelector<HTMLElement>('.hs-cat[data-cat="nabi"] .hs-cat__plate') as HTMLElement;
    expect(plate().style.clipPath).toContain("polygon(");

    rerender(
      <HouseScene time="day" placements={sitting.map((p) => (p.cat === "nabi" ? { ...p, pose: "walk", walking: true, walkMs: 1500 } : p))} />,
    );
    expect(plate().style.clipPath).toBe("");
  });

  it("정보 패널은 장면 밖 위층에 놓이고, 고양이를 누르면 열리고 다시 누르면 닫힌다", () => {
    function Harness() {
      const panel = useCatPanel();
      const [layer, setLayer] = useState<HTMLDivElement | null>(null);
      return (
        <div>
          <HouseScene
            time="day"
            label="고양이들"
            placements={staticPlacements(FAKE_PLANS[0])}
            interaction={{ panel, bubbleLayer: layer, renderPanel: (cat) => <p>패널 {cat}</p> }}
          />
          <div data-testid="layer" ref={setLayer} />
        </div>
      );
    }
    render(<Harness />);
    const nabi = screen.getByRole("button", { name: /^나비,/ });
    fireEvent.click(nabi);
    expect(within(screen.getByTestId("layer")).getByText("패널 nabi")).toBeInTheDocument();
    expect(nabi).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(nabi);
    expect(screen.queryByText("패널 nabi")).not.toBeInTheDocument();
  });
});

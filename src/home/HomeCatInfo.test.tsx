// 고양이 정보 패널 — 일하는 줄 · 단추 (쉬는 고양이는 예전 그대로).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeCatInfo, type HomeCatWork } from "./HomeCatInfo";

const home = { cat: "danchu" as const, entry: null };

function show(work?: HomeCatWork, activity: "wheel" | "box" | "stone" = "wheel") {
  return render(<HomeCatInfo home={home} activity={activity} work={work} onClose={() => undefined} />);
}

describe("HomeCatInfo — 맡은 일", () => {
  it("일하는 고양이 — 일하는 중, 프로젝트 · 맡은 일 · 일한 지, 진행 보기 단추", () => {
    const onOpen = vi.fn();
    show({ kind: "job", projectName: "고양이 앨범", description: "사진 목록 화면 만들기", worked: "3분째", onOpen });
    const panel = screen.getByRole("region", { name: "단추" });
    expect(panel.querySelector(".hm-info__state")).toHaveTextContent("일하는 중");
    expect(panel).toHaveTextContent("프로젝트고양이 앨범");
    expect(panel).toHaveTextContent("맡은 일사진 목록 화면 만들기");
    expect(panel).toHaveTextContent("일한 지3분째");
    fireEvent.click(screen.getByRole("button", { name: "진행 보기" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("설명이 없으면 맡은 일 줄이 없고, 프로젝트 이름을 모르면 그 줄도 없다", () => {
    show({ kind: "job", projectName: null, description: null, worked: "방금 시작했어요", onOpen: () => undefined });
    expect(screen.queryByText("맡은 일", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("프로젝트", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.getByText("방금 시작했어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "진행 보기" })).toBeInTheDocument();
  });

  it("먹물이 댓돌에서 기다릴 때 — 기다리는 중, 카드 수, 채팅에서 보기 단추", () => {
    const onOpen = vi.fn();
    show({ kind: "waiting", projectName: "레시피 상자", count: 2, onOpen }, "stone");
    expect(document.querySelector(".hm-info__state")).toHaveTextContent("기다리는 중");
    expect(screen.getByText("답을 기다리는 카드")).toBeInTheDocument();
    expect(screen.getByText("2개")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "진행 보기" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "채팅에서 보기" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("쉬는 고양이는 예전 그대로 — 쉬는 중, 일 줄 · 단추 없음", () => {
    show(undefined, "box");
    expect(document.querySelector(".hm-info__state")).toHaveTextContent("쉬는 중");
    expect(screen.queryByRole("button", { name: /진행 보기|채팅에서 보기/ })).not.toBeInTheDocument();
    expect(screen.queryByText("일한 지")).not.toBeInTheDocument();
  });
});

// 접근성 검사 — axe. 밝은 테마가 기본이고, 어두운 테마는 `:root[data-theme="dark"]` (tokens.css 가 강제로 받는 속성) 로 바꿔 한 번 더 본다.
import AxeBuilder from "@axe-core/webdriverio";
import { browser } from "@wdio/globals";

export interface Violation {
  id: string;
  impact: string | null | undefined;
  help: string;
  nodes: string[];
}

/** 지금 화면의 axe 위반 목록. 검사가 실제로 돌았는지 (통과한 규칙이 있는지) 도 확인한다 — 안 돌았는데 "위반 없음" 이 되지 않게. */
export async function axeViolations(): Promise<Violation[]> {
  const results = await new AxeBuilder({ client: browser }).analyze();
  if (results.passes.length === 0) throw new Error("axe 가 아무 규칙도 돌리지 못했다");
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));
}

async function setTheme(theme: "light" | "dark" | null): Promise<void> {
  await browser.execute((value) => {
    if (value === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  }, theme);
}

/** 밝은 테마 · 어두운 테마 각각의 위반 (테마는 검사 뒤 원래대로) */
export async function axeBothThemes(): Promise<{ light: Violation[]; dark: Violation[] }> {
  await setTheme("light");
  const light = await axeViolations();
  await setTheme("dark");
  try {
    const dark = await axeViolations();
    return { light, dark };
  } finally {
    await setTheme(null);
  }
}

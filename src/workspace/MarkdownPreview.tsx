// 마크다운 미리보기 — 안전이 먼저다 (요구사항 파일은 남이 쓴 글일 수도 있다).
//   - 마크다운 안의 HTML(`<script>` · `<img>` 등)은 그리지 않고 글자 그대로 보인다 (`react-markdown` 은 `rehype-raw` 가 없으면 HTML 을 이스케이프한다 — 일부러 더하지 않는다).
//   - 이미지는 불러오지 않는다 (`<img>` 를 만들지 않고 그림 설명 글자만) — 원격 주소로 나가는 요청이 없다.
//   - 링크는 앱 안에서 이동하지 않는다 (`<a href>` 를 만들지 않고 글자만 — 주소는 풍선말로). 밖에서 열기는 나중.
//   - 표 · 체크 목록 · 지운 글 · 맨 주소는 GFM(`remark-gfm`)으로 읽는다 — 하네스 문서는 표가 많다 (P7, 2026-11-07 고객). 맨 주소도 위 링크 규칙대로 글자만.
//     넓은 표는 그 칸 안에서만 가로로 밀어 본다 (화면 전체가 옆으로 밀리지 않게) — 키보드로도 밀 수 있게 포커스를 받는다.
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { t, tf } from "../i18n/ko";

const components: Components = {
  img: ({ alt }) => <span className="ws-md__img">{tf("ws.preview.image", { alt: alt?.trim() || "…" })}</span>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <span className="ws-md__link" title={href || undefined}>
      {children}
    </span>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="ws-md__table" tabIndex={0} role="region" aria-label={t("ws.preview.table")}>
      <table>{children}</table>
    </div>
  ),
};

const plugins = [remarkGfm];

export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="ws-md selectable">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

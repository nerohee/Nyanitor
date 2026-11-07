// 문서 목록을 폴더별로 묶는다 (순수 함수) — 폴더는 이름 순(바로 아래 문서가 맨 위), 문서도 이름 순 (숫자는 크기 순: P2 < P10).
import type { DocFile } from "../../lib/ipc-types";

export interface DocItem extends DocFile {
  /** 폴더를 뗀 파일 이름 */
  name: string;
}

export interface DocGroup {
  /** `docs/` 바로 아래면 빈 글, 아니면 `01-planning/design` 처럼 끝 `/` 없는 폴더 경로 */
  dir: string;
  files: DocItem[];
}

const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

export function groupDocs(files: readonly DocFile[]): DocGroup[] {
  const groups = new Map<string, DocItem[]>();
  for (const file of files) {
    const cut = file.path.lastIndexOf("/");
    const dir = cut < 0 ? "" : file.path.slice(0, cut);
    const name = cut < 0 ? file.path : file.path.slice(cut + 1);
    const list = groups.get(dir);
    if (list) list.push({ ...file, name });
    else groups.set(dir, [{ ...file, name }]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : collator.compare(a, b)))
    .map(([dir, items]) => ({ dir, files: items.sort((a, b) => collator.compare(a.name, b.name)) }));
}

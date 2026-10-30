// 마크다운 편집기 — CodeMirror 6 (D-27). 마크다운 강조 · 줄바꿈 · 실행 취소. 한글 입력(IME) 조합은 CodeMirror 가 직접 다룬다 (글을 통째로 바꾸는 일은 조합 중에 하지 않는다 — 훅이 미룬다).
// 모양(색 · 글자 크기)은 `workspace.css` 의 토큰이 정한다 — 여기서는 어떤 글자가 어떤 부분인지만 클래스로 붙인다.
// Tab 은 칸 사이 이동 그대로 둔다 (들여쓰기 키로 가로채면 키보드만으로 편집기에서 나올 수 없다).
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { RequirementsDoc } from "./useRequirements";

export interface MarkdownEditorHandle {
  focus: () => void;
  /** 한글 같은 글자를 조합하는 중인가 */
  isComposing: () => boolean;
}

interface Props {
  doc: RequirementsDoc;
  /** 스크린 리더에 읽힐 이름 */
  label: string;
  readOnly?: boolean;
  onChange: (text: string) => void;
  handle?: Ref<MarkdownEditorHandle>;
}

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "ws-md-h ws-md-h1" },
  { tag: tags.heading2, class: "ws-md-h ws-md-h2" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: "ws-md-h ws-md-h3" },
  { tag: tags.processingInstruction, class: "ws-md-mark" },
  { tag: tags.strong, class: "ws-md-strong" },
  { tag: tags.emphasis, class: "ws-md-em" },
  { tag: tags.monospace, class: "ws-md-code" },
  { tag: tags.quote, class: "ws-md-quote" },
  { tag: [tags.link, tags.url], class: "ws-md-link" },
]);

const editable = new Compartment();

export function MarkdownEditor({ doc, label, readOnly = false, onChange, handle }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);

  useEffect(() => {
    onChangeRef.current = onChange;
    readOnlyRef.current = readOnly;
  });

  useImperativeHandle(handle, () => ({
    focus: () => view.current?.focus(),
    isComposing: () => view.current?.composing ?? false,
  }));

  // 글이 통째로 바뀔 때(처음 · 새로 읽음)만 상태를 새로 만든다 — 되돌리기 기록도 비운다
  useEffect(() => {
    const state = EditorState.create({
      doc: doc.text,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        syntaxHighlighting(markdownStyle),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }),
        editable.of(EditorState.readOnly.of(readOnlyRef.current)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    if (view.current) view.current.setState(state);
    else if (host.current) view.current = new EditorView({ state, parent: host.current });
  }, [doc, label]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(
    () => () => {
      view.current?.destroy();
      view.current = null;
    },
    [],
  );

  return <div className="ws-cm" ref={host} />;
}

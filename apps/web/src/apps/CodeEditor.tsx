import { useEffect, useRef } from "react";

type Props = {
  value: string;
  language: string;
  readOnly: boolean;
  onChange: (value: string) => void;
};

async function languageExtension(language: string) {
  switch (language.toLowerCase()) {
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "javascript":
    case "js":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "typescript":
    case "ts":
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: language.toLowerCase() === "tsx" });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "markdown":
    case "md":
      return (await import("@codemirror/lang-markdown")).markdown();
    default:
      return [];
  }
}

export function CodeEditor({ value, language, readOnly, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<import("codemirror").EditorView>();
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const applyingRef = useRef(false);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    let disposed = false;
    let view: import("codemirror").EditorView | undefined;
    void Promise.all([import("codemirror"), languageExtension(language)]).then(([cm, syntax]) => {
      if (disposed || !hostRef.current) return;
      const extensions = [
        cm.basicSetup,
        syntax,
        cm.EditorView.editable.of(!readOnly),
        cm.EditorView.lineWrapping,
        cm.EditorView.theme({
          "&": { height: "100%", backgroundColor: "transparent", fontSize: "12px" },
          ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", lineHeight: "1.5rem" },
          ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "rgb(100 116 139)" },
          ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgb(148 163 184 / 0.10)" },
          ".cm-focused": { outline: "none" },
        }),
        cm.EditorView.updateListener.of((update: Parameters<Parameters<typeof cm.EditorView.updateListener.of>[0]>[0]) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          valueRef.current = next;
          if (!applyingRef.current) onChangeRef.current(next);
        }),
      ];
      view = new cm.EditorView({ doc: valueRef.current, extensions, parent: hostRef.current });
      viewRef.current = view;
    });
    return () => { disposed = true; if (viewRef.current === view) viewRef.current = undefined; view?.destroy(); };
  }, [language, readOnly]);

  useEffect(() => {
    valueRef.current = value;
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      applyingRef.current = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      applyingRef.current = false;
    }
  }, [value]);

  return <div ref={hostRef} className="h-full min-h-[320px] overflow-hidden" aria-label="代码编辑器" />;
}

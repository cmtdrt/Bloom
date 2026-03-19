import "./App.css";
import { useEffect, useMemo, useState } from "preact/hooks";
import MarkdownIt from "markdown-it";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

type Mode = "single" | "split";
type SingleView = "edit" | "preview";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

function displayPath(path: string | null) {
  if (!path) return "";
  try {
    // Some Tauri flows return a URI (eg. file://...)
    const url = new URL(path);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ? last : path;
  } catch {
    const last = path.split("/").filter(Boolean).pop();
    return last ? last : path;
  }
}

export default function App() {
  const [mode, setMode] = useState<Mode>("single");
  const [singleView, setSingleView] = useState<SingleView>("edit");

  const [filePath, setFilePath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewHtml = useMemo(() => md.render(content || ""), [content]);

  const toggleMode = () => {
    setMode((prev) => (prev === "single" ? "split" : "single"));
  };

  const toggleSingleView = () => {
    setSingleView((prev) => (prev === "edit" ? "preview" : "edit"));
  };

  const openMarkdown = async () => {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!selected) return;

      const text = await readTextFile(selected);
      setFilePath(selected);
      setContent(text);
      setDirty(false);
      setSingleView("edit");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error(e);
    }
  };

  const saveMarkdown = async () => {
    setError(null);
    try {
      if (!filePath) {
        const selected = await save({
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
          defaultPath: "note.md",
        });
        if (!selected) return;
        await writeTextFile(selected, content);
        setFilePath(selected);
        setDirty(false);
        return;
      }

      await writeTextFile(filePath, content);
      setDirty(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error(e);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const modKey = isMac ? event.metaKey : event.ctrlKey;
      if (!modKey) return;

      const key = event.key.toLowerCase();
      if (key === "m") {
        event.preventDefault();
        toggleMode();
        return;
      }
      if (key === "i" && mode === "single") {
        event.preventDefault();
        toggleSingleView();
        return;
      }
      if (key === "s") {
        event.preventDefault();
        void saveMarkdown();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, filePath, content]);

  const showEditor = mode === "split" || singleView === "edit";
  const showPreview = mode === "split" || singleView === "preview";

  return (
    <div className="app">
      <div className="toolbar">
        <button type="button" onClick={() => void openMarkdown()}>
          Ouvrir…
        </button>
        <button type="button" onClick={() => void saveMarkdown()} disabled={!dirty && !filePath}>
          Enregistrer
        </button>

        <div className="toolbarSpacer" />

        <button type="button" onClick={toggleMode} className="modeButton">
          Mode: {mode === "single" ? "Single" : "Split"}
        </button>
        <button
          type="button"
          onClick={toggleSingleView}
          className="modeButton"
          disabled={mode !== "single"}
          aria-disabled={mode !== "single"}
        >
          Vue: {singleView === "edit" ? "Édition" : "Preview"}
        </button>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="fileInfo">
        <span className="filePath">{displayPath(filePath)}</span>
        {dirty ? <span className="dirty">Modifié</span> : null}
      </div>

      <div className={mode === "split" ? "splitLayout" : "singleLayout"}>
        {showEditor ? (
          <textarea
            className={mode === "split" ? "editor editorSplit" : "editor editorSingle"}
            value={content}
            onInput={(e) => {
              setContent((e.target as HTMLTextAreaElement).value);
              setDirty(true);
            }}
            placeholder={"Commencez à écrire votre Markdown…"}
          />
        ) : null}

        {showPreview ? (
          <div
            className={mode === "split" ? "preview previewSplit" : "preview previewSingle"}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : null}
      </div>
    </div>
  );
}

import "./App.css";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import MarkdownIt from "markdown-it";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { menu as tauriMenu } from "@tauri-apps/api";
import type { CheckMenuItem, MenuItem } from "@tauri-apps/api/menu";

type Mode = "single" | "split";
type SingleView = "edit" | "preview";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

function basenameFromTauriPath(path: string | null) {
  if (!path) return "";
  // Some Tauri flows return a URI (eg. file://...)
  try {
    const url = new URL(path);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ?? path;
  } catch {
    const last = path.split("/").filter(Boolean).pop();
    return last ?? path;
  }
}

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mode, setMode] = useState<Mode>("single");
  const [singleView, setSingleView] = useState<SingleView>("edit");

  const [filePath, setFilePath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewHtml = useMemo(() => md.render(content || ""), [content]);
  const previewElRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const filePathRef = useRef<string | null>(null);
  const contentRef = useRef<string>("");
  const dirtyRef = useRef(false);
  useEffect(() => {
    filePathRef.current = filePath;
    contentRef.current = content;
    dirtyRef.current = dirty;
  }, [filePath, content, dirty]);

  const menuInitRef = useRef(false);
  const saveMenuItemRef = useRef<MenuItem | null>(null);
  const singleMenuItemRef = useRef<CheckMenuItem | null>(null);
  const splitMenuItemRef = useRef<CheckMenuItem | null>(null);

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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error(e);
    }
  };

  const saveMarkdown = async () => {
    setError(null);
    try {
      const currentPath = filePathRef.current;
      const currentContent = contentRef.current;

      if (!currentPath) {
        const selected = await save({
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
          defaultPath: "note.md",
        });
        if (!selected) return;
        await writeTextFile(selected, currentContent);
        setFilePath(selected); // persist actual path for subsequent saves
        setDirty(false);
        return;
      }

      await writeTextFile(currentPath, currentContent);
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
      if (key === "o") {
        event.preventDefault();
        void openMarkdown();
        return;
      }
      if (key === "s") {
        event.preventDefault();
        void saveMarkdown();
        return;
      }
      if (key === "m") {
        event.preventDefault();
        setMode((prev) => (prev === "single" ? "split" : "single"));
        return;
      }
      if (key === "i") {
        event.preventDefault();
        setSingleView((prev) => (mode === "single" ? (prev === "edit" ? "preview" : "edit") : prev));
        return;
      }
      if (key === "t") {
        event.preventDefault();
        setTheme((prev) => (prev === "dark" ? "light" : "dark"));
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

  // Single/Split + Open/Save via le menu Tauri (File / View).
  useEffect(() => {
    if (menuInitRef.current) return;
    menuInitRef.current = true;

    const init = async () => {
      try {
        const openItem = await tauriMenu.MenuItem.new({
          id: "file_open",
          text: "Ouvrir…",
          action: () => {
            void openMarkdown();
          },
        });

        const saveItem = await tauriMenu.MenuItem.new({
          id: "file_save",
          text: "Enregistrer",
          enabled: false,
          action: () => {
            void saveMarkdown();
          },
        });
        saveMenuItemRef.current = saveItem;

        const singleItem = await tauriMenu.CheckMenuItem.new({
          id: "view_single",
          text: "Single",
          checked: mode === "single",
          action: () => {
            setMode("single");
          },
        });
        singleMenuItemRef.current = singleItem;

        const splitItem = await tauriMenu.CheckMenuItem.new({
          id: "view_split",
          text: "Split",
          checked: mode === "split",
          action: () => {
            setMode("split");
          },
        });
        splitMenuItemRef.current = splitItem;

        const fileMenu = await tauriMenu.Submenu.new({
          id: "menu_file",
          text: "File",
          items: [openItem, saveItem],
        });

        const viewMenu = await tauriMenu.Submenu.new({
          id: "menu_view",
          text: "View",
          items: [singleItem, splitItem],
        });

        // Sur macOS, le menu est global (app-wide).
        const appMenu = await tauriMenu.Menu.new({
          id: "app_menu",
          items: [fileMenu, viewMenu],
        });
        await appMenu.setAsAppMenu();
      } catch (e) {
        console.error("Failed to init Tauri menu", e);
      }
    };

    void init();
  }, []);

  useEffect(() => {
    if (singleMenuItemRef.current) {
      void singleMenuItemRef.current.setChecked(mode === "single");
    }
    if (splitMenuItemRef.current) {
      void splitMenuItemRef.current.setChecked(mode === "split");
    }
    if (saveMenuItemRef.current) {
      void saveMenuItemRef.current.setEnabled(filePathRef.current !== null);
    }
  }, [mode, filePath, dirty]);

  const title = basenameFromTauriPath(filePath) || "Aucun document";

  const showEditor = mode === "split" || (mode === "single" && singleView === "edit");
  const showPreview = mode === "split" || (mode === "single" && singleView === "preview");

  useEffect(() => {
    if (!showPreview) return;
    if (!previewElRef.current) return;
    previewElRef.current.innerHTML = previewHtml;
  }, [previewHtml, showPreview]);

  return (
    <div className="app">
      {error ? <div className="error">{error}</div> : null}

      <div className="doc">
        <div className="docTitle">{title}</div>

        {mode === "split" ? (
          <div className="splitLayout">
            {showEditor ? (
              <textarea
                className="editor editorSplit"
                value={content}
                onInput={(e) => {
                  setContent((e.target as HTMLTextAreaElement).value);
                  setDirty(true);
                }}
                placeholder={"Commencez à écrire votre Markdown…"}
              />
            ) : null}
            {showPreview ? <div ref={previewElRef} className="preview previewSplit" /> : null}
          </div>
        ) : (
          <div className="singleLayout">
            {showEditor ? (
              <textarea
                className="editor editorSingle"
                value={content}
                onInput={(e) => {
                  setContent((e.target as HTMLTextAreaElement).value);
                  setDirty(true);
                }}
                placeholder={"Commencez à écrire votre Markdown…"}
              />
            ) : null}
            {showPreview ? <div ref={previewElRef} className="preview previewSingle" /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

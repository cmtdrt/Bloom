import "./App.css";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import MarkdownIt from "markdown-it";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { menu as tauriMenu } from "@tauri-apps/api";
import type { CheckMenuItem, MenuItem } from "@tauri-apps/api/menu";

type Mode = "single" | "split";
type SingleView = "edit" | "preview";
const WORKSPACE_STORAGE_KEY = "bloom.workspace.files";
const UNTITLED_WORKSPACE_KEY = "__bloom_untitled__";

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
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);

  const previewHtml = useMemo(() => md.render(content || ""), [content]);
  const previewElRef = useRef<HTMLDivElement | null>(null);

  const addPathToWorkspace = (path: string) => {
    setWorkspaceFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
  };

  const createNewUntitled = () => {
    addPathToWorkspace(UNTITLED_WORKSPACE_KEY);
    setFilePath(null);
    setContent("");
    setDirty(false);
    setSingleView("edit");
    savedContentRef.current = "";
    historyRef.current.past = [];
    historyRef.current.future = [];
    if (historyRef.current.typingTimer) {
      clearTimeout(historyRef.current.typingTimer);
    }
    historyRef.current.typingTimer = null;
    historyRef.current.pendingPrev = null;
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setWorkspaceFiles(parsed.filter((item): item is string => typeof item === "string"));
      }
    } catch {
      // ignore malformed local storage values
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceFiles));
  }, [workspaceFiles]);

  useEffect(() => {
    const closeWorkspaceMenu = () => setWorkspaceMenu(null);
    window.addEventListener("click", closeWorkspaceMenu);
    window.addEventListener("resize", closeWorkspaceMenu);
    return () => {
      window.removeEventListener("click", closeWorkspaceMenu);
      window.removeEventListener("resize", closeWorkspaceMenu);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const filePathRef = useRef<string | null>(null);
  const contentRef = useRef<string>("");
  const dirtyRef = useRef(false);
  const savedContentRef = useRef<string>("");

  // Undo/Redo (Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y)
  const historyRef = useRef<{
    past: string[];
    future: string[];
    typingTimer: number | null;
    pendingPrev: string | null;
  }>({
    past: [],
    future: [],
    typingTimer: null,
    pendingPrev: null,
  });
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
      addPathToWorkspace(selected);
      setDirty(false);
      savedContentRef.current = text;
      historyRef.current.past = [];
      historyRef.current.future = [];
      if (historyRef.current.typingTimer) {
        clearTimeout(historyRef.current.typingTimer);
      }
      historyRef.current.typingTimer = null;
      historyRef.current.pendingPrev = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error(e);
    }
  };

  const showShortcuts = async () => {
    const isMac =
      /Mac|iPod|iPhone|iPad/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent || "");

    const mod = isMac ? "Cmd" : "Ctrl";
    const text = [
      `${mod} + O  : ouvrir un fichier .md`,
      `${mod} + S  : enregistrer (choisir un emplacement si nécessaire)`,
      `${mod} + N  : nouveau document untitled.md`,
      `${mod} + M  : toggle Single / Split`,
      `${mod} + I  : en Single, toggle Édition / Preview`,
      `${mod} + T  : toggle theme (dark / light)`,
      `${mod} + Z  : undo`,
      `${mod} + Shift + Z ou ${mod} + Y : redo`,
      `${mod} + C  : copier`,
      `${mod} + X  : couper`,
      "",
      "Astuce : clic droit sur un élément du workspace -> Close.",
    ].join("\n");

    await message(text, { title: "Shortcuts", kind: "info" });
  };

  const openWorkspaceFile = async (path: string) => {
    setError(null);
    try {
      if (path === UNTITLED_WORKSPACE_KEY) {
        createNewUntitled();
        return;
      }
      const text = await readTextFile(path);
      addPathToWorkspace(path);
      setFilePath(path);
      setContent(text);
      setDirty(false);
      savedContentRef.current = text;
      historyRef.current.past = [];
      historyRef.current.future = [];
      if (historyRef.current.typingTimer) {
        clearTimeout(historyRef.current.typingTimer);
      }
      historyRef.current.typingTimer = null;
      historyRef.current.pendingPrev = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error(e);
    }
  };

  const addFileToWorkspace = async () => {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!selected) return;
      addPathToWorkspace(selected);
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
          defaultPath: "untitled.md",
        });
        if (!selected) return;
        await writeTextFile(selected, currentContent);
        setFilePath(selected); // persist actual path for subsequent saves
        addPathToWorkspace(selected);
        setWorkspaceFiles((prev) => prev.filter((p) => p !== UNTITLED_WORKSPACE_KEY));
        setDirty(false);
        savedContentRef.current = currentContent;
        historyRef.current.past = [];
        historyRef.current.future = [];
        if (historyRef.current.typingTimer) {
          clearTimeout(historyRef.current.typingTimer);
        }
        historyRef.current.typingTimer = null;
        historyRef.current.pendingPrev = null;
        return;
      }

      await writeTextFile(currentPath, currentContent);
      setDirty(false);
      savedContentRef.current = currentContent;
      historyRef.current.past = [];
      historyRef.current.future = [];
      if (historyRef.current.typingTimer) {
        clearTimeout(historyRef.current.typingTimer);
      }
      historyRef.current.typingTimer = null;
      historyRef.current.pendingPrev = null;
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
      if (key === "n") {
        event.preventDefault();
        createNewUntitled();
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

      const active = document.activeElement;
      const isEditorFocused = active instanceof HTMLTextAreaElement;
      if (isEditorFocused && (key === "c" || key === "x")) {
        event.preventDefault();
        const cmd = key === "c" ? "copy" : "cut";
        try {
          document.execCommand(cmd);
        } catch (e) {
          console.error(e);
        }
        return;
      }

      if (isEditorFocused && key === "z" && !event.shiftKey) {
        if (historyRef.current.past.length === 0) return;
        event.preventDefault();
        if (historyRef.current.typingTimer) {
          clearTimeout(historyRef.current.typingTimer);
          historyRef.current.typingTimer = null;
        }
        historyRef.current.pendingPrev = null;

        const current = contentRef.current;
        historyRef.current.future.push(current);
        const prev = historyRef.current.past.pop()!;
        setContent(prev);
        setDirty(prev !== savedContentRef.current);
        return;
      }

      if (isEditorFocused && ((key === "z" && event.shiftKey) || key === "y")) {
        if (historyRef.current.future.length === 0) return;
        event.preventDefault();
        if (historyRef.current.typingTimer) {
          clearTimeout(historyRef.current.typingTimer);
          historyRef.current.typingTimer = null;
        }
        historyRef.current.pendingPrev = null;

        const current = contentRef.current;
        historyRef.current.past.push(current);
        const next = historyRef.current.future.pop()!;
        setContent(next);
        setDirty(next !== savedContentRef.current);
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

        const toggleThemeItem = await tauriMenu.MenuItem.new({
          id: "view_toggle_theme",
          text: "Toggle theme",
          accelerator: "CmdOrCtrl+T",
          action: () => {
            setTheme((prev) => (prev === "dark" ? "light" : "dark"));
          },
        });

        const fileMenu = await tauriMenu.Submenu.new({
          id: "menu_file",
          text: "File",
          items: [openItem, saveItem],
        });

        const viewMenu = await tauriMenu.Submenu.new({
          id: "menu_view",
          text: "View",
          items: [singleItem, splitItem, toggleThemeItem],
        });

        const shortcutsItem = await tauriMenu.MenuItem.new({
          id: "menu_shortcuts_show",
          text: "Keyboard shortcuts",
          action: () => {
            void showShortcuts();
          },
        });

        const shortcutsMenu = await tauriMenu.Submenu.new({
          id: "menu_shortcuts",
          text: "Shortcuts",
          items: [shortcutsItem],
        });

        // Sur macOS, le menu est global (app-wide).
        const appMenu = await tauriMenu.Menu.new({
          id: "app_menu",
          items: [fileMenu, viewMenu, shortcutsMenu],
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

  const title = basenameFromTauriPath(filePath) || "untitled.md";

  const showEditor = mode === "split" || (mode === "single" && singleView === "edit");
  const showPreview = mode === "split" || (mode === "single" && singleView === "preview");

  useEffect(() => {
    if (!showPreview) return;
    if (!previewElRef.current) return;
    previewElRef.current.innerHTML = previewHtml;
  }, [previewHtml, showPreview]);

  return (
    <div className="app">
      <aside className={workspaceOpen ? "workspace workspaceOpen" : "workspace workspaceClosed"}>
        <button
          type="button"
          className="workspaceBurger"
          aria-label="Toggle workspace"
          onClick={() => setWorkspaceOpen((prev) => !prev)}
        >
          <span className="burgerIcon">☰</span>
        </button>

        {workspaceOpen ? (
          <div className="workspaceBody">
            <div className="workspaceHeader">
              <div className="workspaceTitle">Workspace</div>
              <button
                type="button"
                className="workspaceAddBtn"
                aria-label="Add file to workspace"
                onClick={() => void addFileToWorkspace()}
              >
                +
              </button>
            </div>
            <div className="workspaceList">
              {workspaceFiles.map((path) => (
                <button
                  key={path}
                  type="button"
                  className={
                    path === filePath || (path === UNTITLED_WORKSPACE_KEY && filePath === null)
                      ? "workspaceItem active"
                      : "workspaceItem"
                  }
                  onClick={() => void openWorkspaceFile(path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setWorkspaceMenu({ path, x: e.clientX, y: e.clientY });
                  }}
                >
                  {path === UNTITLED_WORKSPACE_KEY ? "untitled.md" : basenameFromTauriPath(path)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </aside>

      {workspaceMenu ? (
        <div
          className="workspaceContextMenu"
          style={{ left: `${workspaceMenu.x}px`, top: `${workspaceMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setWorkspaceFiles((prev) => prev.filter((p) => p !== workspaceMenu.path));
              setWorkspaceMenu(null);
            }}
          >
            Close
          </button>
        </div>
      ) : null}

      <main className="mainPane">
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
                    const next = (e.target as HTMLTextAreaElement).value;
                    const prev = contentRef.current;

                    setContent(next);
                    setDirty(next !== savedContentRef.current);

                    if (historyRef.current.pendingPrev === null) {
                      if (historyRef.current.past.length === 0 || historyRef.current.past[historyRef.current.past.length - 1] !== prev) {
                        historyRef.current.past.push(prev);
                      }
                      historyRef.current.future = [];
                      historyRef.current.pendingPrev = prev;
                    }

                    if (historyRef.current.typingTimer) {
                      clearTimeout(historyRef.current.typingTimer);
                    }
                    historyRef.current.typingTimer = window.setTimeout(() => {
                      historyRef.current.pendingPrev = null;
                      historyRef.current.typingTimer = null;
                    }, 500);
                  }}
                  placeholder={"Start typing your Markdown…"}
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
                    const next = (e.target as HTMLTextAreaElement).value;
                    const prev = contentRef.current;

                    setContent(next);
                    setDirty(next !== savedContentRef.current);

                    if (historyRef.current.pendingPrev === null) {
                      if (historyRef.current.past.length === 0 || historyRef.current.past[historyRef.current.past.length - 1] !== prev) {
                        historyRef.current.past.push(prev);
                      }
                      historyRef.current.future = [];
                      historyRef.current.pendingPrev = prev;
                    }

                    if (historyRef.current.typingTimer) {
                      clearTimeout(historyRef.current.typingTimer);
                    }
                    historyRef.current.typingTimer = window.setTimeout(() => {
                      historyRef.current.pendingPrev = null;
                      historyRef.current.typingTimer = null;
                    }, 500);
                  }}
                  placeholder={"Start typing your Markdown…"}
                />
              ) : null}
              {showPreview ? <div ref={previewElRef} className="preview previewSingle" /> : null}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

import "./App.css";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import MarkdownIt from "markdown-it";
import { confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readDir, readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { menu as tauriMenu } from "@tauri-apps/api";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as pathApi from "@tauri-apps/api/path";
import JSZip from "jszip";
import type { CheckMenuItem, MenuItem } from "@tauri-apps/api/menu";

type Mode = "single" | "split";
type SingleView = "edit" | "preview";
const WORKSPACE_STORAGE_KEY = "bloom.workspace.files";
const UNTITLED_WORKSPACE_KEY = "__bloom_untitled__";
const BLOOM_DOC_NAME = "document.md";
const BLOOM_ASSETS_DIR = "assets";

type DocumentKind = "untitled" | "md" | "bloom";
type DocumentMeta = {
  kind: DocumentKind;
  // Directory used to resolve relative assets in preview (absolute path).
  baseDir?: string;
  // Local staging dir for assets for this document (absolute path).
  assetsDir?: string;
  // List of asset filenames stored under assetsDir / assets/ (e.g. ["img.png"]).
  assetFiles: string[];
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

// Render markdown and rewrite local image URLs to something the webview can load.
const defaultImageRenderer =
  md.renderer.rules.image ??
  ((tokens: any, idx: any, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));

md.renderer.rules.image = (tokens: any, idx: any, options: any, env: any, self: any) => {
  const token = tokens[idx];
  const srcIdx = token.attrIndex("src");
  if (srcIdx >= 0) {
    const src = token.attrs?.[srcIdx]?.[1] ?? "";
    const baseDir = (env as { baseDir?: string } | undefined)?.baseDir;
    if (baseDir && src && !/^(https?:|data:|blob:|file:)/i.test(src)) {
      const normalized = src.replace(/^\.?\//, "");
      const resolved = `${baseDir}/${normalized}`.replace(/\/+/g, "/");
      token.attrs![srcIdx][1] = convertFileSrc(resolved);
    }
  }
  return defaultImageRenderer(tokens, idx, options, env, self);
};

function renderMarkdownWithBaseDir(text: string, baseDir?: string) {
  return md.render(text || "", { baseDir });
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isBloomPath(p: string) {
  return p.toLowerCase().endsWith(".bloom");
}

function isMarkdownPath(p: string) {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function basenameFromPath(path: string | null) {
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
    kind: "context" | "more";
  } | null>(null);

  const [docMeta, setDocMeta] = useState<DocumentMeta>({
    kind: "untitled",
    assetFiles: [],
  });

  const previewHtml = useMemo(
    () => renderMarkdownWithBaseDir(content || "", docMeta.baseDir),
    [content, docMeta.baseDir]
  );
  const previewElRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const addPathToWorkspace = (path: string) => {
    setWorkspaceFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
  };

  const ensureTempDocDirs = async () => {
    // Use AppData/Bloom for staging extracted bloom + pasted images.
    const appData = await pathApi.appDataDir();
    const root = await pathApi.join(appData, "Bloom");
    const docsRoot = await pathApi.join(root, "docs");
    await mkdir(root, { recursive: true });
    await mkdir(docsRoot, { recursive: true });
    return { root, docsRoot };
  };

  const insertTextAtCursor = (text: string) => {
    const el = editorRef.current;
    if (!el) return;
    const prev = contentRef.current;
    const start = el.selectionStart ?? prev.length;
    const end = el.selectionEnd ?? prev.length;
    const next = prev.slice(0, start) + text + prev.slice(end);
    setContent(next);
    setDirty(next !== savedContentRef.current);
    requestAnimationFrame(() => {
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
      el.focus();
    });
  };

  const ensureAssetsDir = async (): Promise<{ baseDir: string; assetsDir: string }> => {
    if (docMeta.baseDir && docMeta.assetsDir) return { baseDir: docMeta.baseDir, assetsDir: docMeta.assetsDir };
    const { docsRoot } = await ensureTempDocDirs();
    const id = randomId();
    const baseDir = await pathApi.join(docsRoot, id);
    const assetsDir = await pathApi.join(baseDir, BLOOM_ASSETS_DIR);
    await mkdir(assetsDir, { recursive: true });
    setDocMeta((prev) => ({ ...prev, baseDir, assetsDir }));
    return { baseDir, assetsDir };
  };

  const createNewUntitledAsync = async () => {
    addPathToWorkspace(UNTITLED_WORKSPACE_KEY);
    const { docsRoot } = await ensureTempDocDirs();
    const id = randomId();
    const baseDir = await pathApi.join(docsRoot, id);
    const assetsDir = await pathApi.join(baseDir, BLOOM_ASSETS_DIR);
    await mkdir(assetsDir, { recursive: true });

    setDocMeta({ kind: "untitled", baseDir, assetsDir, assetFiles: [] });
    setFilePath(null);
    setContent("");
    setDirty(false);
    setSingleView("edit");
    savedContentRef.current = "";
    historyRef.current.past = [];
    historyRef.current.future = [];
    if (historyRef.current.typingTimer) clearTimeout(historyRef.current.typingTimer);
    historyRef.current.typingTimer = null;
    historyRef.current.pendingPrev = null;
  };

  const createNewUntitled = () => {
    void createNewUntitledAsync();
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

  const convertCurrentMdToBloom = async (): Promise<string | null> => {
    if (!filePathRef.current) return null;
    const current = filePathRef.current;
    if (!isMarkdownPath(current)) return null;
    const dir = await pathApi.dirname(current);
    const base = basenameFromPath(current).replace(/\.(md|markdown)$/i, "");
    const defaultBloomPath = await pathApi.join(dir, `${base}.bloom`);

    const target = await save({
      filters: [{ name: "Bloom", extensions: ["bloom"] }],
      defaultPath: defaultBloomPath,
    });
    if (!target) return null;

    const mdText = contentRef.current;
    const { assetsDir } = await ensureAssetsDir();

    const zip = new JSZip();
    zip.file(BLOOM_DOC_NAME, mdText);
    zip.folder(BLOOM_ASSETS_DIR); // create empty assets folder
    // If there are already staged assets (rare for md), include them.
    const entries = await readDir(assetsDir);
    for (const entry of entries) {
      if (!entry.isFile) continue;
      const name = entry.name;
      if (!name) continue;
      const data = await readFile(await pathApi.join(assetsDir, name));
      zip.file(`${BLOOM_ASSETS_DIR}/${name}`, data);
    }
    const out = await zip.generateAsync({ type: "uint8array" });
    await writeFile(target, out);

    // Update current doc to be bloom
    setFilePath(target);
    setDocMeta((prev) => ({ ...prev, kind: "bloom" }));
    savedContentRef.current = mdText;
    setDirty(false);

    // Workspace: replace path
    setWorkspaceFiles((prev) => prev.map((p) => (p === current ? target : p)));
    addPathToWorkspace(target);
    return target;
  };

  const convertWorkspaceMdToBloom = async (mdPath: string): Promise<string | null> => {
    if (!isMarkdownPath(mdPath)) return null;
    const dir = await pathApi.dirname(mdPath);
    const base = basenameFromPath(mdPath).replace(/\.(md|markdown)$/i, "");
    const defaultBloomPath = await pathApi.join(dir, `${base}.bloom`);

    const target = await save({
      filters: [{ name: "Bloom", extensions: ["bloom"] }],
      defaultPath: defaultBloomPath,
    });
    if (!target) return null;

    const mdText = mdPath === filePathRef.current ? contentRef.current : await readTextFile(mdPath);
    const zip = new JSZip();
    zip.file(BLOOM_DOC_NAME, mdText);
    zip.folder(BLOOM_ASSETS_DIR);
    const out = await zip.generateAsync({ type: "uint8array" });
    await writeFile(target, out);

    setWorkspaceFiles((prev) => prev.map((p) => (p === mdPath ? target : p)));
    addPathToWorkspace(target);

    if (mdPath === filePathRef.current) {
      setFilePath(target);
      setDocMeta((prev) => ({ ...prev, kind: "bloom" }));
      savedContentRef.current = mdText;
      setDirty(false);
    }

    return target;
  };

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
        filters: [
          { name: "Bloom", extensions: ["bloom"] },
          { name: "Markdown", extensions: ["md", "markdown"] },
        ],
      });
      if (!selected) return;

      addPathToWorkspace(selected);

      if (isBloomPath(selected)) {
        const bytes = await readFile(selected);
        const zip = await JSZip.loadAsync(bytes);
        const mdFile = zip.file(BLOOM_DOC_NAME);
        const mdText = mdFile ? await mdFile.async("string") : "";

        const { docsRoot } = await ensureTempDocDirs();
        const id = randomId();
        const baseDir = await pathApi.join(docsRoot, id);
        const assetsDir = await pathApi.join(baseDir, BLOOM_ASSETS_DIR);
        await mkdir(assetsDir, { recursive: true });

        const assetFiles: string[] = [];
        const prefix = `${BLOOM_ASSETS_DIR}/`;
        for (const name of Object.keys(zip.files)) {
          if (!name.startsWith(prefix)) continue;
          if (zip.files[name].dir) continue;
          const rel = name.slice(prefix.length);
          if (!rel) continue;
          const data = await zip.files[name].async("uint8array");
          await writeFile(await pathApi.join(assetsDir, rel), data);
          assetFiles.push(rel);
        }

        setDocMeta({ kind: "bloom", baseDir, assetsDir, assetFiles });
        setFilePath(selected);
        setContent(mdText);
        setDirty(false);
        savedContentRef.current = mdText;
      } else {
        const text = await readTextFile(selected);
        const baseDir = await pathApi.dirname(selected);
        setDocMeta({ kind: "md", baseDir, assetsDir: undefined, assetFiles: [] });
        setFilePath(selected);
        setContent(text);
        setDirty(false);
        savedContentRef.current = text;
      }
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
      `${mod} + O  : open a Markdown file`,
      `${mod} + S  : save the current Markdown file`,
      `${mod} + N  : create a new untitled.md document`,
      `${mod} + M  : toggle Single / Split`,
      `${mod} + I  : in Single, toggle Edit / Preview`,
      `${mod} + T  : toggle theme (dark / light)`,
      `${mod} + 1  : set current line(s) to # heading`,
      `${mod} + 2  : set current line(s) to ## heading`,
      `${mod} + 3  : set current line(s) to ### heading`,
      `${mod} + Z  : undo`,
      `${mod} + Shift + Z or ${mod} + Y : redo`,
      `${mod} + C  : copy`,
      `${mod} + X  : cut`,
      "",
      "Tip: right-click a Workspace item -> Close (remove it from the workspace).",
    ].join("\n");

    await message(text, { title: "Help", kind: "info" });
  };

  const openWorkspaceFile = async (path: string) => {
    setError(null);
    try {
      if (path === UNTITLED_WORKSPACE_KEY) {
        createNewUntitled();
        return;
      }
      addPathToWorkspace(path);

      if (isBloomPath(path)) {
        const bytes = await readFile(path);
        const zip = await JSZip.loadAsync(bytes);
        const mdFile = zip.file(BLOOM_DOC_NAME);
        const mdText = mdFile ? await mdFile.async("string") : "";

        const { docsRoot } = await ensureTempDocDirs();
        const id = randomId();
        const baseDir = await pathApi.join(docsRoot, id);
        const assetsDir = await pathApi.join(baseDir, BLOOM_ASSETS_DIR);
        await mkdir(assetsDir, { recursive: true });

        const assetFiles: string[] = [];
        const prefix = `${BLOOM_ASSETS_DIR}/`;
        for (const name of Object.keys(zip.files)) {
          if (!name.startsWith(prefix)) continue;
          if (zip.files[name].dir) continue;
          const rel = name.slice(prefix.length);
          if (!rel) continue;
          const data = await zip.files[name].async("uint8array");
          await writeFile(await pathApi.join(assetsDir, rel), data);
          assetFiles.push(rel);
        }

        setDocMeta({ kind: "bloom", baseDir, assetsDir, assetFiles });
        setFilePath(path);
        setContent(mdText);
        setDirty(false);
        savedContentRef.current = mdText;
      } else {
        const text = await readTextFile(path);
        const baseDir = await pathApi.dirname(path);
        setDocMeta({ kind: "md", baseDir, assetsDir: undefined, assetFiles: [] });
        setFilePath(path);
        setContent(text);
        setDirty(false);
        savedContentRef.current = text;
      }
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
          filters: [
            { name: "Bloom", extensions: ["bloom"] },
            { name: "Markdown", extensions: ["md", "markdown"] },
          ],
          defaultPath: "untitled.md",
        });
        if (!selected) return;
        if (isBloomPath(selected)) {
          const zip = new JSZip();
          zip.file(BLOOM_DOC_NAME, currentContent);
          const folder = zip.folder(BLOOM_ASSETS_DIR);
          const { assetsDir } = await ensureAssetsDir();
          const entries = await readDir(assetsDir);
          for (const entry of entries) {
            if (!entry.isFile) continue;
            const name = entry.name;
            if (!name) continue;
            const data = await readFile(await pathApi.join(assetsDir, name));
            folder?.file(name, data);
          }
          const out = await zip.generateAsync({ type: "uint8array" });
          await writeFile(selected, out);
          setDocMeta((prev) => ({ ...prev, kind: "bloom" }));
        } else {
          await writeTextFile(selected, currentContent);
          const baseDir = await pathApi.dirname(selected);
          setDocMeta({ kind: "md", baseDir, assetsDir: undefined, assetFiles: [] });
        }

        setFilePath(selected);
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

      if (isBloomPath(currentPath) || docMeta.kind === "bloom") {
        const zip = new JSZip();
        zip.file(BLOOM_DOC_NAME, currentContent);
        const folder = zip.folder(BLOOM_ASSETS_DIR);
        const { assetsDir } = await ensureAssetsDir();
        const entries = await readDir(assetsDir);
        for (const entry of entries) {
          if (!entry.isFile) continue;
          const name = entry.name;
          if (!name) continue;
          const data = await readFile(await pathApi.join(assetsDir, name));
          folder?.file(name, data);
        }
        const out = await zip.generateAsync({ type: "uint8array" });
        await writeFile(currentPath, out);
      } else {
        await writeTextFile(currentPath, currentContent);
      }
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
          id: "menu_help",
          text: "Help",
          items: [shortcutsItem],
        });

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

  const title = basenameFromPath(filePath) || "untitled.md";

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
                    setWorkspaceMenu({ path, x: e.clientX, y: e.clientY, kind: "context" });
                  }}
                >
                  <span className="fileLabel">
                    {path === UNTITLED_WORKSPACE_KEY ? "untitled.md" : basenameFromPath(path)}
                  </span>
                  <span className="workspaceRight">
                    {dirty &&
                    (path === filePath || (path === UNTITLED_WORKSPACE_KEY && filePath === null)) ? (
                      <span className="notSavedDot" aria-label="Unsaved changes" />
                    ) : null}
                    <button
                      type="button"
                      className="workspaceMoreBtn"
                      aria-label="More"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setWorkspaceMenu({ path, x: e.clientX, y: e.clientY, kind: "more" });
                      }}
                    >
                      ...
                    </button>
                  </span>
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
          {workspaceMenu.kind === "more" && isMarkdownPath(workspaceMenu.path) ? (
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    await convertWorkspaceMdToBloom(workspaceMenu.path);
                  } finally {
                    setWorkspaceMenu(null);
                  }
                })();
              }}
            >
              Convert to .bloom
            </button>
          ) : null}

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
          <div className="docTitle">
            <span className="fileLabel">{title}</span>
            {dirty ? <span className="notSavedDot" aria-label="Unsaved changes" /> : null}
          </div>

          {mode === "split" ? (
            <div className="splitLayout">
              {showEditor ? (
                <textarea
                  ref={editorRef}
                  className="editor editorSplit"
                  value={content}
                  onPaste={(e) => {
                    const dt = e.clipboardData;
                    if (!dt) return;
                    const items = Array.from(dt.items);
                    const img = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
                    if (!img) return;
                    const file = img.getAsFile();
                    if (!file) return;
                    e.preventDefault();
                    void (async () => {
                      try {
                        if (docMeta.kind === "md") {
                          const ok = await confirm(
                            "Pasting images requires a .bloom document.\n\nConvert this file to .bloom now?",
                            { title: "Convert to .bloom", okLabel: "Convert", cancelLabel: "Cancel" }
                          );
                          if (!ok) return;
                          const converted = await convertCurrentMdToBloom();
                          if (!converted) return;
                        }
                        const { assetsDir } = await ensureAssetsDir();
                        const ext = file.type === "image/jpeg" ? "jpg" : "png";
                        const filename = `img-${randomId()}.${ext}`;
                        const bytes = new Uint8Array(await file.arrayBuffer());
                        await writeFile(await pathApi.join(assetsDir, filename), bytes);
                        setDocMeta((prev) => ({
                          ...prev,
                          kind: prev.kind === "md" ? prev.kind : "bloom",
                          assetFiles: prev.assetFiles.includes(filename) ? prev.assetFiles : [...prev.assetFiles, filename],
                        }));
                        insertTextAtCursor(`![](${BLOOM_ASSETS_DIR}/${filename})`);
                      } catch (err) {
                        console.error(err);
                      }
                    })();
                  }}
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
                  ref={editorRef}
                  className="editor editorSingle"
                  value={content}
                  onPaste={(e) => {
                    const dt = e.clipboardData;
                    if (!dt) return;
                    const items = Array.from(dt.items);
                    const img = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
                    if (!img) return;
                    const file = img.getAsFile();
                    if (!file) return;
                    e.preventDefault();
                    void (async () => {
                      try {
                        if (docMeta.kind === "md") {
                          const ok = await confirm(
                            "Pasting images requires a .bloom document.\n\nConvert this file to .bloom now?",
                            { title: "Convert to .bloom", okLabel: "Convert", cancelLabel: "Cancel" }
                          );
                          if (!ok) return;
                          const converted = await convertCurrentMdToBloom();
                          if (!converted) return;
                        }
                        const { assetsDir } = await ensureAssetsDir();
                        const ext = file.type === "image/jpeg" ? "jpg" : "png";
                        const filename = `img-${randomId()}.${ext}`;
                        const bytes = new Uint8Array(await file.arrayBuffer());
                        await writeFile(await pathApi.join(assetsDir, filename), bytes);
                        setDocMeta((prev) => ({
                          ...prev,
                          kind: prev.kind === "md" ? prev.kind : "bloom",
                          assetFiles: prev.assetFiles.includes(filename) ? prev.assetFiles : [...prev.assetFiles, filename],
                        }));
                        insertTextAtCursor(`![](${BLOOM_ASSETS_DIR}/${filename})`);
                      } catch (err) {
                        console.error(err);
                      }
                    })();
                  }}
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

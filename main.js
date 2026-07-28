const { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_SETTINGS = {
  pandocPath: "pandoc",
  outputFolder: "Экспорт DOCX",
  importFolder: "Импорт DOCX",
  referenceDocx: "",
  useBuiltInReferenceDocx: true,
  bodyFontSize: 12,
  footnoteFontSize: 10,
  normalizeWithWord: true,
  openAfterExport: true,
  openMarkdownAfterImport: true
};

module.exports = class MarkdownDocxExporterPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addCommand({
      id: "export-active-markdown-to-docx",
      name: "Export active Markdown to DOCX",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canRun = file instanceof TFile && file.extension === "md";
        if (checking) return canRun;
        this.exportActiveMarkdown().catch((error) => {
          console.error("[markdown-docx-exporter] Export failed", error);
          new Notice(`DOCX export failed: ${error.message || error}`);
        });
        return true;
      }
    });

    this.addCommand({
      id: "import-active-docx-to-markdown",
      name: "Import active DOCX to Markdown",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canRun = file instanceof TFile && file.extension === "docx";
        if (checking) return canRun;
        this.importActiveDocx().catch((error) => {
          console.error("[markdown-docx-exporter] Import failed", error);
          new Notice(`DOCX import failed: ${error.message || error}`);
        });
        return true;
      }
    });

    this.addSettingTab(new MarkdownDocxExporterSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
    if (adapter.basePath) return adapter.basePath;
    throw new Error("Cannot resolve vault path. This plugin requires the desktop filesystem adapter.");
  }

  async exportActiveMarkdown() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      throw new Error("Active file is not a Markdown note.");
    }

    const vaultBasePath = this.getVaultBasePath();
    const sourcePath = path.join(vaultBasePath, file.path);
    const outputFolderVaultPath = normalizePath(this.settings.outputFolder || DEFAULT_SETTINGS.outputFolder);
    const outputFolderPath = path.join(vaultBasePath, outputFolderVaultPath);
    await fs.promises.mkdir(outputFolderPath, { recursive: true });

    const outputFileName = `${sanitizeBaseName(file.basename)}.docx`;
    const preferredOutputPath = path.join(outputFolderPath, outputFileName);
    const outputPath = await resolveWritableOutputPath(preferredOutputPath);
    const actualOutputFileName = path.basename(outputPath);
    const preparedSourcePath = await createPreparedMarkdownSource(sourcePath, file.basename);
    const args = this.buildPandocArgs(preparedSourcePath, outputPath, vaultBasePath, file, path.dirname(sourcePath));
    const progressNotice = createActivityNotice("Экспорт DOCX: подготовка");

    try {
      progressNotice.setStage("Экспорт DOCX: преобразование Markdown");
      await runProcess(this.settings.pandocPath || DEFAULT_SETTINGS.pandocPath, args);
      if (this.settings.normalizeWithWord) {
        progressNotice.setStage("Экспорт DOCX: нормализация Word");
        await normalizeDocxWithWord(outputPath, {
          bodyFontSize: readFontSize(this.settings.bodyFontSize, DEFAULT_SETTINGS.bodyFontSize),
          footnoteFontSize: readFontSize(this.settings.footnoteFontSize, DEFAULT_SETTINGS.footnoteFontSize)
        });
      } else {
        progressNotice.setStage("Экспорт DOCX: завершение");
      }

      await this.app.vault.adapter.exists(outputFolderVaultPath);
      await this.app.vault.adapter.exists(normalizePath(`${outputFolderVaultPath}/${actualOutputFileName}`));

      progressNotice.complete(`DOCX готов: ${actualOutputFileName}`);

      if (this.settings.openAfterExport) {
        await openPath(outputPath);
      }

      setTimeout(() => progressNotice.hide(), 3000);
    } catch (error) {
      progressNotice.hide();
      throw explainExportError(error, outputPath);
    } finally {
      fs.promises.unlink(preparedSourcePath).catch(() => {});
    }
  }

  buildPandocArgs(sourcePath, outputPath, vaultBasePath, file, originalSourceDir) {
    const resourcePaths = [
      vaultBasePath,
      originalSourceDir,
      path.dirname(sourcePath)
    ].filter(Boolean);

    const args = [
      sourcePath,
      "--from",
      "markdown+footnotes+smart",
      "--to",
      "docx",
      "--output",
      outputPath,
      "--resource-path",
      resourcePaths.join(path.delimiter)
    ];

    const underlineFilter = path.join(vaultBasePath, ".obsidian", "plugins", this.manifest.id, "underline.lua");
    if (fs.existsSync(underlineFilter)) {
      args.push("--lua-filter", underlineFilter);
    }

    const referenceDocx = (this.settings.referenceDocx || "").trim();
    if (referenceDocx) {
      const resolvedReference = path.isAbsolute(referenceDocx)
        ? referenceDocx
        : path.join(vaultBasePath, referenceDocx);
      if (!fs.existsSync(resolvedReference)) {
        throw new Error(`Reference DOCX not found: ${resolvedReference}`);
      }
      args.push("--reference-doc", resolvedReference);
    } else if (this.settings.useBuiltInReferenceDocx) {
      const builtInReference = path.join(".obsidian", "plugins", this.manifest.id, "reference.docx");
      const resolvedReference = path.isAbsolute(builtInReference)
        ? builtInReference
        : path.join(vaultBasePath, builtInReference);
      if (fs.existsSync(resolvedReference)) {
        args.push("--reference-doc", resolvedReference);
      }
    }

    return args;
  }

  async importActiveDocx() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "docx") {
      throw new Error("Active file is not a DOCX file.");
    }

    const vaultBasePath = this.getVaultBasePath();
    const sourcePath = path.join(vaultBasePath, file.path);
    const importFolderVaultPath = normalizePath(this.settings.importFolder || DEFAULT_SETTINGS.importFolder);
    const importFolderPath = path.join(vaultBasePath, importFolderVaultPath);
    await fs.promises.mkdir(importFolderPath, { recursive: true });

    const outputFileName = `${sanitizeBaseName(file.basename)}.md`;
    const preferredOutputPath = path.join(importFolderPath, outputFileName);
    const outputPath = await resolveWritableOutputPath(preferredOutputPath);
    const actualOutputFileName = path.basename(outputPath);
    const mediaFolderPath = path.join(importFolderPath, `${path.parse(actualOutputFileName).name}-media`);
    const progressNotice = createActivityNotice("Импорт DOCX: подготовка");

    try {
      progressNotice.setStage("Импорт DOCX: преобразование Word");
      await runProcess(this.settings.pandocPath || DEFAULT_SETTINGS.pandocPath, [
        sourcePath,
        "--from",
        "docx",
        "--to",
        "gfm+footnotes+smart",
        "--wrap",
        "none",
        "--extract-media",
        mediaFolderPath,
        "--output",
        outputPath
      ]);

      progressNotice.setStage("Импорт DOCX: очистка таблиц");
      await normalizeImportedMarkdown(outputPath);

      const outputVaultPath = normalizePath(`${importFolderVaultPath}/${actualOutputFileName}`);
      await this.app.vault.adapter.exists(outputVaultPath);
      progressNotice.complete(`Markdown готов: ${actualOutputFileName}`);

      if (this.settings.openMarkdownAfterImport) {
        await this.app.workspace.openLinkText(outputVaultPath, "", false);
      }

      setTimeout(() => progressNotice.hide(), 3000);
    } catch (error) {
      progressNotice.hide();
      throw error;
    }
  }
};

class MarkdownDocxExporterSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Markdown DOCX Exporter" });

    const warning = containerEl.createDiv({ cls: "markdown-docx-exporter-setting-warning" });
    warning.setText("This plugin exports Markdown to DOCX through Pandoc. It does not edit DOCX files inside Obsidian.");

    new Setting(containerEl)
      .setName("Pandoc path")
      .setDesc("Use 'pandoc' if it is available in PATH, or set the full path to pandoc.exe.")
      .addText((text) => text
        .setPlaceholder("pandoc")
        .setValue(this.plugin.settings.pandocPath)
        .onChange(async (value) => {
          this.plugin.settings.pandocPath = value.trim() || DEFAULT_SETTINGS.pandocPath;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault-relative folder where exported DOCX files will be written.")
      .addText((text) => text
        .setPlaceholder("Экспорт DOCX")
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = normalizePath(value.trim() || DEFAULT_SETTINGS.outputFolder);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("DOCX import folder")
      .setDesc("Vault-relative folder where imported Markdown files will be written.")
      .addText((text) => text
        .setPlaceholder("Импорт DOCX")
        .setValue(this.plugin.settings.importFolder)
        .onChange(async (value) => {
          this.plugin.settings.importFolder = normalizePath(value.trim() || DEFAULT_SETTINGS.importFolder);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Reference DOCX")
      .setDesc("Optional Word reference template. If empty, the built-in plain academic template is used.")
      .addText((text) => text
        .setPlaceholder("Templates/dissertation-reference.docx")
        .setValue(this.plugin.settings.referenceDocx)
        .onChange(async (value) => {
          this.plugin.settings.referenceDocx = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Use built-in plain DOCX template")
      .setDesc("Use the built-in Times New Roman template without opening Word after export.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useBuiltInReferenceDocx)
        .onChange(async (value) => {
          this.plugin.settings.useBuiltInReferenceDocx = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Body font size")
      .setDesc("Standard text size in points. Used by the built-in template default and by Word normalization.")
      .addText((text) => text
        .setPlaceholder("12")
        .setValue(String(this.plugin.settings.bodyFontSize ?? DEFAULT_SETTINGS.bodyFontSize))
        .onChange(async (value) => {
          this.plugin.settings.bodyFontSize = readFontSize(value, DEFAULT_SETTINGS.bodyFontSize);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Footnote font size")
      .setDesc("Footnote text size in points. Used by the built-in template default and by Word normalization.")
      .addText((text) => text
        .setPlaceholder("10")
        .setValue(String(this.plugin.settings.footnoteFontSize ?? DEFAULT_SETTINGS.footnoteFontSize))
        .onChange(async (value) => {
          this.plugin.settings.footnoteFontSize = readFontSize(value, DEFAULT_SETTINGS.footnoteFontSize);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Normalize typography with Word")
      .setDesc("Recommended. After export, use Microsoft Word to apply Times New Roman, headings, selected font sizes, and correct footnote styling.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.normalizeWithWord)
        .onChange(async (value) => {
          this.plugin.settings.normalizeWithWord = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Open DOCX after export")
      .setDesc("Open the exported file with the default system application.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.openAfterExport)
        .onChange(async (value) => {
          this.plugin.settings.openAfterExport = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Open Markdown after DOCX import")
      .setDesc("Open the imported Markdown note after converting a DOCX file.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.openMarkdownAfterImport)
        .onChange(async (value) => {
          this.plugin.settings.openMarkdownAfterImport = value;
          await this.plugin.saveSettings();
        }));
  }
}

function sanitizeBaseName(value) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "export";
}

function readFontSize(value, fallback) {
  const parsed = Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 6 || parsed > 72) return fallback;
  return parsed;
}

async function createPreparedMarkdownSource(sourcePath, basename) {
  const originalMarkdown = await fs.promises.readFile(sourcePath, "utf8");
  const preparedMarkdown = transformObsidianMarkdownForWord(originalMarkdown);
  const safeBaseName = sanitizeBaseName(basename);
  const tempPath = path.join(os.tmpdir(), `markdown-docx-export-${Date.now()}-${safeBaseName}.md`);
  await fs.promises.writeFile(tempPath, preparedMarkdown, "utf8");
  return tempPath;
}

function transformObsidianMarkdownForWord(markdown) {
  return markdown
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (match, inner) => {
      if (match.startsWith("![[")) return match;
      const parts = inner.split("|");
      if (parts.length > 1) return parts.slice(1).join("|").trim();
      return cleanWikilinkTargetForWord(parts[0]);
    });
}

function cleanWikilinkTargetForWord(target) {
  const withoutHeading = String(target).split("#").pop() || target;
  const withoutBlockMarker = withoutHeading.replace(/^\^/, "");
  const withoutExtension = withoutBlockMarker.replace(/\.(md|pdf|docx?)$/i, "");
  return withoutExtension.trim();
}

async function normalizeImportedMarkdown(markdownPath) {
  const markdown = await fs.promises.readFile(markdownPath, "utf8");
  const normalized = convertHtmlTablesToMarkdown(markdown);
  if (normalized !== markdown) {
    await fs.promises.writeFile(markdownPath, normalized, "utf8");
  }
}

function convertHtmlTablesToMarkdown(markdown) {
  if (!markdown.includes("<table")) return markdown;
  return markdown.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const tableMarkdown = htmlTableToPipeMarkdown(tableHtml);
    return tableMarkdown || tableHtml;
  });
}

function htmlTableToPipeMarkdown(tableHtml) {
  if (typeof DOMParser === "undefined") return null;

  const doc = new DOMParser().parseFromString(tableHtml, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
  if (!headerRow) return null;

  const headers = Array.from(headerRow.cells)
    .map((cell) => normalizeTableCellText(cell))
    .filter((value) => value.length > 0);
  if (headers.length === 0) return null;

  const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
  const rows = (bodyRows.length > 0 ? bodyRows : Array.from(table.querySelectorAll("tr")).slice(1))
    .map((row) => normalizeTableRow(row, headers.length))
    .filter((row) => row.some((cell) => cell.length > 0));

  if (rows.length === 0) return null;

  const lines = [
    `| ${headers.map(escapeMarkdownTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`)
  ];

  return `\n${lines.join("\n")}\n`;
}

function normalizeTableRow(row, columnCount) {
  const cells = Array.from(row.cells).map((cell) => normalizeTableCellText(cell));
  if (cells.length > columnCount) {
    const leadingCellCount = cells.length - columnCount + 1;
    const leading = cells
      .slice(0, leadingCellCount)
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" / ");
    return [leading, ...cells.slice(leadingCellCount)].slice(0, columnCount);
  }
  while (cells.length < columnCount) cells.push("");
  return cells.slice(0, columnCount);
}

function normalizeTableCellText(cell) {
  const clone = cell.cloneNode(true);
  clone.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
  return (clone.textContent || "")
    .replace(/\s+/g, " ")
    .replace(/\*\*\*/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const details = (stderr || stdout || error.message || "").trim();
        reject(new Error(details || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function createActivityNotice(initialStage) {
  const barWidth = 8;
  let stage = initialStage;
  let filled = 1;
  const notice = new Notice(formatActivityMessage(stage, filled, barWidth), 0);
  const timer = setInterval(() => {
    filled = filled >= barWidth ? 1 : filled + 1;
    setNoticeMessage(notice, formatActivityMessage(stage, filled, barWidth));
  }, 500);

  return {
    setStage(nextStage) {
      stage = nextStage;
      filled = 1;
      setNoticeMessage(notice, formatActivityMessage(stage, filled, barWidth));
    },
    complete(message) {
      clearInterval(timer);
      setNoticeMessage(notice, message);
    },
    hide() {
      clearInterval(timer);
      if (typeof notice.hide === "function") notice.hide();
    }
  };
}

function formatActivityMessage(stage, filled, width) {
  const active = "|".repeat(filled);
  const empty = " ".repeat(Math.max(width - filled, 0));
  return `${stage} [${active}${empty}]`;
}

function setNoticeMessage(notice, message) {
  if (typeof notice.setMessage === "function") {
    notice.setMessage(message);
  } else {
    new Notice(message, 2500);
  }
}

async function resolveWritableOutputPath(preferredPath) {
  if (!(await pathExists(preferredPath))) return preferredPath;
  if (await canWriteExistingFile(preferredPath)) return preferredPath;

  const parsed = path.parse(preferredPath);
  for (let index = 2; index <= 99; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!(await pathExists(candidate))) return candidate;
    if (await canWriteExistingFile(candidate)) return candidate;
  }

  throw new Error("Cannot find a writable DOCX output file name.");
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function canWriteExistingFile(targetPath) {
  let handle = null;
  try {
    handle = await fs.promises.open(targetPath, "r+");
    return true;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function explainExportError(error, outputPath) {
  const message = String(error && error.message ? error.message : error);
  if (/permission denied|access is denied|denied/i.test(message)) {
    return new Error(`Не удалось записать DOCX: ${path.basename(outputPath)}. Закройте файл в Word или выберите другую папку экспорта.`);
  }
  return error;
}

async function normalizeDocxWithWord(docxPath, options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Word normalization is available only on Windows.");
  }

  const bodyFontSize = readFontSize(options.bodyFontSize, DEFAULT_SETTINGS.bodyFontSize);
  const footnoteFontSize = readFontSize(options.footnoteFontSize, DEFAULT_SETTINGS.footnoteFontSize);
  const heading1FontSize = Math.max(bodyFontSize + 4, 16);
  const heading2FontSize = Math.max(bodyFontSize + 2, 14);
  const heading3FontSize = Math.max(bodyFontSize, 12);
  const scriptPath = path.join(os.tmpdir(), `markdown-docx-normalize-${Date.now()}.ps1`);
  const script = `
param(
  [Parameter(Mandatory=$true)][string]$DocxPath,
  [Parameter(Mandatory=$true)][double]$BodyFontSize,
  [Parameter(Mandatory=$true)][double]$FootnoteFontSize,
  [Parameter(Mandatory=$true)][double]$Heading1FontSize,
  [Parameter(Mandatory=$true)][double]$Heading2FontSize,
  [Parameter(Mandatory=$true)][double]$Heading3FontSize
)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($DocxPath)
  try {
    $black = 0
    $mainFont = 'Times New Roman'
    $russianLanguageId = 1049

    try {
      $doc.Content.LanguageID = $russianLanguageId
    } catch {}

    # First make the whole style table use a legal academic font and black color,
    # but do not force every style to body size: headings and footnotes need their own sizes.
    foreach ($style in $doc.Styles) {
      try {
        if ($style.Font -ne $null) {
          $style.Font.Name = $mainFont
          $style.Font.Color = $black
          $style.Font.LanguageID = $russianLanguageId
        }
      } catch {}
    }

    foreach ($style in $doc.Styles) {
      try {
        $name = [string]$style.NameLocal
        if ($name -match '^(Обычный|Normal|Body Text|Основной текст)') {
          $style.Font.Name = $mainFont
          $style.Font.Size = $BodyFontSize
          $style.Font.Color = $black
        } elseif ($name -match '^(Заголовок 1|Heading 1|Title|Название)') {
          $style.Font.Name = $mainFont
          $style.Font.Size = $Heading1FontSize
          $style.Font.Bold = $true
          $style.Font.Color = $black
        } elseif ($name -match '^(Заголовок 2|Heading 2|Subtitle|Подзаголовок)') {
          $style.Font.Name = $mainFont
          $style.Font.Size = $Heading2FontSize
          $style.Font.Bold = $true
          $style.Font.Color = $black
        } elseif ($name -match '^(Заголовок 3|Heading 3)') {
          $style.Font.Name = $mainFont
          $style.Font.Size = $Heading3FontSize
          $style.Font.Bold = $true
          $style.Font.Color = $black
        }
        try {
          if ($name -match '^(Обычный|Normal|Body Text|Основной текст|Заголовок|Heading|Title|Название|Subtitle|Подзаголовок)') {
            foreach ($border in $style.ParagraphFormat.Borders) {
              $border.LineStyle = 0
            }
          }
        } catch {}
      } catch {}
    }

    # Paragraph and footnote ranges often carry direct formatting after Pandoc.
    # This loop is slower than style-only changes, but it preserves the required Word result.
    $mainStory = $doc.StoryRanges.Item(1)
    foreach ($paragraph in $mainStory.Paragraphs) {
      try {
        $styleName = [string]$paragraph.Range.Style.NameLocal
        $paragraph.Range.Font.Name = $mainFont
        $paragraph.Range.Font.Color = $black
        $paragraph.Range.LanguageID = $russianLanguageId
        if ($styleName -match '^(Заголовок 1|Heading 1|Title|Название)') {
          $paragraph.Range.Font.Size = $Heading1FontSize
          $paragraph.Range.Font.Bold = $true
        } elseif ($styleName -match '^(Заголовок 2|Heading 2|Subtitle|Подзаголовок)') {
          $paragraph.Range.Font.Size = $Heading2FontSize
          $paragraph.Range.Font.Bold = $true
        } elseif ($styleName -match '^(Заголовок 3|Heading 3)') {
          $paragraph.Range.Font.Size = $Heading3FontSize
          $paragraph.Range.Font.Bold = $true
        } else {
          $paragraph.Range.Font.Size = $BodyFontSize
        }
        foreach ($border in $paragraph.Borders) {
          $border.LineStyle = 0
        }
      } catch {}
    }

    foreach ($footnote in $doc.Footnotes) {
      $footnote.Range.Font.Name = $mainFont
      $footnote.Range.Font.Size = $FootnoteFontSize
      $footnote.Range.Font.Color = $black
      $footnote.Range.LanguageID = $russianLanguageId
      try {
        $footnote.Reference.Font.Name = $mainFont
        $footnote.Reference.Font.Size = $FootnoteFontSize
        $footnote.Reference.Font.Color = $black
        $footnote.Reference.Font.Superscript = $true
        $footnote.Reference.LanguageID = $russianLanguageId
      } catch {}
    }

    foreach ($endnote in $doc.Endnotes) {
      $endnote.Range.Font.Name = $mainFont
      $endnote.Range.Font.Size = $FootnoteFontSize
      $endnote.Range.Font.Color = $black
      $endnote.Range.LanguageID = $russianLanguageId
      try {
        $endnote.Reference.Font.Name = $mainFont
        $endnote.Reference.Font.Size = $FootnoteFontSize
        $endnote.Reference.Font.Color = $black
        $endnote.Reference.Font.Superscript = $true
        $endnote.Reference.LanguageID = $russianLanguageId
      } catch {}
    }

    try {
      $doc.Styles.Item('Footnote Text').Font.Name = $mainFont
      $doc.Styles.Item('Footnote Text').Font.Size = $FootnoteFontSize
      $doc.Styles.Item('Footnote Text').Font.Color = $black
      $doc.Styles.Item('Footnote Reference').Font.Name = $mainFont
      $doc.Styles.Item('Footnote Reference').Font.Size = $FootnoteFontSize
      $doc.Styles.Item('Footnote Reference').Font.Color = $black
      $doc.Styles.Item('Footnote Reference').Font.Superscript = $true
    } catch {}

    try {
      $doc.Styles.Item('Текст сноски').Font.Name = $mainFont
      $doc.Styles.Item('Текст сноски').Font.Size = $FootnoteFontSize
      $doc.Styles.Item('Текст сноски').Font.Color = $black
      $doc.Styles.Item('Знак сноски').Font.Name = $mainFont
      $doc.Styles.Item('Знак сноски').Font.Size = $FootnoteFontSize
      $doc.Styles.Item('Знак сноски').Font.Color = $black
      $doc.Styles.Item('Знак сноски').Font.Superscript = $true
    } catch {}

    $doc.Save()
  } finally {
    $doc.Close($false)
  }
} finally {
  $word.Quit()
}
`;

  await fs.promises.writeFile(scriptPath, script, "utf8");
  try {
    await runProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-DocxPath",
      docxPath,
      "-BodyFontSize",
      String(bodyFontSize),
      "-FootnoteFontSize",
      String(footnoteFontSize),
      "-Heading1FontSize",
      String(heading1FontSize),
      "-Heading2FontSize",
      String(heading2FontSize),
      "-Heading3FontSize",
      String(heading3FontSize)
    ]);
  } finally {
    fs.promises.unlink(scriptPath).catch(() => {});
  }
}

async function openPath(targetPath) {
  const electron = require("electron");
  const shell = electron.shell || (electron.remote && electron.remote.shell);
  if (!shell || typeof shell.openPath !== "function") return;
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) throw new Error(errorMessage);
}

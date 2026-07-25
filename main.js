const { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_SETTINGS = {
  pandocPath: "pandoc",
  outputFolder: "Экспорт DOCX",
  referenceDocx: "",
  useBuiltInReferenceDocx: true,
  normalizeWithWord: false,
  openAfterExport: true
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
    const outputPath = path.join(outputFolderPath, outputFileName);
    const args = this.buildPandocArgs(sourcePath, outputPath, vaultBasePath, file);

    new Notice("Exporting Markdown to DOCX...");
    await runProcess(this.settings.pandocPath || DEFAULT_SETTINGS.pandocPath, args);

    if (this.settings.normalizeWithWord) {
      new Notice("Normalizing DOCX typography...");
      await normalizeDocxWithWord(outputPath);
    }

    await this.app.vault.adapter.exists(outputFolderVaultPath);
    await this.app.vault.adapter.exists(normalizePath(`${outputFolderVaultPath}/${outputFileName}`));

    new Notice(`DOCX exported: ${outputFileName}`);

    if (this.settings.openAfterExport) {
      await openPath(outputPath);
    }
  }

  buildPandocArgs(sourcePath, outputPath, vaultBasePath, file) {
    const resourcePaths = [
      vaultBasePath,
      path.dirname(sourcePath)
    ];

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
      .setDesc("Use Times New Roman, 12 pt body text, black font, and 10 pt footnotes without opening Word after export.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useBuiltInReferenceDocx)
        .onChange(async (value) => {
          this.plugin.settings.useBuiltInReferenceDocx = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Normalize typography with Word")
      .setDesc("Slow fallback. After export, use Microsoft Word to force Times New Roman, 12 pt, black text, and 10 pt footnotes.")
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
  }
}

function sanitizeBaseName(value) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "export";
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

async function normalizeDocxWithWord(docxPath) {
  if (process.platform !== "win32") {
    throw new Error("Word normalization is available only on Windows.");
  }

  const scriptPath = path.join(os.tmpdir(), `markdown-docx-normalize-${Date.now()}.ps1`);
  const script = `
param([Parameter(Mandatory=$true)][string]$DocxPath)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($DocxPath)
  try {
    $black = 0
    $mainFont = 'Times New Roman'
    $doc.Content.Font.Name = $mainFont
    $doc.Content.Font.Size = 12
    $doc.Content.Font.Color = $black

    foreach ($style in $doc.Styles) {
      try {
        if ($style.Font -ne $null) {
          $style.Font.Name = $mainFont
          $style.Font.Color = $black
          $style.Font.Size = 12
        }
      } catch {}
    }

    foreach ($footnote in $doc.Footnotes) {
      $footnote.Range.Font.Name = $mainFont
      $footnote.Range.Font.Size = 10
      $footnote.Range.Font.Color = $black
    }

    foreach ($endnote in $doc.Endnotes) {
      $endnote.Range.Font.Name = $mainFont
      $endnote.Range.Font.Size = 10
      $endnote.Range.Font.Color = $black
    }

    try {
      $doc.Styles.Item('Footnote Text').Font.Name = $mainFont
      $doc.Styles.Item('Footnote Text').Font.Size = 10
      $doc.Styles.Item('Footnote Text').Font.Color = $black
    } catch {}

    try {
      $doc.Styles.Item('Текст сноски').Font.Name = $mainFont
      $doc.Styles.Item('Текст сноски').Font.Size = 10
      $doc.Styles.Item('Текст сноски').Font.Color = $black
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
      docxPath
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

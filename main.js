const { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
  pandocPath: "pandoc",
  outputFolder: "Экспорт DOCX",
  referenceDocx: "",
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

    const referenceDocx = (this.settings.referenceDocx || "").trim();
    if (referenceDocx) {
      const resolvedReference = path.isAbsolute(referenceDocx)
        ? referenceDocx
        : path.join(vaultBasePath, referenceDocx);
      if (!fs.existsSync(resolvedReference)) {
        throw new Error(`Reference DOCX not found: ${resolvedReference}`);
      }
      args.push("--reference-doc", resolvedReference);
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
      .setDesc("Optional Word reference template. Use a vault-relative or absolute path.")
      .addText((text) => text
        .setPlaceholder("Templates/dissertation-reference.docx")
        .setValue(this.plugin.settings.referenceDocx)
        .onChange(async (value) => {
          this.plugin.settings.referenceDocx = value.trim();
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

async function openPath(targetPath) {
  const electron = require("electron");
  const shell = electron.shell || (electron.remote && electron.remote.shell);
  if (!shell || typeof shell.openPath !== "function") return;
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) throw new Error(errorMessage);
}

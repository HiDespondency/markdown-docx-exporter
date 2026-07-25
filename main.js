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
  bodyFontSize: 12,
  footnoteFontSize: 10,
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
    const preferredOutputPath = path.join(outputFolderPath, outputFileName);
    const outputPath = await resolveWritableOutputPath(preferredOutputPath);
    const actualOutputFileName = path.basename(outputPath);
    const args = this.buildPandocArgs(sourcePath, outputPath, vaultBasePath, file);

    new Notice("Exporting Markdown to DOCX...");
    try {
      await runProcess(this.settings.pandocPath || DEFAULT_SETTINGS.pandocPath, args);
    } catch (error) {
      throw explainExportError(error, outputPath);
    }

    await patchDocxStyles(outputPath, {
      bodyFontSize: readFontSize(this.settings.bodyFontSize, DEFAULT_SETTINGS.bodyFontSize),
      footnoteFontSize: readFontSize(this.settings.footnoteFontSize, DEFAULT_SETTINGS.footnoteFontSize)
    });

    if (this.settings.normalizeWithWord) {
      new Notice("Normalizing DOCX typography...");
      await normalizeDocxWithWord(outputPath);
    }

    await this.app.vault.adapter.exists(outputFolderVaultPath);
    await this.app.vault.adapter.exists(normalizePath(`${outputFolderVaultPath}/${actualOutputFileName}`));

    new Notice(`DOCX exported: ${actualOutputFileName}`);

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
      .setName("Body font size")
      .setDesc("Standard text size in points. Enter a number, for example 12.")
      .addText((text) => text
        .setPlaceholder("12")
        .setValue(String(this.plugin.settings.bodyFontSize ?? DEFAULT_SETTINGS.bodyFontSize))
        .onChange(async (value) => {
          this.plugin.settings.bodyFontSize = readFontSize(value, DEFAULT_SETTINGS.bodyFontSize);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Footnote font size")
      .setDesc("Footnote text size in points. Enter a number, for example 10.")
      .addText((text) => text
        .setPlaceholder("10")
        .setValue(String(this.plugin.settings.footnoteFontSize ?? DEFAULT_SETTINGS.footnoteFontSize))
        .onChange(async (value) => {
          this.plugin.settings.footnoteFontSize = readFontSize(value, DEFAULT_SETTINGS.footnoteFontSize);
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

function readFontSize(value, fallback) {
  const parsed = Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 6 || parsed > 72) return fallback;
  return parsed;
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

async function patchDocxStyles(docxPath, options) {
  const bodyFontSize = readFontSize(options.bodyFontSize, DEFAULT_SETTINGS.bodyFontSize);
  const footnoteFontSize = readFontSize(options.footnoteFontSize, DEFAULT_SETTINGS.footnoteFontSize);
  const scriptPath = path.join(os.tmpdir(), `markdown-docx-style-patch-${Date.now()}.ps1`);
  const script = `
param(
  [Parameter(Mandatory=$true)][string]$DocxPath,
  [Parameter(Mandatory=$true)][double]$BodyFontSize,
  [Parameter(Mandatory=$true)][double]$FootnoteFontSize
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$wNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
$bodyHalfPoints = [int]($BodyFontSize * 2)
$footnoteHalfPoints = [int]($FootnoteFontSize * 2)

function Read-ZipEntryText($zip, $name) {
  $entry = $zip.GetEntry($name)
  if ($null -eq $entry) { return $null }
  $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Write-ZipEntryText($zip, $name, $text) {
  $old = $zip.GetEntry($name)
  if ($null -ne $old) { $old.Delete() }
  $entry = $zip.CreateEntry($name)
  $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
  try { $writer.Write($text) } finally { $writer.Dispose() }
}

function Ensure-Child($doc, $node, $localName) {
  foreach ($child in $node.ChildNodes) {
    if ($child.LocalName -eq $localName -and $child.NamespaceURI -eq $wNs) { return $child }
  }
  $created = $doc.CreateElement('w', $localName, $wNs)
  [void]$node.AppendChild($created)
  return $created
}

function Ensure-RunProps($doc, $node, [bool]$prepend) {
  foreach ($child in $node.ChildNodes) {
    if ($child.LocalName -eq 'rPr' -and $child.NamespaceURI -eq $wNs) { return $child }
  }
  $created = $doc.CreateElement('w', 'rPr', $wNs)
  if ($prepend -and $node.HasChildNodes) {
    [void]$node.InsertBefore($created, $node.FirstChild)
  } else {
    [void]$node.AppendChild($created)
  }
  return $created
}

function Set-RunProps($doc, $rPr, [int]$halfPoints, [bool]$superscript) {
  $rFonts = Ensure-Child $doc $rPr 'rFonts'
  foreach ($attr in @('ascii', 'hAnsi', 'eastAsia', 'cs')) {
    $rFonts.SetAttribute($attr, $wNs, 'Times New Roman')
  }
  $sz = Ensure-Child $doc $rPr 'sz'
  $sz.SetAttribute('val', $wNs, [string]$halfPoints)
  $szCs = Ensure-Child $doc $rPr 'szCs'
  $szCs.SetAttribute('val', $wNs, [string]$halfPoints)
  $color = Ensure-Child $doc $rPr 'color'
  $color.SetAttribute('val', $wNs, '000000')
  if ($superscript) {
    $vertAlign = Ensure-Child $doc $rPr 'vertAlign'
    $vertAlign.SetAttribute('val', $wNs, 'superscript')
  }
}

function Patch-StylesXml($xmlText) {
  if ([string]::IsNullOrWhiteSpace($xmlText)) { return $xmlText }
  [xml]$doc = $xmlText
  $ns = [System.Xml.XmlNamespaceManager]::new($doc.NameTable)
  $ns.AddNamespace('w', $wNs)

  foreach ($styleId in @('Normal', 'BodyText', 'BodyText2', 'BodyText3', 'BlockText', 'Quote')) {
    $style = $doc.SelectSingleNode("//w:style[@w:styleId='$styleId']", $ns)
    if ($null -ne $style) {
      $rPr = Ensure-RunProps $doc $style $false
      Set-RunProps $doc $rPr $bodyHalfPoints $false
    }
  }

  foreach ($styleId in @('FootnoteText', 'EndnoteText')) {
    $style = $doc.SelectSingleNode("//w:style[@w:styleId='$styleId']", $ns)
    if ($null -ne $style) {
      $rPr = Ensure-RunProps $doc $style $false
      Set-RunProps $doc $rPr $footnoteHalfPoints $false
    }
  }

  foreach ($styleId in @('FootnoteReference', 'EndnoteReference')) {
    $style = $doc.SelectSingleNode("//w:style[@w:styleId='$styleId']", $ns)
    if ($null -ne $style) {
      $rPr = Ensure-RunProps $doc $style $false
      Set-RunProps $doc $rPr $footnoteHalfPoints $true
    }
  }

  return $doc.OuterXml
}

function Patch-ReferenceRunsXml($xmlText) {
  if ([string]::IsNullOrWhiteSpace($xmlText)) { return $xmlText }
  [xml]$doc = $xmlText
  $ns = [System.Xml.XmlNamespaceManager]::new($doc.NameTable)
  $ns.AddNamespace('w', $wNs)
  $runs = $doc.SelectNodes('//w:r[w:footnoteReference or w:endnoteReference]', $ns)
  foreach ($run in $runs) {
    $rPr = Ensure-RunProps $doc $run $true
    Set-RunProps $doc $rPr $footnoteHalfPoints $true
  }
  return $doc.OuterXml
}

$zip = [System.IO.Compression.ZipFile]::Open($DocxPath, [System.IO.Compression.ZipArchiveMode]::Update)
try {
  $styles = Read-ZipEntryText $zip 'word/styles.xml'
  if ($null -ne $styles) { Write-ZipEntryText $zip 'word/styles.xml' (Patch-StylesXml $styles) }

  foreach ($entryName in @('word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml')) {
    $xml = Read-ZipEntryText $zip $entryName
    if ($null -ne $xml) { Write-ZipEntryText $zip $entryName (Patch-ReferenceRunsXml $xml) }
  }
} finally {
  $zip.Dispose()
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
      String(footnoteFontSize)
    ]);
  } finally {
    fs.promises.unlink(scriptPath).catch(() => {});
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

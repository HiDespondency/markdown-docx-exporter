# Markdown DOCX Exporter

Локальный proof-of-concept плагин Obsidian для экспорта активной Markdown-заметки в `.docx` через Pandoc.

## Задача

Проверить рабочую схему:

```text
Obsidian Markdown -> Pandoc -> Word DOCX
```

Это не редактор `.docx` внутри Obsidian. Плагин нужен, чтобы писать текст в `.md`, а затем получать нормальный Word-документ без открытия Markdown как обычного текстового файла.

## Требования

- Windows.
- Obsidian Desktop.
- Pandoc в системе. По умолчанию используется команда `pandoc`.

## Команды

- `Export active Markdown to DOCX` - экспортирует текущую Markdown-заметку в `.docx`.

## Настройки

- `Pandoc path` - путь к `pandoc.exe` или команда `pandoc`, если Pandoc доступен из PATH.
- `Output folder` - папка внутри хранилища для готовых `.docx`.
- `Reference DOCX` - необязательный путь к Word-шаблону стилей.
- `Normalize typography with Word` - после экспорта приводит документ через Microsoft Word к обычному виду: Times New Roman, 12 pt, чёрный текст, сноски 10 pt.
- `Open DOCX after export` - открыть результат системным приложением после экспорта.

## Текущий статус

Проверка концепции. Основные риски для дальнейшей доработки:

- Obsidian wikilinks требуют отдельной обработки.
- Callout-блоки требуют правил: экспортировать, преобразовывать или исключать.
- Для научного текста нужен `reference.docx` с правильными стилями Word.
- Ссылки вида `[1]` остаются текстом; настоящие Markdown-сноски `[^1]` Pandoc умеет превращать в сноски Word.

## Номенклатурная нормализация

Если включена настройка `Normalize typography with Word`, плагин после Pandoc открывает готовый `.docx` через Microsoft Word и приводит шрифт к базовым требованиям:

- основной текст: Times New Roman, 12 pt;
- сноски: Times New Roman, 10 pt;
- цвет шрифта: чёрный;
- без декоративных цветов и нестандартных шрифтов.
